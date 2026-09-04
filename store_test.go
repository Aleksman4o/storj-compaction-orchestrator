package main

import (
	"database/sql"
	"path/filepath"
	"testing"
	"time"
)

func TestSQLiteMigratesV1SchedulesWithoutLosingRules(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "orchestrator.db")
	db, err := sql.Open("sqlite3", databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE schedules (
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
	);
	INSERT INTO schedules(id, name, enabled, target_type, target_id, days_json, at_time, position)
		VALUES('nightly', 'Nightly', 1, 'group', 'disk-a', '[1,2,3,4,5]', '02:00', 0);
	PRAGMA user_version = 1`); err != nil {
		t.Fatal(err)
	}
	store := &stateStore{db: db}
	if err := store.migrateSchema(); err != nil {
		t.Fatal(err)
	}
	var version int
	if err := db.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if version != databaseSchemaVersion {
		t.Fatalf("schema version is %d, expected %d", version, databaseSchemaVersion)
	}
	var id, name, mode, startAt, at string
	var interval int
	if err := db.QueryRow(`SELECT id, name, schedule_mode, start_at, interval_hours, at_time FROM schedules`).
		Scan(&id, &name, &mode, &startAt, &interval, &at); err != nil {
		t.Fatal(err)
	}
	if id != "nightly" || name != "Nightly" || mode != scheduleModeWeekly || startAt != "" || interval != 0 || at != "02:00" {
		t.Fatalf("migrated schedule changed: id=%q name=%q mode=%q start=%q interval=%d at=%q",
			id, name, mode, startAt, interval, at)
	}
}

func TestSQLitePersistsIntervalSchedule(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "orchestrator.db")
	store, state, err := openStateStore(databasePath)
	if err != nil {
		t.Fatal(err)
	}
	state.Settings.Groups = []diskGroup{{ID: "disk-a", Name: "Disk A"}}
	state.Settings.Schedules = []scheduleRule{{
		ID: "every-48h", Name: "Every 48 hours", Enabled: true, TargetType: "group", TargetID: "disk-a",
		Mode: scheduleModeInterval, StartAt: "2026-08-25T10:00", Interval: 48,
	}}
	state.ScheduleState["every-48h"] = scheduleRunState{LastDueKey: "interval:2026-08-25T07:00:00Z"}
	if err := store.writeFullState(state); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	store, loaded, err := openStateStore(databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if len(loaded.Settings.Schedules) != 1 {
		t.Fatalf("loaded %d schedules", len(loaded.Settings.Schedules))
	}
	rule := loaded.Settings.Schedules[0]
	if rule.Mode != scheduleModeInterval || rule.StartAt != "2026-08-25T10:00" || rule.Interval != 48 {
		t.Fatalf("interval schedule changed after reload: %+v", rule)
	}
}

func TestSQLiteInitializesAndPersistsState(t *testing.T) {
	dir := t.TempDir()
	databasePath := filepath.Join(dir, "orchestrator.db")
	store, state, err := openStateStore(databasePath)
	if err != nil {
		t.Fatal(err)
	}
	if state.Settings.PollIntervalSeconds != 10 || state.Settings.Timezone != "UTC" || len(state.Jobs) != 0 {
		t.Fatalf("unexpected initial state: %+v", state)
	}

	var journal string
	var synchronous, foreignKeys int
	if err := store.db.QueryRow(`PRAGMA journal_mode`).Scan(&journal); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRow(`PRAGMA synchronous`).Scan(&synchronous); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRow(`PRAGMA foreign_keys`).Scan(&foreignKeys); err != nil {
		t.Fatal(err)
	}
	if journal != "wal" || synchronous != 2 || foreignKeys != 1 {
		t.Fatalf("unexpected SQLite safety settings: journal=%s synchronous=%d foreign_keys=%d", journal, synchronous, foreignKeys)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	store, reopened, err := openStateStore(databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if reopened.Settings.PollIntervalSeconds != 10 || reopened.Settings.Timezone != "UTC" {
		t.Fatalf("reopen changed state: %+v", reopened)
	}
}

func TestSQLiteRetainsHistoryBeyondMemoryWindow(t *testing.T) {
	dir := t.TempDir()
	store, state, err := openStateStore(filepath.Join(dir, "orchestrator.db"))
	if err != nil {
		t.Fatal(err)
	}
	state.Settings.Groups = []diskGroup{{ID: "disk-a", Name: "Disk A"}}
	base := time.Date(2026, time.January, 1, 0, 0, 0, 0, time.UTC)
	for i := 0; i < maxLoadedJobs+5; i++ {
		finished := base.Add(time.Duration(i)*time.Minute + time.Minute)
		state.Jobs = append(state.Jobs, jobRecord{
			ID: "job-" + time.Duration(i).String(), GroupID: "disk-a", GroupName: "Disk A",
			State: "succeeded", StartedAt: base.Add(time.Duration(i) * time.Minute), FinishedAt: &finished,
			Trigger: "manual",
		})
	}
	if err := store.writeFullState(state); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	store, loaded, err := openStateStore(filepath.Join(dir, "orchestrator.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if len(loaded.Jobs) != maxLoadedJobs {
		t.Fatalf("loaded %d jobs, expected bounded window %d", len(loaded.Jobs), maxLoadedJobs)
	}
	stats, err := store.HistoryStats()
	if err != nil {
		t.Fatal(err)
	}
	if len(stats) != 1 || stats[0].Runs != maxLoadedJobs+5 {
		t.Fatalf("database history was truncated: %+v", stats)
	}
	page, err := store.HistoryPage(3, maxLoadedJobs+2, "started", "desc")
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != maxLoadedJobs+5 || len(page.Jobs) != 3 {
		t.Fatalf("database history page is incomplete: %+v", page)
	}
}

func TestTrimLoadedJobsKeepsRunningQueue(t *testing.T) {
	jobs := make([]jobRecord, 0, 5)
	jobs = append(jobs, jobRecord{ID: "old-running", State: "running"})
	for _, id := range []string{"old-finished", "new-a", "new-b", "new-c"} {
		jobs = append(jobs, jobRecord{ID: id, State: "succeeded"})
	}
	trimmed := trimLoadedJobs(jobs, 3)
	if len(trimmed) != 4 || findJob(trimmed, "old-running") == nil || findJob(trimmed, "old-finished") != nil {
		t.Fatalf("active queue was not retained safely: %+v", trimmed)
	}
}

func writeTestState(path string, state persistedState) error {
	store, _, err := openStateStore(path)
	if err != nil {
		return err
	}
	if err := store.writeFullState(state); err != nil {
		_ = store.Close()
		return err
	}
	return store.Close()
}
