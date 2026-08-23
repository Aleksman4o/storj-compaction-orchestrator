package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAPIHistoryIsPagedFromDatabase(t *testing.T) {
	o := newTestOrchestrator(t)
	api, err := newAPIServer(o, "")
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/history?limit=7&offset=0&sort=duration&direction=asc", nil)
	recorder := httptest.NewRecorder()
	api.handler().ServeHTTP(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body.String())
	}
	var page historyPage
	if err := json.NewDecoder(recorder.Body).Decode(&page); err != nil {
		t.Fatal(err)
	}
	if page.Total != 0 || page.Limit != 7 || page.Offset != 0 || page.Jobs == nil {
		t.Fatalf("unexpected history page: %+v", page)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/history?offset=invalid", nil)
	recorder = httptest.NewRecorder()
	api.handler().ServeHTTP(recorder, req)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid offset, got %d", recorder.Code)
	}
}

func TestAPIMutationsRequireRequestHeader(t *testing.T) {
	o := newTestOrchestrator(t)
	api, err := newAPIServer(o, "")
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/groups/disk-a/start", nil)
	recorder := httptest.NewRecorder()
	api.handler().ServeHTTP(recorder, req)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", recorder.Code)
	}
}

func TestAPIPasswordAuthentication(t *testing.T) {
	o := newTestOrchestrator(t)
	api, err := newAPIServer(o, "secret")
	if err != nil {
		t.Fatal(err)
	}

	recorder := httptest.NewRecorder()
	api.handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/settings", nil))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("expected unauthenticated API request to return 401, got %d", recorder.Code)
	}
	recorder = httptest.NewRecorder()
	api.handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/", nil))
	if recorder.Code != http.StatusSeeOther || recorder.Header().Get("Location") != "/login.html" {
		t.Fatalf("expected dashboard redirect to password form, got %d %q", recorder.Code, recorder.Header().Get("Location"))
	}
	recorder = httptest.NewRecorder()
	api.handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/login.html", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected login form, got %d", recorder.Code)
	}

	recorder = httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/auth/login", strings.NewReader(`{"password":"wrong"}`))
	api.handler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("expected wrong password to return 401, got %d", recorder.Code)
	}

	recorder = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodPost, "/auth/login", strings.NewReader(`{"password":"secret"}`))
	api.handler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected valid password to return 200, got %d: %s", recorder.Code, recorder.Body.String())
	}
	cookies := recorder.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != sessionCookieName || !cookies[0].HttpOnly {
		t.Fatalf("authentication cookie is missing or unsafe: %+v", cookies)
	}

	recorder = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodGet, "/api/settings", nil)
	request.AddCookie(cookies[0])
	api.handler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected authenticated request to return 200, got %d", recorder.Code)
	}
}
