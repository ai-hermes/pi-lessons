// Package memstore 是 store.Store 的内存实现，仅用于单元测试。
package memstore

import (
	"context"
	"maps"
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
	rates       map[rateKey]*rateCount
	settled     map[string]settledRequest
	daily       map[dailyKey]store.UsageSummaryRow
	rollupMark  *time.Time
	usageEvents []store.UsageEvent
	audit       []store.Audit
	pricing     map[string]store.ModelPrice
	nextID      int64

	quotaAdjustments []store.QuotaAdjustment
	adminTokens      []*store.AdminToken
	adminAudit       []store.AdminAudit
}

// New 创建空存储。
func New() *Store {
	return &Store{
		accounts: map[uuid.UUID]*store.Account{},
		apiKeys:  map[uuid.UUID]*store.APIKey{},
		byHash:   map[string]uuid.UUID{},
		reserv:   map[string]store.Reservation{},
		rates:    map[rateKey]*rateCount{},
		settled:  map[string]settledRequest{},
		daily:    map[dailyKey]store.UsageSummaryRow{},
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
	a.Status, a.Group, a.QuotaLimit, a.Limits = s.Status, s.Group, s.QuotaLimit, s.Limits
	a.UpdatedAt = time.Now()
	return *a, nil
}

// AddAccountQuotaLimit 见 store.Store。
func (m *Store) AddAccountQuotaLimit(
	_ context.Context,
	id uuid.UUID,
	delta int64,
	actor string,
) (store.Account, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	a, ok := m.accounts[id]
	if !ok {
		return store.Account{}, store.ErrNotFound
	}
	before := a.QuotaLimit
	v := delta
	if a.QuotaLimit != nil {
		v += *a.QuotaLimit
	}
	a.QuotaLimit, a.UpdatedAt = &v, time.Now()
	m.appendAdjustmentLocked(store.QuotaAdjustment{
		AccountID:   id,
		Kind:        store.QuotaTopUp,
		LimitBefore: before,
		LimitAfter:  a.QuotaLimit,
		UsedBefore:  a.QuotaUsed,
		UsedAfter:   a.QuotaUsed,
		Actor:       actor,
	})
	return *a, nil
}

func (m *Store) appendAdjustmentLocked(adj store.QuotaAdjustment) {
	m.nextID++
	adj.ID, adj.Time = m.nextID, time.Now()
	m.quotaAdjustments = append(m.quotaAdjustments, adj)
}

func reserve(limit *int64, used, reserved, nanos int64) (store.QuotaState, bool) {
	if limit != nil && *limit-used-reserved < nanos {
		return store.QuotaState{}, false
	}
	return store.QuotaState{Limit: limit, Used: used, Reserved: reserved + nanos}, true
}

// SetAccountQuota 见 store.Store。
func (m *Store) SetAccountQuota(_ context.Context, id uuid.UUID, change store.QuotaChange) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	a, ok := m.accounts[id]
	if !ok {
		return store.ErrNotFound
	}
	m.appendAdjustmentLocked(store.QuotaAdjustment{
		AccountID:   id,
		Kind:        store.QuotaReset,
		LimitBefore: a.QuotaLimit,
		LimitAfter:  change.LimitNanos,
		UsedBefore:  a.QuotaUsed,
		UsedAfter:   change.UsedNanos,
		Actor:       change.Actor,
	})
	a.QuotaLimit, a.QuotaUsed, a.Reserved, a.InFlight = change.LimitNanos, change.UsedNanos, 0, 0
	a.UpdatedAt = time.Now()
	for k, r := range m.reserv {
		if r.AccountID == id {
			m.apiKeys[r.APIKeyID].Reserved -= r.Nanos
			m.apiKeys[r.APIKeyID].InFlight--
			delete(m.reserv, k)
		}
	}
	return nil
}

// SetAPIKeyQuota 见 store.Store。
func (m *Store) SetAPIKeyQuota(_ context.Context, id uuid.UUID, change store.QuotaChange) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	apiKey, ok := m.apiKeys[id]
	if !ok {
		return store.ErrNotFound
	}
	apiKeyID := id
	m.appendAdjustmentLocked(store.QuotaAdjustment{
		AccountID:   apiKey.AccountID,
		APIKeyID:    &apiKeyID,
		Kind:        store.QuotaReset,
		LimitBefore: apiKey.QuotaLimit,
		LimitAfter:  change.LimitNanos,
		UsedBefore:  apiKey.QuotaUsed,
		UsedAfter:   change.UsedNanos,
		Actor:       change.Actor,
	})
	apiKey.QuotaLimit, apiKey.QuotaUsed, apiKey.Reserved, apiKey.InFlight = change.LimitNanos, change.UsedNanos, 0, 0
	apiKey.UpdatedAt = time.Now()
	for rk, r := range m.reserv {
		if r.APIKeyID == id {
			m.accounts[r.AccountID].Reserved -= r.Nanos
			m.accounts[r.AccountID].InFlight--
			delete(m.reserv, rk)
		}
	}
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
	apiKey.Limits = s.Limits
	apiKey.UpdatedAt = time.Now()
	return m.apiKeyLocked(id)
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
	if ev.Time.IsZero() {
		ev.Time = time.Now()
	}
	if ev.RequestID != "" {
		if _, ok := m.settled[ev.RequestID]; ok {
			return false, nil
		}
		m.settled[ev.RequestID] = settledRequest{usageTime: ev.Time, settledAt: time.Now()}
	}
	m.nextID++
	ev.ID, ev.Settled = m.nextID, true
	m.usageEvents = append(m.usageEvents, ev)
	// 与 PostgreSQL 一致：有预扣时按预扣记录的两级结算；没有时按事件上的 Key 与账户累加，不存在的对象跳过
	if r, ok := m.reserv[ev.RequestID]; ok && ev.APIKeyID != nil {
		m.apiKeys[r.APIKeyID].QuotaUsed += ev.CostNanos
		m.accounts[r.AccountID].QuotaUsed += ev.CostNanos
		m.releaseLocked(r)
		return true, nil
	}
	if ev.APIKeyID != nil {
		if apiKey, ok := m.apiKeys[*ev.APIKeyID]; ok {
			apiKey.QuotaUsed += ev.CostNanos
		}
	}
	if ev.AccountID != nil {
		if account, ok := m.accounts[*ev.AccountID]; ok {
			account.QuotaUsed += ev.CostNanos
		}
	}
	return true, nil
}

// BackfillAgentGatewayCost 见 store.Store。
func (m *Store) BackfillAgentGatewayCost(_ context.Context, requestID string, nanos int64) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.settled[requestID]; !ok {
		return false, nil // 与 PostgreSQL 一致：超出幂等保留期的请求不再补写
	}
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
		m.releaseLocked(r)
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
	agg := map[summaryKey]*store.UsageSummaryRow{}
	add := func(row store.UsageSummaryRow) {
		k := summaryKey{row.AccountID, row.APIKeyID, row.Model}
		existing, ok := agg[k]
		if !ok {
			agg[k] = &row
			return
		}
		existing.Requests += row.Requests
		existing.InputTokens += row.InputTokens
		existing.OutputTokens += row.OutputTokens
		existing.CachedTokens += row.CachedTokens
		existing.CostNanos += row.CostNanos
		existing.AgentGatewayCostNanos += row.AgentGatewayCostNanos
	}
	// 与 PostgreSQL 一致：水位线之前查日汇总（since 按 UTC 日对齐），之后查明细
	var mark time.Time
	if m.rollupMark != nil {
		mark = *m.rollupMark
	}
	for _, event := range m.usageEvents {
		row := summaryRowOf(event)
		if event.Time.Before(mark) || !f.Matches(row.AccountID, row.APIKeyID) {
			continue
		}
		if f.Since != nil && event.Time.Before(*f.Since) {
			continue
		}
		add(row)
	}
	for k, row := range m.daily {
		if !k.day.Before(utcDay(mark)) || !f.Matches(row.AccountID, row.APIKeyID) {
			continue
		}
		if f.Since != nil && k.day.Before(utcDay(*f.Since)) {
			continue
		}
		add(row)
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
		r.Count = max(r.Count, 1)
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

// ListQuotaAdjustments 见 store.Store。
func (m *Store) ListQuotaAdjustments(
	_ context.Context,
	f store.QuotaAdjustmentFilter,
	limit int,
) ([]store.QuotaAdjustment, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []store.QuotaAdjustment{}
	for _, adj := range slices.Backward(m.quotaAdjustments) {
		if f.AccountID != nil && adj.AccountID != *f.AccountID {
			continue
		}
		if f.APIKeyID != nil && (adj.APIKeyID == nil || *adj.APIKeyID != *f.APIKeyID) {
			continue
		}
		out = append(out, adj)
		if len(out) == limit {
			break
		}
	}
	return out, nil
}

// CreateAdminToken 见 store.Store。
func (m *Store) CreateAdminToken(_ context.Context, t store.AdminToken) (store.AdminToken, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, existing := range m.adminTokens {
		if existing.Name == t.Name || existing.TokenHash == t.TokenHash {
			return store.AdminToken{}, store.ErrConflict
		}
	}
	t.CreatedAt = time.Now()
	m.adminTokens = append(m.adminTokens, &t)
	return t, nil
}

// GetAdminTokenByHash 见 store.Store。
func (m *Store) GetAdminTokenByHash(_ context.Context, hash string) (store.AdminToken, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, t := range m.adminTokens {
		if t.TokenHash == hash && t.RevokedAt == nil {
			return *t, nil
		}
	}
	return store.AdminToken{}, store.ErrNotFound
}

// ListAdminTokens 见 store.Store。
func (m *Store) ListAdminTokens(context.Context) ([]store.AdminToken, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]store.AdminToken, 0, len(m.adminTokens))
	for _, t := range m.adminTokens {
		out = append(out, *t)
	}
	return out, nil
}

// RevokeAdminToken 见 store.Store。
func (m *Store) RevokeAdminToken(_ context.Context, id uuid.UUID) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, t := range m.adminTokens {
		if t.ID == id && t.RevokedAt == nil {
			now := time.Now()
			t.RevokedAt = &now
			return nil
		}
	}
	return store.ErrNotFound
}

// InsertAdminAudit 见 store.Store。
func (m *Store) InsertAdminAudit(_ context.Context, row store.AdminAudit) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.nextID++
	row.ID, row.Time = m.nextID, time.Now()
	m.adminAudit = append(m.adminAudit, row)
	return nil
}

// ListAdminAudit 见 store.Store。
func (m *Store) ListAdminAudit(_ context.Context, limit int) ([]store.AdminAudit, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []store.AdminAudit{}
	for _, row := range slices.Backward(m.adminAudit) {
		out = append(out, row)
		if len(out) == limit {
			break
		}
	}
	return out, nil
}

// ReserveQuota 见 store.Store：在同一把锁内检查两级额度与并发，全部满足才同时生效。
func (m *Store) ReserveQuota(
	ctx context.Context,
	r store.Reservation,
	concurrency store.ConcurrencyLimits,
) (store.QuotaReservation, error) {
	if err := ctx.Err(); err != nil {
		return store.QuotaReservation{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	apiKey, keyOK := m.apiKeys[r.APIKeyID]
	account, accountOK := m.accounts[r.AccountID]
	if !keyOK || !accountOK {
		return store.QuotaReservation{}, store.ErrInsufficientQuota
	}
	expired := apiKey.ExpiresAt != nil && apiKey.ExpiresAt.Before(time.Now())
	if apiKey.Status != store.StatusActive || expired || account.Status != store.StatusActive {
		return store.QuotaReservation{}, store.ErrInsufficientQuota
	}
	keyState, keyOK := reserve(apiKey.QuotaLimit, apiKey.QuotaUsed, apiKey.Reserved, r.Nanos)
	accountState, accountOK := reserve(account.QuotaLimit, account.QuotaUsed, account.Reserved, r.Nanos)
	switch {
	case concurrency.APIKey != nil && apiKey.InFlight >= *concurrency.APIKey:
		return store.QuotaReservation{}, concurrencyLimited(store.RateScopeAPIKey)
	case concurrency.Account != nil && account.InFlight >= *concurrency.Account:
		return store.QuotaReservation{}, concurrencyLimited(store.RateScopeAccount)
	case !keyOK || !accountOK:
		return store.QuotaReservation{}, store.ErrInsufficientQuota
	}
	now := time.Now()
	apiKey.Reserved, apiKey.LastUsedAt = keyState.Reserved, &now
	account.Reserved = accountState.Reserved
	apiKey.InFlight++
	account.InFlight++
	if r.CreatedAt.IsZero() {
		r.CreatedAt = now
	}
	m.reserv[r.RequestID] = r
	return store.QuotaReservation{APIKey: keyState, Account: accountState}, nil
}

func concurrencyLimited(scope store.RateScope) error {
	return &store.RateLimitError{Scope: scope, Kind: store.RateLimitConcurrency}
}

// releaseLocked 删除一笔预扣并回退两级的 reserved 与 in_flight。
func (m *Store) releaseLocked(r store.Reservation) {
	apiKey, account := m.apiKeys[r.APIKeyID], m.accounts[r.AccountID]
	apiKey.Reserved -= r.Nanos
	apiKey.InFlight--
	account.Reserved -= r.Nanos
	account.InFlight--
	delete(m.reserv, r.RequestID)
}

// ReleaseReservation 见 store.Store。
func (m *Store) ReleaseReservation(_ context.Context, requestID string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.reserv[requestID]
	if !ok {
		return false, nil
	}
	m.releaseLocked(r)
	return true, nil
}

type rateKey struct {
	subject uuid.UUID
	window  time.Time
}

type rateCount struct {
	requests, tokens int64
}

// AcquireRate 见 store.Store：先检查全部 claim，都不超限才一起计数。
func (m *Store) AcquireRate(_ context.Context, window time.Time, claims []store.RateClaim) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, claim := range claims {
		current := m.rates[rateKey{claim.Subject, window}]
		var requests, tokens int64
		if current != nil {
			requests, tokens = current.requests, current.tokens
		}
		switch {
		case claim.RPM != nil && requests >= *claim.RPM:
			return &store.RateLimitError{Scope: claim.Scope, Kind: store.RateLimitRPM}
		case claim.TPM != nil && tokens+claim.Tokens > *claim.TPM:
			return &store.RateLimitError{Scope: claim.Scope, Kind: store.RateLimitTPM}
		}
	}
	for _, claim := range claims {
		count := m.rateLocked(claim.Subject, window)
		count.requests++
		count.tokens += claim.Tokens
	}
	return nil
}

// ReleaseRate 见 store.Store。
func (m *Store) ReleaseRate(_ context.Context, window time.Time, claims []store.RateClaim) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, claim := range claims {
		if count, ok := m.rates[rateKey{claim.Subject, window}]; ok {
			count.requests = max(count.requests-1, 0)
			count.tokens = max(count.tokens-claim.Tokens, 0)
		}
	}
	return nil
}

// AddRateTokens 见 store.Store。
func (m *Store) AddRateTokens(_ context.Context, window time.Time, claims []store.RateClaim) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, claim := range claims {
		count := m.rateLocked(claim.Subject, window)
		count.tokens = max(count.tokens+claim.Tokens, 0)
	}
	return nil
}

// DeleteRateWindows 见 store.Store。
func (m *Store) DeleteRateWindows(_ context.Context, before time.Time) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var n int64
	for k := range m.rates {
		if k.window.Before(before) {
			delete(m.rates, k)
			n++
		}
	}
	return n, nil
}

func (m *Store) rateLocked(subject uuid.UUID, window time.Time) *rateCount {
	k := rateKey{subject, window}
	count, ok := m.rates[k]
	if !ok {
		count = &rateCount{}
		m.rates[k] = count
	}
	return count
}

type settledRequest struct {
	usageTime, settledAt time.Time
}

type summaryKey struct {
	account, apiKey uuid.UUID
	model           string
}

type dailyKey struct {
	day time.Time // UTC 日零点
	summaryKey
}

func utcDay(t time.Time) time.Time { return t.UTC().Truncate(24 * time.Hour) }

func summaryRowOf(event store.UsageEvent) store.UsageSummaryRow {
	row := store.UsageSummaryRow{
		Model:        event.Model,
		Requests:     1,
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
	return row
}

// EnsurePartitions 见 store.Store：内存实现没有分区。
func (m *Store) EnsurePartitions(context.Context, time.Time, time.Time) (int, error) { return 0, nil }

// RollupUsageDaily 见 store.Store：整日覆盖写入；明细已被清理的日子保留原有汇总。
func (m *Store) RollupUsageDaily(_ context.Context, from, to time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	recomputed := map[dailyKey]store.UsageSummaryRow{}
	for _, event := range m.usageEvents {
		if event.Time.Before(from) || !event.Time.Before(to) {
			continue
		}
		row := summaryRowOf(event)
		k := dailyKey{utcDay(event.Time), summaryKey{row.AccountID, row.APIKeyID, row.Model}}
		sum := recomputed[k]
		sum.AccountID, sum.APIKeyID, sum.Model = row.AccountID, row.APIKeyID, row.Model
		sum.Requests++
		sum.InputTokens += row.InputTokens
		sum.OutputTokens += row.OutputTokens
		sum.CachedTokens += row.CachedTokens
		sum.CostNanos += row.CostNanos
		sum.AgentGatewayCostNanos += row.AgentGatewayCostNanos
		recomputed[k] = sum
	}
	maps.Copy(m.daily, recomputed)
	if m.rollupMark == nil || to.After(*m.rollupMark) {
		m.rollupMark = &to
	}
	return nil
}

// UsageRollupWatermark 见 store.Store。
func (m *Store) UsageRollupWatermark(context.Context) (time.Time, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.rollupMark == nil {
		return time.Time{}, false, nil
	}
	return *m.rollupMark, true, nil
}

// PruneUsageEvents 见 store.Store：按行删除，返回行数。
func (m *Store) PruneUsageEvents(_ context.Context, before time.Time) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := len(m.usageEvents)
	m.usageEvents = slices.DeleteFunc(m.usageEvents, func(e store.UsageEvent) bool { return e.Time.Before(before) })
	return int64(n - len(m.usageEvents)), nil
}

// PruneAudit 见 store.Store。
func (m *Store) PruneAudit(_ context.Context, before time.Time) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := len(m.audit)
	m.audit = slices.DeleteFunc(m.audit, func(a store.Audit) bool { return a.Time.Before(before) })
	return int64(n - len(m.audit)), nil
}

// PruneSettledRequests 见 store.Store。
func (m *Store) PruneSettledRequests(_ context.Context, before time.Time) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var n int64
	for id, r := range m.settled {
		if r.settledAt.Before(before) {
			delete(m.settled, id)
			n++
		}
	}
	return n, nil
}
