// Package throttle 是客户级限流：API Key 与账户两级的 RPM、TPM 与最大并发。
//
// 计数放在共享存储里（第一版 PostgreSQL 的分钟窗口计数表），上限与副本数无关、扩缩容后仍然成立：
//   - RPM / TPM：分钟固定窗口；准入时按预扣估值计入 token，结算时用实际值修正（计入结算时所在的窗口）。
//   - 并发：由账本在预扣事务中按未结算的预扣记录数精确判断，本包只给出生效的上限。
//
// 账户未配置的项取 pricing.yaml 中所属分组的 limits；API Key 级不继承分组默认值。
package throttle

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/telemetry"
)

// Window 计数窗口长度。
const Window = time.Minute

// 窗口过期多久后删除；只需保留当前窗口与刚结束、可能还有结算修正的上一个窗口。
const retainWindows = 2 * Window

// releaseTimeout 退回计数的时限；失败只会让该窗口多计一次，窗口结束后自然失效。
const releaseTimeout = 2 * time.Second

// Counter 共享计数后端；由 store.Store 实现，以后可以换成 Redis 而不改动业务代码。
type Counter interface {
	AcquireRate(ctx context.Context, window time.Time, claims []store.RateClaim) error
	ReleaseRate(ctx context.Context, window time.Time, claims []store.RateClaim) error
	AddRateTokens(ctx context.Context, window time.Time, claims []store.RateClaim) error
	DeleteRateWindows(ctx context.Context, before time.Time) (int64, error)
}

// GroupLimits 提供分组的账户级限流默认值（pricing.PriceTable 实现，随 pricing.yaml 热加载）。
type GroupLimits interface {
	GroupLimits(group string) store.RateLimits
}

// Limits 一次请求生效的两级上限。
type Limits struct {
	APIKey  store.RateLimits
	Account store.RateLimits
}

// Concurrency 预扣时检查的两级并发上限。
func (l Limits) Concurrency() store.ConcurrencyLimits {
	return store.ConcurrencyLimits{APIKey: l.APIKey.MaxConcurrency, Account: l.Account.MaxConcurrency}
}

// Ticket 一次成功 Acquire 的计数凭据；请求随后被拒绝时用它退回。零值表示没有计数。
type Ticket struct {
	window time.Time
	claims []store.RateClaim
}

// Limiter 限流器。
type Limiter struct {
	counter Counter
	groups  GroupLimits
	metrics *telemetry.Metrics
	log     *slog.Logger
	now     func() time.Time
}

// New 创建限流器。
func New(counter Counter, groups GroupLimits, metrics *telemetry.Metrics, log *slog.Logger) *Limiter {
	return &Limiter{
		counter: counter,
		groups:  groups,
		metrics: metrics,
		log:     log,
		now:     time.Now,
	}
}

// Resolve 计算 API Key 生效的两级上限：账户未配置的项取分组默认值。
func (l *Limiter) Resolve(apiKey store.APIKey) Limits {
	return Limits{
		APIKey:  apiKey.Limits,
		Account: apiKey.Account.Limits.Or(l.groups.GroupLimits(apiKey.Account.Group)),
	}
}

// Acquire 在当前窗口为两级各计 1 次请求与 tokens 个 token；没有 RPM / TPM 上限的层级不计数，两级都没有时不访问存储。
// 超限返回 *store.RateLimitError，被拒绝的请求不占用计数。
func (l *Limiter) Acquire(ctx context.Context, apiKey store.APIKey, limits Limits, tokens int64) (Ticket, error) {
	ticket := Ticket{
		window: l.window(),
		claims: claims(apiKey, limits, tokens),
	}
	if len(ticket.claims) == 0 {
		return Ticket{}, nil
	}
	if err := l.counter.AcquireRate(ctx, ticket.window, ticket.claims); err != nil {
		l.recordRejection(err)
		return Ticket{}, err
	}
	return ticket, nil
}

// Release 在后台退回一次计数（请求随后被额度或并发拒绝）。
func (l *Limiter) Release(ctx context.Context, ticket Ticket) {
	if len(ticket.claims) == 0 {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), releaseTimeout)
		defer cancel()
		if err := l.counter.ReleaseRate(ctx, ticket.window, ticket.claims); err != nil {
			l.log.Warn("release rate counters failed", "err", err)
		}
	}()
}

// RecordRejection 记录一次限流拒绝的指标（并发拒绝由账本判出，经准入层回报到这里）。
func (l *Limiter) RecordRejection(err error) { l.recordRejection(err) }

func (l *Limiter) recordRejection(err error) {
	if limited, ok := errors.AsType[*store.RateLimitError](err); ok {
		l.metrics.ThrottleRejections.WithLabelValues(string(limited.Scope), string(limited.Kind)).Inc()
	}
}

// AdjustTokens 结算时用实际 token 数修正准入时的估值（delta = 实际 - 估值），计入当前窗口；两级都没有 TPM 上限时什么也不做。
func (l *Limiter) AdjustTokens(ctx context.Context, apiKey store.APIKey, delta int64) {
	if delta == 0 {
		return
	}
	limits := l.Resolve(apiKey)
	var adjustments []store.RateClaim
	if limits.APIKey.TPM != nil {
		adjustments = append(adjustments, store.RateClaim{
			Scope:   store.RateScopeAPIKey,
			Subject: apiKey.ID,
			Tokens:  delta,
		})
	}
	if limits.Account.TPM != nil {
		adjustments = append(adjustments, store.RateClaim{
			Scope:   store.RateScopeAccount,
			Subject: apiKey.AccountID,
			Tokens:  delta,
		})
	}
	if len(adjustments) == 0 {
		return
	}
	if err := l.counter.AddRateTokens(ctx, l.window(), adjustments); err != nil {
		l.log.Warn("adjust rate tokens failed", "key_id", apiKey.ID, "err", err)
	}
}

// RetryAfter 给被限流的调用方的重试建议：RPM / TPM 等到当前窗口结束，并发等 1 秒。
func (l *Limiter) RetryAfter(kind store.RateLimitKind) time.Duration {
	if kind == store.RateLimitConcurrency {
		return time.Second
	}
	now := l.now()
	return now.Truncate(Window).Add(Window).Sub(now)
}

// Run 定期删除过期的计数窗口，阻塞直到 ctx 结束。
func (l *Limiter) Run(ctx context.Context) {
	ticker := time.NewTicker(Window)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			before := l.window().Add(-retainWindows)
			if _, err := l.counter.DeleteRateWindows(ctx, before); err != nil {
				l.log.Warn("delete expired rate windows failed", "err", err)
			}
		}
	}
}

func (l *Limiter) window() time.Time { return l.now().UTC().Truncate(Window) }

// claims 为配置了 RPM 或 TPM 的层级生成计数申请。只有配置了 TPM 的层级才计 token：
// 否则在窗口中途开启 TPM 时，会带着从未按实际用量修正过的估值起步。
func claims(apiKey store.APIKey, limits Limits, tokens int64) []store.RateClaim {
	var out []store.RateClaim
	if claim, ok := claimFor(store.RateScopeAPIKey, apiKey.ID, limits.APIKey, tokens); ok {
		out = append(out, claim)
	}
	if claim, ok := claimFor(store.RateScopeAccount, apiKey.AccountID, limits.Account, tokens); ok {
		out = append(out, claim)
	}
	return out
}

func claimFor(scope store.RateScope, subject uuid.UUID, limits store.RateLimits, tokens int64) (store.RateClaim, bool) {
	if limits.RPM == nil && limits.TPM == nil {
		return store.RateClaim{}, false
	}
	claim := store.RateClaim{
		Scope:   scope,
		Subject: subject,
		RPM:     limits.RPM,
		TPM:     limits.TPM,
	}
	if limits.TPM != nil {
		claim.Tokens = tokens
	}
	return claim, true
}
