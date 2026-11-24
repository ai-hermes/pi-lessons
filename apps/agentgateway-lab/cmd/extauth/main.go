package main

import (
	"context"
	"log"
	"net/http"
	"time"

	"agentgateway-lab/internal/extauth"
)

func main() {
	mode := extauth.Env("EXTAUTH_MODE", "both")
	httpAddr := extauth.Env("EXTAUTH_HTTP_ADDR", ":9001")
	grpcAddr := extauth.Env("EXTAUTH_GRPC_ADDR", ":9002")
	dsn := extauth.Env("EXTAUTH_PG_DSN", "")
	adminToken := extauth.Env("EXTAUTH_ADMIN_TOKEN", "")
	secret := extauth.Env("EXTAUTH_JWT_SECRET", "changeme-jwt-secret")
	port := extauth.Env("PORT", "")

	engine := &extauth.Config{JWTSecret: []byte(secret)}

	var store extauth.Store
	if dsn != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		for i := 0; ; i++ {
			pg, err := extauth.NewPGStore(ctx, dsn)
			if err == nil {
				store = pg
				log.Printf("ext-auth store: PostgreSQL")
				break
			}
			if i >= 29 || ctx.Err() != nil {
				log.Fatalf("connect postgres: %v", err)
			}
			log.Printf("postgres not ready (%v), retrying", err)
			time.Sleep(2 * time.Second)
		}
		defer store.Close()
	} else {
		store = extauth.NewMemStore()
		log.Printf("ext-auth store: in-memory (no EXTAUTH_PG_DSN)")
	}

	if mode == "grpc" || mode == "both" {
		gs := extauth.NewGRPCServer(engine, store)
		go func() {
			if err := gs.Serve(grpcAddr); err != nil {
				log.Fatalf("grpc serve: %v", err)
			}
		}()
	}

	if mode == "http" || mode == "both" {
		ha := &extauth.HTTPAuth{Engine: engine, Store: store, AdminToken: adminToken, GRPCAddr: grpcAddr}
		if mode == "http" {
			ha.GRPCAddr = ""
		}
		srv := &http.Server{Addr: httpAddr, Handler: ha.Handler(), ReadHeaderTimeout: 10 * time.Second}
		log.Printf("ext-auth HTTP (extAuth.http contract) listening on %s", httpAddr)
		if port != "" {
			log.Printf("PORT=%s is ignored; set EXTAUTH_HTTP_ADDR instead", port)
		}
		if err := srv.ListenAndServe(); err != nil {
			log.Fatal(err)
		}
	}

	// gRPC-only mode: the HTTP façade never started, block forever.
	log.Printf("ext-auth running in gRPC-only mode")
	select {}
}
