// Package mem 是 store.Store 的内存实现，仅用于单元测试。
package mem

import (
	"context"
	"sort"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
	"github.com/ai-hermes/pi-lessons/apps/loom/pkg/loom"
)

// Mem 内存存储。
type Mem struct {
	mu       sync.Mutex
	accounts map[uuid.UUID]*store.Account
	keys     map[uuid.UUID]*store.Key
	byHash   map[string]uuid.UUID
	reserv   map[string]store.Reservation
	usage    []store.UsageEvent
	audit    []store.Audit
	pricing  map[string]store.ModelPrice
	nextID   int64
}

// New 创建空存储。
func New() *Mem {
	return &Mem{accounts: map[uuid.UUID]*store.Account{}, keys: map[uuid.UUID]*store.Key{}, byHash: map[string]uuid.UUID{},
		reserv: map[string]store.Reservation{}, pricing: map[string]store.ModelPrice{}}
}

func (m *Mem) Close() error { return nil }

func (m *Mem) GetAccount(_ context.Context, id uuid.UUID) (store.Account, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	a, ok := m.accounts[id]
	if !ok {
		return store.Account{}, loom.ErrNotFound
	}
	return *a, nil
}

func (m *Mem) GetAccountByName(_ context.Context, name string) (store.Account, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, a := range m.accounts {
		if a.Name == name {
			return *a, nil
		}
	}
	return store.Account{}, loom.ErrNotFound
}

func (m *Mem) ListAccounts(_ context.Context, limit int) ([]store.Account, error) {
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

func (m *Mem) CreateAccount(_ context.Context, a store.Account) (store.Account, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, x := range m.accounts {
		if x.Name == a.Name {
			return store.Account{}, loom.ErrNotFound
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
		a.Status = loom.StatusActive
	}
	if a.Group == "" {
		a.Group = "default"
	}
	m.accounts[a.ID] = &a
	return a, nil
}

func (m *Mem) UpdateAccount(_ context.Context, id uuid.UUID, status string, quotaLimit *int64, group string) (store.Account, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	a, ok := m.accounts[id]
	if !ok {
		return store.Account{}, loom.ErrNotFound
	}
	a.Status, a.QuotaLimit, a.Group, a.UpdatedAt = status, quotaLimit, group, time.Now()
	return *a, nil
}

func (m *Mem) AddAccountQuotaLimit(_ context.Context, id uuid.UUID, delta int64) (store.Account, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	a, ok := m.accounts[id]
	if !ok {
		return store.Account{}, loom.ErrNotFound
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

func (m *Mem) SetAccountQuota(_ context.Context, id uuid.UUID, limit *int64, used int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	a, ok := m.accounts[id]
	if !ok {
		return loom.ErrNotFound
	}
	a.QuotaLimit, a.QuotaUsed, a.Reserved, a.UpdatedAt = limit, used, 0, time.Now()
	for k, r := range m.reserv {
		if r.AccountID == id {
			delete(m.reserv, k)
		}
	}
	return nil
}

func (m *Mem) SetKeyQuota(_ context.Context, id uuid.UUID, limit *int64, used int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	k, ok := m.keys[id]
	if !ok {
		return loom.ErrNotFound
	}
	k.QuotaLimit, k.QuotaUsed, k.Reserved, k.UpdatedAt = limit, used, 0, time.Now()
	for rk, r := range m.reserv {
		if r.KeyID == id {
			delete(m.reserv, rk)
		}
	}
	return nil
}

func (m *Mem) ReserveAccountQuota(_ context.Context, id uuid.UUID, nanos int64) (store.QuotaState, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	a, ok := m.accounts[id]
	if !ok {
		return store.QuotaState{}, loom.ErrNotFound
	}
	if nanos <= 0 {
		return store.QuotaState{Limit: a.QuotaLimit, Used: a.QuotaUsed, Reserved: a.Reserved}, nil
	}
	if a.Status != loom.StatusActive {
		return store.QuotaState{}, loom.ErrInsufficientQuota
	}
	q, ok := reserve(a.QuotaLimit, a.QuotaUsed, a.Reserved, nanos)
	if !ok {
		return store.QuotaState{}, loom.ErrInsufficientQuota
	}
	a.Reserved = q.Reserved
	return q, nil
}

func (m *Mem) ReleaseAccountReservation(_ context.Context, id uuid.UUID, nanos int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	a, ok := m.accounts[id]
	if !ok {
		return loom.ErrNotFound
	}
	a.Reserved -= nanos
	return nil
}

func (m *Mem) GetKeyByHash(_ context.Context, hash string) (store.Key, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	id, ok := m.byHash[hash]
	if !ok {
		return store.Key{}, loom.ErrNotFound
	}
	return m.keyLocked(id)
}

func (m *Mem) keyLocked(id uuid.UUID) (store.Key, error) {
	k, ok := m.keys[id]
	if !ok {
		return store.Key{}, loom.ErrNotFound
	}
	out := *k
	out.Account = *m.accounts[k.AccountID]
	return out, nil
}

func (m *Mem) GetKey(_ context.Context, id uuid.UUID) (store.Key, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.keyLocked(id)
}

func (m *Mem) ListKeys(_ context.Context, accountID *uuid.UUID, limit int) ([]store.Key, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]store.Key, 0, len(m.keys))
	for _, k := range m.keys {
		if accountID != nil && k.AccountID != *accountID {
			continue
		}
		full, _ := m.keyLocked(k.ID)
		out = append(out, full)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (m *Mem) CreateKey(_ context.Context, k store.Key, allowlist []string) (store.Key, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.accounts[k.AccountID]; !ok {
		return store.Key{}, loom.ErrNotFound
	}
	if k.ID == uuid.Nil {
		k.ID = uuid.New()
	}
	if k.CreatedAt.IsZero() {
		k.CreatedAt = time.Now()
	}
	k.UpdatedAt = k.CreatedAt
	if k.Status == "" {
		k.Status = loom.StatusActive
	}
	k.ModelAllowlist = allowlist
	m.keys[k.ID] = &k
	m.byHash[k.KeyHash] = k.ID
	return m.keyLocked(k.ID)
}

func (m *Mem) UpdateKey(_ context.Context, id uuid.UUID, status string, allowlist []string, quotaLimit *int64, expiresAt *time.Time, name string) (store.Key, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	k, ok := m.keys[id]
	if !ok {
		return store.Key{}, loom.ErrNotFound
	}
	k.Status, k.ModelAllowlist, k.QuotaLimit, k.ExpiresAt, k.Name, k.UpdatedAt = status, allowlist, quotaLimit, expiresAt, name, time.Now()
	return m.keyLocked(id)
}

func (m *Mem) ReserveKeyQuota(_ context.Context, id uuid.UUID, nanos int64) (store.QuotaState, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	k, ok := m.keys[id]
	if !ok {
		return store.QuotaState{}, loom.ErrNotFound
	}
	if nanos <= 0 {
		return store.QuotaState{Limit: k.QuotaLimit, Used: k.QuotaUsed, Reserved: k.Reserved}, nil
	}
	if k.Status != loom.StatusActive || (k.ExpiresAt != nil && k.ExpiresAt.Before(time.Now())) {
		return store.QuotaState{}, loom.ErrInsufficientQuota
	}
	q, ok := reserve(k.QuotaLimit, k.QuotaUsed, k.Reserved, nanos)
	if !ok {
		return store.QuotaState{}, loom.ErrInsufficientQuota
	}
	k.Reserved, k.LastUsedAt = q.Reserved, &[]time.Time{time.Now()}[0]
	return q, nil
}

func (m *Mem) ReleaseKeyReservation(_ context.Context, id uuid.UUID, nanos int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	k, ok := m.keys[id]
	if !ok {
		return loom.ErrNotFound
	}
	k.Reserved -= nanos
	return nil
}

func (m *Mem) CreateReservation(_ context.Context, r store.Reservation) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.reserv[r.RequestID] = r
	return nil
}

func (m *Mem) GetReservation(_ context.Context, requestID string) (store.Reservation, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.reserv[requestID]
	if !ok {
		return store.Reservation{}, loom.ErrNotFound
	}
	return r, nil
}

func (m *Mem) ListReservations(_ context.Context, limit int) ([]store.Reservation, error) {
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

func (m *Mem) CountReservations(_ context.Context) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return int64(len(m.reserv)), nil
}

func (m *Mem) SettleUsage(_ context.Context, ev store.UsageEvent) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, u := range m.usage {
		if ev.RequestID != "" && u.RequestID == ev.RequestID {
			return false, nil
		}
	}
	m.nextID++
	ev.ID, ev.Settled = m.nextID, true
	if ev.Time.IsZero() {
		ev.Time = time.Now()
	}
	m.usage = append(m.usage, ev)
	if ev.KeyID != nil {
		k := m.keys[*ev.KeyID]
		a := m.accounts[k.AccountID]
		if r, ok := m.reserv[ev.RequestID]; ok {
			k.QuotaUsed, k.Reserved = k.QuotaUsed+ev.CostNanos, k.Reserved-r.Nanos
			a.QuotaUsed, a.Reserved = a.QuotaUsed+ev.CostNanos, a.Reserved-r.Nanos
			delete(m.reserv, ev.RequestID)
		} else {
			k.QuotaUsed += ev.CostNanos
			a.QuotaUsed += ev.CostNanos
		}
	} else if ev.AccountID != nil {
		if a, ok := m.accounts[*ev.AccountID]; ok {
			a.QuotaUsed += ev.CostNanos
		}
	}
	return true, nil
}

func (m *Mem) BackfillGatewayCost(_ context.Context, requestID string, nanos int64) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := range m.usage {
		if m.usage[i].RequestID == requestID && m.usage[i].GatewayCostNanos == nil {
			n := nanos
			m.usage[i].GatewayCostNanos = &n
			return true, nil
		}
	}
	return false, nil
}

func (m *Mem) ReleaseExpiredReservations(_ context.Context, now time.Time, limit int) (int, error) {
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
		m.keys[r.KeyID].Reserved -= r.Nanos
		m.accounts[r.AccountID].Reserved -= r.Nanos
		delete(m.reserv, r.RequestID)
	}
	return len(expired), nil
}

func (m *Mem) ListUsage(_ context.Context, keyID *uuid.UUID, since *time.Time, limit int) ([]store.UsageEvent, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]store.UsageEvent, 0, len(m.usage))
	for i := len(m.usage) - 1; i >= 0; i-- {
		u := m.usage[i]
		if keyID != nil && (u.KeyID == nil || *u.KeyID != *keyID) {
			continue
		}
		if since != nil && u.Time.Before(*since) {
			continue
		}
		out = append(out, u)
	}
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (m *Mem) SummaryUsage(_ context.Context, f store.UsageFilter) ([]store.UsageSummaryRow, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	agg := map[string]*store.UsageSummaryRow{}
	for _, u := range m.usage {
		if f.AccountID != nil && (u.AccountID == nil || *u.AccountID != *f.AccountID) {
			continue
		}
		if f.KeyID != nil && (u.KeyID == nil || *u.KeyID != *f.KeyID) {
			continue
		}
		if f.Since != nil && u.Time.Before(*f.Since) {
			continue
		}
		row := store.UsageSummaryRow{Model: u.Model, InputTokens: u.InputTokens, OutputTokens: u.OutputTokens,
			CachedTokens: u.CachedTokens, CostNanos: u.CostNanos}
		if u.AccountID != nil {
			row.AccountID = *u.AccountID
		}
		if u.KeyID != nil {
			row.KeyID = *u.KeyID
		}
		if u.GatewayCostNanos != nil {
			row.GatewayCostNanos = *u.GatewayCostNanos
		}
		key := row.AccountID.String() + row.KeyID.String() + row.Model
		if a, ok := agg[key]; ok {
			a.Requests++
			a.InputTokens += row.InputTokens
			a.OutputTokens += row.OutputTokens
			a.CachedTokens += row.CachedTokens
			a.CostNanos += row.CostNanos
			a.GatewayCostNanos += row.GatewayCostNanos
		} else {
			row.Requests = 1
			agg[key] = &row
		}
	}
	out := make([]store.UsageSummaryRow, 0, len(agg))
	for _, v := range agg {
		out = append(out, *v)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CostNanos > out[j].CostNanos })
	return out, nil
}

func (m *Mem) InsertAudit(_ context.Context, rows []store.Audit) error {
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

func (m *Mem) ListAudit(_ context.Context, keyID *uuid.UUID, limit int) ([]store.Audit, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]store.Audit, 0, len(m.audit))
	for i := len(m.audit) - 1; i >= 0; i-- {
		a := m.audit[i]
		if keyID != nil && (a.KeyID == nil || *a.KeyID != *keyID) {
			continue
		}
		out = append(out, a)
	}
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (m *Mem) ListModelPricing(_ context.Context) ([]store.ModelPrice, error) {
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

func (m *Mem) GetModelPricing(_ context.Context, model string) (store.ModelPrice, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.pricing[model]
	if !ok || !p.Enabled {
		return store.ModelPrice{}, loom.ErrNotFound
	}
	return p, nil
}

func (m *Mem) UpsertModelPricing(_ context.Context, p store.ModelPrice) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	p.Enabled, p.UpdatedAt = true, time.Now()
	m.pricing[p.Model] = p
	return nil
}

func (m *Mem) DeleteModelPricing(_ context.Context, model string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.pricing, model)
	return nil
}
