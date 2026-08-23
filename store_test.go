package main

import (
	"path/filepath"
	"testing"
	"time"
)

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
