package admission

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strconv"
	"time"

	"github.com/google/uuid"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/ledger"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/pricing"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/telemetry"
)

// Store 是准入所需的持久化能力。
type Store interface {
	GetAPIKeyByHash(ctx context.Context, hash string) (store.APIKey, error)
	InsertAudit(ctx context.Context, rows []store.Audit) error
}

// Pricer 按模型与分组查单价卡。
type Pricer interface {
	Lookup(ctx context.Context, model, group string) (pricing.UnitPrice, error)
}

// QuotaReserver 预扣额度。
type QuotaReserver interface {
	ReserveQuota(
		ctx context.Context,
		apiKey store.APIKey,
		unitPrice pricing.UnitPrice,
		requestID string,
	) (ledger.ReservationHold, error)
}

// Options 准入参数。
type Options struct {
	// Timeout 单次准入的截止时间；为 0 时不设截止（测试用）。
	Timeout     time.Duration
	APIKeyCache APIKeyCacheOptions
	AuditQueue  int // 审计写入队列长度；0 表示不写审计
}

// Gate 准入门。
type Gate struct {
	store         Store
	pricer        Pricer
	quotaReserver QuotaReserver
	metrics       *telemetry.Metrics
	log           *slog.Logger
	apiKeys       *apiKeyCache
	audit         *auditWriter
	timeout       time.Duration
}

// New 创建准入门；审计写入需另行调用 RunAuditWriter。
func New(
	opts Options,
	storage Store,
	pricer Pricer,
	quotaReserver QuotaReserver,
	metrics *telemetry.Metrics,
	logger *slog.Logger,
) *Gate {
	return &Gate{
		store:         storage,
		pricer:        pricer,
		quotaReserver: quotaReserver,
		metrics:       metrics,
		log:           logger,
		apiKeys:       newAPIKeyCache(opts.APIKeyCache),
		audit:         newAuditWriter(storage, opts.AuditQueue, logger),
		timeout:       opts.Timeout,
	}
}

// RunAuditWriter 批量写入审计记录，阻塞直到 ctx 结束并刷完队列。
func (g *Gate) RunAuditWriter(ctx context.Context) { g.audit.run(ctx) }

// InvalidateAPIKey 清除某把 Key 的缓存（管理 API 修改 Key 后调用；仅作用于当前副本）。
func (g *Gate) InvalidateAPIKey(apiKeyID uuid.UUID) { g.apiKeys.invalidate(apiKeyID) }

// InvalidateAccount 清除某账户下所有 API Key 的缓存（管理 API 修改账户状态或分组后调用；仅作用于当前副本）。
func (g *Gate) InvalidateAccount(accountID uuid.UUID) { g.apiKeys.invalidateAccount(accountID) }

// Admit 对一次请求做准入判断，并记录指标、日志与审计。
func (g *Gate) Admit(ctx context.Context, req Request) Verdict {
	start := time.Now()
	admitCtx := ctx
	if g.timeout > 0 {
		var cancel context.CancelFunc
		admitCtx, cancel = context.WithTimeout(ctx, g.timeout)
		defer cancel()
	}
	v := g.admit(admitCtx, req, uuid.NewString())

	g.metrics.AdmissionDuration.WithLabelValues("total").Observe(time.Since(start).Seconds())
	g.metrics.AdmissionDecisions.WithLabelValues(string(v.Reason), strconv.FormatBool(v.Allowed)).Inc()
	g.audit.record(req, v)
	g.logVerdict(req, v, start)
	return v
}

func (g *Gate) admit(ctx context.Context, req Request, requestID string) Verdict {
	v := Verdict{RequestID: requestID}

	apiKey, denyReason := g.authenticate(ctx, req.Credential)
	if denyReason != "" {
		return v.deny(denyReason)
	}
	v.APIKeyID, v.AccountID, v.AccountName = apiKey.ID, apiKey.AccountID, apiKey.Account.Name
	if denyReason := checkUsable(apiKey, time.Now()); denyReason != "" {
		return v.deny(denyReason)
	}

	v.Model = resolveModel(req)
	if v.Model == "" {
		// 非模型请求（如 /echo）：只鉴权，不定价、不预扣
		return v.allow()
	}
	if !apiKey.AllowsModel(v.Model) {
		return v.deny(ReasonModelNotAllowed)
	}

	unitPrice, denyReason := g.lookupUnitPrice(ctx, v.Model, apiKey.Account.Group)
	if denyReason != "" {
		return v.deny(denyReason)
	}
	reservationHold, denyReason := g.reserveQuota(ctx, apiKey, unitPrice, requestID)
	if denyReason != "" {
		return v.deny(denyReason)
	}
	v.ReservedNanos, v.RemainingNanos = reservationHold.Nanos, reservationHold.Remaining
	return v.allow()
}

// authenticate 用凭据查找 Key；失败时返回拒绝原因。
func (g *Gate) authenticate(ctx context.Context, credential string) (store.APIKey, Reason) {
	if credential == "" {
		return store.APIKey{}, ReasonMissingCredential
	}
	defer g.observe("authenticate", time.Now())

	apiKey, err := g.lookupAPIKey(ctx, store.HashAPIKey(credential))
	switch {
	case errors.Is(err, store.ErrNotFound):
		return store.APIKey{}, ReasonUnknownKey
	case err != nil:
		g.log.Error("api key lookup failed", "err", err)
		return store.APIKey{}, ReasonInternalError
	}
	return apiKey, ""
}

// checkUsable 检查 Key 与账户是否可用。
func checkUsable(apiKey store.APIKey, now time.Time) Reason {
	if !apiKey.Status.IsActive() || !apiKey.Account.Status.IsActive() {
		return ReasonInactive
	}
	if apiKey.ExpiresAt != nil && !apiKey.ExpiresAt.After(now) {
		return ReasonExpiredKey
	}
	return ""
}

// lookupUnitPrice 查找模型与账户分组对应的有效价卡；失败时返回拒绝原因。
func (g *Gate) lookupUnitPrice(ctx context.Context, model, group string) (pricing.UnitPrice, Reason) {
	defer g.observe("price", time.Now())

	unitPrice, err := g.pricer.Lookup(ctx, model, group)
	switch {
	case errors.Is(err, pricing.ErrNotPriced):
		return pricing.UnitPrice{}, ReasonModelNotPriced
	case errors.Is(err, pricing.ErrGroupNotPriced):
		return pricing.UnitPrice{}, ReasonGroupNotPriced
	case err != nil:
		g.log.Error("price lookup failed", "err", err, "model", model)
		return pricing.UnitPrice{}, ReasonInternalError
	}
	return unitPrice, ""
}

// reserveQuota 预扣额度；失败时返回拒绝原因。
func (g *Gate) reserveQuota(
	ctx context.Context,
	apiKey store.APIKey,
	unitPrice pricing.UnitPrice,
	requestID string,
) (ledger.ReservationHold, Reason) {
	defer g.observe("reserve", time.Now())

	reservationHold, err := g.quotaReserver.ReserveQuota(ctx, apiKey, unitPrice, requestID)
	switch {
	case ledger.IsInsufficientQuota(err):
		return ledger.ReservationHold{}, ReasonInsufficientQuota
	case err != nil:
		g.log.Error("reserve failed", "err", err, "key_id", apiKey.ID)
		return ledger.ReservationHold{}, ReasonInternalError
	}
	return reservationHold, ""
}

func (g *Gate) lookupAPIKey(ctx context.Context, hash string) (store.APIKey, error) {
	if apiKey, err, ok := g.apiKeys.get(hash); ok {
		g.metrics.CacheLookups.WithLabelValues("api_key", "hit").Inc()
		return apiKey, err
	}
	g.metrics.CacheLookups.WithLabelValues("api_key", "miss").Inc()

	apiKey, err := g.store.GetAPIKeyByHash(ctx, hash)
	switch {
	case err == nil:
		g.apiKeys.add(hash, apiKey)
	case errors.Is(err, store.ErrNotFound):
		g.apiKeys.addMiss(hash)
	}
	return apiKey, err
}

func (g *Gate) observe(stage string, start time.Time) {
	g.metrics.AdmissionDuration.WithLabelValues(stage).Observe(time.Since(start).Seconds())
}

func (g *Gate) logVerdict(req Request, v Verdict, start time.Time) {
	logAttrs := []any{
		"request_id", v.RequestID,
		"reason", v.Reason,
		"key_id", v.APIKeyID,
		"account", v.AccountName,
		"model", v.Model,
		"protocol", req.Protocol,
		"ms", float64(time.Since(start).Microseconds()) / 1000,
	}
	if v.Allowed {
		g.log.Info("admission allowed", append(logAttrs, "reserved_nanos", v.ReservedNanos)...)
		return
	}
	g.log.Info("admission denied", append(logAttrs, "path", req.Path)...)
}

// resolveModel 取模型名：网关提示优先，其次请求体 JSON 的 model 字段。
func resolveModel(req Request) string {
	if req.ModelHint != "" {
		return req.ModelHint
	}
	if len(req.Body) == 0 || req.Body[0] != '{' {
		return ""
	}
	var body struct {
		Model string `json:"model"`
	}
	if err := json.Unmarshal(req.Body, &body); err != nil {
		return ""
	}
	return body.Model
}
