package extauth

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	authv3 "github.com/envoyproxy/go-control-plane/envoy/service/auth/v3"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/admission"
)

// fakeGate 记录收到的请求并返回固定结论。
type fakeGate struct {
	got     admission.Request
	verdict admission.Verdict
}

func (g *fakeGate) Admit(_ context.Context, req admission.Request) admission.Verdict {
	g.got = req
	return g.verdict
}

func testOptions() Options {
	return Options{
		Headers: Headers{
			Credentials:     []string{"authorization", "x-api-key"},
			ClientRequestID: "x-request-id",
			Model:           "x-loom-model",
			Account:         "x-loom-client-id",
			KeyID:           "x-loom-key-id",
			RequestID:       "x-loom-request-id",
			QuotaRemaining:  "x-loom-quota-remaining",
			DenyReason:      "x-loom-deny-reason",
		},
		DenyStatus: map[admission.Reason]int{admission.ReasonInsufficientQuota: http.StatusForbidden},
		BodyLimit:  1 << 20,
	}
}

func TestHTTPAllowCarriesIdentityHeaders(t *testing.T) {
	remaining := int64(42)
	gate := &fakeGate{verdict: admission.Verdict{
		Allowed: true, Reason: admission.ReasonAllowed, RequestID: "req-1",
		KeyID: uuid.MustParse("11111111-1111-1111-1111-111111111111"), AccountName: "alice",
		Model: "lab-model", RemainingNanos: &remaining,
	}}
	req := httptest.NewRequest(http.MethodPost, CheckPath, bytes.NewReader([]byte(`{"model":"lab-model"}`)))
	req.Header.Set("Authorization", "Bearer loom-secret")
	req.Header.Set("X-Request-Id", "client-req")
	rec := httptest.NewRecorder()

	NewHTTPHandler(gate, testOptions()).ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "alice", rec.Header().Get("x-loom-client-id"))
	assert.Equal(t, "req-1", rec.Header().Get("x-loom-request-id"))
	assert.Equal(t, "lab-model", rec.Header().Get("x-loom-model"))
	assert.Equal(t, "42", rec.Header().Get("x-loom-quota-remaining"))
	assert.Equal(t, "loom-secret", gate.got.Credential, "Bearer prefix stripped")
	assert.Equal(t, "client-req", gate.got.ClientRequestID)
	assert.Equal(t, "http", gate.got.Protocol)
}

func TestHTTPDenyReturnsOpenAIErrorBody(t *testing.T) {
	gate := &fakeGate{verdict: admission.Verdict{Reason: admission.ReasonInsufficientQuota}}
	req := httptest.NewRequest(http.MethodGet, CheckPath, http.NoBody)
	rec := httptest.NewRecorder()

	NewHTTPHandler(gate, testOptions()).ServeHTTP(rec, req)

	assert.Equal(t, http.StatusForbidden, rec.Code)
	assert.Equal(t, "insufficient_quota", rec.Header().Get("x-loom-deny-reason"))
	var body struct {
		Error struct{ Code, Type string }
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, "insufficient_quota", body.Error.Code)
	assert.Equal(t, "quota_error", body.Error.Type)
}

func TestUnlistedReasonDefaultsTo401(t *testing.T) {
	assert.Equal(t, http.StatusUnauthorized, testOptions().statusFor(admission.ReasonUnknownKey))
}

func TestCredentialExtraction(t *testing.T) {
	names := []string{"authorization", "x-api-key"}
	tests := []struct {
		name     string
		headers  map[string]string
		expected string
	}{
		{name: "bearer", headers: map[string]string{"authorization": "Bearer k1"}, expected: "k1"},
		{name: "bearer case insensitive", headers: map[string]string{"authorization": "bearer k1"}, expected: "k1"},
		{name: "raw authorization", headers: map[string]string{"authorization": "k1"}, expected: "k1"},
		{name: "fallback header", headers: map[string]string{"x-api-key": "k2"}, expected: "k2"},
		{
			name:     "authorization wins",
			headers:  map[string]string{"authorization": "Bearer k1", "x-api-key": "k2"},
			expected: "k1",
		},
		{name: "none", headers: map[string]string{}, expected: ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.expected, credential(tt.headers, names))
		})
	}
}

func TestGRPCMatchesHTTP(t *testing.T) {
	gate := &fakeGate{verdict: admission.Verdict{Reason: admission.ReasonUnknownKey}}
	req := &authv3.CheckRequest{Attributes: &authv3.AttributeContext{Request: &authv3.AttributeContext_Request{
		Http: &authv3.AttributeContext_HttpRequest{
			Headers: map[string]string{"x-api-key": "bogus", ":path": "/grpc"},
			Path:    "/grpc",
		},
	}}}

	resp, err := NewGRPCServer(gate, testOptions()).Check(context.Background(), req)

	require.NoError(t, err)
	denied := resp.GetDeniedResponse()
	require.NotNil(t, denied)
	assert.EqualValues(t, http.StatusUnauthorized, denied.GetStatus().GetCode())
	assert.Equal(t, "bogus", gate.got.Credential)
	assert.Equal(t, "grpc", gate.got.Protocol)
}
