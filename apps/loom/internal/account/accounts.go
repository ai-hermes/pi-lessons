package account

import (
	"context"
	"fmt"
	"strings"

	"github.com/google/uuid"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
)

const defaultGroup = "default"

// NewAccount 创建账户的参数。
type NewAccount struct {
	Name       string       `json:"name"`
	Tenant     string       `json:"tenant"`
	Group      string       `json:"group"`
	QuotaNanos *int64       `json:"quota_limit_nanos"` // nil = 不限
	Status     store.Status `json:"status"`
}

// AccountUpdate 修改账户的参数；零值字段保持不变。
type AccountUpdate struct {
	Status     store.Status `json:"status"`
	Group      string       `json:"group"`
	QuotaNanos *int64       `json:"quota_limit_nanos"`
}

// QuotaReset 直接设置额度上限与已用量，并清空预扣（运维与验收复位用）。
type QuotaReset struct {
	LimitNanos *int64 `json:"quota_limit_nanos"`
	UsedNanos  int64  `json:"quota_used_nanos"`
}

// CreateAccount 创建账户。
func (s *Service) CreateAccount(ctx context.Context, in NewAccount) (store.Account, error) {
	if strings.TrimSpace(in.Name) == "" {
		return store.Account{}, fmt.Errorf("%w: name is required", ErrInvalidInput)
	}
	return s.store.CreateAccount(ctx, store.Account{
		ID:         uuid.New(),
		Name:       in.Name,
		Tenant:     in.Tenant,
		Group:      orDefault(in.Group, defaultGroup),
		Status:     orDefault(in.Status, store.StatusActive),
		QuotaLimit: in.QuotaNanos,
	})
}

// UpdateAccount 修改账户。
func (s *Service) UpdateAccount(ctx context.Context, id uuid.UUID, in AccountUpdate) (store.Account, error) {
	cur, err := s.store.GetAccount(ctx, id)
	if err != nil {
		return store.Account{}, err
	}
	limit := cur.QuotaLimit
	if in.QuotaNanos != nil {
		limit = in.QuotaNanos
	}
	return s.store.UpdateAccount(ctx, id, orDefault(in.Status, cur.Status), limit, orDefault(in.Group, cur.Group))
}

// TopUp 增加账户额度上限。
func (s *Service) TopUp(ctx context.Context, id uuid.UUID, nanos int64) (store.Account, error) {
	if nanos <= 0 {
		return store.Account{}, fmt.Errorf("%w: nanos must be positive", ErrInvalidInput)
	}
	return s.store.AddAccountQuotaLimit(ctx, id, nanos)
}

// ResetAccountQuota 设置账户额度并清空其预扣。
func (s *Service) ResetAccountQuota(ctx context.Context, id uuid.UUID, in QuotaReset) (store.Account, error) {
	if err := s.store.SetAccountQuota(ctx, id, in.LimitNanos, in.UsedNanos); err != nil {
		return store.Account{}, err
	}
	return s.store.GetAccount(ctx, id)
}

// GetAccount 查询账户。
func (s *Service) GetAccount(ctx context.Context, id uuid.UUID) (store.Account, error) {
	return s.store.GetAccount(ctx, id)
}

// ListAccounts 列出账户。
func (s *Service) ListAccounts(ctx context.Context, limit int) ([]store.Account, error) {
	return s.store.ListAccounts(ctx, limit)
}

func orDefault[T comparable](v, fallback T) T {
	var zero T
	if v == zero {
		return fallback
	}
	return v
}
