// Package account 提供账户、API Key、兜底定价的管理操作与用量查询，供管理 API 与 seed 命令复用。
package account

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/pricing"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
)

var (
	// ErrInvalidInput 请求参数不合法。
	ErrInvalidInput = errors.New("account: invalid input")
	// ErrNotFound 账户或 Key 不存在。
	ErrNotFound = store.ErrNotFound
	// ErrConflict 账户名或 Key 已存在。
	ErrConflict = store.ErrConflict
)

// Store 是管理操作所需的持久化能力。
type Store interface {
	GetAccount(ctx context.Context, id uuid.UUID) (store.Account, error)
	GetAccountByName(ctx context.Context, name string) (store.Account, error)
	ListAccounts(ctx context.Context, limit int) ([]store.Account, error)
	CreateAccount(ctx context.Context, a store.Account) (store.Account, error)
	UpdateAccount(
		ctx context.Context,
		id uuid.UUID,
		status store.Status,
		quotaLimit *int64,
		group string,
	) (store.Account, error)
	AddAccountQuotaLimit(ctx context.Context, id uuid.UUID, delta int64) (store.Account, error)
	SetAccountQuota(ctx context.Context, id uuid.UUID, limit *int64, used int64) error

	GetKey(ctx context.Context, id uuid.UUID) (store.Key, error)
	ListKeys(ctx context.Context, accountID *uuid.UUID, limit int) ([]store.Key, error)
	CreateKey(ctx context.Context, k store.Key, allowlist []string) (store.Key, error)
	UpdateKey(ctx context.Context, id uuid.UUID, status store.Status, allowlist []string,
		quotaLimit *int64, expiresAt *time.Time, name string) (store.Key, error)
	SetKeyQuota(ctx context.Context, id uuid.UUID, limit *int64, used int64) error

	ListModelPricing(ctx context.Context) ([]store.ModelPrice, error)
	UpsertModelPricing(ctx context.Context, p store.ModelPrice) error
	DeleteModelPricing(ctx context.Context, model string) error

	ListUsage(ctx context.Context, keyID *uuid.UUID, since *time.Time, limit int) ([]store.UsageEvent, error)
	SummaryUsage(ctx context.Context, f store.UsageFilter) ([]store.UsageSummaryRow, error)
	ListAudit(ctx context.Context, keyID *uuid.UUID, limit int) ([]store.Audit, error)
	ListReservations(ctx context.Context, limit int) ([]store.Reservation, error)
}

// PriceBook 是管理操作需要的价目表能力。
type PriceBook interface {
	Spec() *pricing.Spec
	InvalidateStoreCache(model string)
	GatewayCatalog(ctx context.Context) (pricing.GatewayCatalog, error)
}

// KeyInvalidator 在 Key 被修改后清除准入缓存。
type KeyInvalidator interface {
	InvalidateKey(keyID uuid.UUID)
}

// Service 管理操作。
type Service struct {
	store     Store
	prices    PriceBook
	keyCache  KeyInvalidator
	keyPrefix string
}

// New 创建管理服务；keyCache 可为 nil（如 seed 命令）。
func New(st Store, prices PriceBook, keyCache KeyInvalidator, keyPrefix string) *Service {
	if keyPrefix == "" {
		keyPrefix = "loom-"
	}
	return &Service{store: st, prices: prices, keyCache: keyCache, keyPrefix: keyPrefix}
}

func (s *Service) invalidateKey(id uuid.UUID) {
	if s.keyCache != nil {
		s.keyCache.InvalidateKey(id)
	}
}
