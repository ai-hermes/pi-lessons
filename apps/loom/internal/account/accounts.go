package account

import (
	"context"
	"fmt"
	"strings"

	"github.com/google/uuid"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/pricing"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
)

// CreateAccountInput 创建账户的参数。
type CreateAccountInput struct {
	Name       string       `json:"name"`
	Tenant     string       `json:"tenant"`
	Group      string       `json:"group"`
	QuotaNanos *int64       `json:"quota_limit_nanos"` // nil = 不限
	Status     store.Status `json:"status"`
}

// UpdateAccountInput 修改账户的参数；零值字段保持不变。
type UpdateAccountInput struct {
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
func (s *Service) CreateAccount(ctx context.Context, in CreateAccountInput) (store.Account, error) {
	if strings.TrimSpace(in.Name) == "" {
		return store.Account{}, fmt.Errorf("%w: name is required", ErrInvalidInput)
	}
	group := orDefault(in.Group, pricing.DefaultGroup)
	if err := s.validateGroup(group); err != nil {
		return store.Account{}, err
	}
	return s.store.CreateAccount(ctx, store.Account{
		ID:         uuid.New(),
		Name:       in.Name,
		Tenant:     in.Tenant,
		Group:      group,
		Status:     orDefault(in.Status, store.StatusActive),
		QuotaLimit: in.QuotaNanos,
	})
}

// UpdateAccount 修改账户。
func (s *Service) UpdateAccount(ctx context.Context, id uuid.UUID, in UpdateAccountInput) (store.Account, error) {
	cur, err := s.store.GetAccount(ctx, id)
	if err != nil {
		return store.Account{}, err
	}
	settings := cur.Settings()
	settings.Status = orDefault(in.Status, settings.Status)
	settings.Group = orDefault(in.Group, settings.Group)
	if in.QuotaNanos != nil {
		settings.QuotaLimit = in.QuotaNanos
	}
	if err := s.validateGroup(settings.Group); err != nil {
		return store.Account{}, err
	}
	account, err := s.store.UpdateAccount(ctx, id, settings)
	if err != nil {
		return store.Account{}, err
	}
	s.invalidateAccount(id)
	return account, nil
}

// validateGroup 拒绝 pricing.yaml 中未定义的分组（unknown_group 为 default 时放行）。
func (s *Service) validateGroup(group string) error {
	if err := s.prices.PriceConfig().ValidateGroup(group); err != nil {
		return fmt.Errorf("%w: group %w", ErrInvalidInput, err)
	}
	return nil
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
