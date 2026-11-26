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
	GetKeyByHash(ctx context.Context, hash string) (store.Key, error)
	InsertAudit(ctx context.Context, rows []store.Audit) error
}

// Pricer 按模型与分组查单价卡。
type Pricer interface {
	Lookup(ctx context.Context, model, group string) (pricing.Card, error)
}

// Reserver 预扣额度。
type Reserver interface {
	Reserve(ctx context.Context, key store.Key, card pricing.Card, requestID string) (ledger.Hold, error)
}

// Options 准入参数。
type Options struct {
	KeyCache   KeyCacheOptions
	AuditQueue int // 审计写入队列长度；0 表示不写审计
}

// Deps 准入依赖。
type Deps struct {
	Store    Store
	Pricer   Pricer
	Reserver Reserver
	Metrics  *telemetry.Metrics
	Log      *slog.Logger
}

// Gate 准入门。
type Gate struct {
	deps  Deps
	keys  *keyCache
	audit *auditWriter
}

// New 创建准入门；审计写入需另行调用 RunAuditWriter。
func New(opts Options, deps Deps) *Gate {
	return &Gate{
		deps:  deps,
		keys:  newKeyCache(opts.KeyCache),
		audit: newAuditWriter(deps.Store, opts.AuditQueue, deps.Log),
	}
}

// RunAuditWriter 批量写入审计记录，阻塞直到 ctx 结束并刷完队列。
func (g *Gate) RunAuditWriter(ctx context.Context) { g.audit.run(ctx) }

// InvalidateKey 清除某把 Key 的缓存（管理 API 修改 Key 后调用；仅作用于当前副本）。
func (g *Gate) InvalidateKey(keyID uuid.UUID) { g.keys.invalidate(keyID) }

// Admit 对一次请求做准入判断，并记录指标、日志与审计。
func (g *Gate) Admit(ctx context.Context, req Request) Verdict {
	start := time.Now()
	v := g.admit(ctx, req, uuid.NewString())

	g.deps.Metrics.AdmissionDuration.WithLabelValues("total").Observe(time.Since(start).Seconds())
	g.deps.Metrics.AdmissionDecisions.WithLabelValues(string(v.Reason), strconv.FormatBool(v.Allowed)).Inc()
	g.audit.record(req, v)
	g.logVerdict(req, v, start)
	return v
}

func (g *Gate) admit(ctx context.Context, req Request, requestID string) Verdict {
	v := Verdict{RequestID: requestID}

	key, reason := g.authenticate(ctx, req.Credential)
	if reason != "" {
		return v.deny(reason)
	}
	v.KeyID, v.AccountID, v.AccountName = key.ID, key.AccountID, key.Account.Name
	if reason := checkUsable(key, time.Now()); reason != "" {
		return v.deny(reason)
	}

	v.Model = resolveModel(req)
	if v.Model == "" {
		// 非模型请求（如 /echo）：只鉴权，不定价、不预扣
		return v.allow()
	}
	if !key.AllowsModel(v.Model) {
		return v.deny(ReasonModelNotAllowed)
	}

	card, reason := g.price(ctx, v.Model, key.Account.Group)
	if reason != "" {
		return v.deny(reason)
	}
	hold, reason := g.reserve(ctx, key, card, requestID)
	if reason != "" {
		return v.deny(reason)
	}
	v.ReservedNanos, v.RemainingNanos = hold.Nanos, hold.Remaining
	return v.allow()
}

// authenticate 用凭据查找 Key；失败时返回拒绝原因。
func (g *Gate) authenticate(ctx context.Context, credential string) (store.Key, Reason) {
	if credential == "" {
		return store.Key{}, ReasonMissingCredential
	}
	defer g.observe("authenticate", time.Now())

	key, err := g.lookupKey(ctx, store.HashAPIKey(credential))
	switch {
	case errors.Is(err, store.ErrNotFound):
		return store.Key{}, ReasonUnknownKey
	case err != nil:
		g.deps.Log.Error("key lookup failed", "err", err)
		return store.Key{}, ReasonInternalError
	}
	return key, ""
}

// checkUsable 检查 Key 与账户是否可用。
func checkUsable(key store.Key, now time.Time) Reason {
	if !key.Status.IsActive() || !key.Account.Status.IsActive() {
		return ReasonInactive
	}
	if key.ExpiresAt != nil && !key.ExpiresAt.After(now) {
		return ReasonExpiredKey
	}
	return ""
}

// price 查单价卡；失败时返回拒绝原因。
func (g *Gate) price(ctx context.Context, model, group string) (pricing.Card, Reason) {
	defer g.observe("price", time.Now())

	card, err := g.deps.Pricer.Lookup(ctx, model, group)
	switch {
	case errors.Is(err, pricing.ErrNotPriced):
		return pricing.Card{}, ReasonModelNotPriced
	case err != nil:
		g.deps.Log.Error("price lookup failed", "err", err, "model", model)
		return pricing.Card{}, ReasonInternalError
	}
	return card, ""
}

// reserve 预扣额度；失败时返回拒绝原因。
func (g *Gate) reserve(ctx context.Context, key store.Key, card pricing.Card, requestID string) (ledger.Hold, Reason) {
	defer g.observe("reserve", time.Now())

	hold, err := g.deps.Reserver.Reserve(ctx, key, card, requestID)
	switch {
	case ledger.IsInsufficientQuota(err):
		return ledger.Hold{}, ReasonInsufficientQuota
	case err != nil:
		g.deps.Log.Error("reserve failed", "err", err, "key_id", key.ID)
		return ledger.Hold{}, ReasonInternalError
	}
	return hold, ""
}

func (g *Gate) lookupKey(ctx context.Context, hash string) (store.Key, error) {
	if key, err, ok := g.keys.get(hash); ok {
		g.deps.Metrics.CacheLookups.WithLabelValues("api_key", "hit").Inc()
		return key, err
	}
	g.deps.Metrics.CacheLookups.WithLabelValues("api_key", "miss").Inc()

	key, err := g.deps.Store.GetKeyByHash(ctx, hash)
	switch {
	case err == nil:
		g.keys.add(hash, key)
	case errors.Is(err, store.ErrNotFound):
		g.keys.addMiss(hash)
	}
	return key, err
}

func (g *Gate) observe(stage string, start time.Time) {
	g.deps.Metrics.AdmissionDuration.WithLabelValues(stage).Observe(time.Since(start).Seconds())
}

func (g *Gate) logVerdict(req Request, v Verdict, start time.Time) {
	attrs := []any{
		"request_id", v.RequestID,
		"reason", v.Reason,
		"key_id", v.KeyID,
		"account", v.AccountName,
		"model", v.Model,
		"protocol", req.Protocol,
		"ms", float64(time.Since(start).Microseconds()) / 1000,
	}
	if v.Allowed {
		g.deps.Log.Info("admission allowed", append(attrs, "reserved_nanos", v.ReservedNanos)...)
		return
	}
	g.deps.Log.Info("admission denied", append(attrs, "path", req.Path)...)
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
