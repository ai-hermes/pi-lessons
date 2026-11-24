package extauth

import (
	"strings"
	"testing"
	"time"
)

func fixedNow() time.Time { return time.Date(2026, 11, 16, 12, 0, 0, 0, time.UTC) }

func testStore() *MemStore {
	s := NewMemStore()
	s.AddKey("sk-lab-alice", Client{ClientID: "alice", Tenant: "tenant-a", Plan: "pro", Status: "active", BudgetCents: 500})
	s.AddKey("sk-lab-bob", Client{ClientID: "bob", Tenant: "tenant-b", Plan: "free", Status: "active", BudgetCents: 100, SpentMicros: 2000000})
	s.AddKey("sk-lab-carol", Client{ClientID: "carol", Tenant: "tenant-a", Plan: "pro", Status: "disabled"})
	s.AddSession("sess_lab_alice", "alice", fixedNow().Add(10*time.Minute))
	s.AddSession("sess_lab_expired", "alice", fixedNow().Add(-time.Minute))
	return s
}

func TestEvaluate(t *testing.T) {
	engine := &Config{JWTSecret: []byte("test-secret"), Now: fixedNow}
	store := testStore()

	validJWT, err := engine.MintHS256(map[string]any{"client_id": "alice", "tenant": "tenant-a"}, time.Minute)
	if err != nil {
		t.Fatalf("mint jwt: %v", err)
	}
	expiredJWT, _ := engine.MintHS256(map[string]any{"client_id": "alice", "exp": fixedNow().Add(-time.Minute).Unix()}, 0)
	unknownClientJWT, _ := engine.MintHS256(map[string]any{"client_id": "dave", "tenant": "tenant-d"}, time.Minute)
	badSignature := validJWT[:strings.LastIndex(validJWT, ".")] + ".deadbeef"

	cases := []struct {
		name    string
		headers map[string]string
		want    int
		reason  string
		client  string
		source  string
	}{
		{"no credential", map[string]string{}, 401, ReasonMissingCredential, "", "none"},
		{"unknown api key", map[string]string{"x-api-key": "sk-lab-nope"}, 401, ReasonUnknownKey, "", "api_key"},
		{"valid api key", map[string]string{"authorization": "Bearer sk-lab-alice"}, 200, ReasonAllowed, "alice", "api_key"},
		{"disabled client", map[string]string{"x-api-key": "sk-lab-carol"}, 403, ReasonInactiveClient, "carol", "api_key"},
		{"budget exhausted", map[string]string{"x-api-key": "sk-lab-bob"}, 429, ReasonBudgetExhausted, "bob", "api_key"},
		{"valid session", map[string]string{"x-session-token": "sess_lab_alice"}, 200, ReasonAllowed, "alice", "session"},
		{"expired session", map[string]string{"x-session-token": "sess_lab_expired"}, 401, ReasonExpiredSession, "", "session"},
		{"valid jwt", map[string]string{"authorization": "Bearer " + validJWT}, 200, ReasonAllowed, "alice", "jwt"},
		{"expired jwt", map[string]string{"authorization": "Bearer " + expiredJWT}, 401, ReasonExpiredJWT, "", "jwt"},
		{"bad jwt signature", map[string]string{"authorization": "Bearer " + badSignature}, 401, ReasonInvalidJWT, "", "jwt"},
		{"jwt for unknown client", map[string]string{"authorization": "Bearer " + unknownClientJWT}, 200, ReasonAllowed, "dave", "jwt"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := engine.Evaluate(store, Request{Method: "GET", Path: "/v1/models", Headers: tc.headers})
			if got.HTTPStatus != tc.want {
				t.Fatalf("status = %d, want %d (reason %s)", got.HTTPStatus, tc.want, got.Reason)
			}
			if got.Reason != tc.reason {
				t.Fatalf("reason = %q, want %q", got.Reason, tc.reason)
			}
			if got.Identity.ClientID != tc.client {
				t.Fatalf("client = %q, want %q", got.Identity.ClientID, tc.client)
			}
			if got.Identity.Source != tc.source {
				t.Fatalf("source = %q, want %q", got.Identity.Source, tc.source)
			}
		})
	}
}

func TestInjectedHeaders(t *testing.T) {
	engine := &Config{JWTSecret: []byte("s"), Now: fixedNow}
	store := testStore()
	got := engine.Evaluate(store, Request{Headers: map[string]string{"x-api-key": "sk-lab-alice"}})
	if !got.Allow {
		t.Fatalf("expected allow, got %s", got.Reason)
	}
	want := map[string]string{
		"X-Client-Id":              "alice",
		"X-Tenant-Id":              "tenant-a",
		"X-Plan":                   "pro",
		"X-Auth-Source":            "api_key",
		"X-Budget-Remaining-Cents": "500",
	}
	for k, v := range want {
		if got.Headers[k] != v {
			t.Errorf("header %s = %q, want %q", k, got.Headers[k], v)
		}
	}
}

func TestBudgetRemainingNeverNegative(t *testing.T) {
	id := Identity{BudgetCents: 10, SpentMicros: 200000}
	if got := id.RemainingCents(); got != 0 {
		t.Fatalf("remaining = %d, want 0", got)
	}
	if got := (Identity{}).RemainingCents(); got != -1 {
		t.Fatalf("unlimited budget should report -1, got %d", got)
	}
}

func TestAuditRecorded(t *testing.T) {
	engine := &Config{JWTSecret: []byte("s"), Now: fixedNow}
	store := testStore()
	engine.Evaluate(store, Request{Method: "GET", Path: "/echo", Headers: map[string]string{"x-api-key": "sk-lab-alice"}})
	engine.Evaluate(store, Request{Method: "GET", Path: "/echo", Headers: map[string]string{"x-api-key": "bad"}})
	if n := len(store.Audits()); n != 2 {
		t.Fatalf("audits = %d, want 2", n)
	}
}
