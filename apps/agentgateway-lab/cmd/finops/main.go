package main

import (
	"context"
	"log"
	"net/http"
	"time"

	"agentgateway-lab/internal/billing"
	"agentgateway-lab/internal/extauth"
)

func main() {
	addr := extauth.Env("FINOPS_ADDR", ":9100")
	dsn := extauth.Env("FINOPS_PG_DSN", "")
	adminToken := extauth.Env("FINOPS_ADMIN_TOKEN", "")
	if dsn == "" {
		log.Fatal("FINOPS_PG_DSN is required: usage and chargeback are persisted in PostgreSQL")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var store *billing.Store
	for i := 0; ; i++ {
		s, err := billing.NewStore(ctx, dsn)
		if err == nil {
			store = s
			break
		}
		if i >= 29 || ctx.Err() != nil {
			log.Fatalf("connect postgres: %v", err)
		}
		log.Printf("postgres not ready (%v), retrying", err)
		time.Sleep(2 * time.Second)
	}
	defer store.Close()

	svc := &billing.Service{Store: store, AdminToken: adminToken}

	grpcAddr := extauth.Env("FINOPS_GRPC_ADDR", ":9101")
	go func() {
		if err := (&billing.OTGRPCServer{Service: svc}).Serve(grpcAddr); err != nil {
			log.Fatalf("otlp grpc serve: %v", err)
		}
	}()

	srv := &http.Server{Addr: addr, Handler: svc.Handler(), ReadHeaderTimeout: 10 * time.Second}
	log.Printf("finops OTLP/chargeback service listening on %s", addr)
	if err := srv.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}
