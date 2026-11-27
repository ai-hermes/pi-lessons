package extauth

import (
	"context"
	"strings"

	core "github.com/envoyproxy/go-control-plane/envoy/config/core/v3"
	authv3 "github.com/envoyproxy/go-control-plane/envoy/service/auth/v3"
	typev3 "github.com/envoyproxy/go-control-plane/envoy/type/v3"
	"google.golang.org/genproto/googleapis/rpc/status"
	"google.golang.org/grpc/codes"
)

// GRPCServer 实现 Envoy ext_authz.v3 Authorization/Check，与 HTTP 门面结论一致。
type GRPCServer struct {
	authv3.UnimplementedAuthorizationServer
	gate Admitter
	opts Options
}

// NewGRPCServer 创建 gRPC 门面。
func NewGRPCServer(gate Admitter, opts Options) *GRPCServer {
	return &GRPCServer{gate: gate, opts: opts}
}

// Check 见 envoy.service.auth.v3.Authorization/Check。
func (s *GRPCServer) Check(ctx context.Context, req *authv3.CheckRequest) (*authv3.CheckResponse, error) {
	httpReq := req.GetAttributes().GetRequest().GetHttp()
	headers := make(map[string]string, len(httpReq.GetHeaders()))
	for name, value := range httpReq.GetHeaders() {
		if !strings.HasPrefix(name, ":") { // 跳过 HTTP/2 伪头
			headers[name] = value
		}
	}

	admissionReq := s.opts.admissionRequest(headers, []byte(httpReq.GetBody()), "grpc", httpReq.GetPath())
	verdict := s.gate.Admit(ctx, admissionReq)
	resp := s.opts.checkResponse(verdict)

	if resp.isAllowed {
		return &authv3.CheckResponse{
			Status: &status.Status{Code: int32(codes.OK)},
			HttpResponse: &authv3.CheckResponse_OkResponse{
				OkResponse: &authv3.OkHttpResponse{Headers: headerOptions(resp.headers)},
			},
		}, nil
	}
	resp.headers["content-type"] = "application/json"
	return &authv3.CheckResponse{
		Status: &status.Status{Code: int32(codes.PermissionDenied)},
		HttpResponse: &authv3.CheckResponse_DeniedResponse{
			DeniedResponse: &authv3.DeniedHttpResponse{
				Status: &typev3.HttpStatus{
					Code: typev3.StatusCode(resp.status), //nolint:gosec // Config validation restricts HTTP status to 100..599.
				},
				Headers: headerOptions(resp.headers),
				Body:    string(resp.body),
			},
		},
	}, nil
}

func headerOptions(headers map[string]string) []*core.HeaderValueOption {
	opts := make([]*core.HeaderValueOption, 0, len(headers))
	for name, value := range headers {
		opts = append(opts, &core.HeaderValueOption{Header: &core.HeaderValue{Key: name, Value: value}})
	}
	return opts
}
