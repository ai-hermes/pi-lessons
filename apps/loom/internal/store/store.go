// Package store 定义 loom 的持久化领域模型与存储接口；pg（sqlc）与 mem（单测）各有一份实现。
package store

import (
	"context"
	"time"

	"github.com/google/uuid"
)

// Account 额度第一级。
type Account struct {
	ID         uuid.UUID
	Name       string
	Tenant     string
	Group      string
	Status     string
	QuotaLimit *int64 // nil = 不限
	QuotaUsed  int64
	Reserved   int64
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

// Remaining 剩余额度；Limit 为 nil 时返回 (0, false)。
func (a Account) Remaining() (int64, bool) {
	if a.QuotaLimit == nil {
		return 0, false
	}
	return *a.QuotaLimit - a.QuotaUsed - a.Reserved, true
}

// Key 额度第二级，附带所属账户快照。
type Key struct {
	ID             uuid.UUID
	AccountID      uuid.UUID
	Name           string
	KeyHash        string
	KeyPreview     string
	Status         string
	ModelAllowlist []string // nil = 全部模型
	QuotaLimit     *int64   // nil = 跟随账户
	QuotaUsed      int64
	Reserved       int64
	ExpiresAt      *time.Time
	LastUsedAt     *time.Time
	CreatedAt      time.Time
	UpdatedAt      time.Time
	Account        Account
}

// AllowsModel 判断模型是否在白名单内。
func (k Key) AllowsModel(model string) bool {
	if len(k.ModelAllowlist) == 0 {
		return true
	}
	for _, m := range k.ModelAllowlist {
		if m == model {
			return true
		}
	}
	return false
}

// QuotaState 预扣/结算后的额度快照。
type QuotaState struct {
	Limit    *int64
	Used     int64
	Reserved int64
}

// Remaining 剩余额度。
func (q QuotaState) Remaining() (int64, bool) {
	if q.Limit == nil {
		return 0, false
	}
	return *q.Limit - q.Used - q.Reserved, true
}

// Reservation 鉴权阶段写入的预扣记录。
type Reservation struct {
	RequestID string    `json:"request_id"`
	KeyID     uuid.UUID `json:"key_id"`
	AccountID uuid.UUID `json:"account_id"`
	Model     string    `json:"model"`
	Nanos     int64     `json:"nanos"`
	ExpiresAt time.Time `json:"expires_at"`
	CreatedAt time.Time `json:"created_at"`
}

// UsageEvent 计费明细。
type UsageEvent struct {
	ID               int64      `json:"id"`
	Time             time.Time  `json:"time"`
	RequestID        string     `json:"request_id"`
	TraceID          string     `json:"trace_id"`
	SpanID           string     `json:"span_id"`
	AccountID        *uuid.UUID `json:"account_id"`
	KeyID            *uuid.UUID `json:"key_id"`
	Model            string     `json:"model"`
	Provider         string     `json:"provider"`
	Route            string     `json:"route"`
	Gateway          string     `json:"gateway"`
	InputTokens      int64      `json:"input_tokens"`
	OutputTokens     int64      `json:"output_tokens"`
	CachedTokens     int64      `json:"cached_tokens"`
	CostNanos        int64      `json:"cost_nanos"`
	GatewayCostNanos *int64     `json:"gateway_cost_nanos"`
	PricingSource    string     `json:"pricing_source"`
	Settled          bool       `json:"settled"`
}

// Audit 鉴权审计。
type Audit struct {
	Time            time.Time  `json:"time"`
	RequestID       string     `json:"request_id"`
	ClientRequestID string     `json:"client_request_id"`
	KeyID           *uuid.UUID `json:"key_id"`
	AccountID       *uuid.UUID `json:"account_id"`
	Source          string     `json:"source"`
	Model           string     `json:"model"`
	Allowed         bool       `json:"allowed"`
	Status          int        `json:"status"`
	Reason          string     `json:"reason"`
}

// ModelPrice PG 兜底定价行。
type ModelPrice struct {
	Model               string    `json:"model"`
	ModelRatio          float64   `json:"model_ratio"`
	CompletionRatio     float64   `json:"completion_ratio"`
	CacheRatio          float64   `json:"cache_ratio"`
	ModelPrice          *float64  `json:"model_price"`
	ReserveInputTokens  *int      `json:"reserve_input_tokens"`
	ReserveOutputTokens *int      `json:"reserve_output_tokens"`
	Enabled             bool      `json:"enabled"`
	UpdatedAt           time.Time `json:"updated_at"`
}

// UsageSummaryRow 聚合结果；AccountID/KeyID 为 uuid.Nil 表示未归属。
type UsageSummaryRow struct {
	AccountID        uuid.UUID
	KeyID            uuid.UUID
	Model            string
	Requests         int64
	InputTokens      int64
	OutputTokens     int64
	CachedTokens     int64
	CostNanos        int64
	GatewayCostNanos int64
}

// UsageFilter 聚合过滤条件。
type UsageFilter struct {
	AccountID *uuid.UUID
	KeyID     *uuid.UUID
	Since     *time.Time
}

// Store 持久化接口。
type Store interface {
	// accounts
	GetAccount(ctx context.Context, id uuid.UUID) (Account, error)
	GetAccountByName(ctx context.Context, name string) (Account, error)
	ListAccounts(ctx context.Context, limit int) ([]Account, error)
	CreateAccount(ctx context.Context, a Account) (Account, error)
	UpdateAccount(ctx context.Context, id uuid.UUID, status string, quotaLimit *int64, group string) (Account, error)
	AddAccountQuotaLimit(ctx context.Context, id uuid.UUID, delta int64) (Account, error)
	// SetAccountQuota 管理用：直接设置额度上限与已用量，清空预扣。
	SetAccountQuota(ctx context.Context, id uuid.UUID, limit *int64, used int64) error

	// keys
	GetKeyByHash(ctx context.Context, hash string) (Key, error)
	GetKey(ctx context.Context, id uuid.UUID) (Key, error)
	ListKeys(ctx context.Context, accountID *uuid.UUID, limit int) ([]Key, error)
	CreateKey(ctx context.Context, k Key, allowlist []string) (Key, error)
	UpdateKey(ctx context.Context, id uuid.UUID, status string, allowlist []string, quotaLimit *int64, expiresAt *time.Time, name string) (Key, error)
	// SetKeyQuota 管理用：直接设置额度上限与已用量，清空预扣。
	SetKeyQuota(ctx context.Context, id uuid.UUID, limit *int64, used int64) error

	// quota（原子操作）
	ReserveKeyQuota(ctx context.Context, keyID uuid.UUID, nanos int64) (QuotaState, error)
	ReleaseKeyReservation(ctx context.Context, keyID uuid.UUID, nanos int64) error
	ReserveAccountQuota(ctx context.Context, accountID uuid.UUID, nanos int64) (QuotaState, error)
	ReleaseAccountReservation(ctx context.Context, accountID uuid.UUID, nanos int64) error

	// reservations
	CreateReservation(ctx context.Context, r Reservation) error
	GetReservation(ctx context.Context, requestID string) (Reservation, error)
	ListReservations(ctx context.Context, limit int) ([]Reservation, error)
	CountReservations(ctx context.Context) (int64, error)
	// SettleUsage 单事务：幂等插入 usage_event → 按预扣记录结算或直接累加 → 删除预扣。返回是否真正插入。
	SettleUsage(ctx context.Context, ev UsageEvent) (bool, error)
	// ReleaseExpiredReservations 单事务：锁定过期的预扣、释放两级额度、删除记录，返回释放条数。
	ReleaseExpiredReservations(ctx context.Context, now time.Time, limit int) (int, error)

	// usage
	ListUsage(ctx context.Context, keyID *uuid.UUID, since *time.Time, limit int) ([]UsageEvent, error)
	SummaryUsage(ctx context.Context, f UsageFilter) ([]UsageSummaryRow, error)

	// audit（best-effort 批量）
	InsertAudit(ctx context.Context, rows []Audit) error
	ListAudit(ctx context.Context, keyID *uuid.UUID, limit int) ([]Audit, error)

	// pg fallback pricing
	ListModelPricing(ctx context.Context) ([]ModelPrice, error)
	GetModelPricing(ctx context.Context, model string) (ModelPrice, error)
	UpsertModelPricing(ctx context.Context, p ModelPrice) error
	DeleteModelPricing(ctx context.Context, model string) error

	Close() error
}
