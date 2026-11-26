// Package admin 提供账户 / Key / 定价 / 用量的管理操作，供 HTTP API 与 CLI（seed、admin 子命令）复用。
package admin

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/auth"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/pricing"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
	"github.com/ai-hermes/pi-lessons/apps/loom/pkg/loom"
)

// Service 管理操作。
type Service struct {
	st        store.Store
	pricing   *pricing.Service
	keyPrefix string
}

// NewService 创建管理服务。
func NewService(st store.Store, pr *pricing.Service, keyPrefix string) *Service {
	if keyPrefix == "" {
		keyPrefix = "loom-"
	}
	return &Service{st: st, pricing: pr, keyPrefix: keyPrefix}
}

// Store 底层存储。
func (s *Service) Store() store.Store { return s.st }

// CreateAccountReq 创建账户请求。
type CreateAccountReq struct {
	Name       string `json:"name"`
	Tenant     string `json:"tenant"`
	Group      string `json:"group"`
	QuotaNanos *int64 `json:"quota_limit_nanos"`
	Status     string `json:"status"`
}

// CreateAccount 创建账户。
func (s *Service) CreateAccount(ctx context.Context, r CreateAccountReq) (store.Account, error) {
	if strings.TrimSpace(r.Name) == "" {
		return store.Account{}, errors.New("name is required")
	}
	if r.Group == "" {
		r.Group = "default"
	}
	if r.Status == "" {
		r.Status = loom.StatusActive
	}
	return s.st.CreateAccount(ctx, store.Account{ID: uuid.New(), Name: r.Name, Tenant: r.Tenant, Group: r.Group,
		Status: r.Status, QuotaLimit: r.QuotaNanos})
}

// UpdateAccountReq 更新账户请求；nil 字段保持不变。
type UpdateAccountReq struct {
	Status     string `json:"status"`
	Group      string `json:"group"`
	QuotaNanos *int64 `json:"quota_limit_nanos"`
}

// UpdateAccount 更新账户。
func (s *Service) UpdateAccount(ctx context.Context, id uuid.UUID, r UpdateAccountReq) (store.Account, error) {
	cur, err := s.st.GetAccount(ctx, id)
	if err != nil {
		return store.Account{}, err
	}
	status, group, limit := cur.Status, cur.Group, cur.QuotaLimit
	if r.Status != "" {
		status = r.Status
	}
	if r.Group != "" {
		group = r.Group
	}
	if r.QuotaNanos != nil {
		limit = r.QuotaNanos
	}
	return s.st.UpdateAccount(ctx, id, status, limit, group)
}

// TopUp 增加账户额度上限。
func (s *Service) TopUp(ctx context.Context, id uuid.UUID, delta int64) (store.Account, error) {
	if delta <= 0 {
		return store.Account{}, errors.New("delta must be positive")
	}
	return s.st.AddAccountQuotaLimit(ctx, id, delta)
}

// CreateKeyReq 创建 Key 请求。
type CreateKeyReq struct {
	AccountID      uuid.UUID  `json:"account_id"`
	Name           string     `json:"name"`
	QuotaNanos     *int64     `json:"quota_limit_nanos"`
	ModelAllowlist []string   `json:"model_allowlist"`
	ExpiresAt      *time.Time `json:"expires_at"`
	// Plaintext 可选：指定明文 key（seed 用）；为空则随机生成。
	Plaintext string `json:"-"`
}

// CreatedKey 创建结果，Plaintext 只在创建时返回一次。
type CreatedKey struct {
	store.Key
	Plaintext string `json:"plaintext"`
}

// GenerateKey 生成随机明文 key。
func (s *Service) GenerateKey() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return s.keyPrefix + hex.EncodeToString(b), nil
}

// CreateKey 创建 Key。
func (s *Service) CreateKey(ctx context.Context, r CreateKeyReq) (CreatedKey, error) {
	if r.AccountID == uuid.Nil {
		return CreatedKey{}, errors.New("account_id is required")
	}
	if strings.TrimSpace(r.Name) == "" {
		return CreatedKey{}, errors.New("name is required")
	}
	plain := r.Plaintext
	if plain == "" {
		var err error
		if plain, err = s.GenerateKey(); err != nil {
			return CreatedKey{}, err
		}
	}
	preview := plain
	if len(preview) > 12 {
		preview = preview[:12]
	}
	k, err := s.st.CreateKey(ctx, store.Key{ID: uuid.New(), AccountID: r.AccountID, Name: r.Name, KeyHash: auth.HashKey(plain),
		KeyPreview: preview, Status: loom.StatusActive, QuotaLimit: r.QuotaNanos, ExpiresAt: r.ExpiresAt}, r.ModelAllowlist)
	if err != nil {
		if pgIsUnique(err) {
			return CreatedKey{}, fmt.Errorf("key already exists: %w", err)
		}
		return CreatedKey{}, err
	}
	return CreatedKey{Key: k, Plaintext: plain}, nil
}

func pgIsUnique(err error) bool {
	return strings.Contains(err.Error(), "duplicate key value") || strings.Contains(err.Error(), "23505")
}

// UpdateKeyReq 更新 Key 请求；nil 字段保持不变。
type UpdateKeyReq struct {
	Status         string     `json:"status"`
	QuotaNanos     *int64     `json:"quota_limit_nanos"`
	ModelAllowlist *[]string  `json:"model_allowlist"`
	ExpiresAt      *time.Time `json:"expires_at"`
	Name           string     `json:"name"`
}

// UpdateKey 更新 Key。
func (s *Service) UpdateKey(ctx context.Context, id uuid.UUID, r UpdateKeyReq) (store.Key, error) {
	cur, err := s.st.GetKey(ctx, id)
	if err != nil {
		return store.Key{}, err
	}
	status, limit, allow, expires, name := cur.Status, cur.QuotaLimit, cur.ModelAllowlist, cur.ExpiresAt, cur.Name
	if r.Status != "" {
		status = r.Status
	}
	if r.QuotaNanos != nil {
		limit = r.QuotaNanos
	}
	if r.ModelAllowlist != nil {
		allow = *r.ModelAllowlist
	}
	if r.ExpiresAt != nil {
		expires = r.ExpiresAt
	}
	if r.Name != "" {
		name = r.Name
	}
	return s.st.UpdateKey(ctx, id, status, allow, limit, expires, name)
}

// PricingView 合并后的定价视图。
type PricingView struct {
	Source string            `json:"source"`
	Spec   pricing.ModelSpec `json:"spec"`
}

// Pricing 列出 ConfigMap 与 PG 两处的定价。
func (s *Service) Pricing(ctx context.Context) (map[string]pricing.ModelSpec, []store.ModelPrice, error) {
	spec, _, err := s.pricing.Spec()
	if err != nil {
		return nil, nil, err
	}
	rows, err := s.st.ListModelPricing(ctx)
	return spec.Models, rows, err
}

// UpsertPricing 写入 PG 兜底定价并清理缓存。
func (s *Service) UpsertPricing(ctx context.Context, p store.ModelPrice) error {
	if p.Model == "" {
		return errors.New("model is required")
	}
	if err := s.st.UpsertModelPricing(ctx, p); err != nil {
		return err
	}
	s.pricing.InvalidatePG(p.Model)
	return nil
}

// DeletePricing 删除 PG 兜底定价并清理缓存。
func (s *Service) DeletePricing(ctx context.Context, model string) error {
	if err := s.st.DeleteModelPricing(ctx, model); err != nil {
		return err
	}
	s.pricing.InvalidatePG(model)
	return nil
}

// UsageFilter 解析查询参数。
type UsageFilter struct {
	AccountID *uuid.UUID
	KeyID     *uuid.UUID
	Since     *time.Time
	Limit     int
}
