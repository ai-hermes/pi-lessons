package auth

import (
	"context"
	"strings"
	"time"

	core "github.com/envoyproxy/go-control-plane/envoy/config/core/v3"
	authv3 "github.com/envoyproxy/go-control-plane/envoy/service/auth/v3"
	typev3 "github.com/envoyproxy/go-control-plane/envoy/type/v3"
	"google.golang.org/genproto/googleapis/rpc/status"
	"google.golang.org/grpc/codes"

	"github.com/ai-hermes/pi-lessons/apps/loom/pkg/loom"
)

// GRPCServer 实现 Envoy ext_authz.v3 的 Check，与 HTTP 门面共用同一个 Engine。
type GRPCServer struct {
	authv3.UnimplementedAuthorizationServer
	engine *Engine
}

// NewGRPCServer 创建 gRPC 门面。
func NewGRPCServer(e *Engine) *GRPCServer { return &GRPCServer{engine: e} }

// Check 见 envoy.service.auth.v3.Authorization/Check。
func (s *GRPCServer) Check(ctx context.Context, req *authv3.CheckRequest) (*authv3.CheckResponse, error) {
	httpReq := req.GetAttributes().GetRequest().GetHttp()
	headers := make(map[string]string, len(httpReq.GetHeaders()))
	for k, v := range httpReq.GetHeaders() {
		if strings.HasPrefix(k, ":") {
			continue
		}
		headers[k] = v
	}
	dec := s.engine.Evaluate(ctx, Request{Headers: headers, Body: []byte(httpReq.GetBody()), Path: httpReq.GetPath(), Method: httpReq.GetMethod(),
		Source: "grpc", ClientRequestID: httpReq.GetHeaders()[loom.HdrClientReqID], Now: time.Now()})
	if dec.Allow {
		return &authv3.CheckResponse{
			Status:       &status.Status{Code: int32(codes.OK)},
			HttpResponse: &authv3.CheckResponse_OkResponse{OkResponse: &authv3.OkHttpResponse{Headers: headerOptions(dec.Headers)}},
		}, nil
	}
	return &authv3.CheckResponse{
		Status: &status.Status{Code: int32(codes.PermissionDenied)},
		HttpResponse: &authv3.CheckResponse_DeniedResponse{DeniedResponse: &authv3.DeniedHttpResponse{
			Status:  &typev3.HttpStatus{Code: typev3.StatusCode(dec.Status)},
			Headers: append(headerOptions(dec.Headers), &core.HeaderValueOption{Header: &core.HeaderValue{Key: "content-type", Value: "application/json"}}),
			Body:    string(dec.Body),
		}},
	}, nil
}

func headerOptions(h map[string]string) []*core.HeaderValueOption {
	out := make([]*core.HeaderValueOption, 0, len(h))
	for k, v := range h {
		out = append(out, &core.HeaderValueOption{Header: &core.HeaderValue{Key: k, Value: v}})
	}
	return out
}
