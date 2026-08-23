package main

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"strconv"
	"strings"
)

//go:embed web/*
var webFiles embed.FS

type apiServer struct {
	orchestrator *orchestrator
	password     string
	sessionToken string
	static       http.Handler
}

const sessionCookieName = "compaction_orchestrator_session"

func newAPIServer(o *orchestrator, password string) (*apiServer, error) {
	sub, err := fs.Sub(webFiles, "web")
	if err != nil {
		return nil, err
	}
	var token [32]byte
	if _, err := rand.Read(token[:]); err != nil {
		return nil, fmt.Errorf("generate authentication token: %w", err)
	}
	return &apiServer{
		orchestrator: o,
		password:     password,
		sessionToken: base64.RawURLEncoding.EncodeToString(token[:]),
		static:       http.FileServer(http.FS(sub)),
	}, nil
}

func (s *apiServer) handler() http.Handler {
	return s.securityHeaders(s.passwordAuth(http.HandlerFunc(s.serveHTTP)))
}

func (s *apiServer) serveHTTP(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		s.serveAPI(w, r)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	s.static.ServeHTTP(w, r)
}

func (s *apiServer) serveAPI(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet && r.Header.Get("X-Orchestrator-Request") != "1" {
		writeError(w, http.StatusForbidden, errors.New("missing orchestrator request header"))
		return
	}
	switch {
	case r.URL.Path == "/api/dashboard" && r.Method == http.MethodGet:
		data := s.orchestrator.dashboard()
		sortDashboard(&data)
		writeJSON(w, http.StatusOK, data)
	case r.URL.Path == "/api/settings" && r.Method == http.MethodGet:
		writeJSON(w, http.StatusOK, s.orchestrator.publicSettings())
	case r.URL.Path == "/api/settings" && r.Method == http.MethodPut:
		var input publicSettings
		if err := decodeJSON(r, &input); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		if err := s.orchestrator.updateSettings(input); err != nil {
			status := http.StatusBadRequest
			if strings.Contains(err.Error(), "while an orchestration") {
				status = http.StatusConflict
			}
			writeError(w, status, err)
			return
		}
		writeJSON(w, http.StatusOK, s.orchestrator.publicSettings())
	case r.URL.Path == "/api/history" && r.Method == http.MethodGet:
		limit, err := queryInteger(r, "limit", 25)
		if err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		offset, err := queryInteger(r, "offset", 0)
		if err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		page, err := s.orchestrator.store.HistoryPage(limit, offset, r.URL.Query().Get("sort"), r.URL.Query().Get("direction"))
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, page)
	case strings.HasPrefix(r.URL.Path, "/api/groups/"):
		s.serveGroupAction(w, r)
	case strings.HasPrefix(r.URL.Path, "/api/nodes/"):
		s.serveNodeAction(w, r)
	default:
		writeError(w, http.StatusNotFound, errNotFound)
	}
}

func queryInteger(r *http.Request, name string, fallback int) (int, error) {
	value := r.URL.Query().Get(name)
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < 0 {
		return 0, fmt.Errorf("invalid %s", name)
	}
	return parsed, nil
}

func (s *apiServer) serveGroupAction(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/groups/"), "/")
	if len(parts) != 2 || r.Method != http.MethodPost {
		writeError(w, http.StatusNotFound, errNotFound)
		return
	}
	var (
		job jobRecord
		err error
	)
	switch parts[1] {
	case "start":
		job, err = s.orchestrator.startGroup(parts[0], "")
	case "stop":
		job, err = s.orchestrator.stopGroup(parts[0])
	default:
		writeError(w, http.StatusNotFound, errNotFound)
		return
	}
	if err != nil {
		writeActionError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, job)
}

func (s *apiServer) serveNodeAction(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/nodes/"), "/")
	if len(parts) != 2 || r.Method != http.MethodPost {
		writeError(w, http.StatusNotFound, errNotFound)
		return
	}
	switch parts[1] {
	case "start":
		job, err := s.orchestrator.startSingleNode(parts[0])
		if err != nil {
			writeActionError(w, err)
			return
		}
		writeJSON(w, http.StatusAccepted, job)
	case "test":
		runtime, err := s.orchestrator.testNode(parts[0])
		if err != nil {
			writeActionError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, runtime)
	default:
		writeError(w, http.StatusNotFound, errNotFound)
	}
}

func writeActionError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errNotFound):
		writeError(w, http.StatusNotFound, err)
	case errors.Is(err, errConflict):
		writeError(w, http.StatusConflict, err)
	default:
		writeError(w, http.StatusBadRequest, err)
	}
}

func decodeJSON(r *http.Request, target any) error {
	decoder := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return errors.New("request must contain one JSON value")
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

func (s *apiServer) passwordAuth(next http.Handler) http.Handler {
	if s.password == "" {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/auth/login":
			s.serveLogin(w, r)
			return
		case r.URL.Path == "/auth/logout":
			s.serveLogout(w, r)
			return
		case r.URL.Path == "/login.html" || r.URL.Path == "/login.js" || r.URL.Path == "/styles.css":
			next.ServeHTTP(w, r)
			return
		case s.authenticated(r):
			next.ServeHTTP(w, r)
			return
		case strings.HasPrefix(r.URL.Path, "/api/"):
			writeError(w, http.StatusUnauthorized, errors.New("authentication required"))
			return
		default:
			http.Redirect(w, r, "/login.html", http.StatusSeeOther)
			return
		}
	})
}

func (s *apiServer) authenticated(r *http.Request) bool {
	cookie, err := r.Cookie(sessionCookieName)
	return err == nil && subtle.ConstantTimeCompare([]byte(cookie.Value), []byte(s.sessionToken)) == 1
}

func (s *apiServer) serveLogin(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
		return
	}
	var input struct {
		Password string `json:"password"`
	}
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	want := sha256.Sum256([]byte(s.password))
	got := sha256.Sum256([]byte(input.Password))
	if subtle.ConstantTimeCompare(got[:], want[:]) != 1 {
		writeError(w, http.StatusUnauthorized, errors.New("invalid password"))
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    s.sessionToken,
		Path:     "/",
		HttpOnly: true,
		Secure:   r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https"),
		SameSite: http.SameSiteStrictMode,
	})
	writeJSON(w, http.StatusOK, map[string]bool{"authenticated": true})
}

func (s *apiServer) serveLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
	})
	writeJSON(w, http.StatusOK, map[string]bool{"authenticated": false})
}

func (s *apiServer) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'")
		next.ServeHTTP(w, r)
	})
}
