package account

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
)

const apiKeyPreviewLen = 12

// CreateAPIKeyInput 创建 Key 的参数。
type CreateAPIKeyInput struct {
	AccountID      uuid.UUID  `json:"account_id"`
	Name           string     `json:"name"`
	QuotaNanos     *int64     `json:"quota_limit_nanos"` // nil = 跟随账户
	ModelAllowlist []string   `json:"model_allowlist"`   // nil = 全部模型
	ExpiresAt      *time.Time `json:"expires_at"`
	// Plaintext 指定明文（仅 seed 使用）；为空时随机生成。
	Plaintext string `json:"-"`
	// RateLimits API Key 级限流；不继承分组默认值。
	RateLimits store.RateLimits `json:"rate_limits"`
}

// APIKeyUpdate 修改 Key 的参数；零值或 nil 字段保持不变。
type APIKeyUpdate struct {
	Name           string       `json:"name"`
	Status         store.Status `json:"status"`
	QuotaNanos     *int64       `json:"quota_limit_nanos"`
	ModelAllowlist *[]string    `json:"model_allowlist"`
	ExpiresAt      *time.Time   `json:"expires_at"`
	// RateLimits 非 nil 时整体替换三项（其中为 null 的项表示不限）。
	RateLimits *store.RateLimits `json:"rate_limits"`
}

// IssuedAPIKey 新建 Key 的结果；Plaintext 只在创建时返回这一次。
type IssuedAPIKey struct {
	APIKey    store.APIKey
	Plaintext string
}

// CreateAPIKey 创建 Key。
func (s *Service) CreateAPIKey(ctx context.Context, in CreateAPIKeyInput) (IssuedAPIKey, error) {
	if in.AccountID == uuid.Nil {
		return IssuedAPIKey{}, fmt.Errorf("%w: account_id is required", ErrInvalidInput)
	}
	if strings.TrimSpace(in.Name) == "" {
		return IssuedAPIKey{}, fmt.Errorf("%w: name is required", ErrInvalidInput)
	}
	if err := validateRateLimits(in.RateLimits); err != nil {
		return IssuedAPIKey{}, err
	}
	plaintext := in.Plaintext
	if plaintext == "" {
		var err error
		if plaintext, err = s.generatePlaintext(); err != nil {
			return IssuedAPIKey{}, err
		}
	}
	apiKey, err := s.store.CreateAPIKey(ctx, store.APIKey{
		ID:             uuid.New(),
		AccountID:      in.AccountID,
		Name:           in.Name,
		KeyHash:        store.HashAPIKey(plaintext),
		KeyPreview:     preview(plaintext),
		Status:         store.StatusActive,
		ModelAllowlist: in.ModelAllowlist,
		QuotaLimit:     in.QuotaNanos,
		ExpiresAt:      in.ExpiresAt,
		Limits:         in.RateLimits,
	})
	if err != nil {
		return IssuedAPIKey{}, err
	}
	return IssuedAPIKey{APIKey: apiKey, Plaintext: plaintext}, nil
}

// UpdateAPIKey 修改 Key，并清除准入缓存。
func (s *Service) UpdateAPIKey(ctx context.Context, id uuid.UUID, in APIKeyUpdate) (store.APIKey, error) {
	cur, err := s.store.GetAPIKey(ctx, id)
	if err != nil {
		return store.APIKey{}, err
	}
	settings := cur.Settings()
	settings.Name = orDefault(in.Name, settings.Name)
	settings.Status = orDefault(in.Status, settings.Status)
	if in.QuotaNanos != nil {
		settings.QuotaLimit = in.QuotaNanos
	}
	if in.ModelAllowlist != nil {
		settings.ModelAllowlist = *in.ModelAllowlist
	}
	if in.ExpiresAt != nil {
		settings.ExpiresAt = in.ExpiresAt
	}
	if in.RateLimits != nil {
		settings.Limits = *in.RateLimits
	}
	if err := validateRateLimits(settings.Limits); err != nil {
		return store.APIKey{}, err
	}
	apiKey, err := s.store.UpdateAPIKey(ctx, id, settings)
	if err != nil {
		return store.APIKey{}, err
	}
	s.caches.InvalidateAPIKey(ctx, id)
	return apiKey, nil
}

// ResetAPIKeyQuota 设置 Key 额度并清空其预扣。
func (s *Service) ResetAPIKeyQuota(ctx context.Context, id uuid.UUID, in QuotaReset) (store.APIKey, error) {
	if err := s.store.SetAPIKeyQuota(ctx, id, in.change(ctx)); err != nil {
		return store.APIKey{}, err
	}
	s.caches.InvalidateAPIKey(ctx, id)
	return s.store.GetAPIKey(ctx, id)
}

// GetAPIKey 查询 API Key。
func (s *Service) GetAPIKey(ctx context.Context, id uuid.UUID) (store.APIKey, error) {
	return s.store.GetAPIKey(ctx, id)
}

// ListAPIKeys 列出 Key；accountID 为 nil 时列出全部。
func (s *Service) ListAPIKeys(ctx context.Context, accountID *uuid.UUID, limit int) ([]store.APIKey, error) {
	return s.store.ListAPIKeys(ctx, accountID, limit)
}

func (s *Service) generatePlaintext() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate api key: %w", err)
	}
	return s.keyPrefix + hex.EncodeToString(b), nil
}

func preview(plaintext string) string {
	if len(plaintext) > apiKeyPreviewLen {
		return plaintext[:apiKeyPreviewLen]
	}
	return plaintext
}
