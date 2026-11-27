// Package ratelimit 把 AgentGateway 的 RateLimitService 调用用作同步结算通道。
//
// 网关策略 rateLimit.global（unit: Tokens，descriptors[].cost 读取 llm.* 用量）对每个请求调用两次：
//   - check：请求阶段，所有描述符 hits_addend=0；恒返回 OK，额度门禁在 extauth 准入阶段完成。
//   - amend：响应完成后，描述符分别携带 input / cached / output token 数与 completion=1；收到后立即结算。
//
// 描述符 entries 约定：request_id、key_id、model、kind（input | cached | output | completion）。
// completion 的 cost 恒为 1，不计入 token，只表示"该请求已有响应"：上游报错或客户端中途断开时
// token 用量全为 0，靠它把请求与请求阶段的 check 区分开，按实际用量（0）结算并释放预扣。
// 网关不看 amend 的返回值；结算失败时返回 ERROR 只为在网关 trace 中留下痕迹。
package ratelimit

import (
	"context"
	"log/slog"
	"math"
	"time"

	rlscommon "github.com/envoyproxy/go-control-plane/envoy/extensions/common/ratelimit/v3"
	rlsv3 "github.com/envoyproxy/go-control-plane/envoy/service/ratelimit/v3"
	"github.com/google/uuid"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/ledger"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/pricing"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/telemetry"
)

// Channel 是本通道在结算记录中的名称。
const Channel = "rls"

// codeError 是 RateLimitResponse.Code 的 ERROR(3)。go-control-plane v1.40 尚未生成该枚举值，
// proto3 枚举是开放的，可直接写入数值；网关侧解析为 Code::Error。
const codeError = rlsv3.RateLimitResponse_Code(3)

// Settler 结算用量。
type Settler interface {
	Settle(ctx context.Context, u ledger.UsageReport) (bool, error)
}

// Server 实现 envoy.service.ratelimit.v3.RateLimitService。
type Server struct {
	rlsv3.UnimplementedRateLimitServiceServer
	settler Settler
	domain  string
	metrics *telemetry.Metrics
	log     *slog.Logger
}

// NewServer 创建 RateLimitService；只处理 domain 匹配的调用，其余一律返回 OK。
func NewServer(settler Settler, domain string, metrics *telemetry.Metrics, log *slog.Logger) *Server {
	return &Server{settler: settler, domain: domain, metrics: metrics, log: log}
}

// ShouldRateLimit 见 envoy.service.ratelimit.v3.RateLimitService/ShouldRateLimit。
func (s *Server) ShouldRateLimit(ctx context.Context, req *rlsv3.RateLimitRequest) (*rlsv3.RateLimitResponse, error) {
	resp := &rlsv3.RateLimitResponse{OverallCode: rlsv3.RateLimitResponse_OK}
	if req.GetDomain() != s.domain {
		return resp, nil
	}
	for range req.GetDescriptors() {
		status := &rlsv3.RateLimitResponse_DescriptorStatus{Code: rlsv3.RateLimitResponse_OK}
		resp.Statuses = append(resp.Statuses, status)
	}

	reports := groupByRequest(req.GetDescriptors())
	if len(reports) == 0 {
		s.metrics.RateLimitCalls.WithLabelValues("check").Inc()
		return resp, nil
	}
	s.metrics.RateLimitCalls.WithLabelValues("amend").Inc()

	failed := false
	for _, r := range reports {
		if _, err := s.settler.Settle(ctx, r.usageReport()); err != nil {
			failed = true
			s.log.Error("ratelimit amend settlement failed", "err", err, "request_id", r.requestID)
		}
	}
	if failed {
		resp.OverallCode = codeError
		for _, st := range resp.Statuses {
			st.Code = codeError
		}
	}
	return resp, nil
}

// report 是同一 request_id 的三个描述符合并后的用量。
type report struct {
	requestID  string
	apiKeyID   string
	model      string
	tokenUsage pricing.TokenUsage
}

func (r report) usageReport() ledger.UsageReport {
	u := ledger.UsageReport{
		RequestID:  r.requestID,
		Channel:    Channel,
		Model:      r.model,
		TokenUsage: r.tokenUsage,
		Time:       time.Now(),
	}
	if id, err := uuid.Parse(r.apiKeyID); err == nil {
		u.APIKeyID = id
	}
	return u
}

// groupByRequest 把描述符按 request_id 合并；全部 hits_addend 为 0（check 阶段）的请求不返回。
func groupByRequest(descriptors []*rlscommon.RateLimitDescriptor) []report {
	byID := map[string]*report{}
	var order []string
	charged := map[string]bool{}

	for _, d := range descriptors {
		entries := entryMap(d)
		requestID := entries["request_id"]
		if requestID == "" {
			continue
		}
		r, ok := byID[requestID]
		if !ok {
			r = &report{requestID: requestID, apiKeyID: entries["key_id"], model: entries["model"]}
			byID[requestID] = r
			order = append(order, requestID)
		}
		value := d.GetHitsAddend().GetValue()
		if value > math.MaxInt64 {
			continue
		}
		n := int64(value)
		if n > 0 {
			charged[requestID] = true
		}
		switch entries["kind"] {
		case "input":
			r.tokenUsage.Input = n
		case "cached":
			r.tokenUsage.Cached = n
		case "output":
			r.tokenUsage.Output = n
		}
	}

	reports := make([]report, 0, len(order))
	for _, id := range order {
		if charged[id] {
			reports = append(reports, *byID[id])
		}
	}
	return reports
}

func entryMap(d *rlscommon.RateLimitDescriptor) map[string]string {
	m := make(map[string]string, len(d.GetEntries()))
	for _, e := range d.GetEntries() {
		m[e.GetKey()] = e.GetValue()
	}
	return m
}
