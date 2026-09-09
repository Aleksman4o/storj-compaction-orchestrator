package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type nodeClient struct {
	http *http.Client
}

type nodeAPIError struct {
	StatusCode int
	Code       string `json:"code"`
	Message    string `json:"error"`
}

func (e *nodeAPIError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("node API: %s: %s", e.Code, e.Message)
	}
	return fmt.Sprintf("node API returned HTTP %d", e.StatusCode)
}

func newNodeClient(timeout time.Duration) *nodeClient {
	return &nodeClient{http: &http.Client{Timeout: timeout}}
}

func compactionEndpoint(base, suffix string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(base))
	if err != nil {
		return "", err
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", errors.New("address must use http or https")
	}
	if u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("address must contain only scheme, host, port and optional path")
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/api/sno/compaction" + suffix
	return u.String(), nil
}

func (c *nodeClient) get(ctx context.Context, node nodeConfig) (*compactionInfo, time.Duration, error) {
	endpoint, err := compactionEndpoint(node.URL, "")
	if err != nil {
		return nil, 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Accept", "application/json")
	started := time.Now()
	resp, err := c.http.Do(req)
	latency := time.Since(started)
	if err != nil {
		return nil, latency, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, latency, decodeNodeError(resp)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, latency, fmt.Errorf("read node response: %w", err)
	}
	var info compactionInfo
	if err := json.Unmarshal(body, &info); err != nil {
		if strings.HasPrefix(strings.TrimSpace(string(body)), "<") {
			return nil, latency, errors.New("node returned HTML instead of compaction JSON; check the node version and dashboard address")
		}
		return nil, latency, fmt.Errorf("decode node response: %w", err)
	}
	return &info, latency, nil
}

func (c *nodeClient) start(ctx context.Context, node nodeConfig) (*manualCompactionJob, error) {
	endpoint, err := compactionEndpoint(node.URL, "/start")
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+node.APIKey)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted {
		return nil, decodeNodeError(resp)
	}
	var body startCompactionResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&body); err != nil {
		return nil, fmt.Errorf("decode start response: %w", err)
	}
	return &body.ManualJob, nil
}

func decodeNodeError(resp *http.Response) error {
	apiErr := &nodeAPIError{StatusCode: resp.StatusCode}
	_ = json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(apiErr)
	return apiErr
}
