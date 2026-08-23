package main

import (
	"slices"
	"time"
	_ "time/tzdata"
)

const scheduleRetryInterval = time.Minute

type dueSchedule struct {
	rule     scheduleRule
	dueKey   string
	groupID  string
	onlyNode string
}

func cloneSchedule(rule scheduleRule) scheduleRule {
	rule.Days = append([]int(nil), rule.Days...)
	return rule
}

func (o *orchestrator) scheduleLoop() {
	defer o.wg.Done()
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	o.processSchedules(time.Now().UTC())
	for {
		select {
		case <-o.ctx.Done():
			return
		case now := <-ticker.C:
			o.processSchedules(now.UTC())
		}
	}
}

// processSchedules selects at most one due rule per physical disk. A failed attempt remains due
// until the local day ends, so temporary node or disk-group conflicts are retried safely.
func (o *orchestrator) processSchedules(now time.Time) {
	o.mu.Lock()
	location, err := time.LoadLocation(o.state.Settings.Timezone)
	if err != nil {
		location = time.UTC
	}
	selected := make(map[string]dueSchedule)
	for _, rule := range o.state.Settings.Schedules {
		if !rule.Enabled {
			continue
		}
		runState := o.state.ScheduleState[rule.ID]
		due, dueKey, _ := scheduleOccurrence(rule, runState, now, location)
		if !due || (runState.LastAttemptAt != nil && now.Sub(*runState.LastAttemptAt) < scheduleRetryInterval) {
			continue
		}
		groupID, onlyNode, ok := o.scheduleTargetLocked(rule)
		if !ok || o.running[groupID] != "" {
			continue
		}
		if _, exists := selected[groupID]; !exists {
			selected[groupID] = dueSchedule{rule: cloneSchedule(rule), dueKey: dueKey, groupID: groupID, onlyNode: onlyNode}
		}
	}
	for _, candidate := range selected {
		runState := o.state.ScheduleState[candidate.rule.ID]
		attempted := now.UTC()
		runState.LastAttemptAt = &attempted
		runState.LastError = ""
		o.state.ScheduleState[candidate.rule.ID] = runState
	}
	if len(selected) > 0 {
		if err := o.persistLocked(); err != nil {
			o.log.Error("persist schedule attempts", "error", err)
		}
	}
	o.mu.Unlock()

	for _, candidate := range selected {
		candidate := candidate
		select {
		case o.scheduleSem <- struct{}{}:
			o.wg.Add(1)
			go func() {
				defer o.wg.Done()
				defer func() { <-o.scheduleSem }()
				o.runSchedule(candidate)
			}()
		case <-o.ctx.Done():
			return
		}
	}
}

func (o *orchestrator) runSchedule(candidate dueSchedule) {
	job, err := o.startGroupWithTrigger(candidate.groupID, candidate.onlyNode, "schedule", candidate.rule.ID, candidate.dueKey)
	if err == nil {
		o.log.Info("scheduled compaction accepted", "schedule", candidate.rule.Name, "job", job.ID)
		return
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	runState := o.state.ScheduleState[candidate.rule.ID]
	runState.LastError = err.Error()
	o.log.Warn("scheduled compaction deferred", "schedule", candidate.rule.Name, "error", err)
	o.state.ScheduleState[candidate.rule.ID] = runState
	if err := o.persistLocked(); err != nil {
		o.log.Error("persist schedule result", "error", err)
	}
}

func (o *orchestrator) scheduleTargetLocked(rule scheduleRule) (groupID, onlyNode string, ok bool) {
	if rule.TargetType == "group" {
		for _, group := range o.state.Settings.Groups {
			if group.ID == rule.TargetID {
				return group.ID, "", true
			}
		}
		return "", "", false
	}
	if rule.TargetType == "node" {
		for _, node := range o.state.Settings.Nodes {
			if node.ID == rule.TargetID && node.Enabled {
				return node.GroupID, node.ID, true
			}
		}
	}
	return "", "", false
}

func scheduleOccurrence(rule scheduleRule, runState scheduleRunState, now time.Time, location *time.Location) (due bool, dueKey string, scheduled time.Time) {
	local := now.In(location)
	hour, minute, ok := parseScheduleTime(rule.At)
	if !ok || !slices.Contains(rule.Days, int(local.Weekday())) {
		return false, "", time.Time{}
	}
	scheduled = time.Date(local.Year(), local.Month(), local.Day(), hour, minute, 0, 0, location)
	dueKey = scheduled.Format("2006-01-02|15:04")
	return !local.Before(scheduled) && runState.LastDueKey != dueKey, dueKey, scheduled
}

func nextScheduleOccurrence(rule scheduleRule, runState scheduleRunState, now time.Time, location *time.Location) (time.Time, bool) {
	if due, _, scheduled := scheduleOccurrence(rule, runState, now, location); due {
		return scheduled, true
	}
	hour, minute, ok := parseScheduleTime(rule.At)
	if !ok {
		return time.Time{}, false
	}
	local := now.In(location)
	for offset := 0; offset <= 7; offset++ {
		day := local.AddDate(0, 0, offset)
		if !slices.Contains(rule.Days, int(day.Weekday())) {
			continue
		}
		candidate := time.Date(day.Year(), day.Month(), day.Day(), hour, minute, 0, 0, location)
		if candidate.After(local) {
			return candidate, false
		}
	}
	return time.Time{}, false
}

func parseScheduleTime(value string) (hour, minute int, ok bool) {
	parsed, err := time.Parse("15:04", value)
	if err != nil {
		return 0, 0, false
	}
	return parsed.Hour(), parsed.Minute(), true
}

func (o *orchestrator) scheduleStatusesLocked(now time.Time) []scheduleStatus {
	location, err := time.LoadLocation(o.state.Settings.Timezone)
	if err != nil {
		location = time.UTC
	}
	statuses := make([]scheduleStatus, 0, len(o.state.Settings.Schedules))
	for _, rule := range o.state.Settings.Schedules {
		runState := o.state.ScheduleState[rule.ID]
		next, pending := nextScheduleOccurrence(rule, runState, now, location)
		status := scheduleStatus{
			RuleID: rule.ID, Pending: rule.Enabled && pending,
			LastAttemptAt: runState.LastAttemptAt, LastStartedAt: runState.LastStartedAt,
			LastJobID: runState.LastJobID, LastError: runState.LastError,
		}
		if rule.Enabled && !next.IsZero() {
			value := next.UTC()
			status.NextRun = &value
		}
		statuses = append(statuses, status)
	}
	return statuses
}
