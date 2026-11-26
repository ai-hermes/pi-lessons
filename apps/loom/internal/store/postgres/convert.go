package postgres

import (
	"encoding/json"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store/sqlcgen"
)

// sqlc 行类型 ↔ store 领域类型的转换。

func toAccount(a sqlcgen.Account) store.Account {
	return store.Account{
		ID:         a.ID,
		Name:       a.Name,
		Tenant:     a.Tenant,
		Group:      a.Group,
		Status:     store.Status(a.Status),
		QuotaLimit: a.QuotaLimit,
		QuotaUsed:  a.QuotaUsed,
		Reserved:   a.Reserved,
		CreatedAt:  a.CreatedAt,
		UpdatedAt:  a.UpdatedAt,
	}
}

// toKey 转换带账户快照的 Key 行。sqlc 为 GetKeyByHash / GetKey / ListKeys 生成了
// 字段完全相同的三个行类型，调用方用类型转换统一成 GetKeyByHashRow。
func toKey(r sqlcgen.GetKeyByHashRow) store.Key {
	return store.Key{
		ID:             r.ID,
		AccountID:      r.AccountID,
		Name:           r.Name,
		KeyHash:        r.KeyHash,
		KeyPreview:     r.KeyPreview,
		Status:         store.Status(r.Status),
		ModelAllowlist: decodeAllowlist(r.ModelAllowlist),
		QuotaLimit:     r.QuotaLimit,
		QuotaUsed:      r.QuotaUsed,
		Reserved:       r.Reserved,
		ExpiresAt:      r.ExpiresAt,
		LastUsedAt:     r.LastUsedAt,
		CreatedAt:      r.CreatedAt,
		UpdatedAt:      r.UpdatedAt,
		Account: store.Account{
			ID:         r.AccountID,
			Name:       r.AccountName,
			Tenant:     r.AccountTenant,
			Group:      r.AccountGroup,
			Status:     store.Status(r.AccountStatus),
			QuotaLimit: r.AccountQuotaLimit,
			QuotaUsed:  r.AccountQuotaUsed,
			Reserved:   r.AccountReserved,
		},
	}
}

func toReservation(r sqlcgen.Reservation) store.Reservation {
	return store.Reservation{
		RequestID: r.RequestID,
		KeyID:     r.KeyID,
		AccountID: r.AccountID,
		Model:     r.Model,
		Nanos:     r.Nanos,
		ExpiresAt: r.ExpiresAt,
		CreatedAt: r.CreatedAt,
	}
}

func toUsageEvent(u sqlcgen.UsageEvent) store.UsageEvent {
	return store.UsageEvent{
		ID:               u.ID,
		Time:             u.Time,
		RequestID:        u.RequestID.String,
		TraceID:          u.TraceID,
		SpanID:           u.SpanID,
		AccountID:        u.AccountID,
		KeyID:            u.KeyID,
		Model:            u.Model,
		Provider:         u.Provider,
		Route:            u.Route,
		Gateway:          u.Gateway,
		InputTokens:      u.InputTokens,
		OutputTokens:     u.OutputTokens,
		CachedTokens:     u.CachedTokens,
		CostNanos:        u.CostNanos,
		GatewayCostNanos: u.GatewayCostNanos,
		PricingSource:    u.PricingSource,
		Settled:          u.Settled,
	}
}

func toAudit(a sqlcgen.AuthAudit) store.Audit {
	return store.Audit{
		Time:            a.Time,
		RequestID:       a.RequestID,
		ClientRequestID: a.ClientRequestID,
		KeyID:           a.KeyID,
		AccountID:       a.AccountID,
		Protocol:        a.Protocol,
		Model:           a.Model,
		Allowed:         a.Allowed,
		Reason:          a.Reason,
	}
}

func toModelPrice(m sqlcgen.ModelPricing) store.ModelPrice {
	return store.ModelPrice{
		Model:               m.Model,
		ModelRatio:          m.ModelRatio,
		CompletionRatio:     m.CompletionRatio,
		CacheRatio:          m.CacheRatio,
		ModelPrice:          m.ModelPrice,
		ReserveInputTokens:  m.ReserveInputTokens,
		ReserveOutputTokens: m.ReserveOutputTokens,
		Enabled:             m.Enabled,
		UpdatedAt:           m.UpdatedAt,
	}
}

func decodeAllowlist(b []byte) []string {
	var models []string
	if len(b) == 0 || json.Unmarshal(b, &models) != nil {
		return nil
	}
	return models
}

func encodeAllowlist(models []string) []byte {
	if len(models) == 0 {
		return nil
	}
	b, _ := json.Marshal(models)
	return b
}

// optionalText 把空字符串存为 NULL。
func optionalText(s string) pgtype.Text { return pgtype.Text{String: s, Valid: s != ""} }

func mapRows[R, T any](rows []R, convert func(R) T) []T {
	out := make([]T, 0, len(rows))
	for _, r := range rows {
		out = append(out, convert(r))
	}
	return out
}
