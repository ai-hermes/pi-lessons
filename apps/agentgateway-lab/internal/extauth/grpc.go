package extauth

import (
	"context"
	"log"
	"strings"

	corev3 "github.com/envoyproxy/go-control-plane/envoy/config/core/v3"
	authv3 "github.com/envoyproxy/go-control-plane/envoy/service/auth/v3"
	typev3 "github.com/envoyproxy/go-control-plane/envoy/type/v3"
	"google.golang.org/genproto/googleapis/rpc/status"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/health"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/reflection"
	"net"
)

// GRPCServer implements the Envoy-compatible ext_authz protocol, so the same
// policy engine can be reached by agentgateway, Envoy or any other xDS proxy.
type GRPCServer struct {
	authv3.UnimplementedAuthorizationServer
	engine *Config
	store  Store
}

func NewGRPCServer(engine *Config, store Store) *GRPCServer {
	return &GRPCServer{engine: engine, store: store}
}

// Check is called by Envoy/agentgateway before the request is forwarded.
func (s *GRPCServer) Check(ctx context.Context, req *authv3.CheckRequest) (*authv3.CheckResponse, error) {
	httpReq := req.GetAttributes().GetRequest().GetHttp()
	r := Request{
		Method:     httpReq.GetMethod(),
		Path:       httpReq.GetPath(),
		RemoteAddr: req.GetAttributes().GetSource().GetAddress().GetSocketAddress().GetAddress(),
		Headers:    httpReq.GetHeaders(),
	}
	decision := s.engine.Evaluate(s.store, r)

	if decision.Allow {
		return &authv3.CheckResponse{
			Status: &status.Status{Code: int32(codes.OK)},
			HttpResponse: &authv3.CheckResponse_OkResponse{
				OkResponse: &authv3.OkHttpResponse{Headers: headerOptions(decision.Headers)},
			},
		}, nil
	}
	return &authv3.CheckResponse{
		Status: &status.Status{Code: int32(codes.PermissionDenied), Message: decision.Reason},
		HttpResponse: &authv3.CheckResponse_DeniedResponse{
			DeniedResponse: &authv3.DeniedHttpResponse{
				Status:  &typev3.HttpStatus{Code: typev3.StatusCode(decision.HTTPStatus)},
				Body:    decision.Reason,
				Headers: headerOptions(decision.Headers),
			},
		},
	}, nil
}

func headerOptions(h map[string]string) []*corev3.HeaderValueOption {
	out := make([]*corev3.HeaderValueOption, 0, len(h))
	for k, v := range h {
		out = append(out, &corev3.HeaderValueOption{
			Header:       &corev3.HeaderValue{Key: strings.ToLower(k), Value: v},
			AppendAction: corev3.HeaderValueOption_OVERWRITE_IF_EXISTS_OR_ADD,
		})
	}
	return out
}

// Serve registers the ext_authz service plus gRPC health and reflection, then
// blocks until the listener fails.
func (s *GRPCServer) Serve(addr string) error {
	lis, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	srv := grpc.NewServer()
	authv3.RegisterAuthorizationServer(srv, s)
	hs := health.NewServer()
	hs.SetServingStatus("", healthpb.HealthCheckResponse_SERVING)
	healthpb.RegisterHealthServer(srv, hs)
	reflection.Register(srv)
	log.Printf("ext-auth gRPC (Envoy ext_authz v3) listening on %s", addr)
	return srv.Serve(lis)
}
