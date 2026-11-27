// Package adminapi 是 loom 的管理 HTTP API（gin），挂在运维端口的 /v1 下。
//
// 认证：Authorization: Bearer <token>（或 X-Admin-Token）。GET 请求需要 read 角色，其余方法需要 write 角色；
// 每个写请求记录一条管理操作审计（请求体脱敏）。
package adminapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/pprof"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/account"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/maintenance"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/operator"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
)

const (
	defaultListLimit = 200
	maxListLimit     = 1000

	maxAuditedBody = 64 << 10
	auditTimeout   = 2 * time.Second
)

// redactedFields 是审计时脱敏的请求体字段。
var redactedFields = map[string]bool{"plaintext": true, "token": true, "password": true, "secret": true}

// Options 管理 API 参数。
type Options struct {
	Pprof bool // 是否在 /debug/pprof 暴露 pprof（需要 read 角色）
	Log   *slog.Logger
	// Maintenance 立即执行一轮数据维护；为 nil 时 POST /v1/admin/maintenance 返回 501。
	Maintenance Maintainer
}

// Maintainer 执行一轮数据维护（maintenance.Runner 实现），返回各任务的结果。
type Maintainer interface {
	RunOnce(ctx context.Context) maintenance.Report
}

// API 管理 API。
type API struct {
	accounts  *account.Service
	operators *operator.Service
	opts      Options
}

// New 创建管理 API。
func New(accounts *account.Service, operators *operator.Service, opts Options) *API {
	return &API{accounts: accounts, operators: operators, opts: opts}
}

// Handler 返回挂载好 /v1 路由（以及开启时的 /debug/pprof）的 http.Handler。
func (a *API) Handler() http.Handler {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	// 让 gin.Context 作为 context.Context 传给下游时能取到请求 context 中的值（如操作者）
	r.ContextWithFallback = true
	r.Use(gin.Recovery())

	v1 := r.Group("/v1", a.authenticate, a.auditWrites)
	v1.GET("/accounts", a.listAccounts)
	v1.POST("/accounts", a.createAccount)
	v1.GET("/accounts/:id", a.getAccount)
	v1.PATCH("/accounts/:id", a.updateAccount)
	v1.POST("/accounts/:id/topup", a.topUpAccount)
	v1.POST("/accounts/:id/quota", a.resetAccountQuota)
	v1.GET("/accounts/:id/keys", a.listAccountAPIKeys)

	v1.GET("/keys", a.listAPIKeys)
	v1.POST("/keys", a.createAPIKey)
	v1.GET("/keys/:id", a.getAPIKey)
	v1.PATCH("/keys/:id", a.updateAPIKey)
	v1.POST("/keys/:id/quota", a.resetAPIKeyQuota)
	v1.GET("/quota-adjustments", a.listQuotaAdjustments)

	v1.GET("/pricing", a.getPricing)
	v1.PUT("/pricing/:model", a.upsertPrice)
	v1.DELETE("/pricing/:model", a.deletePrice)
	v1.GET("/catalog", a.getCatalog)

	v1.GET("/usage/events", a.listUsage)
	v1.GET("/usage/summary", a.usageSummary)
	v1.GET("/admission/audit", a.listAudit)
	v1.GET("/reservations", a.listReservations)

	v1.GET("/admin/tokens", a.listAdminTokens)
	v1.POST("/admin/tokens", a.issueAdminToken)
	v1.DELETE("/admin/tokens/:id", a.revokeAdminToken)
	v1.GET("/admin/audit", a.listAdminAudit)
	v1.POST("/admin/maintenance", a.runMaintenance)

	if a.opts.Pprof {
		debug := r.Group("/debug/pprof", a.authenticate)
		debug.GET("/*profile", gin.WrapF(servePprof))
	}
	return r
}

// servePprof 按路径分发到 net/http/pprof 的各个 handler。
func servePprof(w http.ResponseWriter, r *http.Request) {
	switch strings.TrimPrefix(r.URL.Path, "/debug/pprof/") {
	case "cmdline":
		pprof.Cmdline(w, r)
	case "profile":
		pprof.Profile(w, r)
	case "symbol":
		pprof.Symbol(w, r)
	case "trace":
		pprof.Trace(w, r)
	default:
		pprof.Index(w, r)
	}
}

// authenticate 认证操作者并按方法检查角色：GET / HEAD 需要 read，其余需要 write。
func (a *API) authenticate(c *gin.Context) {
	token := c.GetHeader("X-Admin-Token")
	if auth := c.GetHeader("Authorization"); len(auth) > 7 && strings.EqualFold(auth[:7], "bearer ") {
		token = strings.TrimSpace(auth[7:])
	}
	op, err := a.operators.Authenticate(c, token)
	switch {
	case errors.Is(err, operator.ErrUnauthenticated):
		abort(c, http.StatusUnauthorized, "unauthorized", "valid admin token required")
		return
	case err != nil:
		fail(c, err)
		return
	}
	required := operator.RoleWrite
	if c.Request.Method == http.MethodGet || c.Request.Method == http.MethodHead {
		required = operator.RoleRead
	}
	if !op.Role.Allows(required) {
		abort(c, http.StatusForbidden, "forbidden", "admin token role "+string(op.Role)+" cannot "+c.Request.Method)
		return
	}
	c.Request = c.Request.WithContext(operator.WithOperator(c.Request.Context(), op))
	c.Next()
}

// auditWrites 为每个写请求记录操作者、路由、目标、脱敏后的请求体与响应码。
func (a *API) auditWrites(c *gin.Context) {
	if c.Request.Method == http.MethodGet || c.Request.Method == http.MethodHead {
		c.Next()
		return
	}
	body, _ := io.ReadAll(io.LimitReader(c.Request.Body, maxAuditedBody))
	c.Request.Body = io.NopCloser(bytes.NewReader(body))
	c.Next()

	op, _ := operator.FromContext(c.Request.Context())
	row := store.AdminAudit{
		Actor:   op.Name,
		Method:  c.Request.Method,
		Route:   c.FullPath(),
		Target:  c.Param("id") + c.Param("model"),
		Request: redact(body),
		Status:  c.Writer.Status(),
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(c.Request.Context()), auditTimeout)
	defer cancel()
	if err := a.operators.RecordAudit(ctx, row); err != nil && a.opts.Log != nil {
		a.opts.Log.Error("record admin audit failed", "err", err, "route", row.Route, "actor", row.Actor)
	}
}

// redact 脱敏 JSON 请求体的敏感字段；非 JSON 对象的请求体不记录内容。
func redact(body []byte) string {
	if len(bytes.TrimSpace(body)) == 0 {
		return ""
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil {
		return ""
	}
	for name := range fields {
		if redactedFields[strings.ToLower(name)] {
			fields[name] = json.RawMessage(`"***"`)
		}
	}
	out, _ := json.Marshal(fields)
	return string(out)
}

func (a *API) listAccounts(c *gin.Context) {
	rows, err := a.accounts.ListAccounts(c, listLimit(c))
	if err != nil {
		fail(c, err)
		return
	}
	views := make([]accountView, 0, len(rows))
	for _, row := range rows {
		views = append(views, newAccountView(row))
	}
	c.JSON(http.StatusOK, gin.H{"accounts": views})
}

func (a *API) createAccount(c *gin.Context) {
	var in account.CreateAccountInput
	if !bind(c, &in) {
		return
	}
	created, err := a.accounts.CreateAccount(c, in)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusCreated, newAccountView(created))
}

func (a *API) getAccount(c *gin.Context) {
	id, ok := pathID(c)
	if !ok {
		return
	}
	acct, err := a.accounts.GetAccount(c, id)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, newAccountView(acct))
}

func (a *API) updateAccount(c *gin.Context) {
	id, ok := pathID(c)
	var in account.UpdateAccountInput
	if !ok || !bind(c, &in) {
		return
	}
	acct, err := a.accounts.UpdateAccount(c, id, in)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, newAccountView(acct))
}

func (a *API) topUpAccount(c *gin.Context) {
	id, ok := pathID(c)
	var in struct {
		Nanos int64 `json:"nanos"`
	}
	if !ok || !bind(c, &in) {
		return
	}
	acct, err := a.accounts.TopUp(c, id, in.Nanos)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, newAccountView(acct))
}

func (a *API) resetAccountQuota(c *gin.Context) {
	id, ok := pathID(c)
	var in account.QuotaReset
	if !ok || !bind(c, &in) {
		return
	}
	acct, err := a.accounts.ResetAccountQuota(c, id, in)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, newAccountView(acct))
}

func (a *API) listAccountAPIKeys(c *gin.Context) {
	id, ok := pathID(c)
	if !ok {
		return
	}
	a.respondKeys(c, &id)
}

// ---- api keys ----

func (a *API) listAPIKeys(c *gin.Context) {
	a.respondKeys(c, queryID(c, "account_id"))
}

func (a *API) respondKeys(c *gin.Context, accountID *uuid.UUID) {
	rows, err := a.accounts.ListAPIKeys(c, accountID, listLimit(c))
	if err != nil {
		fail(c, err)
		return
	}
	views := make([]apiKeyView, 0, len(rows))
	for _, row := range rows {
		views = append(views, newAPIKeyView(row))
	}
	c.JSON(http.StatusOK, gin.H{"keys": views})
}

func (a *API) createAPIKey(c *gin.Context) {
	var in account.CreateAPIKeyInput
	if !bind(c, &in) {
		return
	}
	issued, err := a.accounts.CreateAPIKey(c, in)
	if err != nil {
		fail(c, err)
		return
	}
	// 明文只在创建时返回这一次
	c.JSON(http.StatusCreated, gin.H{"key": newAPIKeyView(issued.APIKey), "plaintext": issued.Plaintext})
}

func (a *API) getAPIKey(c *gin.Context) {
	id, ok := pathID(c)
	if !ok {
		return
	}
	apiKey, err := a.accounts.GetAPIKey(c, id)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, newAPIKeyView(apiKey))
}

func (a *API) updateAPIKey(c *gin.Context) {
	id, ok := pathID(c)
	var in account.APIKeyUpdate
	if !ok || !bind(c, &in) {
		return
	}
	apiKey, err := a.accounts.UpdateAPIKey(c, id, in)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, newAPIKeyView(apiKey))
}

func (a *API) resetAPIKeyQuota(c *gin.Context) {
	id, ok := pathID(c)
	var in account.QuotaReset
	if !ok || !bind(c, &in) {
		return
	}
	apiKey, err := a.accounts.ResetAPIKeyQuota(c, id, in)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, newAPIKeyView(apiKey))
}

// ---- pricing ----

func (a *API) getPricing(c *gin.Context) {
	view, err := a.accounts.Pricing(c)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, view)
}

func (a *API) upsertPrice(c *gin.Context) {
	var in account.ModelPriceInput
	if !bind(c, &in) {
		return
	}
	model := c.Param("model")
	if err := a.accounts.UpsertModelPrice(c, model, in); err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"model": model, "source": "pg"})
}

func (a *API) deletePrice(c *gin.Context) {
	if err := a.accounts.DeleteModelPrice(c, c.Param("model")); err != nil {
		fail(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *API) getCatalog(c *gin.Context) {
	catalog, err := a.accounts.AgentGatewayCatalog(c)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, catalog)
}

// ---- reports ----

func (a *API) listUsage(c *gin.Context) {
	rows, err := a.accounts.ListUsage(c, queryID(c, "key_id"), nil, listLimit(c))
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"events": rows})
}

func (a *API) usageSummary(c *gin.Context) {
	filter := store.UsageFilter{AccountID: queryID(c, "account_id"), APIKeyID: queryID(c, "key_id")}
	if v := c.Query("since"); v != "" {
		since, err := time.Parse(time.RFC3339, v)
		if err != nil {
			abort(c, http.StatusBadRequest, "bad_request", "since must be RFC3339")
			return
		}
		filter.Since = &since
	}
	rows, totals, err := a.accounts.UsageSummary(c, filter)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"rows": rows, "total": totals})
}

func (a *API) listAudit(c *gin.Context) {
	rows, err := a.accounts.ListAudit(c, queryID(c, "key_id"), listLimit(c))
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"audit": rows})
}

func (a *API) listReservations(c *gin.Context) {
	rows, err := a.accounts.ListReservations(c, listLimit(c))
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"reservations": rows})
}

// ---- helpers ----

func bind(c *gin.Context, dst any) bool {
	if err := c.ShouldBindJSON(dst); err != nil {
		abort(c, http.StatusBadRequest, "bad_request", err.Error())
		return false
	}
	return true
}

func pathID(c *gin.Context) (uuid.UUID, bool) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		abort(c, http.StatusBadRequest, "bad_request", "invalid id")
		return uuid.Nil, false
	}
	return id, true
}

func queryID(c *gin.Context, name string) *uuid.UUID {
	id, err := uuid.Parse(c.Query(name))
	if err != nil {
		return nil
	}
	return &id
}

func listLimit(c *gin.Context) int {
	n, err := strconv.Atoi(c.Query("limit"))
	if err != nil || n <= 0 || n > maxListLimit {
		return defaultListLimit
	}
	return n
}

// fail 把领域错误映射为 HTTP 状态码。
func fail(c *gin.Context, err error) {
	switch {
	case errors.Is(err, account.ErrInvalidInput), errors.Is(err, operator.ErrInvalidInput):
		abort(c, http.StatusBadRequest, "bad_request", err.Error())
	case errors.Is(err, account.ErrNotFound):
		abort(c, http.StatusNotFound, "not_found", err.Error())
	case errors.Is(err, account.ErrConflict):
		abort(c, http.StatusConflict, "conflict", err.Error())
	default:
		_ = c.Error(err)
		abort(c, http.StatusInternalServerError, "internal", "internal error")
	}
}

func abort(c *gin.Context, status int, code, message string) {
	c.AbortWithStatusJSON(status, gin.H{"error": gin.H{"code": code, "message": message}})
}

// ---- 额度变更流水 ----

func (a *API) listQuotaAdjustments(c *gin.Context) {
	filter := store.QuotaAdjustmentFilter{AccountID: queryID(c, "account_id"), APIKeyID: queryID(c, "key_id")}
	rows, err := a.accounts.ListQuotaAdjustments(c, filter, listLimit(c))
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"adjustments": rows})
}

// ---- 管理 token 与审计 ----

func (a *API) listAdminTokens(c *gin.Context) {
	tokens, err := a.operators.ListTokens(c)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"tokens": tokens})
}

func (a *API) issueAdminToken(c *gin.Context) {
	var in operator.IssueTokenInput
	if !bind(c, &in) {
		return
	}
	issued, err := a.operators.IssueToken(c, in)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"token": issued.Token, "plaintext": issued.Plaintext})
}

func (a *API) revokeAdminToken(c *gin.Context) {
	id, ok := pathID(c)
	if !ok {
		return
	}
	if err := a.operators.RevokeToken(c, id); err != nil {
		fail(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *API) listAdminAudit(c *gin.Context) {
	rows, err := a.operators.ListAudit(c, listLimit(c))
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"audit": rows})
}

// runMaintenance 立即执行一轮数据维护（建分区、日汇总、保留期清理），用于运维与验收；平时由后台每 retention.interval 执行。
func (a *API) runMaintenance(c *gin.Context) {
	if a.opts.Maintenance == nil {
		c.JSON(http.StatusNotImplemented, gin.H{"error": "maintenance is not configured"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"tasks": a.opts.Maintenance.RunOnce(c)})
}
