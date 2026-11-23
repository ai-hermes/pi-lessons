package extauth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strconv"
	"strings"
	"time"
)

// Denial reasons are stable strings: tests assert them and the audit table
// stores them, so dashboards can be built without parsing prose.
const (
	ReasonMissingCredential = "missing_credential"
	ReasonUnknownKey        = "unknown_api_key"
	ReasonInactiveClient    = "client_inactive"
	ReasonExpiredSession    = "session_expired"
	ReasonInvalidJWT        = "invalid_jwt"
	ReasonExpiredJWT        = "jwt_expired"
	ReasonBudgetExhausted   = "budget_exhausted"
	ReasonAllowed           = "allowed"
)

// Config holds the policy knobs that must not be hard-coded.
type Config struct {
	JWTSecret []byte
	// Now is injectable so JWT/session expiry tests are deterministic.
	Now func() time.Time
}

func (c *Config) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

// HashKey is the credential digest stored in PostgreSQL. The gateway never
// stores raw client keys and neither does this service.
func HashKey(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

// Credential extracts the caller credential from the transports the lab
// supports: Authorization: Bearer, x-api-key and x-session-token.
func Credential(headers map[string]string) (kind, value string) {
	for k, v := range headers {
		switch strings.ToLower(k) {
		case "authorization":
			v = strings.TrimSpace(v)
			if len(v) > 7 && strings.EqualFold(v[:7], "bearer ") {
				return "bearer", strings.TrimSpace(v[7:])
			}
			if v != "" {
				return "bearer", v
			}
		case "x-api-key":
			if v != "" {
				return "api_key", strings.TrimSpace(v)
			}
		case "x-session-token":
			if v != "" {
				return "session", strings.TrimSpace(v)
			}
		}
	}
	return "none", ""
}

// Evaluate is the whole BYO authorization contract in one function:
// authenticate, check entitlement, inject identity headers, and audit the
// outcome. Both façades render the returned Decision, so HTTP and gRPC can
// never disagree about who was allowed.
func (c *Config) Evaluate(store Store, req Request) Decision {
	decision := c.evaluate(store, req)
	if store != nil {
		store.Audit(AuditEvent{
			Time: c.now(), ClientID: decision.Identity.ClientID, Source: decision.Identity.Source,
			Allow: decision.Allow, Status: decision.HTTPStatus, Reason: decision.Reason,
			Method: req.Method, Path: req.Path, RemoteAddr: req.RemoteAddr,
		})
	}
	return decision
}

func (c *Config) evaluate(store Store, req Request) Decision {
	_, raw := Credential(req.Headers)
	if raw == "" {
		return deny(401, ReasonMissingCredential, "none")
	}

	var (
		client *Client
		source string
	)
	switch {
	case strings.HasPrefix(raw, "sess_"):
		source = "session"
		cli, ok := store.LookupSession(HashKey(raw), c.now())
		if !ok {
			return deny(401, ReasonExpiredSession, source)
		}
		client = cli
	case looksLikeJWT(raw):
		source = "jwt"
		claims, err := c.verifyHS256(raw)
		if err != nil {
			if err == errJWTExpired {
				return deny(401, ReasonExpiredJWT, source)
			}
			return deny(401, ReasonInvalidJWT, source)
		}
		clientID, _ := claims["client_id"].(string)
		if clientID == "" {
			clientID, _ = claims["sub"].(string)
		}
		if clientID == "" {
			return deny(401, ReasonInvalidJWT, source)
		}
		cli, ok := store.LookupClient(clientID)
		if !ok {
			// A signed, non-expired token is enough to identify the caller even
			// when the client is not in the quota table (IdP-owned identities).
			cli = &Client{ClientID: clientID, Tenant: stringClaim(claims, "tenant"), Plan: stringClaim(claims, "plan"), Status: "active"}
		}
		if len(claims) > 0 {
			if t := stringClaim(claims, "tenant"); t != "" && cli.Tenant == "" {
				cli.Tenant = t
			}
		}
		client = cli
	default:
		source = "api_key"
		cli, ok := store.LookupKey(HashKey(raw))
		if !ok {
			return deny(401, ReasonUnknownKey, source)
		}
		client = cli
	}

	if client.Status != "" && client.Status != "active" {
		d := deny(403, ReasonInactiveClient, source)
		d.Identity = identityOf(client, source)
		return d
	}

	if client.BudgetCents > 0 && client.SpentMicros >= client.BudgetCents*10000 {
		d := deny(429, ReasonBudgetExhausted, source)
		d.Identity = identityOf(client, source)
		return d
	}

	id := identityOf(client, source)
	return Decision{
		Allow:      true,
		HTTPStatus: 200,
		Reason:     ReasonAllowed,
		Identity:   id,
		Headers: map[string]string{
			"X-Client-Id":              id.ClientID,
			"X-Tenant-Id":              id.Tenant,
			"X-Plan":                   id.Plan,
			"X-Auth-Source":            id.Source,
			"X-Budget-Remaining-Cents": strconv.FormatInt(id.RemainingCents(), 10),
		},
	}
}

func identityOf(c *Client, source string) Identity {
	plan := c.Plan
	if plan == "" {
		plan = "unknown"
	}
	tenant := c.Tenant
	if tenant == "" {
		tenant = "default"
	}
	return Identity{
		ClientID:    c.ClientID,
		Tenant:      tenant,
		Plan:        plan,
		Source:      source,
		BudgetCents: c.BudgetCents,
		SpentMicros: c.SpentMicros,
	}
}

func deny(status int, reason, source string) Decision {
	return Decision{
		Allow:      false,
		HTTPStatus: status,
		Reason:     reason,
		Identity:   Identity{Source: source},
		Headers: map[string]string{
			"X-Auth-Denial-Reason": reason,
		},
	}
}

func looksLikeJWT(raw string) bool {
	return strings.Count(raw, ".") == 2 && len(raw) > 20
}

var (
	errJWTInvalid = jwtError("invalid signature")
	errJWTExpired = jwtError("token expired")
)

type jwtError string

func (e jwtError) Error() string { return string(e) }

func (c *Config) verifyHS256(token string) (map[string]any, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, errJWTInvalid
	}
	mac := hmac.New(sha256.New, c.JWTSecret)
	mac.Write([]byte(parts[0] + "." + parts[1]))
	want := mac.Sum(nil)
	got, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || !hmac.Equal(want, got) {
		return nil, errJWTInvalid
	}
	claimBytes, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, errJWTInvalid
	}
	claims := map[string]any{}
	if err := json.Unmarshal(claimBytes, &claims); err != nil {
		return nil, errJWTInvalid
	}
	if exp, ok := claims["exp"]; ok {
		expires, ok := toInt64(exp)
		if !ok {
			return nil, errJWTInvalid
		}
		if c.now().Unix() >= expires {
			return nil, errJWTExpired
		}
	}
	return claims, nil
}

// MintHS256 is used by the dev-only /admin/jwt endpoint and by tests, so the
// gateway receives tokens whose shape matches what an IdP would issue.
func (c *Config) MintHS256(claims map[string]any, ttl time.Duration) (string, error) {
	if _, ok := claims["exp"]; !ok {
		claims["exp"] = c.now().Add(ttl).Unix()
	}
	header, _ := json.Marshal(map[string]string{"alg": "HS256", "typ": "JWT"})
	body, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	signing := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(body)
	mac := hmac.New(sha256.New, c.JWTSecret)
	mac.Write([]byte(signing))
	return signing + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

func stringClaim(claims map[string]any, name string) string {
	if v, ok := claims[name].(string); ok {
		return v
	}
	return ""
}

func toInt64(v any) (int64, bool) {
	switch n := v.(type) {
	case float64:
		return int64(n), true
	case json.Number:
		i, err := n.Int64()
		return i, err == nil
	case int64:
		return n, true
	case string:
		i, err := strconv.ParseInt(n, 10, 64)
		return i, err == nil
	}
	return 0, false
}
