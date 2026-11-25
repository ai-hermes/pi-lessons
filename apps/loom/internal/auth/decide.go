package auth

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	lru "github.com/hashicorp/golang-lru/v2/expirable"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/config"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/pricing"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/quota"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/telemetry"
	"github.com/ai-hermes/pi-lessons/apps/loom/pkg/loom"
)

// Engine 鉴权决策引擎：HTTP 与 gRPC 门面共用。
type Engine struct {
	cfg       config.Auth
	st        store.Store
	pricing   *pricing.Service
	quota     *quota.Service
	m         *telemetry.Metrics
	log       *slog.Logger
	keys      *lru.LRU[string, store.Key]
	neg       *lru.LRU[string, struct{}]
	auditCh   chan store.Audit
	auditDone chan struct{}
}

// NewEngine 创建引擎并启动审计批写。
func NewEngine(cfg config.Auth, st store.Store, pr *pricing.Service, q *quota.Service, m *telemetry.Metrics, log *slog.Logger) *Engine {
	e := &Engine{cfg: cfg, st: st, pricing: pr, quota: q, m: m, log: log,
		auditCh: make(chan store.Audit, cfg.AuditQueue), auditDone: make(chan struct{})}
	if cfg.Cache.Enabled && cfg.Cache.Size > 0 {
		ttl := cfg.Cache.TTL
		if ttl < time.Second {
			ttl = 30 * time.Second
		}
		nttl := cfg.Cache.NegativeTTL
		if nttl < time.Second {
			nttl = 5 * time.Second
		}
		e.keys = lru.NewLRU[string, store.Key](cfg.Cache.Size, nil, ttl)
		e.neg = lru.NewLRU[string, struct{}](cfg.Cache.Size, nil, nttl)
	}
	go e.auditLoop()
	return e
}

// Close 停止审计批写并刷盘。
func (e *Engine) Close() {
	close(e.auditCh)
	<-e.auditDone
}

// AuditChan 审计通道（测试用）。
func (e *Engine) AuditChan() <-chan store.Audit { return e.auditCh }

func (e *Engine) auditLoop() {
	defer close(e.auditDone)
	const batch = 200
	flush := time.NewTicker(time.Second)
	defer flush.Stop()
	buf := make([]store.Audit, 0, batch)
	flushNow := func() {
		if len(buf) == 0 {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		err := e.st.InsertAudit(ctx, buf)
		cancel()
		if err != nil {
			e.log.Warn("audit insert failed", "err", err, "rows", len(buf))
		}
		buf = buf[:0]
	}
	for {
		select {
		case a, ok := <-e.auditCh:
			if !ok {
				flushNow()
				return
			}
			buf = append(buf, a)
			if len(buf) >= batch {
				flushNow()
			}
		case <-flush.C:
			flushNow()
		}
	}
}

func (e *Engine) audit(d Decision, req Request, source, clientReqID string) {
	if e.cfg.AuditQueue <= 0 {
		return
	}
	a := store.Audit{Time: req.Now, RequestID: d.RequestID, ClientRequestID: clientReqID, Source: source, Model: d.Model,
		Allowed: d.Allow, Status: d.Status, Reason: d.Reason}
	if d.KeyID != uuid.Nil {
		id := d.KeyID
		a.KeyID = &id
	}
	if d.AccountID != uuid.Nil {
		id := d.AccountID
		a.AccountID = &id
	}
	select {
	case e.auditCh <- a:
	default:
		e.log.Warn("audit queue full, dropping audit row")
	}
}

// Deny 构造拒绝结论。
func (e *Engine) Deny(req Request, reason string, status int) Decision {
	if status == 0 {
		status = e.statusFor(reason)
	}
	msg := map[string]string{
		loom.ReasonMissingCredential: "missing API key: send Authorization: Bearer <key> or x-api-key",
		loom.ReasonUnknownAPIKey:     "unknown API key",
		loom.ReasonExpiredAPIKey:     "API key expired",
		loom.ReasonClientInactive:    "client is disabled",
		loom.ReasonModelNotAllowed:   "model not allowed for this API key",
		loom.ReasonModelNotPriced:    "model has no pricing configured",
		loom.ReasonInsufficientQuota: "insufficient quota",
		loom.ReasonInternalError:     "internal error",
	}[reason]
	return Decision{Allow: false, Status: status, Reason: reason, Body: ErrorBody(reason, msg),
		Headers:   map[string]string{e.cfg.IdentityHeaders.DenyReason: reason},
		RequestID: req.ClientRequestID, Model: ExtractModel(req.Headers, req.Body)}
}

func (e *Engine) statusFor(reason string) int {
	switch reason {
	case loom.ReasonUnknownAPIKey, loom.ReasonExpiredAPIKey:
		return e.cfg.DenyStatus.UnknownKey
	case loom.ReasonClientInactive:
		return e.cfg.DenyStatus.Inactive
	case loom.ReasonInsufficientQuota:
		return e.cfg.DenyStatus.Quota
	case loom.ReasonModelNotPriced:
		return e.cfg.DenyStatus.NotPriced
	case loom.ReasonModelNotAllowed:
		return e.cfg.DenyStatus.NotAllowed
	case loom.ReasonInternalError:
		return e.cfg.DenyStatus.InternalError
	}
	return 401
}

// Evaluate 执行完整鉴权：凭据 → 查找 → 状态 → 定价 → 白名单 → 预扣 → identity headers。
func (e *Engine) Evaluate(ctx context.Context, req Request) Decision {
	start := time.Now()
	reqID := NewRequestID()
	if req.Now.IsZero() {
		req.Now = start
	}
	stage := func(name string) {
		if e.m != nil {
			e.m.AuthDuration.WithLabelValues(name).Observe(time.Since(start).Seconds())
		}
	}
	decide := func(d Decision) Decision {
		stage("evaluate")
		source := loom.SourceNone
		if d.KeyID != uuid.Nil {
			source = loom.SourceAPIKey
		}
		if d.RequestID == "" {
			d.RequestID = reqID
		}
		if e.m != nil {
			e.m.AuthDecisions.WithLabelValues(source, d.Reason, fmt.Sprintf("%t", d.Allow)).Inc()
		}
		if req.Source != "" {
			source = req.Source
		}
		e.audit(d, req, source, req.ClientRequestID)
		if d.Allow {
			e.log.Info("auth allowed", "request_id", d.RequestID, "key_id", d.KeyID, "client", d.ClientID, "model", d.Model,
				"reserve_nanos", d.ReserveNanos, "source", req.Source, "ms", float64(time.Since(start).Microseconds())/1000)
		} else {
			e.log.Info("auth denied", "request_id", d.RequestID, "key_id", d.KeyID, "reason", d.Reason, "status", d.Status,
				"model", d.Model, "path", req.Path, "source", req.Source)
		}
		return d
	}

	raw, ok := Credential(req.Headers, e.cfg.HeaderSources)
	if !ok {
		return decide(e.Deny(req, loom.ReasonMissingCredential, 401))
	}
	key, err := e.lookupKey(ctx, HashKey(raw))
	if errors.Is(err, loom.ErrNotFound) {
		return decide(e.Deny(req, loom.ReasonUnknownAPIKey, 0))
	}
	if err != nil {
		e.log.Error("key lookup failed", "err", err)
		return decide(e.Deny(req, loom.ReasonInternalError, 0))
	}
	stage("db")

	if key.Status != loom.StatusActive || key.Account.Status != loom.StatusActive {
		d := e.Deny(req, loom.ReasonClientInactive, 0)
		d.KeyID, d.AccountID, d.ClientID, d.KeyPreview = key.ID, key.AccountID, key.Account.Name, key.KeyPreview
		return decide(d)
	}
	if key.ExpiresAt != nil && !key.ExpiresAt.After(req.Now) {
		d := e.Deny(req, loom.ReasonExpiredAPIKey, 0)
		d.KeyID, d.AccountID, d.ClientID = key.ID, key.AccountID, key.Account.Name
		return decide(d)
	}

	model := ExtractModel(req.Headers, req.Body)
	d := Decision{RequestID: reqID, KeyID: key.ID, AccountID: key.AccountID, ClientID: key.Account.Name,
		KeyPreview: key.KeyPreview, Model: model, Headers: map[string]string{}}
	if model == "" {
		// 非模型请求（如 /echo）：不定价、不预扣，直接放行
		d.Allow, d.Status, d.Reason = true, 200, "ok"
		e.setIdentity(&d, req, nil)
		return decide(d)
	}
	if !key.AllowsModel(model) {
		return decide(e.Deny(req, loom.ReasonModelNotAllowed, 0))
	}
	card, err := e.pricing.Lookup(ctx, model, key.Account.Group)
	if errors.Is(err, pricing.ErrNotPriced) {
		return decide(e.Deny(req, loom.ReasonModelNotPriced, 0))
	}
	if err != nil {
		e.log.Error("pricing lookup failed", "err", err, "model", model)
		return decide(e.Deny(req, loom.ReasonInternalError, 0))
	}
	stage("cache")

	res, err := e.quota.Reserve(ctx, key, card, reqID, req.Now)
	if errors.Is(err, loom.ErrInsufficientQuota) {
		return decide(e.Deny(req, loom.ReasonInsufficientQuota, 0))
	}
	if err != nil {
		e.log.Error("reserve failed", "err", err, "key_id", key.ID)
		return decide(e.Deny(req, loom.ReasonInternalError, 0))
	}
	d.Allow, d.Status, d.Reason, d.ReserveNanos = true, 200, "ok", res.Nanos
	remaining, bounded := res.Remaining()
	e.setIdentity(&d, req, &remaining)
	// 把鉴权时定价的模型随请求带下去：access log 以 loom.model 属性回传，计费侧与鉴权侧用同一个模型名
	d.Headers[loom.HdrModel] = model
	if bounded {
		d.Headers[e.cfg.IdentityHeaders.QuotaRemaining] = fmt.Sprintf("%d", remaining)
	}
	return decide(d)
}

func (e *Engine) setIdentity(d *Decision, req Request, _ *int64) {
	h := d.Headers
	if h == nil {
		h = map[string]string{}
		d.Headers = h
	}
	h[e.cfg.IdentityHeaders.ClientID] = d.ClientID
	h[e.cfg.IdentityHeaders.KeyID] = d.KeyID.String()
	h[e.cfg.IdentityHeaders.RequestID] = d.RequestID
}

func (e *Engine) lookupKey(ctx context.Context, hash string) (store.Key, error) {
	if e.keys != nil {
		if k, ok := e.keys.Get(hash); ok {
			if e.m != nil {
				e.m.AuthCacheHits.WithLabelValues("key", "hit").Inc()
			}
			return k, nil
		}
		if _, ok := e.neg.Get(hash); ok {
			if e.m != nil {
				e.m.AuthCacheHits.WithLabelValues("negative", "hit").Inc()
			}
			return store.Key{}, loom.ErrNotFound
		}
	}
	k, err := e.st.GetKeyByHash(ctx, hash)
	if err != nil {
		if errors.Is(err, loom.ErrNotFound) && e.neg != nil {
			e.neg.Add(hash, struct{}{})
			if e.m != nil {
				e.m.AuthCacheHits.WithLabelValues("negative", "miss").Inc()
			}
		}
		return store.Key{}, err
	}
	if e.keys != nil {
		e.keys.Add(hash, k)
		if e.m != nil {
			e.m.AuthCacheHits.WithLabelValues("key", "miss").Inc()
		}
	}
	return k, nil
}

// InvalidateKey 清除某把 Key 的缓存（同进程内管理操作后调用）。
func (e *Engine) InvalidateKey(keyID uuid.UUID) {
	if e.keys == nil {
		return
	}
	for _, hash := range e.keys.Keys() {
		if k, ok := e.keys.Get(hash); ok && k.ID == keyID {
			e.keys.Remove(hash)
		}
	}
}

// InvalidateAll 清空 Key 缓存。
func (e *Engine) InvalidateAll() {
	if e.keys != nil {
		e.keys.Purge()
	}
	if e.neg != nil {
		e.neg.Purge()
	}
}
