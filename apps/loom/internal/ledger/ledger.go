// Package ledger 是额度账本：管理一笔请求费用的完整生命周期——
// 准入时按预估预扣（Reserve），收到用量上报后按实际金额结算（Settle），
// 迟迟没有用量上报的预扣到期后释放（RunReaper）。
//
// 额度分账户与 Key 两级，两级都满足才放行；所有金额为整数 nano-USD。
package ledger

import (
	"context"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/pricing"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/telemetry"
)

// ErrInsufficientQuota 预扣失败：Key 或账户剩余额度不足。
var ErrInsufficientQuota = store.ErrInsufficientQuota

// CostSource 决定结算金额以谁为准。
type CostSource string

const (
	// CostSourceLoom 以 loom 计价表为准，网关金额只做对账（默认）。
	CostSourceLoom CostSource = "loom"
	// CostSourceAgentGatewayPreferred 网关上报了金额时优先使用网关金额。
	CostSourceAgentGatewayPreferred CostSource = "gateway_prefer"

	pricingSourceAgentGateway pricing.PriceSource = "gateway"
)

// Store 是账本所需的持久化能力。
type Store interface {
	ReserveQuota(
		ctx context.Context,
		r store.Reservation,
		concurrency store.ConcurrencyLimits,
	) (store.QuotaReservation, error)
	CountReservations(ctx context.Context) (int64, error)
	ReleaseReservation(ctx context.Context, requestID string) (bool, error)
	ReleaseExpiredReservations(ctx context.Context, now time.Time, limit int) (int, error)

	SettleUsage(ctx context.Context, ev store.UsageEvent) (bool, error)
	BackfillAgentGatewayCost(ctx context.Context, requestID string, nanos int64) (bool, error)

	GetAPIKey(ctx context.Context, id uuid.UUID) (store.APIKey, error)
	GetAccountByName(ctx context.Context, name string) (store.Account, error)
	ListAccounts(ctx context.Context, limit int) ([]store.Account, error)
}

// Pricer 按模型与分组查单价卡。
type Pricer interface {
	Lookup(ctx context.Context, model, group string) (pricing.UnitPrice, error)
}

// TokenCounter 结算时用实际 token 数修正 TPM 计数（throttle.Limiter 实现）。
type TokenCounter interface {
	AdjustTokens(ctx context.Context, apiKey store.APIKey, delta int64)
}

// Options 账本参数。
type Options struct {
	ReservationTTL time.Duration // 预扣有效期，过期由 RunReaper 释放
	ReaperInterval time.Duration
	ReaperBatch    int
	CostSource     CostSource
	OwnerCacheTTL  time.Duration // Key/账户归属缓存
}

// Ledger 额度账本。
type Ledger struct {
	opts    Options
	store   Store
	pricer  Pricer
	owners  *usageOwnerCache
	tokens  TokenCounter // 可为 nil：不修正 TPM
	metrics *telemetry.Metrics
	log     *slog.Logger
}

// SetTokenCounter 设置结算时修正 TPM 的计数器；须在开始结算前调用。
func (l *Ledger) SetTokenCounter(counter TokenCounter) { l.tokens = counter }

// New 创建账本。
func New(opts Options, storage Store, pricer Pricer, metrics *telemetry.Metrics, log *slog.Logger) *Ledger {
	if opts.ReservationTTL <= 0 {
		opts.ReservationTTL = 15 * time.Minute
	}
	if opts.ReaperInterval <= 0 {
		opts.ReaperInterval = time.Minute
	}
	if opts.ReaperBatch <= 0 {
		opts.ReaperBatch = 200
	}
	if opts.CostSource == "" {
		opts.CostSource = CostSourceLoom
	}
	return &Ledger{
		opts:    opts,
		store:   storage,
		pricer:  pricer,
		owners:  newOwnerCache(storage, opts.OwnerCacheTTL),
		metrics: metrics,
		log:     log,
	}
}

// InvalidateAPIKey 清除某 API Key 的结算归属缓存（仅作用于当前副本）。
func (l *Ledger) InvalidateAPIKey(apiKeyID uuid.UUID) { l.owners.invalidateAPIKey(apiKeyID) }

// InvalidateAccount 清除某账户的结算归属缓存，使分组变更立即按新倍率结算（仅作用于当前副本）。
func (l *Ledger) InvalidateAccount(accountID uuid.UUID) { l.owners.invalidateAccount(accountID) }
