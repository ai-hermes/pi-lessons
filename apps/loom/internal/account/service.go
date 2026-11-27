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
	UpdateAccount(ctx context.Context, id uuid.UUID, s store.AccountSettings) (store.Account, error)
	AddAccountQuotaLimit(ctx context.Context, id uuid.UUID, delta int64) (store.Account, error)
	SetAccountQuota(ctx context.Context, id uuid.UUID, limit *int64, used int64) error

	GetAPIKey(ctx context.Context, id uuid.UUID) (store.APIKey, error)
	ListAPIKeys(ctx context.Context, accountID *uuid.UUID, limit int) ([]store.APIKey, error)
	CreateAPIKey(ctx context.Context, k store.APIKey) (store.APIKey, error)
	UpdateAPIKey(ctx context.Context, id uuid.UUID, s store.APIKeySettings) (store.APIKey, error)
	SetAPIKeyQuota(ctx context.Context, id uuid.UUID, limit *int64, used int64) error

	ListModelPricing(ctx context.Context) ([]store.ModelPrice, error)
	UpsertModelPricing(ctx context.Context, p store.ModelPrice) error
	DeleteModelPricing(ctx context.Context, model string) error

	ListUsage(ctx context.Context, apiKeyID *uuid.UUID, since *time.Time, limit int) ([]store.UsageEvent, error)
	SummaryUsage(ctx context.Context, f store.UsageFilter) ([]store.UsageSummaryRow, error)
	ListAudit(ctx context.Context, apiKeyID *uuid.UUID, limit int) ([]store.Audit, error)
	ListReservations(ctx context.Context, limit int) ([]store.Reservation, error)
}

// PriceBook 是管理操作需要的价目表能力。
type PriceBook interface {
	PriceConfig() *pricing.PriceConfig
	InvalidateFallbackCache(model string)
	AgentGatewayCatalog(ctx context.Context) (pricing.AgentGatewayCatalog, error)
}

// CacheInvalidator 在 API Key 或账户被修改后清除本副本内的缓存（准入缓存、结算归属缓存）。
type CacheInvalidator interface {
	InvalidateAPIKey(apiKeyID uuid.UUID)
	InvalidateAccount(accountID uuid.UUID)
}

// Service 管理操作。
type Service struct {
	store     Store
	prices    PriceBook
	caches    []CacheInvalidator
	keyPrefix string
}

// New 创建管理服务；caches 可以为空（如 seed 命令不常驻、没有缓存）。
func New(storage Store, prices PriceBook, keyPrefix string, caches ...CacheInvalidator) *Service {
	if keyPrefix == "" {
		keyPrefix = "loom-"
	}
	return &Service{store: storage, prices: prices, caches: caches, keyPrefix: keyPrefix}
}

func (s *Service) invalidateAPIKey(id uuid.UUID) {
	for _, cache := range s.caches {
		cache.InvalidateAPIKey(id)
	}
}

func (s *Service) invalidateAccount(id uuid.UUID) {
	for _, cache := range s.caches {
		cache.InvalidateAccount(id)
	}
}
