// Package adminapi 是 loom 的管理 HTTP API（gin），挂在运维端口的 /v1 下，需要管理 token。
package adminapi

import (
	"crypto/subtle"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/account"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
)

const (
	defaultListLimit = 200
	maxListLimit     = 1000
)

// API 管理 API。
type API struct {
	accounts *account.Service
	token    string
}

// New 创建管理 API。
func New(accounts *account.Service, token string) *API {
	return &API{accounts: accounts, token: token}
}

// Handler 返回挂载好全部 /v1 路由的 http.Handler。
func (a *API) Handler() http.Handler {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery())

	v1 := r.Group("/v1", a.requireToken)
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

	v1.GET("/pricing", a.getPricing)
	v1.PUT("/pricing/:model", a.upsertPrice)
	v1.DELETE("/pricing/:model", a.deletePrice)
	v1.GET("/catalog", a.getCatalog)

	v1.GET("/usage/events", a.listUsage)
	v1.GET("/usage/summary", a.usageSummary)
	v1.GET("/admission/audit", a.listAudit)
	v1.GET("/auth/audit", a.listAudit) // 兼容旧路径
	v1.GET("/reservations", a.listReservations)
	return r
}

func (a *API) requireToken(c *gin.Context) {
	token := c.GetHeader("X-Admin-Token")
	if auth := c.GetHeader("Authorization"); len(auth) > 7 && strings.EqualFold(auth[:7], "bearer ") {
		token = strings.TrimSpace(auth[7:])
	}
	if subtle.ConstantTimeCompare([]byte(token), []byte(a.token)) != 1 {
		abort(c, http.StatusUnauthorized, "unauthorized", "admin token required")
		return
	}
	c.Next()
}

// ---- accounts ----

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
	case errors.Is(err, account.ErrInvalidInput):
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
