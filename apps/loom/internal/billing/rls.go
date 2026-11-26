package billing

import (
	"context"
	"time"

	rlsv3 "github.com/envoyproxy/go-control-plane/envoy/service/ratelimit/v3"
	"github.com/google/uuid"
)

// rlsCodeError 是 Envoy RateLimitResponse.Code 的 ERROR(3)。go-control-plane v1.40 的生成代码还没有这个枚举值，
// 但 proto3 枚举是开放的，直接写入数值即可；网关侧（Rust prost）解析为 Code::Error。
const rlsCodeError = rlsv3.RateLimitResponse_Code(3)

// RLSServer 实现 Envoy RateLimitService.v3，作为计费结算的同步通道：
//
// 网关策略 rateLimit.global(unit=Tokens, descriptors[].cost=llm.*) 对每个请求会调用两次：
//   - 请求阶段（check）：所有 Tokens 描述符 hits_addend=0，只做放行检查；这里恒返回 OK，额度门禁由 extAuth 负责。
//   - 响应完成（amend）：按 cost CEL 算出 input / cached / output 三个 token 数，分别放在三个描述符的 hits_addend 里；
//     收到后立即用 SettleUsage 幂等结算（与 OTLP 补账共用 request_id 幂等键，先到先结算）。
//
// 描述符 entries 约定：request_id、key_id、model、kind=input|cached|output。
type RLSServer struct {
	rlsv3.UnimplementedRateLimitServiceServer
	ingest *Ingest
	domain string
}

// NewRLSServer 创建 RLS 服务。
func NewRLSServer(ingest *Ingest, domain string) *RLSServer {
	if domain == "" {
		domain = "loom-billing"
	}
	return &RLSServer{ingest: ingest, domain: domain}
}

// ShouldRateLimit 见 envoy.service.ratelimit.v3.RateLimitService/ShouldRateLimit。
func (s *RLSServer) ShouldRateLimit(ctx context.Context, req *rlsv3.RateLimitRequest) (*rlsv3.RateLimitResponse, error) {
	resp := &rlsv3.RateLimitResponse{OverallCode: rlsv3.RateLimitResponse_OK}
	if req.GetDomain() != s.domain {
		return resp, nil
	}
	// 同一 request_id 的多个描述符合并为一条 Record
	type agg struct {
		requestID, keyID, model string
		in, cached, out         uint64
		any                     bool
	}
	byReq := map[string]*agg{}
	for _, d := range req.GetDescriptors() {
		a := &agg{}
		kind := ""
		for _, e := range d.GetEntries() {
			switch e.GetKey() {
			case "request_id":
				a.requestID = e.GetValue()
			case "key_id":
				a.keyID = e.GetValue()
			case "model":
				a.model = e.GetValue()
			case "kind":
				kind = e.GetValue()
			}
		}
		if a.requestID == "" {
			continue
		}
		cur, ok := byReq[a.requestID]
		if !ok {
			cur = a
			byReq[a.requestID] = cur
		}
		addend := uint64(d.GetHitsAddend().GetValue())
		if addend > 0 {
			cur.any = true
		}
		switch kind {
		case "input":
			cur.in = addend
		case "cached":
			cur.cached = addend
		case "output":
			cur.out = addend
		}
		resp.Statuses = append(resp.Statuses, &rlsv3.RateLimitResponse_DescriptorStatus{Code: rlsv3.RateLimitResponse_OK})
	}
	n, failed := 0, 0
	for _, a := range byReq {
		if !a.any {
			continue // 请求阶段 check（全 0），不计费
		}
		rec := Record{Time: time.Now(), RequestID: a.requestID, Model: a.model, InputTokens: int64(a.in),
			CachedTokens: int64(a.cached), OutputTokens: int64(a.out), Channel: "rls"}
		if id, err := uuid.Parse(a.keyID); err == nil {
			rec.KeyID = id
		}
		if _, err := s.ingest.Settle(ctx, rec); err != nil {
			// 结算失败不阻断（网关也不看 amend 的返回值）：OTLP 补账通道仍有机会；
			// 返回 ERROR 只为在网关 trace 里留下可检索的痕迹
			failed++
			if s.ingest.m != nil {
				s.ingest.m.IngestErrors.WithLabelValues("rls_settle").Inc()
			}
			s.ingest.log.Error("rls settle failed", "err", err, "request_id", a.requestID)
		} else {
			n++
		}
	}
	if s.ingest.m != nil {
		if n+failed > 0 {
			s.ingest.m.RLSCalls.WithLabelValues("amend").Inc()
		} else {
			s.ingest.m.RLSCalls.WithLabelValues("check").Inc()
		}
	}
	if failed > 0 {
		resp.OverallCode = rlsCodeError
		for _, st := range resp.Statuses {
			st.Code = rlsCodeError
		}
	}
	return resp, nil
}
