package extauth

import (
	"sync"
	"time"
)

// MemStore is the in-process implementation used by unit tests and by
// `EXTAUTH_PG_DSN=""` smoke runs. It is deliberately tiny: no SQL, no locking
// subtleties beyond a single mutex.
type MemStore struct {
	mu       sync.Mutex
	byHash   map[string]*Client
	sessions map[string]session
	byID     map[string]*Client
	audits   []AuditEvent
}

type session struct {
	clientID string
	expires  time.Time
}

func NewMemStore() *MemStore {
	return &MemStore{
		byHash:   map[string]*Client{},
		sessions: map[string]session{},
		byID:     map[string]*Client{},
	}
}

// AddKey registers a client keyed by its raw value (hashed internally).
func (m *MemStore) AddKey(raw string, c Client) {
	m.mu.Lock()
	defer m.mu.Unlock()
	clone := c
	m.byHash[HashKey(raw)] = &clone
	m.byID[c.ClientID] = &clone
}

// AddSession registers a session token with an explicit expiry.
func (m *MemStore) AddSession(raw, clientID string, expires time.Time) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sessions[HashKey(raw)] = session{clientID: clientID, expires: expires}
	if c, ok := m.byID[clientID]; ok {
		clone := *c
		m.byID[clientID] = &clone
	}
}

func (m *MemStore) LookupKey(hash string) (*Client, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, ok := m.byHash[hash]
	if !ok {
		return nil, false
	}
	clone := *c
	return &clone, true
}

func (m *MemStore) LookupSession(hash string, now time.Time) (*Client, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[hash]
	if !ok || now.After(s.expires) {
		return nil, false
	}
	c, ok := m.byID[s.clientID]
	if !ok {
		return nil, false
	}
	clone := *c
	return &clone, true
}

func (m *MemStore) LookupClient(id string) (*Client, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, ok := m.byID[id]
	if !ok {
		return nil, false
	}
	clone := *c
	return &clone, true
}

func (m *MemStore) Audit(e AuditEvent) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.audits = append(m.audits, e)
}

// Audits returns a copy of recorded audit events (test helper).
func (m *MemStore) Audits() []AuditEvent {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]AuditEvent, len(m.audits))
	copy(out, m.audits)
	return out
}

func (m *MemStore) Close() {}
