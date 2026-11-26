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

const keyPreviewLen = 12

// NewKey 创建 Key 的参数。
type NewKey struct {
	AccountID      uuid.UUID  `json:"account_id"`
	Name           string     `json:"name"`
	QuotaNanos     *int64     `json:"quota_limit_nanos"` // nil = 跟随账户
	ModelAllowlist []string   `json:"model_allowlist"`   // nil = 全部模型
	ExpiresAt      *time.Time `json:"expires_at"`
	// Plaintext 指定明文（仅 seed 使用）；为空时随机生成。
	Plaintext string `json:"-"`
}

// KeyUpdate 修改 Key 的参数；零值或 nil 字段保持不变。
type KeyUpdate struct {
	Name           string       `json:"name"`
	Status         store.Status `json:"status"`
	QuotaNanos     *int64       `json:"quota_limit_nanos"`
	ModelAllowlist *[]string    `json:"model_allowlist"`
	ExpiresAt      *time.Time   `json:"expires_at"`
}

// IssuedKey 新建 Key 的结果；Plaintext 只在创建时返回这一次。
type IssuedKey struct {
	Key       store.Key
	Plaintext string
}

// CreateKey 创建 Key。
func (s *Service) CreateKey(ctx context.Context, in NewKey) (IssuedKey, error) {
	if in.AccountID == uuid.Nil {
		return IssuedKey{}, fmt.Errorf("%w: account_id is required", ErrInvalidInput)
	}
	if strings.TrimSpace(in.Name) == "" {
		return IssuedKey{}, fmt.Errorf("%w: name is required", ErrInvalidInput)
	}
	plaintext := in.Plaintext
	if plaintext == "" {
		var err error
		if plaintext, err = s.generatePlaintext(); err != nil {
			return IssuedKey{}, err
		}
	}
	key, err := s.store.CreateKey(ctx, store.Key{
		ID:         uuid.New(),
		AccountID:  in.AccountID,
		Name:       in.Name,
		KeyHash:    store.HashAPIKey(plaintext),
		KeyPreview: preview(plaintext),
		Status:     store.StatusActive,
		QuotaLimit: in.QuotaNanos,
		ExpiresAt:  in.ExpiresAt,
	}, in.ModelAllowlist)
	if err != nil {
		return IssuedKey{}, err
	}
	return IssuedKey{Key: key, Plaintext: plaintext}, nil
}

// UpdateKey 修改 Key，并清除准入缓存。
func (s *Service) UpdateKey(ctx context.Context, id uuid.UUID, in KeyUpdate) (store.Key, error) {
	cur, err := s.store.GetKey(ctx, id)
	if err != nil {
		return store.Key{}, err
	}
	limit, allowlist, expiresAt := cur.QuotaLimit, cur.ModelAllowlist, cur.ExpiresAt
	if in.QuotaNanos != nil {
		limit = in.QuotaNanos
	}
	if in.ModelAllowlist != nil {
		allowlist = *in.ModelAllowlist
	}
	if in.ExpiresAt != nil {
		expiresAt = in.ExpiresAt
	}
	key, err := s.store.UpdateKey(
		ctx,
		id,
		orDefault(in.Status, cur.Status),
		allowlist,
		limit,
		expiresAt,
		orDefault(in.Name, cur.Name),
	)
	if err != nil {
		return store.Key{}, err
	}
	s.invalidateKey(id)
	return key, nil
}

// ResetKeyQuota 设置 Key 额度并清空其预扣。
func (s *Service) ResetKeyQuota(ctx context.Context, id uuid.UUID, in QuotaReset) (store.Key, error) {
	if err := s.store.SetKeyQuota(ctx, id, in.LimitNanos, in.UsedNanos); err != nil {
		return store.Key{}, err
	}
	s.invalidateKey(id)
	return s.store.GetKey(ctx, id)
}

// GetKey 查询 Key。
func (s *Service) GetKey(ctx context.Context, id uuid.UUID) (store.Key, error) {
	return s.store.GetKey(ctx, id)
}

// ListKeys 列出 Key；accountID 为 nil 时列出全部。
func (s *Service) ListKeys(ctx context.Context, accountID *uuid.UUID, limit int) ([]store.Key, error) {
	return s.store.ListKeys(ctx, accountID, limit)
}

func (s *Service) generatePlaintext() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate key: %w", err)
	}
	return s.keyPrefix + hex.EncodeToString(b), nil
}

func preview(plaintext string) string {
	if len(plaintext) > keyPreviewLen {
		return plaintext[:keyPreviewLen]
	}
	return plaintext
}
