// Package store 定义 loom 的持久化领域模型与存储接口；pg（sqlc）与 mem（单测）各有一份实现。
package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"slices"
	"time"

	"github.com/google/uuid"
)

// ErrNotFound 记录不存在。
var ErrNotFound = errors.New("store: not found")

// ErrConflict 唯一约束冲突（账户名、API Key 摘要等已存在）。
var ErrConflict = errors.New("store: already exists")

// ErrInsufficientQuota 条件预扣失败：剩余额度不足，或 API Key / 账户已停用、已过期。
var ErrInsufficientQuota = errors.New("store: insufficient quota")

// Status 账户与 API Key 的启用状态。
type Status string

// 账户与 API Key 的状态取值。
const (
	StatusActive   Status = "active"
	StatusDisabled Status = "disabled"
)

// Account 额度第一级。
type Account struct {
	ID         uuid.UUID
	Name       string
	Tenant     string
	Group      string
	Status     Status
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

// AccountSettings 是账户可修改的属性，更新时整体替换。
type AccountSettings struct {
	Status     Status
	Group      string
	QuotaLimit *int64 // nil = 不限
}

// Settings 返回账户当前的可修改属性。
func (a Account) Settings() AccountSettings {
	return AccountSettings{Status: a.Status, Group: a.Group, QuotaLimit: a.QuotaLimit}
}

// APIKey 表示一把调用 AgentGateway 的 API Key，并附带所属账户快照。
type APIKey struct {
	ID             uuid.UUID
	AccountID      uuid.UUID
	Name           string
	KeyHash        string
	KeyPreview     string
	Status         Status
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
func (k APIKey) AllowsModel(model string) bool {
	if len(k.ModelAllowlist) == 0 {
		return true
	}
	return slices.Contains(k.ModelAllowlist, model)
}

// APIKeySettings 是 API Key 可修改的属性，更新时整体替换。
type APIKeySettings struct {
	Name           string
	Status         Status
	ModelAllowlist []string   // nil = 全部模型
	QuotaLimit     *int64     // nil = 跟随账户
	ExpiresAt      *time.Time // nil = 不过期
}

// Settings 返回 API Key 当前的可修改属性。
func (k APIKey) Settings() APIKeySettings {
	return APIKeySettings{
		Name:           k.Name,
		Status:         k.Status,
		ModelAllowlist: k.ModelAllowlist,
		QuotaLimit:     k.QuotaLimit,
		ExpiresAt:      k.ExpiresAt,
	}
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

// QuotaReservation 是一次成功预扣后两级额度的快照。
type QuotaReservation struct {
	APIKey  QuotaState
	Account QuotaState
}

// Reservation 鉴权阶段写入的预扣记录。
type Reservation struct {
	RequestID string    `json:"request_id"`
	APIKeyID  uuid.UUID `json:"key_id"`
	AccountID uuid.UUID `json:"account_id"`
	Model     string    `json:"model"`
	Nanos     int64     `json:"nanos"`
	ExpiresAt time.Time `json:"expires_at"`
	CreatedAt time.Time `json:"created_at"`
}

// UsageEvent 计费明细。
type UsageEvent struct {
	ID                    int64      `json:"id"`
	Time                  time.Time  `json:"time"`
	RequestID             string     `json:"request_id"`
	TraceID               string     `json:"trace_id"`
	SpanID                string     `json:"span_id"`
	AccountID             *uuid.UUID `json:"account_id"`
	APIKeyID              *uuid.UUID `json:"key_id"`
	Model                 string     `json:"model"`
	Provider              string     `json:"provider"`
	Route                 string     `json:"route"`
	AgentGateway          string     `json:"gateway"`
	InputTokens           int64      `json:"input_tokens"`
	OutputTokens          int64      `json:"output_tokens"`
	CachedTokens          int64      `json:"cached_tokens"`
	CostNanos             int64      `json:"cost_nanos"`
	AgentGatewayCostNanos *int64     `json:"gateway_cost_nanos"`
	PricingSource         string     `json:"pricing_source"`
	// Pricing 是结算时的计价快照；模型未定价（金额为 0）时为 nil。
	Pricing *PricingSnapshot `json:"pricing"`
	Settled bool             `json:"settled"`
}

// PricingSnapshot 记录一笔用量按什么分组与倍率计价，用于事后复核金额。
type PricingSnapshot struct {
	Group           string   `json:"group"`
	GroupRatio      float64  `json:"group_ratio"`
	ModelRatio      float64  `json:"model_ratio"`
	CompletionRatio float64  `json:"completion_ratio"`
	CacheRatio      float64  `json:"cache_ratio"`
	ModelPrice      *float64 `json:"model_price"` // 按次计费时的 USD/次
}

// Audit 鉴权审计。
type Audit struct {
	Time            time.Time  `json:"time"`
	RequestID       string     `json:"request_id"`
	ClientRequestID string     `json:"client_request_id"`
	APIKeyID        *uuid.UUID `json:"key_id"`
	AccountID       *uuid.UUID `json:"account_id"`
	Protocol        string     `json:"protocol"` // 门面协议：http | grpc
	Model           string     `json:"model"`
	Allowed         bool       `json:"allowed"`
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

// UsageSummaryRow 聚合结果；AccountID/APIKeyID 为 uuid.Nil 表示未归属。
type UsageSummaryRow struct {
	AccountID             uuid.UUID
	APIKeyID              uuid.UUID
	Model                 string
	Requests              int64
	InputTokens           int64
	OutputTokens          int64
	CachedTokens          int64
	CostNanos             int64
	AgentGatewayCostNanos int64
}

// UsageFilter 聚合过滤条件。
type UsageFilter struct {
	AccountID *uuid.UUID
	APIKeyID  *uuid.UUID
	Since     *time.Time
}

// QuotaAdjustmentKind 是额度变更的类型。
type QuotaAdjustmentKind string

// 额度变更类型取值。
const (
	QuotaTopUp QuotaAdjustmentKind = "top_up" // 增加上限
	QuotaReset QuotaAdjustmentKind = "reset"  // 直接设置上限与已用量，并清空预扣
)

// QuotaChange 是管理员对额度的一次直接设置；与修改在同一事务中写入额度变更流水。
type QuotaChange struct {
	LimitNanos *int64 // 新上限；nil 表示不限
	UsedNanos  int64
	Actor      string
}

// QuotaAdjustment 是一条额度变更流水（只追加）。API Key 的变更同时记录所属账户。
type QuotaAdjustment struct {
	ID          int64               `json:"id"`
	Time        time.Time           `json:"time"`
	AccountID   uuid.UUID           `json:"account_id"`
	APIKeyID    *uuid.UUID          `json:"key_id"`
	Kind        QuotaAdjustmentKind `json:"kind"`
	LimitBefore *int64              `json:"limit_before_nanos"`
	LimitAfter  *int64              `json:"limit_after_nanos"`
	UsedBefore  int64               `json:"used_before_nanos"`
	UsedAfter   int64               `json:"used_after_nanos"`
	Actor       string              `json:"actor"`
}

// QuotaAdjustmentFilter 额度变更流水的查询条件。
type QuotaAdjustmentFilter struct {
	AccountID *uuid.UUID
	APIKeyID  *uuid.UUID
}

// AdminToken 是一把管理 token；库中只存哈希，明文只在签发时返回一次。
type AdminToken struct {
	ID           uuid.UUID  `json:"id"`
	Name         string     `json:"name"`
	TokenHash    string     `json:"-"`
	TokenPreview string     `json:"token_preview"`
	Role         string     `json:"role"`
	CreatedAt    time.Time  `json:"created_at"`
	RevokedAt    *time.Time `json:"revoked_at"`
}

// AdminAudit 是一条管理操作审计。
type AdminAudit struct {
	ID      int64     `json:"id"`
	Time    time.Time `json:"time"`
	Actor   string    `json:"actor"`
	Method  string    `json:"method"`
	Route   string    `json:"route"`
	Target  string    `json:"target"`
	Request string    `json:"request"` // 已脱敏
	Status  int       `json:"status"`
}

// HashAPIKey 返回 API Key 明文的存储形式；数据库只保存摘要。
func HashAPIKey(plaintext string) string { return HashSecret(plaintext) }

// HashSecret 返回高熵随机凭据（API Key、管理 token）的存储形式：sha256 十六进制。
func HashSecret(plaintext string) string {
	sum := sha256.Sum256([]byte(plaintext))
	return hex.EncodeToString(sum[:])
}

// IsActive 判断状态是否为启用。
func (s Status) IsActive() bool { return s == StatusActive }

// Store 持久化接口，由 postgres（生产）与 memstore（单测）实现。
// 业务包不直接依赖它的全部方法，而是在各自包内声明所需的窄接口。
//
// 按主键或其他键取单条记录的方法保留 Get 前缀（GetAccount、GetAccountByName），
// 与 List*、Create* 并列时语义最清楚；这是查询而不是字段取值器，不适用"省略 Get"的命名规则。
type Store interface {
	// accounts
	GetAccount(ctx context.Context, id uuid.UUID) (Account, error)
	GetAccountByName(ctx context.Context, name string) (Account, error)
	ListAccounts(ctx context.Context, limit int) ([]Account, error)
	CreateAccount(ctx context.Context, a Account) (Account, error)
	UpdateAccount(ctx context.Context, id uuid.UUID, s AccountSettings) (Account, error)
	// AddAccountQuotaLimit 增加账户额度上限，并在同一事务中写入额度变更流水。
	AddAccountQuotaLimit(ctx context.Context, id uuid.UUID, delta int64, actor string) (Account, error)
	// SetAccountQuota 管理用：直接设置额度上限与已用量，清空预扣，并写入额度变更流水。
	SetAccountQuota(ctx context.Context, id uuid.UUID, change QuotaChange) error

	// keys
	GetAPIKeyByHash(ctx context.Context, hash string) (APIKey, error)
	GetAPIKey(ctx context.Context, id uuid.UUID) (APIKey, error)
	ListAPIKeys(ctx context.Context, accountID *uuid.UUID, limit int) ([]APIKey, error)
	CreateAPIKey(ctx context.Context, k APIKey) (APIKey, error)
	UpdateAPIKey(ctx context.Context, id uuid.UUID, s APIKeySettings) (APIKey, error)
	// SetAPIKeyQuota 管理用：直接设置额度上限与已用量，清空预扣，并写入额度变更流水。
	SetAPIKeyQuota(ctx context.Context, id uuid.UUID, change QuotaChange) error

	// quota（原子操作）
	ReserveAPIKeyQuota(ctx context.Context, apiKeyID uuid.UUID, nanos int64) (QuotaState, error)
	ReleaseAPIKeyReservation(ctx context.Context, apiKeyID uuid.UUID, nanos int64) error
	ReserveAccountQuota(ctx context.Context, accountID uuid.UUID, nanos int64) (QuotaState, error)
	ReleaseAccountReservation(ctx context.Context, accountID uuid.UUID, nanos int64) error

	// ReserveQuota 单事务：API Key 与账户两级条件预扣，并写入预扣记录；任一级不满足（额度不足、已停用、已过期、
	// 不存在）时整体回滚并返回 ErrInsufficientQuota，不留下任何冻结。r.Nanos 必须大于 0。
	ReserveQuota(ctx context.Context, r Reservation) (QuotaReservation, error)

	// reservations
	CreateReservation(ctx context.Context, r Reservation) error
	GetReservation(ctx context.Context, requestID string) (Reservation, error)
	ListReservations(ctx context.Context, limit int) ([]Reservation, error)
	CountReservations(ctx context.Context) (int64, error)
	// SettleUsage 单事务：幂等插入 usage_event → 按预扣记录结算或直接累加 → 删除预扣。返回是否真正插入。
	SettleUsage(ctx context.Context, ev UsageEvent) (bool, error)
	// BackfillAgentGatewayCost 在另一条通道已先结算时补写网关金额（只填空值），返回是否更新。
	BackfillAgentGatewayCost(ctx context.Context, requestID string, nanos int64) (bool, error)
	// ReleaseExpiredReservations 单事务：锁定过期的预扣、释放两级额度、删除记录，返回释放条数。
	ReleaseExpiredReservations(ctx context.Context, now time.Time, limit int) (int, error)

	// usage
	ListUsage(ctx context.Context, apiKeyID *uuid.UUID, since *time.Time, limit int) ([]UsageEvent, error)
	SummaryUsage(ctx context.Context, f UsageFilter) ([]UsageSummaryRow, error)

	// audit（best-effort 批量）
	InsertAudit(ctx context.Context, rows []Audit) error
	ListAudit(ctx context.Context, apiKeyID *uuid.UUID, limit int) ([]Audit, error)

	// pg fallback pricing
	ListModelPricing(ctx context.Context) ([]ModelPrice, error)
	GetModelPrice(ctx context.Context, model string) (ModelPrice, error)
	UpsertModelPricing(ctx context.Context, p ModelPrice) error
	DeleteModelPricing(ctx context.Context, model string) error

	Close()

	// 额度变更流水与管理面
	ListQuotaAdjustments(ctx context.Context, f QuotaAdjustmentFilter, limit int) ([]QuotaAdjustment, error)
	CreateAdminToken(ctx context.Context, t AdminToken) (AdminToken, error)
	// GetAdminTokenByHash 只返回未吊销的 token。
	GetAdminTokenByHash(ctx context.Context, hash string) (AdminToken, error)
	ListAdminTokens(ctx context.Context) ([]AdminToken, error)
	// RevokeAdminToken 吊销 token；不存在或已吊销时返回 ErrNotFound。
	RevokeAdminToken(ctx context.Context, id uuid.UUID) error
	InsertAdminAudit(ctx context.Context, row AdminAudit) error
	ListAdminAudit(ctx context.Context, limit int) ([]AdminAudit, error)
}
