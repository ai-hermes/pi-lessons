package admin

import (
	"crypto/subtle"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/auth"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
	"github.com/ai-hermes/pi-lessons/apps/loom/pkg/loom"
)

// Handlers 管理 API。
type Handlers struct {
	svc    *Service
	engine *auth.Engine
	token  string
}

// NewHandlers 创建处理器。
func NewHandlers(svc *Service, engine *auth.Engine, token string) *Handlers {
	return &Handlers{svc: svc, engine: engine, token: token}
}

// Register 挂载到 gin 引擎：/v1/* 需要管理 token，/healthz /readyz 不需要。
func (h *Handlers) Register(r *gin.Engine, ready func() bool) {
	r.GET("/healthz", func(c *gin.Context) { c.String(http.StatusOK, "ok") })
	r.GET("/readyz", func(c *gin.Context) {
		if ready != nil && !ready() {
			c.String(http.StatusServiceUnavailable, "not ready")
			return
		}
		c.String(http.StatusOK, "ready")
	})
	v1 := r.Group("/v1", h.authMiddleware())
	v1.GET("/accounts", h.listAccounts)
	v1.POST("/accounts", h.createAccount)
	v1.GET("/accounts/:id", h.getAccount)
	v1.PATCH("/accounts/:id", h.updateAccount)
	v1.POST("/accounts/:id/topup", h.topUpAccount)
	v1.POST("/accounts/:id/quota", h.setAccountQuota)
	v1.GET("/accounts/:id/keys", h.listKeys)
	v1.POST("/keys", h.createKey)
	v1.GET("/keys", h.listKeys)
	v1.GET("/keys/:id", h.getKey)
	v1.PATCH("/keys/:id", h.updateKey)
	v1.POST("/keys/:id/quota", h.setKeyQuota)
	v1.GET("/pricing", h.getPricing)
	v1.PUT("/pricing/:model", h.upsertPricing)
	v1.DELETE("/pricing/:model", h.deletePricing)
	v1.GET("/catalog", h.getCatalog)
	v1.GET("/usage/events", h.usageEvents)
	v1.GET("/usage/summary", h.usageSummary)
	v1.GET("/auth/audit", h.audit)
	v1.GET("/reservations", h.reservations)
}

func (h *Handlers) authMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		token := ""
		if a := c.GetHeader("Authorization"); strings.HasPrefix(strings.ToLower(a), "bearer ") {
			token = strings.TrimSpace(a[7:])
		}
		if token == "" {
			token = c.GetHeader("X-Admin-Token")
		}
		if subtle.ConstantTimeCompare([]byte(token), []byte(h.token)) != 1 {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": gin.H{"code": "unauthorized", "message": "admin token required"}})
			return
		}
		c.Next()
	}
}

func parseUUID(c *gin.Context, name string) (uuid.UUID, bool) {
	id, err := uuid.Parse(c.Param(name))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "bad_request", "message": "invalid " + name}})
		return uuid.Nil, false
	}
	return id, true
}

func errResponse(c *gin.Context, err error) {
	if errors.Is(err, loom.ErrNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": gin.H{"code": "not_found", "message": err.Error()}})
		return
	}
	c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"code": "internal", "message": err.Error()}})
}

func accountView(a store.Account) gin.H {
	h := gin.H{"id": a.ID, "name": a.Name, "tenant": a.Tenant, "group": a.Group, "status": a.Status,
		"quota_used_nanos": a.QuotaUsed, "reserved_nanos": a.Reserved, "created_at": a.CreatedAt, "updated_at": a.UpdatedAt}
	if a.QuotaLimit != nil {
		h["quota_limit_nanos"] = *a.QuotaLimit
		h["quota_remaining_nanos"] = *a.QuotaLimit - a.QuotaUsed - a.Reserved
	} else {
		h["quota_limit_nanos"] = nil
	}
	return h
}

func keyView(k store.Key) gin.H {
	h := gin.H{"id": k.ID, "account_id": k.AccountID, "name": k.Name, "key_preview": k.KeyPreview, "status": k.Status,
		"model_allowlist": k.ModelAllowlist, "quota_used_nanos": k.QuotaUsed, "reserved_nanos": k.Reserved,
		"expires_at": k.ExpiresAt, "last_used_at": k.LastUsedAt, "created_at": k.CreatedAt,
		"account": accountView(k.Account)}
	if k.QuotaLimit != nil {
		h["quota_limit_nanos"] = *k.QuotaLimit
		h["quota_remaining_nanos"] = *k.QuotaLimit - k.QuotaUsed - k.Reserved
	} else {
		h["quota_limit_nanos"] = nil
	}
	return h
}

func (h *Handlers) listAccounts(c *gin.Context) {
	rows, err := h.svc.st.ListAccounts(c, limit(c))
	if err != nil {
		errResponse(c, err)
		return
	}
	out := make([]gin.H, 0, len(rows))
	for _, a := range rows {
		out = append(out, accountView(a))
	}
	c.JSON(http.StatusOK, gin.H{"accounts": out})
}

func limit(c *gin.Context) int {
	n, _ := strconv.Atoi(c.DefaultQuery("limit", "200"))
	if n <= 0 || n > 1000 {
		n = 200
	}
	return n
}

func (h *Handlers) createAccount(c *gin.Context) {
	var r CreateAccountReq
	if err := c.ShouldBindJSON(&r); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "bad_request", "message": err.Error()}})
		return
	}
	a, err := h.svc.CreateAccount(c, r)
	if err != nil {
		errResponse(c, err)
		return
	}
	c.JSON(http.StatusCreated, accountView(a))
}

func (h *Handlers) getAccount(c *gin.Context) {
	id, ok := parseUUID(c, "id")
	if !ok {
		return
	}
	a, err := h.svc.st.GetAccount(c, id)
	if err != nil {
		errResponse(c, err)
		return
	}
	c.JSON(http.StatusOK, accountView(a))
}

func (h *Handlers) updateAccount(c *gin.Context) {
	id, ok := parseUUID(c, "id")
	if !ok {
		return
	}
	var r UpdateAccountReq
	if err := c.ShouldBindJSON(&r); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "bad_request", "message": err.Error()}})
		return
	}
	a, err := h.svc.UpdateAccount(c, id, r)
	if err != nil {
		errResponse(c, err)
		return
	}
	c.JSON(http.StatusOK, accountView(a))
}

func (h *Handlers) topUpAccount(c *gin.Context) {
	id, ok := parseUUID(c, "id")
	if !ok {
		return
	}
	var r struct {
		Nanos int64 `json:"nanos"`
	}
	if err := c.ShouldBindJSON(&r); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "bad_request", "message": err.Error()}})
		return
	}
	a, err := h.svc.TopUp(c, id, r.Nanos)
	if err != nil {
		errResponse(c, err)
		return
	}
	c.JSON(http.StatusOK, accountView(a))
}

type quotaReq struct {
	LimitNanos *int64 `json:"quota_limit_nanos"`
	UsedNanos  *int64 `json:"quota_used_nanos"`
}

// setAccountQuota 直接设置账户额度上限与已用量（验收矩阵重置用）。
func (h *Handlers) setAccountQuota(c *gin.Context) {
	id, ok := parseUUID(c, "id")
	if !ok {
		return
	}
	var r quotaReq
	if err := c.ShouldBindJSON(&r); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "bad_request", "message": err.Error()}})
		return
	}
	var used int64
	if r.UsedNanos != nil {
		used = *r.UsedNanos
	}
	if err := h.svc.st.SetAccountQuota(c, id, r.LimitNanos, used); err != nil {
		errResponse(c, err)
		return
	}
	a, err := h.svc.st.GetAccount(c, id)
	if err != nil {
		errResponse(c, err)
		return
	}
	c.JSON(http.StatusOK, accountView(a))
}

// setKeyQuota 直接设置 Key 额度上限与已用量。
func (h *Handlers) setKeyQuota(c *gin.Context) {
	id, ok := parseUUID(c, "id")
	if !ok {
		return
	}
	var r quotaReq
	if err := c.ShouldBindJSON(&r); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "bad_request", "message": err.Error()}})
		return
	}
	var used int64
	if r.UsedNanos != nil {
		used = *r.UsedNanos
	}
	if err := h.svc.st.SetKeyQuota(c, id, r.LimitNanos, used); err != nil {
		errResponse(c, err)
		return
	}
	h.engine.InvalidateKey(id)
	k, err := h.svc.st.GetKey(c, id)
	if err != nil {
		errResponse(c, err)
		return
	}
	c.JSON(http.StatusOK, keyView(k))
}

func (h *Handlers) listKeys(c *gin.Context) {
	var accountID *uuid.UUID
	if v := c.Param("id"); v != "" {
		if id, err := uuid.Parse(v); err == nil {
			accountID = &id
		}
	} else if v := c.Query("account_id"); v != "" {
		if id, err := uuid.Parse(v); err == nil {
			accountID = &id
		}
	}
	rows, err := h.svc.st.ListKeys(c, accountID, limit(c))
	if err != nil {
		errResponse(c, err)
		return
	}
	out := make([]gin.H, 0, len(rows))
	for _, k := range rows {
		out = append(out, keyView(k))
	}
	c.JSON(http.StatusOK, gin.H{"keys": out})
}

func (h *Handlers) createKey(c *gin.Context) {
	var r CreateKeyReq
	if err := c.ShouldBindJSON(&r); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "bad_request", "message": err.Error()}})
		return
	}
	k, err := h.svc.CreateKey(c, r)
	if err != nil {
		errResponse(c, err)
		return
	}
	// 明文 key 只在创建时返回一次
	c.JSON(http.StatusCreated, gin.H{"key": keyView(k.Key), "plaintext": k.Plaintext})
}

func (h *Handlers) getKey(c *gin.Context) {
	id, ok := parseUUID(c, "id")
	if !ok {
		return
	}
	k, err := h.svc.st.GetKey(c, id)
	if err != nil {
		errResponse(c, err)
		return
	}
	c.JSON(http.StatusOK, keyView(k))
}

func (h *Handlers) updateKey(c *gin.Context) {
	id, ok := parseUUID(c, "id")
	if !ok {
		return
	}
	var r UpdateKeyReq
	if err := c.ShouldBindJSON(&r); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "bad_request", "message": err.Error()}})
		return
	}
	k, err := h.svc.UpdateKey(c, id, r)
	if err != nil {
		errResponse(c, err)
		return
	}
	h.engine.InvalidateKey(id)
	c.JSON(http.StatusOK, keyView(k))
}

func (h *Handlers) getPricing(c *gin.Context) {
	cm, pg, err := h.svc.Pricing(c)
	if err != nil {
		errResponse(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"configmap": cm, "pg": pg})
}

func (h *Handlers) upsertPricing(c *gin.Context) {
	var p store.ModelPrice
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "bad_request", "message": err.Error()}})
		return
	}
	p.Model = c.Param("model")
	if err := h.svc.UpsertPricing(c, p); err != nil {
		errResponse(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"model": p.Model, "source": "pg"})
}

func (h *Handlers) deletePricing(c *gin.Context) {
	if err := h.svc.DeletePricing(c, c.Param("model")); err != nil {
		errResponse(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (h *Handlers) getCatalog(c *gin.Context) {
	cat, err := h.svc.pricing.Catalog(c)
	if err != nil {
		errResponse(c, err)
		return
	}
	c.JSON(http.StatusOK, cat)
}

func (h *Handlers) usageEvents(c *gin.Context) {
	var keyID *uuid.UUID
	if v := c.Query("key_id"); v != "" {
		if id, err := uuid.Parse(v); err == nil {
			keyID = &id
		}
	}
	rows, err := h.svc.st.ListUsage(c, keyID, nil, limit(c))
	if err != nil {
		errResponse(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"events": rows})
}

func (h *Handlers) usageSummary(c *gin.Context) {
	f := store.UsageFilter{}
	if v := c.Query("account_id"); v != "" {
		if id, err := uuid.Parse(v); err == nil {
			f.AccountID = &id
		}
	}
	if v := c.Query("key_id"); v != "" {
		if id, err := uuid.Parse(v); err == nil {
			f.KeyID = &id
		}
	}
	if v := c.Query("since"); v != "" {
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			f.Since = &t
		} else {
			c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "bad_request", "message": "since must be RFC3339"}})
			return
		}
	}
	rows, err := h.svc.st.SummaryUsage(c, f)
	if err != nil {
		errResponse(c, err)
		return
	}
	var totalNanos, totalReq, totalGateway int64
	for _, r := range rows {
		totalNanos += r.CostNanos
		totalReq += r.Requests
		totalGateway += r.GatewayCostNanos
	}
	c.JSON(http.StatusOK, gin.H{"rows": rows, "total": gin.H{"requests": totalReq, "cost_nanos": totalNanos, "gateway_cost_nanos": totalGateway}})
}

func (h *Handlers) audit(c *gin.Context) {
	var keyID *uuid.UUID
	if v := c.Query("key_id"); v != "" {
		if id, err := uuid.Parse(v); err == nil {
			keyID = &id
		}
	}
	rows, err := h.svc.st.ListAudit(c, keyID, limit(c))
	if err != nil {
		errResponse(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"audit": rows})
}

func (h *Handlers) reservations(c *gin.Context) {
	rows, err := h.svc.st.ListReservations(c, limit(c))
	if err != nil {
		errResponse(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"reservations": rows})
}
