package extauth

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	authv3 "github.com/envoyproxy/go-control-plane/envoy/service/auth/v3"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

// HTTPAuth is the standalone-mode façade: agentgateway's `extAuth.http` sends
// the request here and copies `allowedResponseHeaders` back to the client.
type HTTPAuth struct {
	Engine     *Config
	Store      Store
	AdminToken string
	GRPCAddr   string
}

func (h *HTTPAuth) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok\n"))
	})
	// /check is the contract used by spec.traffic.extAuth.http.path.
	mux.HandleFunc("/check", h.check)
	mux.HandleFunc("/admin/clients", h.adminUpsertClient)
	mux.HandleFunc("/admin/jwt", h.adminMintJWT)
	mux.HandleFunc("/admin/session", h.adminMintSession)
	mux.HandleFunc("/selfcheck", h.selfcheck)
	return mux
}

func (h *HTTPAuth) check(w http.ResponseWriter, r *http.Request) {
	headers := map[string]string{}
	for k := range r.Header {
		headers[k] = r.Header.Get(k)
	}
	dec := h.Engine.Evaluate(h.Store, Request{
		Method: r.Method, Path: r.URL.Path, RemoteAddr: clientIP(r), Headers: headers,
	})

	if !dec.Allow {
		for k, v := range dec.Headers {
			w.Header().Set(k, v)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(dec.HTTPStatus)
		_ = json.NewEncoder(w).Encode(map[string]string{"reason": dec.Reason, "client_id": dec.Identity.ClientID})
		return
	}
	// agentgateway copies only headers listed in allowedResponseHeaders, so
	// every injected header is also a policy decision (see the manifests).
	for k, v := range dec.Headers {
		w.Header().Set(k, v)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"client_id":              dec.Identity.ClientID,
		"tenant":                 dec.Identity.Tenant,
		"plan":                   dec.Identity.Plan,
		"source":                 dec.Identity.Source,
		"budget_remaining_cents": dec.Identity.RemainingCents(),
	})
}

// selfcheck dials our own gRPC listener so the ext_authz path can be validated
// without shipping grpcurl into the cluster.
func (h *HTTPAuth) selfcheck(w http.ResponseWriter, r *http.Request) {
	if h.GRPCAddr == "" {
		http.Error(w, "grpc listener disabled", http.StatusServiceUnavailable)
		return
	}
	key := r.URL.Query().Get("key")
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	conn, err := grpc.NewClient(h.GRPCAddr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer conn.Close()
	req := &authv3.CheckRequest{
		Attributes: &authv3.AttributeContext{
			Request: &authv3.AttributeContext_Request{
				Http: &authv3.AttributeContext_HttpRequest{
					Method: "GET", Path: "/selfcheck", Host: "selfcheck",
					Headers: map[string]string{"authorization": "Bearer " + key},
				},
			},
		},
	}
	resp, err := authv3.NewAuthorizationClient(conn).Check(ctx, req)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	out := map[string]any{
		"grpc_status": resp.GetStatus().GetCode(),
		"allowed":     resp.GetOkResponse() != nil,
	}
	if ok := resp.GetOkResponse(); ok != nil {
		hdrs := map[string]string{}
		for _, hv := range ok.GetHeaders() {
			hdrs[hv.GetHeader().GetKey()] = hv.GetHeader().GetValue()
		}
		out["headers"] = hdrs
	}
	if d := resp.GetDeniedResponse(); d != nil {
		out["denied_status"] = int32(d.GetStatus().GetCode())
		out["reason"] = d.GetBody()
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(out)
}

func (h *HTTPAuth) adminGuard(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if h.AdminToken == "" {
			next(w, r)
			return
		}
		if r.Header.Get("X-Admin-Token") != h.AdminToken {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next(w, r)
	}
}

type upsertRequest struct {
	ClientID    string `json:"client_id"`
	Tenant      string `json:"tenant"`
	Plan        string `json:"plan"`
	Status      string `json:"status"`
	BudgetCents int64  `json:"budget_cents"`
	APIKey      string `json:"api_key"`
	TTLSeconds  int    `json:"ttl_seconds"`
}

func (h *HTTPAuth) adminUpsertClient(w http.ResponseWriter, r *http.Request) {
	h.adminGuard(func(w http.ResponseWriter, r *http.Request) {
		var body upsertRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if body.ClientID == "" || body.APIKey == "" {
			http.Error(w, "client_id and api_key are required", http.StatusBadRequest)
			return
		}
		if body.Status == "" {
			body.Status = "active"
		}
		pg, ok := h.Store.(*PGStore)
		if !ok {
			http.Error(w, "store is read-only", http.StatusConflict)
			return
		}
		if err := pg.UpsertClient(r.Context(), body.ClientID, body.Tenant, body.Plan, body.Status,
			body.BudgetCents, HashKey(body.APIKey)); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = fmt.Fprintf(w, "upserted %s\n", body.ClientID)
	})(w, r)
}

func (h *HTTPAuth) adminMintJWT(w http.ResponseWriter, r *http.Request) {
	h.adminGuard(func(w http.ResponseWriter, r *http.Request) {
		clientID := r.URL.Query().Get("client_id")
		tenant := r.URL.Query().Get("tenant")
		plan := r.URL.Query().Get("plan")
		ttl := 300
		if v := r.URL.Query().Get("ttl"); v != "" {
			if n, err := strconv.Atoi(v); err == nil {
				ttl = n
			}
		}
		token, err := h.Engine.MintHS256(map[string]any{
			"client_id": clientID, "tenant": tenant, "plan": plan, "iss": "lab-idp",
		}, time.Duration(ttl)*time.Second)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"token": token, "ttl_seconds": ttl})
	})(w, r)
}

func (h *HTTPAuth) adminMintSession(w http.ResponseWriter, r *http.Request) {
	h.adminGuard(func(w http.ResponseWriter, r *http.Request) {
		pg, ok := h.Store.(*PGStore)
		if !ok {
			http.Error(w, "store is read-only", http.StatusConflict)
			return
		}
		clientID := r.URL.Query().Get("client_id")
		ttl := 600
		if v := r.URL.Query().Get("ttl"); v != "" {
			if n, err := strconv.Atoi(v); err == nil {
				ttl = n
			}
		}
		token := "sess_lab_" + strings.ReplaceAll(fmt.Sprintf("%x", time.Now().UnixNano()), "-", "")
		if err := pg.InsertSession(r.Context(), HashKey(token), clientID, time.Now().Add(time.Duration(ttl)*time.Second)); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"session": token, "ttl_seconds": ttl})
	})(w, r)
}

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// Env reads configuration with a default, keeping main() free of clutter.
func Env(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}
