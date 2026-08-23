package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func testKey() string {
	raw := make([]byte, 32)
	for i := range raw {
		raw[i] = byte(i + 1)
	}
	return base64.URLEncoding.EncodeToString(raw)
}

type activeTracker struct {
	active atomic.Int64
	max    atomic.Int64
}

func (t *activeTracker) begin() {
	active := t.active.Add(1)
	for {
		maximum := t.max.Load()
		if active <= maximum || t.max.CompareAndSwap(maximum, active) {
			break
		}
	}
}

func (t *activeTracker) end() { t.active.Add(-1) }

type mockNode struct {
	server  *httptest.Server
	tracker *activeTracker
	delay   time.Duration
	starts  atomic.Int64

	mu        sync.Mutex
	running   bool
	jobID     uint64
	startedAt time.Time
	totals    compactionTotals
}

func newMockNode(t *testing.T, tracker *activeTracker, delay time.Duration) *mockNode {
	t.Helper()
	node := &mockNode{tracker: tracker, delay: delay}
	node.server = httptest.NewServer(http.HandlerFunc(node.serveHTTP))
	t.Cleanup(node.server.Close)
	return node
}

func (n *mockNode) serveHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/api/sno/compaction":
		n.mu.Lock()
		info := compactionInfo{
			Compacting:                 n.running,
			ManualLogCompactionEnabled: true,
			ManualJob: manualCompactionJob{
				ID: n.jobID, State: "idle", TotalSatellites: 1,
			},
			RuntimeTotals: n.totals,
			Satellites:    []satelliteCompaction{},
		}
		if n.running {
			started := n.startedAt
			info.ManualJob.State = "running"
			info.ManualJob.StartedAt = &started
		} else if n.jobID > 0 {
			info.ManualJob.State = "succeeded"
		}
		n.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(info)
	case r.Method == http.MethodPost && r.URL.Path == "/api/sno/compaction/start":
		if r.Header.Get("Authorization") != "Bearer "+testKey() {
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(nodeAPIError{Code: "unauthorized", Message: "bad key"})
			return
		}
		n.mu.Lock()
		if n.running {
			n.mu.Unlock()
			w.WriteHeader(http.StatusConflict)
			_ = json.NewEncoder(w).Encode(nodeAPIError{Code: "manual_compaction_running", Message: "running"})
			return
		}
		n.running = true
		n.jobID++
		n.startedAt = time.Now().UTC()
		jobID := n.jobID
		started := n.startedAt
		n.mu.Unlock()
		n.starts.Add(1)
		n.tracker.begin()
		go func() {
			time.Sleep(n.delay)
			n.mu.Lock()
			n.running = false
			n.totals.FinishedAttempts++
			n.totals.DataReclaimedBytes += 1000
			n.totals.DataRewrittenBytes += 2000
			n.mu.Unlock()
			n.tracker.end()
		}()
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(startCompactionResponse{ManualJob: manualCompactionJob{
			ID: jobID, State: "running", StartedAt: &started, TotalSatellites: 1,
		}})
	default:
		http.NotFound(w, r)
	}
}

func newTestOrchestrator(t *testing.T) *orchestrator {
	t.Helper()
	return newTestOrchestratorAt(t, t.TempDir()+"/orchestrator.db")
}

func newTestOrchestratorAt(t *testing.T, statePath string) *orchestrator {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	o, err := newOrchestratorWithJobPoll(context.Background(), statePath, log, 5*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(o.close)
	return o
}

func TestSettingsRedactAndPreserveAPIKey(t *testing.T) {
	o := newTestOrchestrator(t)
	input := publicSettings{
		PollIntervalSeconds: 10,
		Groups:              []diskGroup{{ID: "disk-a", Name: "Disk A"}},
		Nodes: []publicNodeConfig{{
			ID: "node-a", Name: "Node A", URL: "http://127.0.0.1:14002",
			APIKey: testKey(), GroupID: "disk-a", Enabled: true,
		}},
	}
	if err := o.updateSettings(input); err != nil {
		t.Fatal(err)
	}
	public := o.publicSettings()
	if public.Nodes[0].APIKey != "" || !public.Nodes[0].APIKeyConfigured {
		t.Fatalf("key leaked or missing configured marker: %+v", public.Nodes[0])
	}
	if err := o.updateSettings(public); err != nil {
		t.Fatal(err)
	}
	o.mu.RLock()
	stored := o.state.Settings.Nodes[0].APIKey
	o.mu.RUnlock()
	if stored != testKey() {
		t.Fatal("blank update did not preserve the stored key")
	}
}

func TestDatabaseFilePermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows does not expose Unix file permission bits")
	}

	dir := t.TempDir() + "/private"
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	o, err := newOrchestrator(context.Background(), dir+"/orchestrator.db", log)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(o.close)
	if err := o.updateSettings(publicSettings{PollIntervalSeconds: 10}); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(dir + "/orchestrator.db")
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("state mode is %o, expected 0600", info.Mode().Perm())
	}
	dirInfo, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if dirInfo.Mode().Perm() != 0700 {
		t.Fatalf("state directory mode is %o, expected 0700", dirInfo.Mode().Perm())
	}
}

func TestDiskGroupRunsNodesSequentially(t *testing.T) {
	tracker := &activeTracker{}
	nodeA := newMockNode(t, tracker, 35*time.Millisecond)
	nodeB := newMockNode(t, tracker, 35*time.Millisecond)
	o := newTestOrchestrator(t)
	if err := o.updateSettings(publicSettings{
		PollIntervalSeconds: 10,
		Groups:              []diskGroup{{ID: "disk-a", Name: "Disk A"}},
		Nodes: []publicNodeConfig{
			{ID: "node-a", Name: "Node A", URL: nodeA.server.URL, APIKey: testKey(), GroupID: "disk-a", Enabled: true},
			{ID: "node-b", Name: "Node B", URL: nodeB.server.URL, APIKey: testKey(), GroupID: "disk-a", Enabled: true},
		},
	}); err != nil {
		t.Fatal(err)
	}
	job, err := o.startGroup("disk-a", "")
	if err != nil {
		t.Fatal(err)
	}
	finished := waitForJob(t, o, job.ID)
	if finished.State != "succeeded" {
		t.Fatalf("unexpected job state: %+v", finished)
	}
	if tracker.max.Load() != 1 {
		t.Fatalf("full compactions overlapped on one disk: max active=%d", tracker.max.Load())
	}
	if nodeA.starts.Load() != 1 || nodeB.starts.Load() != 1 {
		t.Fatalf("unexpected starts: A=%d B=%d", nodeA.starts.Load(), nodeB.starts.Load())
	}
	if finished.Nodes[0].Reclaimed != 1000 || finished.Nodes[1].Rewritten != 2000 {
		t.Fatalf("runtime counter deltas were not recorded: %+v", finished.Nodes)
	}
}

func TestRunningQueueResumesAfterOrchestratorRestart(t *testing.T) {
	tracker := &activeTracker{}
	nodeA := newMockNode(t, tracker, 120*time.Millisecond)
	nodeB := newMockNode(t, tracker, 30*time.Millisecond)
	statePath := t.TempDir() + "/orchestrator.db"
	o1 := newTestOrchestratorAt(t, statePath)
	if err := o1.updateSettings(publicSettings{
		PollIntervalSeconds: 10,
		Groups:              []diskGroup{{ID: "disk-a", Name: "Disk A"}},
		Nodes: []publicNodeConfig{
			{ID: "node-a", Name: "Node A", URL: nodeA.server.URL, APIKey: testKey(), GroupID: "disk-a", Enabled: true},
			{ID: "node-b", Name: "Node B", URL: nodeB.server.URL, APIKey: testKey(), GroupID: "disk-a", Enabled: true},
		},
	}); err != nil {
		t.Fatal(err)
	}
	job, err := o1.startGroup("disk-a", "")
	if err != nil {
		t.Fatal(err)
	}
	waitForStarts(t, nodeA, 1)
	o1.close()

	store, persisted, err := openStateStore(statePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	interrupted := findJob(persisted.Jobs, job.ID)
	if interrupted == nil || interrupted.State != "running" || (interrupted.Nodes[0].State != "running" && interrupted.Nodes[0].State != "checking") {
		t.Fatalf("shutdown did not preserve recoverable queue state: %+v", interrupted)
	}
	if interrupted.Nodes[0].State == "checking" && interrupted.Nodes[0].PreviousJobID == nil {
		t.Fatalf("ambiguous accepted request was not recoverable: %+v", interrupted.Nodes[0])
	}

	o2 := newTestOrchestratorAt(t, statePath)
	finished := waitForJob(t, o2, job.ID)
	if finished.State != "succeeded" {
		t.Fatalf("recovered queue did not succeed: %+v", finished)
	}
	if nodeA.starts.Load() != 1 || nodeB.starts.Load() != 1 {
		t.Fatalf("recovery duplicated or skipped starts: A=%d B=%d", nodeA.starts.Load(), nodeB.starts.Load())
	}
	if tracker.max.Load() != 1 {
		t.Fatalf("recovered queue overlapped disk work: max active=%d", tracker.max.Load())
	}
	if finished.Nodes[0].Reclaimed != 1000 || finished.Nodes[0].Rewritten != 2000 {
		t.Fatalf("recovered node counter deltas were not recorded: %+v", finished.Nodes[0])
	}
}

func TestRecoveredQueueDoesNotAdvanceWhileCurrentNodeIsUnavailable(t *testing.T) {
	tracker := &activeTracker{}
	nodeA := newMockNode(t, tracker, 300*time.Millisecond)
	nodeB := newMockNode(t, tracker, 20*time.Millisecond)
	statePath := t.TempDir() + "/orchestrator.db"
	o1 := newTestOrchestratorAt(t, statePath)
	if err := o1.updateSettings(publicSettings{
		PollIntervalSeconds: 10,
		Groups:              []diskGroup{{ID: "disk-a", Name: "Disk A"}},
		Nodes: []publicNodeConfig{
			{ID: "node-a", Name: "Node A", URL: nodeA.server.URL, APIKey: testKey(), GroupID: "disk-a", Enabled: true},
			{ID: "node-b", Name: "Node B", URL: nodeB.server.URL, APIKey: testKey(), GroupID: "disk-a", Enabled: true},
		},
	}); err != nil {
		t.Fatal(err)
	}
	job, err := o1.startGroup("disk-a", "")
	if err != nil {
		t.Fatal(err)
	}
	waitForStarts(t, nodeA, 1)
	o1.close()
	nodeA.server.Close()

	o2 := newTestOrchestratorAt(t, statePath)
	time.Sleep(50 * time.Millisecond)
	o2.mu.RLock()
	recovered := findJob(o2.state.Jobs, job.ID)
	state := recovered.State
	runningID := o2.running["disk-a"]
	o2.mu.RUnlock()
	if state != "running" || runningID != job.ID {
		t.Fatalf("unavailable current node released recovered disk queue: state=%s running=%s", state, runningID)
	}
	if nodeB.starts.Load() != 0 {
		t.Fatalf("next node started while recovered current node was unavailable: %d", nodeB.starts.Load())
	}
}

func TestCheckingNodeRecoveryAdoptsAcceptedNodeJob(t *testing.T) {
	tracker := &activeTracker{}
	nodeA := newMockNode(t, tracker, 100*time.Millisecond)
	nodeB := newMockNode(t, tracker, 20*time.Millisecond)
	statePath := t.TempDir() + "/orchestrator.db"
	configA := nodeConfig{ID: "node-a", Name: "Node A", URL: nodeA.server.URL, APIKey: testKey(), GroupID: "disk-a", Enabled: true}
	configB := nodeConfig{ID: "node-b", Name: "Node B", URL: nodeB.server.URL, APIKey: testKey(), GroupID: "disk-a", Enabled: true}
	started, err := newNodeClient(time.Second).start(context.Background(), configA)
	if err != nil {
		t.Fatal(err)
	}
	previousJobID := uint64(0)
	now := time.Now().UTC()
	state := persistedState{
		Settings: settings{
			PollIntervalSeconds: 10,
			Timezone:            "UTC",
			Groups:              []diskGroup{{ID: "disk-a", Name: "Disk A"}},
			Nodes:               []nodeConfig{configA, configB},
		},
		Jobs: []jobRecord{{
			ID: "recover-checking", GroupID: "disk-a", GroupName: "Disk A", State: "running", StartedAt: now, Current: "node-a",
			Nodes: []nodeRunRecord{
				{NodeID: "node-a", NodeName: "Node A", State: "checking", StartedAt: &now, PreviousJobID: &previousJobID, Before: &compactionTotals{}},
				{NodeID: "node-b", NodeName: "Node B", State: "queued"},
			},
		}},
		ScheduleState: map[string]scheduleRunState{},
	}
	if err := writeTestState(statePath, state); err != nil {
		t.Fatal(err)
	}

	o := newTestOrchestratorAt(t, statePath)
	finished := waitForJob(t, o, "recover-checking")
	if finished.State != "succeeded" {
		t.Fatalf("checking recovery did not succeed: %+v", finished)
	}
	if finished.Nodes[0].NodeJobID != started.ID || nodeA.starts.Load() != 1 || nodeB.starts.Load() != 1 {
		t.Fatalf("accepted node job was not adopted safely: job=%+v starts A=%d B=%d", finished.Nodes[0], nodeA.starts.Load(), nodeB.starts.Load())
	}
	if tracker.max.Load() != 1 {
		t.Fatalf("checking recovery overlapped disk work: max active=%d", tracker.max.Load())
	}
}

func TestRecoveryRestoresLegacyContextCanceledNode(t *testing.T) {
	tracker := &activeTracker{}
	nodeA := newMockNode(t, tracker, 100*time.Millisecond)
	nodeB := newMockNode(t, tracker, 20*time.Millisecond)
	statePath := t.TempDir() + "/orchestrator.db"
	configA := nodeConfig{ID: "node-a", Name: "Node A", URL: nodeA.server.URL, APIKey: testKey(), GroupID: "disk-a", Enabled: true}
	configB := nodeConfig{ID: "node-b", Name: "Node B", URL: nodeB.server.URL, APIKey: testKey(), GroupID: "disk-a", Enabled: true}
	started, err := newNodeClient(time.Second).start(context.Background(), configA)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	finishedAt := now.Add(time.Millisecond)
	state := persistedState{
		Settings: settings{
			PollIntervalSeconds: 10,
			Timezone:            "UTC",
			Groups:              []diskGroup{{ID: "disk-a", Name: "Disk A"}},
			Nodes:               []nodeConfig{configA, configB},
		},
		Jobs: []jobRecord{{
			ID: "legacy-shutdown", GroupID: "disk-a", GroupName: "Disk A", State: "running", StartedAt: now,
			Nodes: []nodeRunRecord{
				{NodeID: "node-a", NodeName: "Node A", State: "failed", StartedAt: &now, FinishedAt: &finishedAt, NodeJobID: started.ID, Error: context.Canceled.Error(), Before: &compactionTotals{}},
				{NodeID: "node-b", NodeName: "Node B", State: "queued"},
			},
		}},
		ScheduleState: map[string]scheduleRunState{},
	}
	if err := writeTestState(statePath, state); err != nil {
		t.Fatal(err)
	}

	o := newTestOrchestratorAt(t, statePath)
	finished := waitForJob(t, o, "legacy-shutdown")
	if finished.State != "succeeded" {
		t.Fatalf("legacy queue did not recover: %+v", finished)
	}
	if nodeA.starts.Load() != 1 || nodeB.starts.Load() != 1 || tracker.max.Load() != 1 {
		t.Fatalf("legacy recovery was unsafe: starts A=%d B=%d max=%d", nodeA.starts.Load(), nodeB.starts.Load(), tracker.max.Load())
	}
	if finished.Nodes[0].Reclaimed != 1000 || finished.Nodes[0].Rewritten != 2000 {
		t.Fatalf("legacy recovered counters are wrong: %+v", finished.Nodes[0])
	}
}

func TestSingleNodeStartChecksEveryNodeOnDisk(t *testing.T) {
	tracker := &activeTracker{}
	nodeA := newMockNode(t, tracker, 20*time.Millisecond)
	nodeB := newMockNode(t, tracker, 20*time.Millisecond)
	o := newTestOrchestrator(t)
	if err := o.updateSettings(publicSettings{
		PollIntervalSeconds: 10,
		Groups:              []diskGroup{{ID: "disk-a", Name: "Disk A"}},
		Nodes: []publicNodeConfig{
			{ID: "node-a", Name: "Node A", URL: nodeA.server.URL, APIKey: testKey(), GroupID: "disk-a", Enabled: true},
			{ID: "node-b", Name: "Node B", URL: nodeB.server.URL, APIKey: testKey(), GroupID: "disk-a", Enabled: true},
		},
	}); err != nil {
		t.Fatal(err)
	}
	nodeB.server.Close()
	if _, err := o.startSingleNode("node-a"); !errors.Is(err, errConflict) {
		t.Fatalf("expected fail-closed preflight conflict, got %v", err)
	}
	if nodeA.starts.Load() != 0 {
		t.Fatal("node started despite an unverifiable peer on the same disk")
	}
}

func TestDifferentDiskGroupsCanRunInParallel(t *testing.T) {
	tracker := &activeTracker{}
	nodeA := newMockNode(t, tracker, 80*time.Millisecond)
	nodeB := newMockNode(t, tracker, 80*time.Millisecond)
	o := newTestOrchestrator(t)
	if err := o.updateSettings(publicSettings{
		PollIntervalSeconds: 10,
		Groups: []diskGroup{
			{ID: "disk-a", Name: "Disk A"},
			{ID: "disk-b", Name: "Disk B"},
		},
		Nodes: []publicNodeConfig{
			{ID: "node-a", Name: "Node A", URL: nodeA.server.URL, APIKey: testKey(), GroupID: "disk-a", Enabled: true},
			{ID: "node-b", Name: "Node B", URL: nodeB.server.URL, APIKey: testKey(), GroupID: "disk-b", Enabled: true},
		},
	}); err != nil {
		t.Fatal(err)
	}
	jobA, err := o.startGroup("disk-a", "")
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for nodeA.starts.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	jobB, err := o.startGroup("disk-b", "")
	if err != nil {
		t.Fatal(err)
	}
	waitForJob(t, o, jobA.ID)
	waitForJob(t, o, jobB.ID)
	if tracker.max.Load() != 2 {
		t.Fatalf("different disks did not run independently: max active=%d", tracker.max.Load())
	}
}

func TestScheduledGroupStartsOnceForOccurrence(t *testing.T) {
	tracker := &activeTracker{}
	node := newMockNode(t, tracker, 20*time.Millisecond)
	o := newTestOrchestrator(t)
	fixed := time.Date(2026, time.August, 24, 12, 0, 0, 0, time.UTC)
	if err := o.updateSettings(publicSettings{
		PollIntervalSeconds: 10,
		Timezone:            "UTC",
		Groups:              []diskGroup{{ID: "disk-a", Name: "Disk A"}},
		Nodes: []publicNodeConfig{{
			ID: "node-a", Name: "Node A", URL: node.server.URL,
			APIKey: testKey(), GroupID: "disk-a", Enabled: true,
		}},
		Schedules: []scheduleRule{{
			ID: "nightly", Name: "Nightly", Enabled: true, TargetType: "group",
			TargetID: "disk-a", Days: []int{int(fixed.Weekday())}, At: "11:00",
		}},
	}); err != nil {
		t.Fatal(err)
	}

	o.processSchedules(fixed)
	job := waitForStartedJob(t, o)
	if job.Trigger != "schedule" || job.ScheduleID != "nightly" {
		t.Fatalf("scheduled job metadata is missing: %+v", job)
	}
	waitForJob(t, o, job.ID)
	o.processSchedules(fixed.Add(2 * time.Hour))
	time.Sleep(20 * time.Millisecond)
	if node.starts.Load() != 1 {
		t.Fatalf("same schedule occurrence started %d times", node.starts.Load())
	}
	o.mu.RLock()
	lastDue := o.state.ScheduleState["nightly"].LastDueKey
	o.mu.RUnlock()
	if lastDue != "2026-08-24|11:00" {
		t.Fatalf("unexpected persisted occurrence key %q", lastDue)
	}
}

func TestScheduledNodeRunsOnlyTargetAndChecksDiskPeers(t *testing.T) {
	tracker := &activeTracker{}
	nodeA := newMockNode(t, tracker, 20*time.Millisecond)
	nodeB := newMockNode(t, tracker, 20*time.Millisecond)
	o := newTestOrchestrator(t)
	fixed := time.Date(2026, time.August, 24, 12, 0, 0, 0, time.UTC)
	if err := o.updateSettings(publicSettings{
		PollIntervalSeconds: 10,
		Timezone:            "UTC",
		Groups:              []diskGroup{{ID: "disk-a", Name: "Disk A"}},
		Nodes: []publicNodeConfig{
			{ID: "node-a", Name: "Node A", URL: nodeA.server.URL, APIKey: testKey(), GroupID: "disk-a", Enabled: true},
			{ID: "node-b", Name: "Node B", URL: nodeB.server.URL, APIKey: testKey(), GroupID: "disk-a", Enabled: true},
		},
		Schedules: []scheduleRule{{
			ID: "one-node", Name: "One node", Enabled: true, TargetType: "node",
			TargetID: "node-b", Days: []int{int(fixed.Weekday())}, At: "11:00",
		}},
	}); err != nil {
		t.Fatal(err)
	}
	o.processSchedules(fixed)
	job := waitForStartedJob(t, o)
	finished := waitForJob(t, o, job.ID)
	if len(finished.Nodes) != 1 || finished.Nodes[0].NodeID != "node-b" {
		t.Fatalf("unexpected scheduled node queue: %+v", finished.Nodes)
	}
	if nodeA.starts.Load() != 0 || nodeB.starts.Load() != 1 {
		t.Fatalf("unexpected starts: A=%d B=%d", nodeA.starts.Load(), nodeB.starts.Load())
	}
}

func TestScheduledNodeIsNotConsumedWhenDiskPeerIsUnavailable(t *testing.T) {
	tracker := &activeTracker{}
	nodeA := newMockNode(t, tracker, 20*time.Millisecond)
	nodeB := newMockNode(t, tracker, 20*time.Millisecond)
	o := newTestOrchestrator(t)
	fixed := time.Date(2026, time.August, 24, 12, 0, 0, 0, time.UTC)
	if err := o.updateSettings(publicSettings{
		PollIntervalSeconds: 10,
		Timezone:            "UTC",
		Groups:              []diskGroup{{ID: "disk-a", Name: "Disk A"}},
		Nodes: []publicNodeConfig{
			{ID: "node-a", Name: "Node A", URL: nodeA.server.URL, APIKey: testKey(), GroupID: "disk-a", Enabled: true},
			{ID: "node-b", Name: "Node B", URL: nodeB.server.URL, APIKey: testKey(), GroupID: "disk-a", Enabled: true},
		},
		Schedules: []scheduleRule{{
			ID: "blocked", Name: "Blocked", Enabled: true, TargetType: "node",
			TargetID: "node-a", Days: []int{int(fixed.Weekday())}, At: "11:00",
		}},
	}); err != nil {
		t.Fatal(err)
	}
	nodeB.server.Close()
	o.processSchedules(fixed)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		o.mu.RLock()
		runState := o.state.ScheduleState["blocked"]
		o.mu.RUnlock()
		if runState.LastError != "" {
			if runState.LastDueKey != "" {
				t.Fatalf("failed occurrence was consumed: %+v", runState)
			}
			if nodeA.starts.Load() != 0 {
				t.Fatal("target node started despite an unverifiable disk peer")
			}
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("timed out waiting for deferred schedule result")
}

func TestScheduleOccurrenceUsesConfiguredTimezone(t *testing.T) {
	location, err := time.LoadLocation("Europe/Moscow")
	if err != nil {
		t.Fatal(err)
	}
	rule := scheduleRule{Days: []int{1}, At: "02:00"}
	before := time.Date(2026, time.August, 23, 22, 59, 0, 0, time.UTC) // Monday 01:59 in Moscow.
	if due, _, _ := scheduleOccurrence(rule, scheduleRunState{}, before, location); due {
		t.Fatal("schedule became due before configured local time")
	}
	after := before.Add(2 * time.Minute)
	due, key, _ := scheduleOccurrence(rule, scheduleRunState{}, after, location)
	if !due || key != "2026-08-24|02:00" {
		t.Fatalf("unexpected local occurrence: due=%v key=%q", due, key)
	}
}

func waitForJob(t *testing.T, o *orchestrator, id string) jobRecord {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		o.mu.RLock()
		job := findJob(o.state.Jobs, id)
		if job != nil && job.State != "running" && job.State != "stopping" {
			result := cloneJob(*job)
			o.mu.RUnlock()
			return result
		}
		o.mu.RUnlock()
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("timed out waiting for job")
	return jobRecord{}
}

func waitForStarts(t *testing.T, node *mockNode, count int64) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for node.starts.Load() < count && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if node.starts.Load() < count {
		t.Fatalf("timed out waiting for %d node starts; got %d", count, node.starts.Load())
	}
}

func waitForStartedJob(t *testing.T, o *orchestrator) jobRecord {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		o.mu.RLock()
		if len(o.state.Jobs) > 0 {
			job := cloneJob(o.state.Jobs[len(o.state.Jobs)-1])
			o.mu.RUnlock()
			return job
		}
		o.mu.RUnlock()
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("timed out waiting for scheduled job")
	return jobRecord{}
}
