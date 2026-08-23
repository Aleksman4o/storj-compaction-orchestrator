package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

const (
	databaseSchemaVersion = 1
)

type stateStore struct {
	db   *sql.DB
	last persistedState
}

func openStateStore(databasePath string) (_ *stateStore, state persistedState, err error) {
	if err := ensurePrivateDatabaseFile(databasePath); err != nil {
		return nil, state, err
	}

	dsn := "file:" + filepath.ToSlash(databasePath) +
		"?_journal_mode=WAL&_busy_timeout=10000&_foreign_keys=on&_synchronous=FULL"
	db, err := sql.Open("sqlite3", dsn)
	if err != nil {
		return nil, state, fmt.Errorf("open sqlite database: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	store := &stateStore{db: db}
	defer func() {
		if err != nil {
			_ = db.Close()
		}
	}()

	if err = db.Ping(); err != nil {
		return nil, state, fmt.Errorf("connect sqlite database: %w", err)
	}
	if err = store.migrateSchema(); err != nil {
		return nil, state, err
	}

	hasState, err := store.hasState()
	if err != nil {
		return nil, state, err
	}
	if !hasState {
		state = defaultState()
		if err = store.writeFullState(state); err != nil {
			return nil, state, fmt.Errorf("initialize sqlite state: %w", err)
		}
	} else {
		state, err = store.load()
		if err != nil {
			return nil, state, err
		}
	}
	store.last = cloneState(state)
	return store, state, nil
}

func defaultState() persistedState {
	return persistedState{
		Settings:      settings{PollIntervalSeconds: 10, Timezone: "UTC"},
		Jobs:          []jobRecord{},
		ScheduleState: make(map[string]scheduleRunState),
	}
}

func ensurePrivateDatabaseFile(path string) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0600)
	if err != nil {
		return err
	}
	if err := file.Chmod(0600); err != nil {
		_ = file.Close()
		return err
	}
	return file.Close()
}

func (s *stateStore) migrateSchema() error {
	var version int
	if err := s.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return fmt.Errorf("read sqlite schema version: %w", err)
	}
	if version > databaseSchemaVersion {
		return fmt.Errorf("unsupported sqlite schema version %d", version)
	}
	if version == databaseSchemaVersion {
		return nil
	}
	if version != 0 {
		return fmt.Errorf("cannot migrate sqlite schema version %d", version)
	}

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	statements := []string{
		`CREATE TABLE app_settings (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			poll_interval_seconds INTEGER NOT NULL,
			timezone TEXT NOT NULL
		)`,
		`CREATE TABLE disk_groups (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			position INTEGER NOT NULL
		)`,
		`CREATE TABLE nodes (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			url TEXT NOT NULL UNIQUE,
			api_key TEXT NOT NULL,
			group_id TEXT NOT NULL REFERENCES disk_groups(id),
			enabled INTEGER NOT NULL,
			position INTEGER NOT NULL
		)`,
		`CREATE INDEX nodes_group_position ON nodes(group_id, position)`,
		`CREATE TABLE schedules (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			enabled INTEGER NOT NULL,
			target_type TEXT NOT NULL,
			target_id TEXT NOT NULL,
			days_json TEXT NOT NULL,
			at_time TEXT NOT NULL,
			position INTEGER NOT NULL,
			last_due_key TEXT NOT NULL DEFAULT '',
			last_attempt_at TEXT,
			last_started_at TEXT,
			last_job_id TEXT NOT NULL DEFAULT '',
			last_error TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE TABLE jobs (
			seq INTEGER PRIMARY KEY AUTOINCREMENT,
			id TEXT NOT NULL UNIQUE,
			group_id TEXT NOT NULL,
			group_name TEXT NOT NULL,
			state TEXT NOT NULL,
			started_at TEXT NOT NULL,
			finished_at TEXT,
			current_node_id TEXT NOT NULL DEFAULT '',
			stop_after_current INTEGER NOT NULL,
			trigger_name TEXT NOT NULL,
			schedule_id TEXT NOT NULL DEFAULT '',
			nodes_json TEXT NOT NULL,
			node_count INTEGER NOT NULL DEFAULT 0,
			reclaimed_bytes INTEGER NOT NULL DEFAULT 0,
			rewritten_bytes INTEGER NOT NULL DEFAULT 0,
			lost_pieces INTEGER NOT NULL DEFAULT 0,
			lost_bytes INTEGER NOT NULL DEFAULT 0,
			error_count INTEGER NOT NULL DEFAULT 0
		)`,
		`CREATE INDEX jobs_started_at ON jobs(started_at DESC)`,
		`CREATE INDEX jobs_group_started_at ON jobs(group_id, started_at DESC)`,
		`CREATE INDEX jobs_state ON jobs(state)`,
	}
	for _, statement := range statements {
		if _, err := tx.Exec(statement); err != nil {
			return fmt.Errorf("create sqlite schema: %w", err)
		}
	}
	if _, err := tx.Exec(fmt.Sprintf("PRAGMA user_version = %d", databaseSchemaVersion)); err != nil {
		return fmt.Errorf("set sqlite schema version: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit sqlite schema: %w", err)
	}
	return nil
}

func (s *stateStore) hasState() (bool, error) {
	var count int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM app_settings`).Scan(&count); err != nil {
		return false, fmt.Errorf("check sqlite state: %w", err)
	}
	return count != 0, nil
}

func (s *stateStore) load() (persistedState, error) {
	state := defaultState()
	if err := s.db.QueryRow(`SELECT poll_interval_seconds, timezone FROM app_settings WHERE id = 1`).
		Scan(&state.Settings.PollIntervalSeconds, &state.Settings.Timezone); err != nil {
		return state, fmt.Errorf("load settings: %w", err)
	}

	groups, err := s.db.Query(`SELECT id, name FROM disk_groups ORDER BY position`)
	if err != nil {
		return state, fmt.Errorf("load disk groups: %w", err)
	}
	for groups.Next() {
		var group diskGroup
		if err := groups.Scan(&group.ID, &group.Name); err != nil {
			_ = groups.Close()
			return state, fmt.Errorf("scan disk group: %w", err)
		}
		state.Settings.Groups = append(state.Settings.Groups, group)
	}
	if err := groups.Close(); err != nil {
		return state, err
	}

	nodes, err := s.db.Query(`SELECT id, name, url, api_key, group_id, enabled FROM nodes ORDER BY position`)
	if err != nil {
		return state, fmt.Errorf("load nodes: %w", err)
	}
	for nodes.Next() {
		var node nodeConfig
		if err := nodes.Scan(&node.ID, &node.Name, &node.URL, &node.APIKey, &node.GroupID, &node.Enabled); err != nil {
			_ = nodes.Close()
			return state, fmt.Errorf("scan node: %w", err)
		}
		state.Settings.Nodes = append(state.Settings.Nodes, node)
	}
	if err := nodes.Close(); err != nil {
		return state, err
	}

	schedules, err := s.db.Query(`SELECT id, name, enabled, target_type, target_id, days_json, at_time,
		last_due_key, last_attempt_at, last_started_at, last_job_id, last_error
		FROM schedules ORDER BY position`)
	if err != nil {
		return state, fmt.Errorf("load schedules: %w", err)
	}
	for schedules.Next() {
		var rule scheduleRule
		var days string
		var lastAttempt, lastStarted sql.NullString
		var run scheduleRunState
		if err := schedules.Scan(&rule.ID, &rule.Name, &rule.Enabled, &rule.TargetType, &rule.TargetID,
			&days, &rule.At, &run.LastDueKey, &lastAttempt, &lastStarted, &run.LastJobID, &run.LastError); err != nil {
			_ = schedules.Close()
			return state, fmt.Errorf("scan schedule: %w", err)
		}
		if err := json.Unmarshal([]byte(days), &rule.Days); err != nil {
			_ = schedules.Close()
			return state, fmt.Errorf("decode schedule %s weekdays: %w", rule.ID, err)
		}
		if run.LastAttemptAt, err = parseOptionalTime(lastAttempt); err != nil {
			_ = schedules.Close()
			return state, err
		}
		if run.LastStartedAt, err = parseOptionalTime(lastStarted); err != nil {
			_ = schedules.Close()
			return state, err
		}
		state.Settings.Schedules = append(state.Settings.Schedules, rule)
		state.ScheduleState[rule.ID] = run
	}
	if err := schedules.Close(); err != nil {
		return state, err
	}

	jobs, err := s.db.Query(`SELECT id, group_id, group_name, state, started_at, finished_at,
		current_node_id, stop_after_current, trigger_name, schedule_id, nodes_json
		FROM jobs
		WHERE state IN ('running', 'stopping')
		   OR seq IN (SELECT seq FROM jobs ORDER BY seq DESC LIMIT ?)
		ORDER BY seq`, maxLoadedJobs)
	if err != nil {
		return state, fmt.Errorf("load jobs: %w", err)
	}
	for jobs.Next() {
		job, err := scanJob(jobs)
		if err != nil {
			_ = jobs.Close()
			return state, err
		}
		state.Jobs = append(state.Jobs, job)
	}
	if err := jobs.Close(); err != nil {
		return state, err
	}
	return state, nil
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanJob(row rowScanner) (jobRecord, error) {
	var job jobRecord
	var started string
	var finished sql.NullString
	var nodesJSON string
	if err := row.Scan(&job.ID, &job.GroupID, &job.GroupName, &job.State, &started, &finished,
		&job.Current, &job.StopAfter, &job.Trigger, &job.ScheduleID, &nodesJSON); err != nil {
		return job, fmt.Errorf("scan job: %w", err)
	}
	parsed, err := time.Parse(time.RFC3339Nano, started)
	if err != nil {
		return job, fmt.Errorf("parse job %s start: %w", job.ID, err)
	}
	job.StartedAt = parsed
	if job.FinishedAt, err = parseOptionalTime(finished); err != nil {
		return job, fmt.Errorf("parse job %s finish: %w", job.ID, err)
	}
	if err := json.Unmarshal([]byte(nodesJSON), &job.Nodes); err != nil {
		return job, fmt.Errorf("decode job %s nodes: %w", job.ID, err)
	}
	return job, nil
}

func parseOptionalTime(value sql.NullString) (*time.Time, error) {
	if !value.Valid || value.String == "" {
		return nil, nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, value.String)
	if err != nil {
		return nil, fmt.Errorf("parse timestamp %q: %w", value.String, err)
	}
	return &parsed, nil
}

func databaseTime(value *time.Time) any {
	if value == nil {
		return nil
	}
	return value.UTC().Format(time.RFC3339Nano)
}

func (s *stateStore) Save(state persistedState) error {
	settingsChanged := !reflect.DeepEqual(s.last.Settings, state.Settings)
	scheduleChanged := settingsChanged || !reflect.DeepEqual(s.last.ScheduleState, state.ScheduleState)
	previousJobs := make(map[string]jobRecord, len(s.last.Jobs))
	for _, job := range s.last.Jobs {
		previousJobs[job.ID] = job
	}
	changedJobs := make([]jobRecord, 0, 1)
	for _, job := range state.Jobs {
		if previous, ok := previousJobs[job.ID]; !ok || !reflect.DeepEqual(previous, job) {
			changedJobs = append(changedJobs, job)
		}
	}
	if !settingsChanged && !scheduleChanged && len(changedJobs) == 0 {
		return nil
	}

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if settingsChanged {
		if err := replaceSettings(tx, state.Settings, state.ScheduleState); err != nil {
			return err
		}
	} else if scheduleChanged {
		if err := updateScheduleStates(tx, state.Settings.Schedules, s.last.ScheduleState, state.ScheduleState); err != nil {
			return err
		}
	}
	for _, job := range changedJobs {
		if err := upsertJob(tx, job); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.last = cloneState(state)
	return nil
}

func (s *stateStore) writeFullState(state persistedState) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := replaceSettings(tx, state.Settings, state.ScheduleState); err != nil {
		return err
	}
	for _, job := range state.Jobs {
		if err := upsertJob(tx, job); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func replaceSettings(tx *sql.Tx, config settings, scheduleState map[string]scheduleRunState) error {
	for _, table := range []string{"schedules", "nodes", "disk_groups"} {
		if _, err := tx.Exec("DELETE FROM " + table); err != nil {
			return fmt.Errorf("clear %s: %w", table, err)
		}
	}
	if _, err := tx.Exec(`INSERT INTO app_settings(id, poll_interval_seconds, timezone) VALUES(1, ?, ?)
		ON CONFLICT(id) DO UPDATE SET poll_interval_seconds=excluded.poll_interval_seconds, timezone=excluded.timezone`,
		config.PollIntervalSeconds, config.Timezone); err != nil {
		return fmt.Errorf("save settings: %w", err)
	}
	for position, group := range config.Groups {
		if _, err := tx.Exec(`INSERT INTO disk_groups(id, name, position) VALUES(?, ?, ?)`, group.ID, group.Name, position); err != nil {
			return fmt.Errorf("save disk group %s: %w", group.ID, err)
		}
	}
	for position, node := range config.Nodes {
		if _, err := tx.Exec(`INSERT INTO nodes(id, name, url, api_key, group_id, enabled, position) VALUES(?, ?, ?, ?, ?, ?, ?)`,
			node.ID, node.Name, node.URL, node.APIKey, node.GroupID, node.Enabled, position); err != nil {
			return fmt.Errorf("save node %s: %w", node.ID, err)
		}
	}
	for position, rule := range config.Schedules {
		if err := insertSchedule(tx, rule, scheduleState[rule.ID], position); err != nil {
			return err
		}
	}
	return nil
}

func insertSchedule(tx *sql.Tx, rule scheduleRule, state scheduleRunState, position int) error {
	days, err := json.Marshal(rule.Days)
	if err != nil {
		return err
	}
	_, err = tx.Exec(`INSERT INTO schedules(id, name, enabled, target_type, target_id, days_json, at_time, position,
		last_due_key, last_attempt_at, last_started_at, last_job_id, last_error)
		VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, rule.ID, rule.Name, rule.Enabled, rule.TargetType,
		rule.TargetID, string(days), rule.At, position, state.LastDueKey, databaseTime(state.LastAttemptAt),
		databaseTime(state.LastStartedAt), state.LastJobID, state.LastError)
	if err != nil {
		return fmt.Errorf("save schedule %s: %w", rule.ID, err)
	}
	return nil
}

func updateScheduleStates(tx *sql.Tx, schedules []scheduleRule, previous, states map[string]scheduleRunState) error {
	for _, rule := range schedules {
		state := states[rule.ID]
		if reflect.DeepEqual(previous[rule.ID], state) {
			continue
		}
		if _, err := tx.Exec(`UPDATE schedules SET last_due_key=?, last_attempt_at=?, last_started_at=?, last_job_id=?, last_error=? WHERE id=?`,
			state.LastDueKey, databaseTime(state.LastAttemptAt), databaseTime(state.LastStartedAt),
			state.LastJobID, state.LastError, rule.ID); err != nil {
			return fmt.Errorf("update schedule state %s: %w", rule.ID, err)
		}
	}
	return nil
}

func upsertJob(tx *sql.Tx, job jobRecord) error {
	nodes, err := json.Marshal(job.Nodes)
	if err != nil {
		return fmt.Errorf("encode job %s nodes: %w", job.ID, err)
	}
	var reclaimed, rewritten int64
	var lostPieces, lostBytes uint64
	errorCount := 0
	for _, node := range job.Nodes {
		reclaimed += node.Reclaimed
		rewritten += node.Rewritten
		lostPieces += node.LostPieces
		lostBytes += node.LostBytes
		if node.State == "failed" {
			errorCount++
		}
	}
	_, err = tx.Exec(`INSERT INTO jobs(id, group_id, group_name, state, started_at, finished_at,
		current_node_id, stop_after_current, trigger_name, schedule_id, nodes_json, node_count,
		reclaimed_bytes, rewritten_bytes, lost_pieces, lost_bytes, error_count)
		VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			group_id=excluded.group_id, group_name=excluded.group_name, state=excluded.state,
			started_at=excluded.started_at, finished_at=excluded.finished_at,
			current_node_id=excluded.current_node_id, stop_after_current=excluded.stop_after_current,
			trigger_name=excluded.trigger_name, schedule_id=excluded.schedule_id, nodes_json=excluded.nodes_json,
			node_count=excluded.node_count,
			reclaimed_bytes=excluded.reclaimed_bytes, rewritten_bytes=excluded.rewritten_bytes,
			lost_pieces=excluded.lost_pieces, lost_bytes=excluded.lost_bytes, error_count=excluded.error_count`,
		job.ID, job.GroupID, job.GroupName, job.State, job.StartedAt.UTC().Format(time.RFC3339Nano),
		databaseTime(job.FinishedAt), job.Current, job.StopAfter, job.Trigger, job.ScheduleID, string(nodes), len(job.Nodes),
		reclaimed, rewritten, int64(lostPieces), int64(lostBytes), errorCount)
	if err != nil {
		return fmt.Errorf("save job %s: %w", job.ID, err)
	}
	return nil
}

func (s *stateStore) Close() error {
	if _, err := s.db.Exec(`PRAGMA wal_checkpoint(TRUNCATE)`); err != nil {
		_ = s.db.Close()
		return err
	}
	return s.db.Close()
}

func cloneState(state persistedState) persistedState {
	copyState := state
	copyState.Settings.Groups = append([]diskGroup(nil), state.Settings.Groups...)
	copyState.Settings.Nodes = append([]nodeConfig(nil), state.Settings.Nodes...)
	copyState.Settings.Schedules = make([]scheduleRule, len(state.Settings.Schedules))
	for i, rule := range state.Settings.Schedules {
		copyState.Settings.Schedules[i] = cloneSchedule(rule)
	}
	copyState.Jobs = make([]jobRecord, len(state.Jobs))
	for i, job := range state.Jobs {
		copyState.Jobs[i] = cloneJob(job)
	}
	copyState.ScheduleState = make(map[string]scheduleRunState, len(state.ScheduleState))
	for id, run := range state.ScheduleState {
		copyState.ScheduleState[id] = run
	}
	return copyState
}

type historyStats struct {
	GroupID                string  `json:"groupId"`
	Runs                   int     `json:"runs"`
	Succeeded              int     `json:"succeeded"`
	Failed                 int     `json:"failed"`
	Stopped                int     `json:"stopped"`
	ErrorCount             int     `json:"errorCount"`
	AverageDurationSeconds float64 `json:"averageDurationSeconds"`
	LastDurationSeconds    float64 `json:"lastDurationSeconds"`
	ReclaimedBytes         int64   `json:"reclaimedBytes"`
	RewrittenBytes         int64   `json:"rewrittenBytes"`
}

type historyPage struct {
	Jobs   []jobRecord `json:"jobs"`
	Total  int         `json:"total"`
	Limit  int         `json:"limit"`
	Offset int         `json:"offset"`
}

func (s *stateStore) HistoryPage(limit, offset int, sortKey, direction string) (historyPage, error) {
	if limit < 1 {
		limit = 25
	}
	if limit > 100 {
		limit = 100
	}
	if offset < 0 {
		offset = 0
	}
	orders := map[string]string{
		"started":   "started_at",
		"trigger":   "trigger_name",
		"group":     "group_name",
		"state":     "state",
		"nodes":     "node_count",
		"reclaimed": "reclaimed_bytes",
		"rewritten": "rewritten_bytes",
		"duration":  "(julianday(COALESCE(finished_at, CURRENT_TIMESTAMP))-julianday(started_at))",
	}
	order, ok := orders[sortKey]
	if !ok {
		order = orders["started"]
	}
	if direction != "asc" {
		direction = "desc"
	}
	page := historyPage{Limit: limit, Offset: offset, Jobs: []jobRecord{}}
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM jobs`).Scan(&page.Total); err != nil {
		return page, err
	}
	query := `SELECT id, group_id, group_name, state, started_at, finished_at,
		current_node_id, stop_after_current, trigger_name, schedule_id, nodes_json
		FROM jobs ORDER BY ` + order + ` ` + direction + `, seq DESC LIMIT ? OFFSET ?`
	rows, err := s.db.Query(query, limit, offset)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	for rows.Next() {
		job, err := scanJob(rows)
		if err != nil {
			return page, err
		}
		page.Jobs = append(page.Jobs, job)
	}
	return page, rows.Err()
}

func (s *stateStore) HistoryStats() ([]historyStats, error) {
	rows, err := s.db.Query(`SELECT group_id,
		COUNT(*),
		SUM(CASE WHEN state='succeeded' THEN 1 ELSE 0 END),
		SUM(CASE WHEN state='failed' THEN 1 ELSE 0 END),
		SUM(CASE WHEN state='stopped' THEN 1 ELSE 0 END),
		SUM(error_count),
		COALESCE(AVG(CASE WHEN state='succeeded' AND finished_at IS NOT NULL THEN
			(julianday(finished_at)-julianday(started_at))*86400.0 END), 0),
		COALESCE((SELECT (julianday(latest.finished_at)-julianday(latest.started_at))*86400.0
			FROM jobs latest WHERE latest.group_id=jobs.group_id AND latest.state='succeeded'
			ORDER BY latest.seq DESC LIMIT 1), 0),
		COALESCE(SUM(reclaimed_bytes), 0),
		COALESCE(SUM(rewritten_bytes), 0)
		FROM jobs GROUP BY group_id ORDER BY group_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []historyStats
	for rows.Next() {
		var item historyStats
		if err := rows.Scan(&item.GroupID, &item.Runs, &item.Succeeded, &item.Failed, &item.Stopped,
			&item.ErrorCount, &item.AverageDurationSeconds, &item.LastDurationSeconds,
			&item.ReclaimedBytes, &item.RewrittenBytes); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}
