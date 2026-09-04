package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"time"
)

const maxLoadedJobs = 1000

var (
	errNotFound = errors.New("not found")
	errConflict = errors.New("conflict")
)

type orchestrator struct {
	ctx     context.Context
	cancel  context.CancelFunc
	store   *stateStore
	client  *nodeClient
	log     *slog.Logger
	jobPoll time.Duration

	mu          sync.RWMutex
	state       persistedState
	runtime     map[string]nodeRuntime
	running     map[string]string
	wake        chan struct{}
	scheduleSem chan struct{}
	wg          sync.WaitGroup
	closeOnce   sync.Once
}

func newOrchestrator(parent context.Context, databasePath string, log *slog.Logger) (*orchestrator, error) {
	return newOrchestratorWithJobPoll(parent, databasePath, log, 2*time.Second)
}

func newOrchestratorWithJobPoll(parent context.Context, databasePath string, log *slog.Logger, jobPoll time.Duration) (*orchestrator, error) {
	store, state, err := openStateStore(databasePath)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(parent)
	o := &orchestrator{
		ctx:         ctx,
		cancel:      cancel,
		store:       store,
		client:      newNodeClient(10 * time.Second),
		log:         log,
		jobPoll:     jobPoll,
		state:       state,
		runtime:     make(map[string]nodeRuntime),
		running:     make(map[string]string),
		wake:        make(chan struct{}, 1),
		scheduleSem: make(chan struct{}, 12),
	}

	recoveries, changed, err := o.recoverableJobs()
	if err != nil {
		cancel()
		_ = store.Close()
		return nil, err
	}
	if changed {
		if err := store.Save(o.state); err != nil {
			cancel()
			_ = store.Close()
			return nil, fmt.Errorf("persist recovered queue state: %w", err)
		}
	}

	o.wg.Add(2)
	go o.pollLoop()
	go o.scheduleLoop()
	for _, recovery := range recoveries {
		o.log.Info("resuming compaction queue", "job", recovery.jobID, "nodes", len(recovery.nodes))
		o.wg.Add(1)
		go o.runJob(recovery.jobID, recovery.nodes)
	}
	return o, nil
}

type jobRecovery struct {
	jobID string
	nodes []nodeConfig
}

func (o *orchestrator) recoverableJobs() (recoveries []jobRecovery, changed bool, err error) {
	nodesByID := make(map[string]nodeConfig, len(o.state.Settings.Nodes))
	for _, node := range o.state.Settings.Nodes {
		nodesByID[node.ID] = node
	}
	for i := range o.state.Jobs {
		job := &o.state.Jobs[i]
		if job.State != "running" && job.State != "stopping" {
			continue
		}
		if existing := o.running[job.GroupID]; existing != "" {
			return nil, false, fmt.Errorf("cannot recover jobs %s and %s for the same disk group %s", existing, job.ID, job.GroupID)
		}
		nodes := make([]nodeConfig, 0, len(job.Nodes))
		for j := range job.Nodes {
			run := &job.Nodes[j]
			node, ok := nodesByID[run.NodeID]
			if !ok {
				return nil, false, fmt.Errorf("cannot recover job %s: node %s is missing from settings", job.ID, run.NodeID)
			}
			nodes = append(nodes, node)
			// Versions before queue recovery recorded a graceful shutdown as a node failure,
			// even though the node-side compaction kept running. Restore that unambiguous
			// marker before reconnecting to the persisted node job.
			if run.State == "failed" && run.Error == context.Canceled.Error() && run.NodeJobID != 0 && run.After == nil {
				run.State = "running"
				run.Error = ""
				run.FinishedAt = nil
				job.Current = run.NodeID
				changed = true
			}
		}
		o.running[job.GroupID] = job.ID
		recoveries = append(recoveries, jobRecovery{jobID: job.ID, nodes: nodes})
	}
	return recoveries, changed, nil
}

func (o *orchestrator) close() {
	o.closeOnce.Do(func() {
		o.cancel()
		o.wg.Wait()
		if err := o.store.Close(); err != nil {
			o.log.Error("close sqlite database", "error", err)
		}
	})
}

func (o *orchestrator) pollLoop() {
	defer o.wg.Done()
	for {
		o.pollAll()
		o.mu.RLock()
		seconds := o.state.Settings.PollIntervalSeconds
		o.mu.RUnlock()
		if seconds < 2 {
			seconds = 2
		}
		timer := time.NewTimer(time.Duration(seconds) * time.Second)
		select {
		case <-o.ctx.Done():
			timer.Stop()
			return
		case <-o.wake:
			timer.Stop()
		case <-timer.C:
		}
	}
}

func (o *orchestrator) pollAll() {
	o.mu.RLock()
	nodes := append([]nodeConfig(nil), o.state.Settings.Nodes...)
	o.mu.RUnlock()

	var wg sync.WaitGroup
	sem := make(chan struct{}, 32)
	for _, node := range nodes {
		if !node.Enabled {
			continue
		}
		node := node
		wg.Add(1)
		go func() {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-o.ctx.Done():
				return
			}
			defer func() { <-sem }()
			o.pollNode(o.ctx, node)
		}()
	}
	wg.Wait()
}

func (o *orchestrator) pollNodes(nodes []nodeConfig) map[string]nodeRuntime {
	type result struct {
		id      string
		runtime nodeRuntime
	}
	results := make(chan result, len(nodes))
	for _, node := range nodes {
		node := node
		go func() {
			results <- result{id: node.ID, runtime: o.pollNode(o.ctx, node)}
		}()
	}
	runtimes := make(map[string]nodeRuntime, len(nodes))
	for range nodes {
		item := <-results
		runtimes[item.id] = item.runtime
	}
	return runtimes
}

func (o *orchestrator) pollNode(ctx context.Context, node nodeConfig) nodeRuntime {
	info, latency, err := o.client.get(ctx, node)
	now := time.Now().UTC()
	o.mu.Lock()
	previous := o.runtime[node.ID]
	runtime := nodeRuntime{
		Online:      err == nil,
		LastChecked: now,
		LatencyMS:   latency.Milliseconds(),
		Info:        info,
	}
	if err != nil {
		runtime.Error = err.Error()
		runtime.Info = previous.Info
	}
	o.runtime[node.ID] = runtime
	o.mu.Unlock()
	return runtime
}

func (o *orchestrator) dashboard() dashboardResponse {
	history, err := o.store.HistoryStats()
	if err != nil {
		o.log.Error("load compaction history statistics", "error", err)
	}
	o.mu.RLock()
	defer o.mu.RUnlock()
	now := time.Now().UTC()

	result := dashboardResponse{
		GeneratedAt: now,
		Groups:      make([]dashboardGroup, 0, len(o.state.Settings.Groups)),
		Nodes:       make([]dashboardNode, 0, len(o.state.Settings.Nodes)),
		Jobs:        make([]jobRecord, 0),
		Schedules:   o.scheduleStatusesLocked(now),
		History:     history,
	}
	groupIDs := make(map[string]struct{}, len(o.state.Settings.Groups))
	activeNodeGroups := make(map[string]string)
	for _, group := range o.state.Settings.Groups {
		groupIDs[group.ID] = struct{}{}
		entry := dashboardGroup{diskGroup: group}
		if jobID := o.running[group.ID]; jobID != "" {
			if job := findJob(o.state.Jobs, jobID); job != nil {
				copyJob := cloneJob(*job)
				entry.RunningJob = &copyJob
				for _, run := range job.Nodes {
					activeNodeGroups[run.NodeID] = job.GroupID
				}
			}
		}
		result.Groups = append(result.Groups, entry)
	}
	for groupID, jobID := range o.running {
		if _, exists := groupIDs[groupID]; exists {
			continue
		}
		job := findJob(o.state.Jobs, jobID)
		if job == nil {
			continue
		}
		copyJob := cloneJob(*job)
		result.Groups = append(result.Groups, dashboardGroup{
			diskGroup:  diskGroup{ID: job.GroupID, Name: job.GroupName},
			RunningJob: &copyJob,
		})
		for _, run := range job.Nodes {
			activeNodeGroups[run.NodeID] = job.GroupID
		}
	}
	for _, node := range o.state.Settings.Nodes {
		if groupID, active := activeNodeGroups[node.ID]; active {
			node.GroupID = groupID
		}
		result.Nodes = append(result.Nodes, dashboardNode{
			publicNodeConfig: publicNode(node),
			Runtime:          o.runtime[node.ID],
		})
	}
	start := max(0, len(o.state.Jobs)-200)
	for i := len(o.state.Jobs) - 1; i >= start; i-- {
		result.Jobs = append(result.Jobs, cloneJob(o.state.Jobs[i]))
	}
	return result
}

func (o *orchestrator) publicSettings() publicSettings {
	o.mu.RLock()
	defer o.mu.RUnlock()
	result := publicSettings{
		PollIntervalSeconds: o.state.Settings.PollIntervalSeconds,
		Timezone:            o.state.Settings.Timezone,
		Groups:              append([]diskGroup{}, o.state.Settings.Groups...),
		Nodes:               make([]publicNodeConfig, 0, len(o.state.Settings.Nodes)),
		Schedules:           make([]scheduleRule, 0, len(o.state.Settings.Schedules)),
	}
	for _, node := range o.state.Settings.Nodes {
		result.Nodes = append(result.Nodes, publicNode(node))
	}
	for _, rule := range o.state.Settings.Schedules {
		result.Schedules = append(result.Schedules, cloneSchedule(rule))
	}
	return result
}

func publicNode(node nodeConfig) publicNodeConfig {
	return publicNodeConfig{
		ID:               node.ID,
		Name:             node.Name,
		URL:              node.URL,
		APIKeyConfigured: node.APIKey != "",
		GroupID:          node.GroupID,
		Enabled:          node.Enabled,
	}
}

func (o *orchestrator) updateSettings(input publicSettings) error {
	if input.PollIntervalSeconds < 2 || input.PollIntervalSeconds > 300 {
		return errors.New("poll interval must be between 2 and 300 seconds")
	}
	input.Timezone = strings.TrimSpace(input.Timezone)
	if input.Timezone == "" {
		input.Timezone = "UTC"
	}
	location, err := time.LoadLocation(input.Timezone)
	if err != nil {
		return fmt.Errorf("invalid IANA timezone %q", input.Timezone)
	}
	groups := make([]diskGroup, 0, len(input.Groups))
	groupIDs := make(map[string]struct{}, len(input.Groups))
	for _, group := range input.Groups {
		group.ID = strings.TrimSpace(group.ID)
		group.Name = strings.TrimSpace(group.Name)
		if group.ID == "" {
			group.ID = newID()
		}
		if !validID(group.ID) || group.Name == "" {
			return errors.New("every disk group needs a name and a valid ID")
		}
		if _, exists := groupIDs[group.ID]; exists {
			return fmt.Errorf("duplicate disk group ID %q", group.ID)
		}
		groupIDs[group.ID] = struct{}{}
		groups = append(groups, group)
	}

	o.mu.RLock()
	existing := make(map[string]nodeConfig, len(o.state.Settings.Nodes))
	for _, node := range o.state.Settings.Nodes {
		existing[node.ID] = node
	}
	o.mu.RUnlock()

	nodes := make([]nodeConfig, 0, len(input.Nodes))
	nodeIDs := make(map[string]struct{}, len(input.Nodes))
	nodeURLs := make(map[string]struct{}, len(input.Nodes))
	for _, public := range input.Nodes {
		public.ID = strings.TrimSpace(public.ID)
		if public.ID == "" {
			public.ID = newID()
		}
		if !validID(public.ID) {
			return fmt.Errorf("invalid node ID %q", public.ID)
		}
		if _, exists := nodeIDs[public.ID]; exists {
			return fmt.Errorf("duplicate node ID %q", public.ID)
		}
		nodeIDs[public.ID] = struct{}{}
		if _, ok := groupIDs[public.GroupID]; !ok {
			return fmt.Errorf("node %q is not assigned to an existing disk group", public.Name)
		}
		public.Name = strings.TrimSpace(public.Name)
		public.URL = strings.TrimRight(strings.TrimSpace(public.URL), "/")
		if public.Name == "" {
			return errors.New("every node needs a name")
		}
		if _, err := compactionEndpoint(public.URL, ""); err != nil {
			return fmt.Errorf("node %q: %w", public.Name, err)
		}
		if _, exists := nodeURLs[public.URL]; exists {
			return fmt.Errorf("node %q duplicates dashboard address %q", public.Name, public.URL)
		}
		nodeURLs[public.URL] = struct{}{}
		key := strings.TrimSpace(public.APIKey)
		if key == "" {
			key = existing[public.ID].APIKey
		}
		if err := validateAPIKey(key); err != nil {
			return fmt.Errorf("node %q: %w", public.Name, err)
		}
		nodes = append(nodes, nodeConfig{
			ID: public.ID, Name: public.Name, URL: public.URL, APIKey: key,
			GroupID: public.GroupID, Enabled: public.Enabled,
		})
	}

	schedules := make([]scheduleRule, 0, len(input.Schedules))
	scheduleIDs := make(map[string]struct{}, len(input.Schedules))
	for _, rule := range input.Schedules {
		rule.ID = strings.TrimSpace(rule.ID)
		if rule.ID == "" {
			rule.ID = newID()
		}
		if !validID(rule.ID) {
			return fmt.Errorf("invalid schedule ID %q", rule.ID)
		}
		if _, exists := scheduleIDs[rule.ID]; exists {
			return fmt.Errorf("duplicate schedule ID %q", rule.ID)
		}
		scheduleIDs[rule.ID] = struct{}{}
		rule.Name = strings.TrimSpace(rule.Name)
		if rule.Name == "" {
			return errors.New("every schedule needs a name")
		}
		switch rule.TargetType {
		case "group":
			if _, ok := groupIDs[rule.TargetID]; !ok {
				return fmt.Errorf("schedule %q references an unknown disk group", rule.Name)
			}
		case "node":
			if _, ok := nodeIDs[rule.TargetID]; !ok {
				return fmt.Errorf("schedule %q references an unknown node", rule.Name)
			}
		default:
			return fmt.Errorf("schedule %q has invalid target type %q", rule.Name, rule.TargetType)
		}
		switch rule.Mode {
		case scheduleModeWeekly:
			if _, err := time.Parse("15:04", rule.At); err != nil {
				return fmt.Errorf("schedule %q has invalid time %q", rule.Name, rule.At)
			}
			if len(rule.Days) == 0 {
				return fmt.Errorf("schedule %q needs at least one weekday", rule.Name)
			}
			days := make(map[int]struct{}, len(rule.Days))
			for _, day := range rule.Days {
				if day < 0 || day > 6 {
					return fmt.Errorf("schedule %q has invalid weekday %d", rule.Name, day)
				}
				days[day] = struct{}{}
			}
			rule.Days = rule.Days[:0]
			for day := 0; day <= 6; day++ {
				if _, ok := days[day]; ok {
					rule.Days = append(rule.Days, day)
				}
			}
			rule.StartAt = ""
			rule.Interval = 0
		case scheduleModeInterval:
			start, err := time.ParseInLocation(scheduleStartLayout, rule.StartAt, location)
			if err != nil || start.Format(scheduleStartLayout) != rule.StartAt {
				return fmt.Errorf("schedule %q has invalid interval start %q", rule.Name, rule.StartAt)
			}
			if rule.Interval < 1 || rule.Interval > 24*365 {
				return fmt.Errorf("schedule %q interval must be between 1 and 8760 hours", rule.Name)
			}
			rule.Days = nil
			rule.At = ""
		default:
			return fmt.Errorf("schedule %q has invalid mode %q", rule.Name, rule.Mode)
		}
		schedules = append(schedules, cloneSchedule(rule))
	}

	o.mu.Lock()
	defer o.mu.Unlock()
	for _, jobID := range o.running {
		job := findJob(o.state.Jobs, jobID)
		if job == nil {
			continue
		}
		for _, run := range job.Nodes {
			if _, ok := nodeIDs[run.NodeID]; !ok {
				return fmt.Errorf("node %q cannot be removed while an orchestration job still references it", run.NodeName)
			}
		}
	}
	proposed := o.state
	proposed.Settings = settings{
		PollIntervalSeconds: input.PollIntervalSeconds,
		Timezone:            input.Timezone,
		Groups:              groups,
		Nodes:               nodes,
		Schedules:           schedules,
	}
	proposed.ScheduleState = make(map[string]scheduleRunState, len(schedules))
	for _, rule := range schedules {
		if runState, ok := o.state.ScheduleState[rule.ID]; ok {
			proposed.ScheduleState[rule.ID] = runState
		}
	}
	if err := o.store.Save(proposed); err != nil {
		return err
	}
	o.state = proposed
	for id := range o.runtime {
		if _, ok := nodeIDs[id]; !ok {
			delete(o.runtime, id)
		}
	}
	select {
	case o.wake <- struct{}{}:
	default:
	}
	return nil
}

func validateAPIKey(key string) error {
	decoded, err := base64.URLEncoding.DecodeString(key)
	if err != nil || len(decoded) != 32 {
		return errors.New("multinode API key must be a padded URL-safe base64 value encoding 32 bytes")
	}
	return nil
}

func validID(id string) bool {
	if len(id) == 0 || len(id) > 80 {
		return false
	}
	for _, r := range id {
		if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') && (r < '0' || r > '9') && r != '-' && r != '_' {
			return false
		}
	}
	return true
}

func newID() string {
	var raw [8]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return fmt.Sprintf("id-%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(raw[:])
}

func (o *orchestrator) startGroup(groupID, onlyNodeID string) (jobRecord, error) {
	trigger := "manual"
	if onlyNodeID != "" {
		trigger = "manual-node"
	}
	return o.startGroupWithTrigger(groupID, onlyNodeID, trigger, "", "")
}

func (o *orchestrator) startGroupWithTrigger(groupID, onlyNodeID, trigger, scheduleID, scheduleDueKey string) (jobRecord, error) {
	if onlyNodeID != "" && trigger == "schedule" {
		trigger = "schedule-node"
	}
	o.mu.RLock()
	group, allNodes, err := o.groupNodesLocked(groupID, "")
	var nodes []nodeConfig
	if err == nil {
		if onlyNodeID == "" {
			nodes = allNodes
		} else {
			for _, node := range allNodes {
				if node.ID == onlyNodeID {
					nodes = append(nodes, node)
				}
			}
			if len(nodes) == 0 {
				err = errNotFound
			}
		}
		if err == nil {
			err = o.ensureNodesAvailableLocked(groupID, nodes)
		}
	}
	o.mu.RUnlock()
	if err != nil {
		return jobRecord{}, err
	}

	// A fresh preflight prevents this orchestrator from starting a second full compaction on the
	// same physical disk when a node was started elsewhere.
	runtimes := o.pollNodes(allNodes)
	for _, node := range allNodes {
		runtime := runtimes[node.ID]
		if !runtime.Online {
			return jobRecord{}, fmt.Errorf("%w: cannot verify node %q: %s", errConflict, node.Name, runtime.Error)
		}
		if runtime.Info != nil && runtime.Info.ManualJob.State == "running" {
			return jobRecord{}, fmt.Errorf("%w: node %q already has a manual full compaction running", errConflict, node.Name)
		}
		if runtime.Info != nil && runtime.Info.Compacting {
			return jobRecord{}, fmt.Errorf("%w: node %q is already compacting", errConflict, node.Name)
		}
	}

	o.mu.Lock()
	defer o.mu.Unlock()
	if err := o.ensureNodesAvailableLocked(groupID, nodes); err != nil {
		return jobRecord{}, err
	}
	job := jobRecord{
		ID:         newID(),
		GroupID:    group.ID,
		GroupName:  group.Name,
		State:      "running",
		StartedAt:  time.Now().UTC(),
		Trigger:    trigger,
		ScheduleID: scheduleID,
	}
	for _, node := range nodes {
		job.Nodes = append(job.Nodes, nodeRunRecord{NodeID: node.ID, NodeName: node.Name, State: "queued"})
	}
	previousJobs := append([]jobRecord(nil), o.state.Jobs...)
	previousScheduleState, hadScheduleState := o.state.ScheduleState[scheduleID]
	o.state.Jobs = append(o.state.Jobs, job)
	o.state.Jobs = trimLoadedJobs(o.state.Jobs, maxLoadedJobs)
	o.running[groupID] = job.ID
	if scheduleID != "" {
		started := job.StartedAt
		runState := o.state.ScheduleState[scheduleID]
		runState.LastDueKey = scheduleDueKey
		runState.LastStartedAt = &started
		runState.LastJobID = job.ID
		runState.LastError = ""
		o.state.ScheduleState[scheduleID] = runState
	}
	if err := o.persistLocked(); err != nil {
		delete(o.running, groupID)
		o.state.Jobs = previousJobs
		if scheduleID != "" {
			if hadScheduleState {
				o.state.ScheduleState[scheduleID] = previousScheduleState
			} else {
				delete(o.state.ScheduleState, scheduleID)
			}
		}
		return jobRecord{}, err
	}
	o.log.Info("compaction queue accepted", "job", job.ID, "group", group.Name, "nodes", len(nodes))
	o.wg.Add(1)
	go o.runJob(job.ID, nodes)
	return cloneJob(job), nil
}

func (o *orchestrator) ensureNodesAvailableLocked(groupID string, nodes []nodeConfig) error {
	if existing := o.running[groupID]; existing != "" {
		return fmt.Errorf("%w: disk group already has job %s", errConflict, existing)
	}
	wanted := make(map[string]string, len(nodes))
	for _, node := range nodes {
		wanted[node.ID] = node.Name
	}
	for _, jobID := range o.running {
		job := findJob(o.state.Jobs, jobID)
		if job == nil {
			continue
		}
		for _, run := range job.Nodes {
			if name, exists := wanted[run.NodeID]; exists {
				return fmt.Errorf("%w: node %q is already reserved by running job %s", errConflict, name, job.ID)
			}
		}
	}
	return nil
}

func (o *orchestrator) groupNodesLocked(groupID, onlyNodeID string) (diskGroup, []nodeConfig, error) {
	var group diskGroup
	for _, candidate := range o.state.Settings.Groups {
		if candidate.ID == groupID {
			group = candidate
			break
		}
	}
	if group.ID == "" {
		return group, nil, errNotFound
	}
	var nodes []nodeConfig
	for _, node := range o.state.Settings.Nodes {
		if node.GroupID == groupID && node.Enabled && (onlyNodeID == "" || node.ID == onlyNodeID) {
			nodes = append(nodes, node)
		}
	}
	if onlyNodeID != "" && len(nodes) == 0 {
		return group, nil, errNotFound
	}
	if len(nodes) == 0 {
		return group, nil, errors.New("disk group has no enabled nodes")
	}
	return group, nodes, nil
}

func (o *orchestrator) stopGroup(groupID string) (jobRecord, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	jobID := o.running[groupID]
	if jobID == "" {
		return jobRecord{}, errNotFound
	}
	job := findJob(o.state.Jobs, jobID)
	if job == nil {
		return jobRecord{}, errNotFound
	}
	previousState, previousStopAfter := job.State, job.StopAfter
	job.StopAfter = true
	job.State = "stopping"
	if err := o.persistLocked(); err != nil {
		job.State, job.StopAfter = previousState, previousStopAfter
		return jobRecord{}, err
	}
	return cloneJob(*job), nil
}

func (o *orchestrator) runJob(jobID string, nodes []nodeConfig) {
	defer o.wg.Done()
	failed := false
	stopped := false

nodeLoop:
	for _, node := range nodes {
		for {
			if o.ctx.Err() != nil {
				return
			}
			o.mu.Lock()
			job := findJob(o.state.Jobs, jobID)
			if job == nil {
				o.mu.Unlock()
				return
			}
			run := findNodeRun(job, node.ID)
			if run == nil {
				o.mu.Unlock()
				failed = true
				continue nodeLoop
			}
			runState := run.State
			expectedJobID := run.NodeJobID
			if job.StopAfter && runState != "running" && runState != "checking" {
				stopped = true
				o.mu.Unlock()
				break nodeLoop
			}
			switch runState {
			case "succeeded":
				o.mu.Unlock()
				continue nodeLoop
			case "failed", "canceled", "interrupted":
				failed = true
				o.mu.Unlock()
				continue nodeLoop
			case "skipped":
				stopped = true
				o.mu.Unlock()
				continue nodeLoop
			case "running", "checking":
				job.Current = node.ID
			case "queued":
				job.Current = node.ID
				run.State = "checking"
				now := time.Now().UTC()
				run.StartedAt = &now
				run.FinishedAt = nil
				run.Error = ""
			}
			if err := o.persistLocked(); err != nil {
				o.log.Error("persist node state", "job", jobID, "node", node.Name, "error", err)
			}
			o.mu.Unlock()

			switch runState {
			case "running":
				if expectedJobID == 0 {
					failed = true
					o.finishNodeRun(jobID, node.ID, "failed", "cannot resume node compaction without nodeJobId", nil)
					continue nodeLoop
				}
				nodeFailed, abort := o.finishRunningNode(jobID, node, expectedJobID)
				if abort {
					return
				}
				failed = failed || nodeFailed
				continue nodeLoop
			case "checking":
				expected, restart, nodeFailed, abort := o.reconcileCheckingNode(jobID, node)
				if abort {
					return
				}
				if nodeFailed {
					failed = true
					continue nodeLoop
				}
				if restart {
					continue
				}
				nodeFailed, abort = o.finishRunningNode(jobID, node, expected)
				if abort {
					return
				}
				failed = failed || nodeFailed
				continue nodeLoop
			}

			nodeFailed, abort := o.startNodeRun(jobID, node)
			if abort {
				return
			}
			failed = failed || nodeFailed
			continue nodeLoop
		}
	}

	if o.ctx.Err() != nil {
		return
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	job := findJob(o.state.Jobs, jobID)
	if job == nil {
		return
	}
	now := time.Now().UTC()
	job.FinishedAt = &now
	job.Current = ""
	switch {
	case stopped || job.StopAfter:
		job.State = "stopped"
		for i := range job.Nodes {
			if job.Nodes[i].State == "queued" {
				job.Nodes[i].State = "skipped"
				job.Nodes[i].Error = "queue stopped by operator"
			}
		}
	case failed:
		job.State = "failed"
	default:
		job.State = "succeeded"
	}
	delete(o.running, job.GroupID)
	if err := o.persistLocked(); err != nil {
		o.log.Error("persist finished job", "error", err)
	}
	o.log.Info("compaction queue finished", "job", job.ID, "group", job.GroupName, "state", job.State)
}

func (o *orchestrator) startNodeRun(jobID string, node nodeConfig) (failed, abort bool) {
	beforeRuntime := o.pollNode(o.ctx, node)
	if o.ctx.Err() != nil {
		return false, true
	}
	if !beforeRuntime.Online || beforeRuntime.Info == nil {
		o.finishNodeRun(jobID, node.ID, "failed", beforeRuntime.Error, nil)
		return true, false
	}
	if !beforeRuntime.Info.ManualLogCompactionEnabled {
		o.finishNodeRun(jobID, node.ID, "failed", "manual-log-compaction is disabled on the node", beforeRuntime.Info)
		return true, false
	}
	before := beforeRuntime.Info.RuntimeTotals
	beforeSalvage := beforeRuntime.Info.Salvage
	previousJobID := beforeRuntime.Info.ManualJob.ID
	o.mu.Lock()
	job := findJob(o.state.Jobs, jobID)
	if job == nil {
		o.mu.Unlock()
		return false, true
	}
	run := findNodeRun(job, node.ID)
	if run == nil {
		o.mu.Unlock()
		return true, false
	}
	run.Before = &before
	run.BeforeSalvage = &beforeSalvage
	run.PreviousJobID = &previousJobID
	if err := o.persistLocked(); err != nil {
		o.log.Error("persist node baseline", "job", jobID, "node", node.Name, "error", err)
	}
	o.mu.Unlock()

	startedJob, err := o.client.start(o.ctx, node)
	if err != nil {
		if o.ctx.Err() != nil {
			return false, true
		}
		resolved, resolveErr := o.resolveStart(node, previousJobID, err)
		if o.ctx.Err() != nil {
			return false, true
		}
		if resolveErr != nil {
			o.finishNodeRun(jobID, node.ID, "failed", resolveErr.Error(), resolved)
			return true, false
		}
		startedJob = &resolved.ManualJob
	}
	o.log.Info("node compaction started", "job", jobID, "node", node.Name, "node_job", startedJob.ID)
	o.mu.Lock()
	job = findJob(o.state.Jobs, jobID)
	if job == nil {
		o.mu.Unlock()
		return false, true
	}
	run = findNodeRun(job, node.ID)
	if run == nil {
		o.mu.Unlock()
		return true, false
	}
	run.State = "running"
	run.NodeJobID = startedJob.ID
	if err := o.persistLocked(); err != nil {
		o.log.Error("persist node start", "job", jobID, "node", node.Name, "error", err)
	}
	o.mu.Unlock()
	return o.finishRunningNode(jobID, node, startedJob.ID)
}

func (o *orchestrator) reconcileCheckingNode(jobID string, node nodeConfig) (expected uint64, restart, failed, abort bool) {
	for {
		if o.ctx.Err() != nil {
			return 0, false, false, true
		}
		runtime := o.pollNode(o.ctx, node)
		if o.ctx.Err() != nil {
			return 0, false, false, true
		}
		if !runtime.Online || runtime.Info == nil {
			if !o.waitJobPoll() {
				return 0, false, false, true
			}
			continue
		}

		o.mu.Lock()
		job := findJob(o.state.Jobs, jobID)
		if job == nil {
			o.mu.Unlock()
			return 0, false, false, true
		}
		run := findNodeRun(job, node.ID)
		if run == nil {
			o.mu.Unlock()
			return 0, false, true, false
		}
		previous := run.PreviousJobID
		if previous == nil {
			run.State = "queued"
			job.Current = ""
			if err := o.persistLocked(); err != nil {
				o.log.Error("persist recovered node check", "job", jobID, "node", node.Name, "error", err)
			}
			o.mu.Unlock()
			return 0, true, false, false
		}
		currentJob := runtime.Info.ManualJob
		switch {
		case currentJob.ID == *previous && currentJob.State != "running":
			run.State = "queued"
			job.Current = ""
			if err := o.persistLocked(); err != nil {
				o.log.Error("persist recovered node retry", "job", jobID, "node", node.Name, "error", err)
			}
			o.mu.Unlock()
			return 0, true, false, false
		case currentJob.ID > *previous:
			run.State = "running"
			run.NodeJobID = currentJob.ID
			if err := o.persistLocked(); err != nil {
				o.log.Error("persist recovered node job", "job", jobID, "node", node.Name, "error", err)
			}
			o.mu.Unlock()
			return currentJob.ID, false, false, false
		default:
			o.mu.Unlock()
			finalInfo := runtime.Info
			if currentJob.State == "running" {
				waited, _ := o.waitNodeJob(node, currentJob.ID)
				if o.ctx.Err() != nil {
					return 0, false, false, true
				}
				if waited != nil {
					finalInfo = waited
				}
			}
			o.finishNodeRun(jobID, node.ID, "failed", fmt.Sprintf("cannot reconcile node job %d after previous job %d", currentJob.ID, *previous), finalInfo)
			return 0, false, true, false
		}
	}
}

func (o *orchestrator) finishRunningNode(jobID string, node nodeConfig, expectedJobID uint64) (failed, abort bool) {
	finalInfo, err := o.waitNodeJob(node, expectedJobID)
	if o.ctx.Err() != nil {
		return false, true
	}
	if err != nil {
		o.finishNodeRun(jobID, node.ID, "failed", err.Error(), finalInfo)
		return true, false
	}
	state := finalInfo.ManualJob.State
	o.finishNodeRun(jobID, node.ID, state, nodeJobError(finalInfo.ManualJob), finalInfo)
	return state != "succeeded", false
}

func (o *orchestrator) waitJobPoll() bool {
	timer := time.NewTimer(o.jobPoll)
	defer timer.Stop()
	select {
	case <-o.ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

// resolveStart handles the ambiguous case where the request may have reached the node even though
// its response did not reach us. The disk queue cannot advance until the node is reachable and a
// newer node-side job has either been found or ruled out.
func (o *orchestrator) resolveStart(node nodeConfig, previousJobID uint64, startErr error) (*compactionInfo, error) {
	var apiErr *nodeAPIError
	if errors.As(startErr, &apiErr) && apiErr.StatusCode != 409 {
		return nil, startErr
	}
	for {
		if o.ctx.Err() != nil {
			return nil, o.ctx.Err()
		}
		runtime := o.pollNode(o.ctx, node)
		if !runtime.Online || runtime.Info == nil {
			select {
			case <-o.ctx.Done():
				return nil, o.ctx.Err()
			case <-time.After(o.jobPoll):
			}
			continue
		}
		job := runtime.Info.ManualJob
		if job.ID > previousJobID || job.State == "running" {
			return runtime.Info, nil
		}
		return runtime.Info, startErr
	}
}

func (o *orchestrator) waitNodeJob(node nodeConfig, expectedID uint64) (*compactionInfo, error) {
	for {
		if o.ctx.Err() != nil {
			return nil, o.ctx.Err()
		}
		runtime := o.pollNode(o.ctx, node)
		if !runtime.Online || runtime.Info == nil {
			// Never advance to the next node merely because the current node became unreachable.
			if !o.waitJobPoll() {
				return nil, o.ctx.Err()
			}
			continue
		}
		job := runtime.Info.ManualJob
		if job.ID != expectedID {
			if job.State == "running" {
				// A different job is active. Wait until it is terminal, but do not attribute its
				// counters or result to the queue being recovered.
				if !o.waitJobPoll() {
					return nil, o.ctx.Err()
				}
				continue
			}
			return runtime.Info, fmt.Errorf("node job changed from %d to %d (state %s)", expectedID, job.ID, job.State)
		}
		if job.State != "running" {
			return runtime.Info, nil
		}
		if !o.waitJobPoll() {
			return nil, o.ctx.Err()
		}
	}
}

func (o *orchestrator) finishNodeRun(jobID, nodeID, state, errMessage string, info *compactionInfo) {
	o.mu.Lock()
	defer o.mu.Unlock()
	job := findJob(o.state.Jobs, jobID)
	if job == nil {
		return
	}
	run := findNodeRun(job, nodeID)
	if run == nil {
		return
	}
	now := time.Now().UTC()
	run.State = state
	run.Error = errMessage
	run.FinishedAt = &now
	if info != nil {
		after := info.RuntimeTotals
		run.After = &after
		if run.Before != nil {
			run.Reclaimed = nonnegativeDelta(after.DataReclaimedBytes, run.Before.DataReclaimedBytes)
			run.Rewritten = nonnegativeDelta(after.DataRewrittenBytes, run.Before.DataRewrittenBytes)
		}
		if run.BeforeSalvage != nil {
			run.LostPieces = nonnegativeDeltaU64(info.Salvage.LostPieces, run.BeforeSalvage.LostPieces)
			run.LostBytes = nonnegativeDeltaU64(info.Salvage.LostBytes, run.BeforeSalvage.LostBytes)
		}
	}
	job.Current = ""
	if err := o.persistLocked(); err != nil {
		o.log.Error("persist node result", "error", err)
	}
	o.log.Info("node compaction finished", "job", jobID, "node", run.NodeName, "state", state,
		"reclaimed_bytes", run.Reclaimed, "rewritten_bytes", run.Rewritten, "error", errMessage)
}

func nodeJobError(job manualCompactionJob) string {
	var messages []string
	for _, result := range job.Results {
		if result.Error != "" {
			messages = append(messages, result.SatelliteID+": "+result.Error)
		}
	}
	return strings.Join(messages, "; ")
}

func nonnegativeDelta(after, before int64) int64 {
	if after < before {
		return 0
	}
	return after - before
}

func nonnegativeDeltaU64(after, before uint64) uint64 {
	if after < before {
		return 0
	}
	return after - before
}

func findJob(jobs []jobRecord, id string) *jobRecord {
	for i := range jobs {
		if jobs[i].ID == id {
			return &jobs[i]
		}
	}
	return nil
}

func findNodeRun(job *jobRecord, nodeID string) *nodeRunRecord {
	for i := range job.Nodes {
		if job.Nodes[i].NodeID == nodeID {
			return &job.Nodes[i]
		}
	}
	return nil
}

func cloneJob(job jobRecord) jobRecord {
	job.Nodes = append([]nodeRunRecord(nil), job.Nodes...)
	return job
}

func trimLoadedJobs(jobs []jobRecord, limit int) []jobRecord {
	if len(jobs) <= limit {
		return jobs
	}
	cutoff := len(jobs) - limit
	trimmed := make([]jobRecord, 0, limit+len(jobs)/10)
	for _, job := range jobs[:cutoff] {
		if job.State == "running" || job.State == "stopping" {
			trimmed = append(trimmed, job)
		}
	}
	return append(trimmed, jobs[cutoff:]...)
}

func (o *orchestrator) persistLocked() error {
	return o.store.Save(o.state)
}

func (o *orchestrator) nodeByID(id string) (nodeConfig, error) {
	o.mu.RLock()
	defer o.mu.RUnlock()
	for _, node := range o.state.Settings.Nodes {
		if node.ID == id {
			return node, nil
		}
	}
	return nodeConfig{}, errNotFound
}

func (o *orchestrator) testNode(id string) (nodeRuntime, error) {
	node, err := o.nodeByID(id)
	if err != nil {
		return nodeRuntime{}, err
	}
	return o.pollNode(o.ctx, node), nil
}

func (o *orchestrator) startSingleNode(nodeID string) (jobRecord, error) {
	node, err := o.nodeByID(nodeID)
	if err != nil {
		return jobRecord{}, err
	}
	return o.startGroup(node.GroupID, nodeID)
}

func sortDashboard(data *dashboardResponse) {
	slices.SortFunc(data.Groups, func(a, b dashboardGroup) int { return strings.Compare(a.Name, b.Name) })
}
