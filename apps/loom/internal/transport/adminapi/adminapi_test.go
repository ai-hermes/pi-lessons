package adminapi

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/account"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/maintenance"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/operator"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/pricing"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store/memstore"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/telemetry"
)

const bootstrapToken = "bootstrap-secret"

type noopCaches struct{}

func (noopCaches) InvalidateAPIKey(context.Context, uuid.UUID)  {}
func (noopCaches) InvalidateAccount(context.Context, uuid.UUID) {}
func (noopCaches) InvalidateModelPrice(context.Context, string) {}

type fixture struct {
	st        *memstore.Store
	operators *operator.Service
	handler   http.Handler
}

func newFixture(t *testing.T, opts Options) *fixture {
	t.Helper()
	file := filepath.Join(t.TempDir(), "pricing.yaml")
	require.NoError(t, os.WriteFile(file, []byte("models:\n  m: {model_ratio: 1}\n"), 0o600))
	st := memstore.New()
	log := slog.New(slog.DiscardHandler)
	prices, err := pricing.New(pricing.Options{File: file}, st, telemetry.NewMetrics("test", "test"), log)
	require.NoError(t, err)
	operators := operator.New(st, bootstrapToken)
	opts.Log = log
	api := New(account.New(st, prices, "", noopCaches{}), operators, opts)
	return &fixture{st: st, operators: operators, handler: api.Handler()}
}

func (f *fixture) do(t *testing.T, method, path, token, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequestWithContext(context.Background(), method, path, strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	f.handler.ServeHTTP(rec, req)
	return rec
}

func (f *fixture) issue(t *testing.T, name string, role operator.Role) string {
	t.Helper()
	issued, err := f.operators.IssueToken(context.Background(), operator.IssueTokenInput{Name: name, Role: role})
	require.NoError(t, err)
	return issued.Plaintext
}

func TestRolesAreEnforcedByMethod(t *testing.T) {
	f := newFixture(t, Options{})
	reader := f.issue(t, "reader", operator.RoleRead)
	writer := f.issue(t, "writer", operator.RoleWrite)
	createAccount := `{"name":"acme"}`

	assert.Equal(t, http.StatusUnauthorized, f.do(t, http.MethodGet, "/v1/accounts", "", "").Code)
	assert.Equal(t, http.StatusUnauthorized, f.do(t, http.MethodGet, "/v1/accounts", "wrong", "").Code)
	assert.Equal(t, http.StatusOK, f.do(t, http.MethodGet, "/v1/accounts", reader, "").Code)
	assert.Equal(t, http.StatusForbidden, f.do(t, http.MethodPost, "/v1/accounts", reader, createAccount).Code)
	assert.Equal(t, http.StatusCreated, f.do(t, http.MethodPost, "/v1/accounts", writer, createAccount).Code)
	assert.Equal(t, http.StatusOK, f.do(t, http.MethodGet, "/v1/accounts", bootstrapToken, "").Code)
}

func TestWritesAreAuditedWithRedactedBody(t *testing.T) {
	f := newFixture(t, Options{})
	writer := f.issue(t, "writer", operator.RoleWrite)

	rec := f.do(t, http.MethodPost, "/v1/admin/tokens", writer, `{"name":"ci","role":"read","token":"leak"}`)
	require.Equal(t, http.StatusCreated, rec.Code)
	f.do(t, http.MethodGet, "/v1/accounts", writer, "") // 读请求不审计

	rows, err := f.st.ListAdminAudit(context.Background(), 10)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	assert.Equal(t, "writer", rows[0].Actor)
	assert.Equal(t, "/v1/admin/tokens", rows[0].Route)
	assert.Equal(t, http.StatusCreated, rows[0].Status)
	assert.NotContains(t, rows[0].Request, "leak")
	assert.Contains(t, rows[0].Request, `"token":"***"`)
}

func TestQuotaChangesRecordTheOperator(t *testing.T) {
	f := newFixture(t, Options{})
	writer := f.issue(t, "finance", operator.RoleWrite)
	rec := f.do(t, http.MethodPost, "/v1/accounts", writer, `{"name":"acme","quota_limit_nanos":100}`)
	require.Equal(t, http.StatusCreated, rec.Code)
	var created store.Account
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &created))

	topUp := f.do(t, http.MethodPost, "/v1/accounts/"+created.ID.String()+"/topup", writer, `{"nanos":50}`)
	require.Equal(t, http.StatusOK, topUp.Code, topUp.Body.String())

	adjustments, err := f.st.ListQuotaAdjustments(context.Background(), store.QuotaAdjustmentFilter{}, 10)
	require.NoError(t, err)
	require.Len(t, adjustments, 1)
	assert.Equal(t, "finance", adjustments[0].Actor, "the operator reaches the store through the gin context")
	assert.Equal(t, store.QuotaTopUp, adjustments[0].Kind)
	assert.Equal(t, int64(100), *adjustments[0].LimitBefore)
	assert.Equal(t, int64(150), *adjustments[0].LimitAfter)
}

func TestRevokedTokenLosesAccess(t *testing.T) {
	f := newFixture(t, Options{})
	rec := f.do(t, http.MethodPost, "/v1/admin/tokens", bootstrapToken, `{"name":"temp","role":"read"}`)
	require.Equal(t, http.StatusCreated, rec.Code)
	var issued struct {
		Token     store.AdminToken `json:"token"`
		Plaintext string           `json:"plaintext"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &issued))
	require.Equal(t, http.StatusOK, f.do(t, http.MethodGet, "/v1/accounts", issued.Plaintext, "").Code)

	revoke := f.do(t, http.MethodDelete, "/v1/admin/tokens/"+issued.Token.ID.String(), bootstrapToken, "")
	require.Equal(t, http.StatusNoContent, revoke.Code)

	assert.Equal(t, http.StatusUnauthorized, f.do(t, http.MethodGet, "/v1/accounts", issued.Plaintext, "").Code)
}

func TestPprofIsOffByDefaultAndAuthenticatedWhenOn(t *testing.T) {
	off := newFixture(t, Options{})
	assert.Equal(t, http.StatusNotFound, off.do(t, http.MethodGet, "/debug/pprof/", bootstrapToken, "").Code)

	on := newFixture(t, Options{Pprof: true})
	reader := on.issue(t, "reader", operator.RoleRead)
	assert.Equal(t, http.StatusUnauthorized, on.do(t, http.MethodGet, "/debug/pprof/", "", "").Code)
	assert.Equal(t, http.StatusOK, on.do(t, http.MethodGet, "/debug/pprof/", reader, "").Code)
}

func TestRedact(t *testing.T) {
	assert.Empty(t, redact(nil))
	assert.Empty(t, redact([]byte("not json")))
	assert.JSONEq(t, `{"name":"a","plaintext":"***"}`, redact([]byte(`{"name":"a","plaintext":"secret"}`)))
}

func TestRateLimitsAreValidatedAndShown(t *testing.T) {
	f := newFixture(t, Options{})
	writer := f.issue(t, "writer", operator.RoleWrite)

	rec := f.do(t, http.MethodPost, "/v1/accounts", writer, `{"name":"acme","rate_limits":{"rpm":0}}`)
	assert.Equal(t, http.StatusBadRequest, rec.Code, "limits must be positive")

	rec = f.do(t, http.MethodPost, "/v1/accounts", writer, `{"name":"acme","rate_limits":{"rpm":60,"max_concurrency":4}}`)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var created struct {
		ID         string `json:"id"`
		RateLimits struct {
			RPM            *int64 `json:"rpm"`
			TPM            *int64 `json:"tpm"`
			MaxConcurrency *int64 `json:"max_concurrency"`
		} `json:"rate_limits"`
		InFlight int64 `json:"in_flight"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &created))
	assert.Equal(t, int64(60), *created.RateLimits.RPM)
	assert.Nil(t, created.RateLimits.TPM)
	assert.Equal(t, int64(4), *created.RateLimits.MaxConcurrency)

	rec = f.do(t, http.MethodPatch, "/v1/accounts/"+created.ID, writer, `{"rate_limits":{"tpm":1000}}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &created))
	assert.Nil(t, created.RateLimits.RPM, "rate_limits replaces all three items")
	assert.Equal(t, int64(1000), *created.RateLimits.TPM)
}

type fakeMaintainer struct{ runs int }

func (m *fakeMaintainer) RunOnce(context.Context) maintenance.Report {
	m.runs++
	return maintenance.Report{maintenance.TaskRollup: "ok"}
}

func TestMaintenanceRunsOnDemandForWriters(t *testing.T) {
	maintainer := &fakeMaintainer{}
	f := newFixture(t, Options{Maintenance: maintainer})
	reader := f.issue(t, "reader", operator.RoleRead)
	writer := f.issue(t, "writer", operator.RoleWrite)

	assert.Equal(t, http.StatusForbidden, f.do(t, http.MethodPost, "/v1/admin/maintenance", reader, "").Code)
	rec := f.do(t, http.MethodPost, "/v1/admin/maintenance", writer, "")
	require.Equal(t, http.StatusOK, rec.Code)
	assert.JSONEq(t, `{"tasks":{"rollup":"ok"}}`, rec.Body.String())
	assert.Equal(t, 1, maintainer.runs)

	unconfigured := newFixture(t, Options{})
	writer = unconfigured.issue(t, "writer", operator.RoleWrite)
	assert.Equal(t, http.StatusNotImplemented, unconfigured.do(t, http.MethodPost, "/v1/admin/maintenance", writer, "").Code)
}
