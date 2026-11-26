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
	// CostSourceGatewayPreferred 网关上报了金额时优先使用网关金额。
	CostSourceGatewayPreferred CostSource = "gateway_prefer"

	pricingSourceGateway pricing.Source = "gateway"
)

// Store 是账本所需的持久化能力。
type Store interface {
	ReserveKeyQuota(ctx context.Context, keyID uuid.UUID, nanos int64) (store.QuotaState, error)
	ReserveAccountQuota(ctx context.Context, accountID uuid.UUID, nanos int64) (store.QuotaState, error)
	ReleaseKeyReservation(ctx context.Context, keyID uuid.UUID, nanos int64) error
	ReleaseAccountReservation(ctx context.Context, accountID uuid.UUID, nanos int64) error
	CreateReservation(ctx context.Context, r store.Reservation) error
	CountReservations(ctx context.Context) (int64, error)
	ReleaseExpiredReservations(ctx context.Context, now time.Time, limit int) (int, error)

	SettleUsage(ctx context.Context, ev store.UsageEvent) (bool, error)
	BackfillGatewayCost(ctx context.Context, requestID string, nanos int64) (bool, error)

	GetKey(ctx context.Context, id uuid.UUID) (store.Key, error)
	GetAccountByName(ctx context.Context, name string) (store.Account, error)
	ListAccounts(ctx context.Context, limit int) ([]store.Account, error)
}

// Pricer 按模型与分组查单价卡。
type Pricer interface {
	Lookup(ctx context.Context, model, group string) (pricing.Card, error)
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
	owners  *ownerCache
	metrics *telemetry.Metrics
	log     *slog.Logger
}

// New 创建账本。
func New(opts Options, st Store, pricer Pricer, metrics *telemetry.Metrics, log *slog.Logger) *Ledger {
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
		store:   st,
		pricer:  pricer,
		owners:  newOwnerCache(st, opts.OwnerCacheTTL),
		metrics: metrics,
		log:     log,
	}
}
