package adminapi

import (
	"time"

	"github.com/google/uuid"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
)

// accountView 账户的 API 表示；金额均为 nano-USD。
type accountView struct {
	ID                  uuid.UUID        `json:"id"`
	Name                string           `json:"name"`
	Tenant              string           `json:"tenant"`
	Group               string           `json:"group"`
	Status              store.Status     `json:"status"`
	QuotaLimitNanos     *int64           `json:"quota_limit_nanos"`
	QuotaUsedNanos      int64            `json:"quota_used_nanos"`
	ReservedNanos       int64            `json:"reserved_nanos"`
	QuotaRemainingNanos *int64           `json:"quota_remaining_nanos,omitempty"`
	RateLimits          store.RateLimits `json:"rate_limits"` // 本账户的配置；未配置的项按分组默认值生效
	InFlight            int64            `json:"in_flight"`
	CreatedAt           time.Time        `json:"created_at,omitzero"`
	UpdatedAt           time.Time        `json:"updated_at,omitzero"`
}

func newAccountView(a store.Account) accountView {
	v := accountView{
		ID:              a.ID,
		Name:            a.Name,
		Tenant:          a.Tenant,
		Group:           a.Group,
		Status:          a.Status,
		QuotaLimitNanos: a.QuotaLimit,
		QuotaUsedNanos:  a.QuotaUsed,
		ReservedNanos:   a.Reserved,
		RateLimits:      a.Limits,
		InFlight:        a.InFlight,
		CreatedAt:       a.CreatedAt,
		UpdatedAt:       a.UpdatedAt,
	}
	if remaining, bounded := a.Remaining(); bounded {
		v.QuotaRemainingNanos = &remaining
	}
	return v
}

// apiKeyView Key 的 API 表示；不包含摘要与明文。
type apiKeyView struct {
	ID                  uuid.UUID        `json:"id"`
	AccountID           uuid.UUID        `json:"account_id"`
	Name                string           `json:"name"`
	KeyPreview          string           `json:"key_preview"`
	Status              store.Status     `json:"status"`
	ModelAllowlist      []string         `json:"model_allowlist"`
	QuotaLimitNanos     *int64           `json:"quota_limit_nanos"`
	QuotaUsedNanos      int64            `json:"quota_used_nanos"`
	ReservedNanos       int64            `json:"reserved_nanos"`
	QuotaRemainingNanos *int64           `json:"quota_remaining_nanos,omitempty"`
	RateLimits          store.RateLimits `json:"rate_limits"`
	InFlight            int64            `json:"in_flight"`
	ExpiresAt           *time.Time       `json:"expires_at"`
	LastUsedAt          *time.Time       `json:"last_used_at"`
	CreatedAt           time.Time        `json:"created_at"`
	Account             accountView      `json:"account"`
}

func newAPIKeyView(k store.APIKey) apiKeyView {
	v := apiKeyView{
		ID:              k.ID,
		AccountID:       k.AccountID,
		Name:            k.Name,
		KeyPreview:      k.KeyPreview,
		Status:          k.Status,
		ModelAllowlist:  k.ModelAllowlist,
		QuotaLimitNanos: k.QuotaLimit,
		QuotaUsedNanos:  k.QuotaUsed,
		ReservedNanos:   k.Reserved,
		RateLimits:      k.Limits,
		InFlight:        k.InFlight,
		ExpiresAt:       k.ExpiresAt,
		LastUsedAt:      k.LastUsedAt,
		CreatedAt:       k.CreatedAt,
		Account:         newAccountView(k.Account),
	}
	if k.QuotaLimit != nil {
		remaining := *k.QuotaLimit - k.QuotaUsed - k.Reserved
		v.QuotaRemainingNanos = &remaining
	}
	return v
}
