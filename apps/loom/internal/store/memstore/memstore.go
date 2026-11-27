// Package memstore 是 store.Store 的内存实现，仅用于单元测试。
package memstore

import (
	"context"
	"slices"
	"sort"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
)

// Store 内存存储。
type Store struct {
	mu          sync.Mutex
	accounts    map[uuid.UUID]*store.Account
	apiKeys     map[uuid.UUID]*store.APIKey
	byHash      map[string]uuid.UUID
	reserv      map[string]store.Reservation
	usageEvents []store.UsageEvent
	audit       []store.Audit
	pricing     map[string]store.ModelPrice
	nextID      int64
}

// New 创建空存储。
func New() *Store {
	return &Store{
		accounts: map[uuid.UUID]*store.Account{},
		apiKeys:  map[uuid.UUID]*store.APIKey{},
		byHash:   map[string]uuid.UUID{},
		reserv:   map[string]store.Reservation{},
		pricing:  map[string]store.ModelPrice{},
	}
}

// Close 见 store.Store。
func (m *Store) Close() {}

// GetAccount 见 store.Store。
func (m *Store) GetAccount(_ context.Context, id uuid.UUID) (store.Account, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	a, ok := m.accounts[id]
	if !ok {
		return store.Account{}, store.ErrNotFound
	}
	return *a, nil
}

// GetAccountByName 见 store.Store。
func (m *Store) GetAccountByName(_ context.Context, name string) (store.Account, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, a := range m.accounts {
		if a.Name == name {
			return *a, nil
		}
	}
	return store.Account{}, store.ErrNotFound
}

// ListAccounts 见 store.Store。
func (m *Store) ListAccounts(_ context.Context, limit int) ([]store.Account, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]store.Account, 0, len(m.accounts))
	for _, a := range m.accounts {
		out = append(out, *a)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// CreateAccount 见 store.Store。
func (m *Store) CreateAccount(_ context.Context, a store.Account) (store.Account, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, x := range m.accounts {
		if x.Name == a.Name {
			return store.Account{}, store.ErrConflict
		}
	}
	if a.ID == uuid.Nil {
		a.ID = uuid.New()
	}
	if a.CreatedAt.IsZero() {
		a.CreatedAt = time.Now()
	}
	a.UpdatedAt = a.CreatedAt
	if a.Status == "" {
		a.Status = store.StatusActive
	}
	if a.Group == "" {
		a.Group = "default"
	}
	m.accounts[a.ID] = &a
	return a, nil
}

// UpdateAccount 见 store.Store。
func (m *Store) UpdateAccount(_ context.Context, id uuid.UUID, s store.AccountSettings) (store.Account, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	a, ok := m.accounts[id]
	if !ok {
		return store.Account{}, store.ErrNotFound
	}
	a.Status, a.Group, a.QuotaLimit = s.Status, s.Group, s.QuotaLimit
	a.UpdatedAt = time.Now()
	return *a, nil
}

// AddAccountQuotaLimit 见 store.Store。
func (m *Store) AddAccountQuotaLimit(_ context.Context, id uuid.UUID, delta int64) (store.Account, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	a, ok := m.accounts[id]
	if !ok {
		return store.Account{}, store.ErrNotFound
	}
	v := delta
	if a.QuotaLimit != nil {
		v += *a.QuotaLimit
	}
	a.QuotaLimit, a.UpdatedAt = &v, time.Now()
	return *a, nil
}

func reserve(limit *int64, used, reserved, nanos int64) (store.QuotaState, bool) {
	if limit != nil && *limit-used-reserved < nanos {
		return store.QuotaState{}, false
	}
	return store.QuotaState{Limit: limit, Used: used, Reserved: reserved + nanos}, true
}

// SetAccountQuota 见 store.Store。
func (m *Store) SetAccountQuota(_ context.Context, id uuid.UUID, limit *int64, used int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	a, ok := m.accounts[id]
	if !ok {
		return store.ErrNotFound
	}
	a.QuotaLimit, a.QuotaUsed, a.Reserved, a.UpdatedAt = limit, used, 0, time.Now()
	for k, r := range m.reserv {
		if r.AccountID == id {
			delete(m.reserv, k)
		}
	}
	return nil
}

// SetAPIKeyQuota 见 store.Store。
func (m *Store) SetAPIKeyQuota(_ context.Context, id uuid.UUID, limit *int64, used int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	apiKey, ok := m.apiKeys[id]
	if !ok {
		return store.ErrNotFound
	}
	apiKey.QuotaLimit, apiKey.QuotaUsed, apiKey.Reserved, apiKey.UpdatedAt = limit, used, 0, time.Now()
	for rk, r := range m.reserv {
		if r.APIKeyID == id {
			delete(m.reserv, rk)
		}
	}
	return nil
}

// ReserveAccountQuota 见 store.Store。
func (m *Store) ReserveAccountQuota(_ context.Context, id uuid.UUID, nanos int64) (store.QuotaState, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	a, ok := m.accounts[id]
	if !ok {
		return store.QuotaState{}, store.ErrNotFound
	}
	if nanos <= 0 {
		return store.QuotaState{Limit: a.QuotaLimit, Used: a.QuotaUsed, Reserved: a.Reserved}, nil
	}
	if a.Status != store.StatusActive {
		return store.QuotaState{}, store.ErrInsufficientQuota
	}
	q, ok := reserve(a.QuotaLimit, a.QuotaUsed, a.Reserved, nanos)
	if !ok {
		return store.QuotaState{}, store.ErrInsufficientQuota
	}
	a.Reserved = q.Reserved
	return q, nil
}

// ReleaseAccountReservation 见 store.Store。
func (m *Store) ReleaseAccountReservation(_ context.Context, id uuid.UUID, nanos int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	a, ok := m.accounts[id]
	if !ok {
		return store.ErrNotFound
	}
	a.Reserved -= nanos
	return nil
}

// GetAPIKeyByHash 见 store.Store。
func (m *Store) GetAPIKeyByHash(_ context.Context, hash string) (store.APIKey, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	id, ok := m.byHash[hash]
	if !ok {
		return store.APIKey{}, store.ErrNotFound
	}
	return m.apiKeyLocked(id)
}

func (m *Store) apiKeyLocked(id uuid.UUID) (store.APIKey, error) {
	apiKey, ok := m.apiKeys[id]
	if !ok {
		return store.APIKey{}, store.ErrNotFound
	}
	out := *apiKey
	out.Account = *m.accounts[apiKey.AccountID]
	return out, nil
}

// GetAPIKey 见 store.Store。
func (m *Store) GetAPIKey(_ context.Context, id uuid.UUID) (store.APIKey, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.apiKeyLocked(id)
}

// ListAPIKeys 见 store.Store。
func (m *Store) ListAPIKeys(_ context.Context, accountID *uuid.UUID, limit int) ([]store.APIKey, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]store.APIKey, 0, len(m.apiKeys))
	for _, apiKey := range m.apiKeys {
		if accountID != nil && apiKey.AccountID != *accountID {
			continue
		}
		full, _ := m.apiKeyLocked(apiKey.ID)
		out = append(out, full)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// CreateAPIKey 见 store.Store。
func (m *Store) CreateAPIKey(_ context.Context, apiKey store.APIKey) (store.APIKey, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.accounts[apiKey.AccountID]; !ok {
		return store.APIKey{}, store.ErrNotFound
	}
	if _, exists := m.byHash[apiKey.KeyHash]; exists {
		return store.APIKey{}, store.ErrConflict
	}
	if apiKey.ID == uuid.Nil {
		apiKey.ID = uuid.New()
	}
	if apiKey.CreatedAt.IsZero() {
		apiKey.CreatedAt = time.Now()
	}
	apiKey.UpdatedAt = apiKey.CreatedAt
	if apiKey.Status == "" {
		apiKey.Status = store.StatusActive
	}
	m.apiKeys[apiKey.ID] = &apiKey
	m.byHash[apiKey.KeyHash] = apiKey.ID
	return m.apiKeyLocked(apiKey.ID)
}

// UpdateAPIKey 见 store.Store。
func (m *Store) UpdateAPIKey(_ context.Context, id uuid.UUID, s store.APIKeySettings) (store.APIKey, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	apiKey, ok := m.apiKeys[id]
	if !ok {
		return store.APIKey{}, store.ErrNotFound
	}
	apiKey.Name = s.Name
	apiKey.Status = s.Status
	apiKey.ModelAllowlist = s.ModelAllowlist
	apiKey.QuotaLimit = s.QuotaLimit
	apiKey.ExpiresAt = s.ExpiresAt
	apiKey.UpdatedAt = time.Now()
	return m.apiKeyLocked(id)
}

// ReserveAPIKeyQuota 见 store.Store。
func (m *Store) ReserveAPIKeyQuota(_ context.Context, id uuid.UUID, nanos int64) (store.QuotaState, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	apiKey, ok := m.apiKeys[id]
	if !ok {
		return store.QuotaState{}, store.ErrNotFound
	}
	if nanos <= 0 {
		return store.QuotaState{Limit: apiKey.QuotaLimit, Used: apiKey.QuotaUsed, Reserved: apiKey.Reserved}, nil
	}
	if apiKey.Status != store.StatusActive || (apiKey.ExpiresAt != nil && apiKey.ExpiresAt.Before(time.Now())) {
		return store.QuotaState{}, store.ErrInsufficientQuota
	}
	q, ok := reserve(apiKey.QuotaLimit, apiKey.QuotaUsed, apiKey.Reserved, nanos)
	if !ok {
		return store.QuotaState{}, store.ErrInsufficientQuota
	}
	apiKey.Reserved, apiKey.LastUsedAt = q.Reserved, &[]time.Time{time.Now()}[0]
	return q, nil
}

// ReleaseAPIKeyReservation 见 store.Store。
func (m *Store) ReleaseAPIKeyReservation(_ context.Context, id uuid.UUID, nanos int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	apiKey, ok := m.apiKeys[id]
	if !ok {
		return store.ErrNotFound
	}
	apiKey.Reserved -= nanos
	return nil
}

// CreateReservation 见 store.Store。
func (m *Store) CreateReservation(_ context.Context, r store.Reservation) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.reserv[r.RequestID] = r
	return nil
}

// GetReservation 见 store.Store。
func (m *Store) GetReservation(_ context.Context, requestID string) (store.Reservation, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.reserv[requestID]
	if !ok {
		return store.Reservation{}, store.ErrNotFound
	}
	return r, nil
}

// ListReservations 见 store.Store。
func (m *Store) ListReservations(_ context.Context, limit int) ([]store.Reservation, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]store.Reservation, 0, len(m.reserv))
	for _, r := range m.reserv {
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// CountReservations 见 store.Store。
func (m *Store) CountReservations(_ context.Context) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return int64(len(m.reserv)), nil
}

// SettleUsage 见 store.Store。
func (m *Store) SettleUsage(_ context.Context, ev store.UsageEvent) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, event := range m.usageEvents {
		if ev.RequestID != "" && event.RequestID == ev.RequestID {
			return false, nil
		}
	}
	m.nextID++
	ev.ID, ev.Settled = m.nextID, true
	if ev.Time.IsZero() {
		ev.Time = time.Now()
	}
	m.usageEvents = append(m.usageEvents, ev)
	if ev.APIKeyID != nil {
		apiKey := m.apiKeys[*ev.APIKeyID]
		account := m.accounts[apiKey.AccountID]
		if r, ok := m.reserv[ev.RequestID]; ok {
			apiKey.QuotaUsed, apiKey.Reserved = apiKey.QuotaUsed+ev.CostNanos, apiKey.Reserved-r.Nanos
			account.QuotaUsed, account.Reserved = account.QuotaUsed+ev.CostNanos, account.Reserved-r.Nanos
			delete(m.reserv, ev.RequestID)
		} else {
			apiKey.QuotaUsed += ev.CostNanos
			account.QuotaUsed += ev.CostNanos
		}
	} else if ev.AccountID != nil {
		if a, ok := m.accounts[*ev.AccountID]; ok {
			a.QuotaUsed += ev.CostNanos
		}
	}
	return true, nil
}

// BackfillAgentGatewayCost 见 store.Store。
func (m *Store) BackfillAgentGatewayCost(_ context.Context, requestID string, nanos int64) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := range m.usageEvents {
		if m.usageEvents[i].RequestID == requestID && m.usageEvents[i].AgentGatewayCostNanos == nil {
			n := nanos
			m.usageEvents[i].AgentGatewayCostNanos = &n
			return true, nil
		}
	}
	return false, nil
}

// ReleaseExpiredReservations 见 store.Store。
func (m *Store) ReleaseExpiredReservations(_ context.Context, now time.Time, limit int) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var expired []store.Reservation
	for _, r := range m.reserv {
		if r.ExpiresAt.Before(now) {
			expired = append(expired, r)
		}
	}
	sort.Slice(expired, func(i, j int) bool { return expired[i].ExpiresAt.Before(expired[j].ExpiresAt) })
	if len(expired) > limit {
		expired = expired[:limit]
	}
	for _, r := range expired {
		m.apiKeys[r.APIKeyID].Reserved -= r.Nanos
		m.accounts[r.AccountID].Reserved -= r.Nanos
		delete(m.reserv, r.RequestID)
	}
	return len(expired), nil
}

// ListUsage 见 store.Store。
func (m *Store) ListUsage(
	_ context.Context,
	apiKeyID *uuid.UUID,
	since *time.Time,
	limit int,
) ([]store.UsageEvent, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]store.UsageEvent, 0, len(m.usageEvents))
	for _, event := range slices.Backward(m.usageEvents) {
		if apiKeyID != nil && (event.APIKeyID == nil || *event.APIKeyID != *apiKeyID) {
			continue
		}
		if since != nil && event.Time.Before(*since) {
			continue
		}
		out = append(out, event)
	}
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// SummaryUsage 见 store.Store。
func (m *Store) SummaryUsage(_ context.Context, f store.UsageFilter) ([]store.UsageSummaryRow, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	agg := map[string]*store.UsageSummaryRow{}
	for _, event := range m.usageEvents {
		if f.AccountID != nil && (event.AccountID == nil || *event.AccountID != *f.AccountID) {
			continue
		}
		if f.APIKeyID != nil && (event.APIKeyID == nil || *event.APIKeyID != *f.APIKeyID) {
			continue
		}
		if f.Since != nil && event.Time.Before(*f.Since) {
			continue
		}
		row := store.UsageSummaryRow{
			Model:        event.Model,
			InputTokens:  event.InputTokens,
			OutputTokens: event.OutputTokens,
			CachedTokens: event.CachedTokens,
			CostNanos:    event.CostNanos,
		}
		if event.AccountID != nil {
			row.AccountID = *event.AccountID
		}
		if event.APIKeyID != nil {
			row.APIKeyID = *event.APIKeyID
		}
		if event.AgentGatewayCostNanos != nil {
			row.AgentGatewayCostNanos = *event.AgentGatewayCostNanos
		}
		groupKey := row.AccountID.String() + row.APIKeyID.String() + row.Model
		if existing, ok := agg[groupKey]; ok {
			existing.Requests++
			existing.InputTokens += row.InputTokens
			existing.OutputTokens += row.OutputTokens
			existing.CachedTokens += row.CachedTokens
			existing.CostNanos += row.CostNanos
			existing.AgentGatewayCostNanos += row.AgentGatewayCostNanos
		} else {
			row.Requests = 1
			agg[groupKey] = &row
		}
	}
	out := make([]store.UsageSummaryRow, 0, len(agg))
	for _, v := range agg {
		out = append(out, *v)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CostNanos > out[j].CostNanos })
	return out, nil
}

// InsertAudit 见 store.Store。
func (m *Store) InsertAudit(_ context.Context, rows []store.Audit) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, r := range rows {
		if r.Time.IsZero() {
			r.Time = time.Now()
		}
		m.audit = append(m.audit, r)
	}
	return nil
}

// ListAudit 见 store.Store。
func (m *Store) ListAudit(_ context.Context, apiKeyID *uuid.UUID, limit int) ([]store.Audit, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]store.Audit, 0, len(m.audit))
	for _, a := range slices.Backward(m.audit) {
		if apiKeyID != nil && (a.APIKeyID == nil || *a.APIKeyID != *apiKeyID) {
			continue
		}
		out = append(out, a)
	}
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// ListModelPricing 见 store.Store。
func (m *Store) ListModelPricing(_ context.Context) ([]store.ModelPrice, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]store.ModelPrice, 0, len(m.pricing))
	for _, p := range m.pricing {
		if p.Enabled {
			out = append(out, p)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Model < out[j].Model })
	return out, nil
}

// GetModelPrice 见 store.Store。
func (m *Store) GetModelPrice(_ context.Context, model string) (store.ModelPrice, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.pricing[model]
	if !ok || !p.Enabled {
		return store.ModelPrice{}, store.ErrNotFound
	}
	return p, nil
}

// UpsertModelPricing 见 store.Store。
func (m *Store) UpsertModelPricing(_ context.Context, p store.ModelPrice) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	p.Enabled, p.UpdatedAt = true, time.Now()
	m.pricing[p.Model] = p
	return nil
}

// DeleteModelPricing 见 store.Store。
func (m *Store) DeleteModelPricing(_ context.Context, model string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.pricing, model)
	return nil
}
