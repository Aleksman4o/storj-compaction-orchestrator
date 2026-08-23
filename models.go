package main

import "time"

type diskGroup struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type nodeConfig struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	URL     string `json:"url"`
	APIKey  string `json:"apiKey"`
	GroupID string `json:"groupId"`
	Enabled bool   `json:"enabled"`
}

type settings struct {
	PollIntervalSeconds int            `json:"pollIntervalSeconds"`
	Timezone            string         `json:"timezone"`
	Groups              []diskGroup    `json:"groups"`
	Nodes               []nodeConfig   `json:"nodes"`
	Schedules           []scheduleRule `json:"schedules"`
}

type persistedState struct {
	Settings      settings
	Jobs          []jobRecord
	ScheduleState map[string]scheduleRunState
}

type scheduleRule struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Enabled    bool   `json:"enabled"`
	TargetType string `json:"targetType"`
	TargetID   string `json:"targetId"`
	Days       []int  `json:"days"`
	At         string `json:"at"`
}

type scheduleRunState struct {
	LastDueKey    string     `json:"lastDueKey,omitempty"`
	LastAttemptAt *time.Time `json:"lastAttemptAt,omitempty"`
	LastStartedAt *time.Time `json:"lastStartedAt,omitempty"`
	LastJobID     string     `json:"lastJobId,omitempty"`
	LastError     string     `json:"lastError,omitempty"`
}

type scheduleStatus struct {
	RuleID        string     `json:"ruleId"`
	Pending       bool       `json:"pending"`
	NextRun       *time.Time `json:"nextRun,omitempty"`
	LastAttemptAt *time.Time `json:"lastAttemptAt,omitempty"`
	LastStartedAt *time.Time `json:"lastStartedAt,omitempty"`
	LastJobID     string     `json:"lastJobId,omitempty"`
	LastError     string     `json:"lastError,omitempty"`
}

type compactionTotals struct {
	FinishedAttempts   uint64 `json:"finishedAttempts"`
	FailedAttempts     uint64 `json:"failedAttempts"`
	LogsRewritten      uint64 `json:"logsRewritten"`
	DataRewrittenBytes int64  `json:"dataRewrittenBytes"`
	DataReclaimedBytes int64  `json:"dataReclaimedBytes"`
}

type salvageTotals struct {
	SuccessfulRounds uint64 `json:"successfulRounds"`
	LostPieces       uint64 `json:"lostPieces"`
	LostBytes        uint64 `json:"lostBytes"`
	AffectedLogs     uint64 `json:"affectedLogs"`
	AbortedRounds    uint64 `json:"abortedRounds"`
}

type compactionProgress struct {
	ElapsedSeconds   float64 `json:"elapsedSeconds"`
	RemainingSeconds float64 `json:"remainingSeconds"`
	ProcessedRecords uint64  `json:"processedRecords"`
	TotalRecords     uint64  `json:"totalRecords"`
}

type satelliteCompaction struct {
	SatelliteID      string              `json:"satelliteID"`
	Compacting       bool                `json:"compacting"`
	Mode             string              `json:"mode,omitempty"`
	CurrentRound     *compactionProgress `json:"currentRound,omitempty"`
	ReclaimableBytes int64               `json:"reclaimableBytes"`
	RuntimeTotals    compactionTotals    `json:"runtimeTotals"`
	Salvage          salvageTotals       `json:"salvage"`
}

type manualCompactionResult struct {
	SatelliteID string `json:"satelliteID"`
	Status      string `json:"status"`
	Error       string `json:"error,omitempty"`
}

type manualCompactionJob struct {
	ID                  uint64                   `json:"id"`
	State               string                   `json:"state"`
	StartedAt           *time.Time               `json:"startedAt,omitempty"`
	FinishedAt          *time.Time               `json:"finishedAt,omitempty"`
	CurrentSatellite    *string                  `json:"currentSatellite,omitempty"`
	TotalSatellites     int                      `json:"totalSatellites"`
	ProcessedSatellites int                      `json:"processedSatellites"`
	Results             []manualCompactionResult `json:"results"`
}

type compactionInfo struct {
	Compacting                 bool                  `json:"compacting"`
	SalvageEnabled             bool                  `json:"salvageEnabled"`
	ManualLogCompactionEnabled bool                  `json:"manualLogCompactionEnabled"`
	ManualJob                  manualCompactionJob   `json:"manualJob"`
	ReclaimableBytes           int64                 `json:"reclaimableBytes"`
	RuntimeTotals              compactionTotals      `json:"runtimeTotals"`
	Salvage                    salvageTotals         `json:"salvage"`
	Satellites                 []satelliteCompaction `json:"satellites"`
}

type startCompactionResponse struct {
	ManualJob manualCompactionJob `json:"manualJob"`
}

type nodeRuntime struct {
	Online      bool            `json:"online"`
	LastChecked time.Time       `json:"lastChecked"`
	LatencyMS   int64           `json:"latencyMs"`
	Error       string          `json:"error,omitempty"`
	Info        *compactionInfo `json:"info,omitempty"`
}

type nodeRunRecord struct {
	NodeID        string            `json:"nodeId"`
	NodeName      string            `json:"nodeName"`
	State         string            `json:"state"`
	StartedAt     *time.Time        `json:"startedAt,omitempty"`
	FinishedAt    *time.Time        `json:"finishedAt,omitempty"`
	NodeJobID     uint64            `json:"nodeJobId,omitempty"`
	PreviousJobID *uint64           `json:"previousNodeJobId,omitempty"`
	Error         string            `json:"error,omitempty"`
	Before        *compactionTotals `json:"before,omitempty"`
	After         *compactionTotals `json:"after,omitempty"`
	BeforeSalvage *salvageTotals    `json:"-"`
	Reclaimed     int64             `json:"reclaimedBytes"`
	Rewritten     int64             `json:"rewrittenBytes"`
	LostPieces    uint64            `json:"lostPieces"`
	LostBytes     uint64            `json:"lostBytes"`
}

type jobRecord struct {
	ID         string          `json:"id"`
	GroupID    string          `json:"groupId"`
	GroupName  string          `json:"groupName"`
	State      string          `json:"state"`
	StartedAt  time.Time       `json:"startedAt"`
	FinishedAt *time.Time      `json:"finishedAt,omitempty"`
	Current    string          `json:"currentNodeId,omitempty"`
	StopAfter  bool            `json:"stopAfterCurrent"`
	Trigger    string          `json:"trigger"`
	ScheduleID string          `json:"scheduleId,omitempty"`
	Nodes      []nodeRunRecord `json:"nodes"`
}

type publicNodeConfig struct {
	ID               string `json:"id"`
	Name             string `json:"name"`
	URL              string `json:"url"`
	APIKey           string `json:"apiKey,omitempty"`
	APIKeyConfigured bool   `json:"apiKeyConfigured"`
	GroupID          string `json:"groupId"`
	Enabled          bool   `json:"enabled"`
}

type publicSettings struct {
	PollIntervalSeconds int                `json:"pollIntervalSeconds"`
	Timezone            string             `json:"timezone"`
	Groups              []diskGroup        `json:"groups"`
	Nodes               []publicNodeConfig `json:"nodes"`
	Schedules           []scheduleRule     `json:"schedules"`
}

type dashboardNode struct {
	publicNodeConfig
	Runtime nodeRuntime `json:"runtime"`
}

type dashboardGroup struct {
	diskGroup
	RunningJob *jobRecord `json:"runningJob,omitempty"`
}

type dashboardResponse struct {
	GeneratedAt time.Time        `json:"generatedAt"`
	Groups      []dashboardGroup `json:"groups"`
	Nodes       []dashboardNode  `json:"nodes"`
	Jobs        []jobRecord      `json:"jobs"`
	Schedules   []scheduleStatus `json:"schedules"`
	History     []historyStats   `json:"historyStats"`
}
