package extauth

import "time"

// Client is the durable record of one API consumer. Every field here is
// readable by the gateway as metadata after a successful authorization.
type Client struct {
	ClientID    string
	Tenant      string
	Plan        string
	Status      string
	BudgetCents int64
	SpentMicros int64
}

// Identity is what the external authorization service injects into the
// request after a successful decision.
type Identity struct {
	ClientID    string
	Tenant      string
	Plan        string
	Source      string
	BudgetCents int64
	SpentMicros int64
}

// RemainingCents is the pre-authorized budget left for this client.
func (i Identity) RemainingCents() int64 {
	if i.BudgetCents <= 0 {
		return -1
	}
	spentCents := i.SpentMicros / 10000
	if spentCents >= i.BudgetCents {
		return 0
	}
	return i.BudgetCents - spentCents
}

// Decision is the single output of the policy engine. Both the HTTP and the
// gRPC façade render it, so the two protocols can never drift apart.
type Decision struct {
	Allow      bool
	HTTPStatus int
	Reason     string
	Identity   Identity
	Headers    map[string]string
}

// Request is the transport-neutral request view used by the policy engine.
type Request struct {
	Method     string
	Path       string
	RemoteAddr string
	Headers    map[string]string
}

// AuditEvent is appended for every decision, allowing the finops service and
// operators to reconcile "who was denied and why".
type AuditEvent struct {
	Time       time.Time
	ClientID   string
	Source     string
	Allow      bool
	Status     int
	Reason     string
	Method     string
	Path       string
	RemoteAddr string
}

// Store is the data plane's view of the identity database. Implementations are
// PostgreSQL (production path) and an in-memory map (tests).
type Store interface {
	LookupKey(hash string) (*Client, bool)
	LookupSession(hash string, now time.Time) (*Client, bool)
	LookupClient(clientID string) (*Client, bool)
	Audit(event AuditEvent)
	Close()
}
