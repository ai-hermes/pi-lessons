// Package extauth 是 AgentGateway 外挂鉴权的协议门面：HTTP `/check` 与 Envoy ext_authz.v3 gRPC。
// 两个门面共用 admission.Gate，只负责把请求头翻译为 admission.Request、把 Verdict 翻译为线上响应。
package extauth

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"strconv"
	"strings"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/admission"
)

// Admitter 准入判断。
type Admitter interface {
	Admit(ctx context.Context, req admission.Request) admission.Verdict
}

// Headers 与网关约定的请求头 / 响应头名称（需与策略 allowedRequestHeaders / allowedResponseHeaders 一致）。
type Headers struct {
	Credentials     []string // 按顺序取第一个非空值；值形如 "Bearer <key>" 或裸 key
	ClientRequestID string   // 调用方请求 ID，仅审计
	Model           string   // 入：网关预提取的模型名；出：本次定价的模型名

	Account        string // 出：账户名
	APIKeyID       string // 出：Key ID
	RequestID      string // 出：loom 请求 ID（结算关联键）
	QuotaRemaining string // 出：剩余额度（nano-USD）
	DenyReason     string // 出：拒绝原因
	RateLimit      string // 出：rate_limited 时触发的层级与限流项，如 account/rpm
}

// Options 门面参数。
type Options struct {
	Headers Headers
	// DenyStatus 拒绝原因 → HTTP 状态码；未列出的原因按 401。
	DenyStatus map[admission.Reason]int
	BodyLimit  int64 // HTTP 门面读取请求体的上限
}

// checkResponse 是 Verdict 的 extAuth 线上形态。
type checkResponse struct {
	isAllowed bool
	status    int
	headers   map[string]string
	body      []byte
}

// admissionRequest 从 extAuth 请求数据构造领域层的 admission.Request；headers 的键须为小写。
func (o Options) admissionRequest(headers map[string]string, body []byte, protocol, path string) admission.Request {
	return admission.Request{
		Credential:      credential(headers, o.Headers.Credentials),
		ModelHint:       headers[o.Headers.Model],
		Body:            body,
		Protocol:        protocol,
		Path:            path,
		ClientRequestID: headers[o.Headers.ClientRequestID],
	}
}

// checkResponse 把领域层的 Verdict 翻译为 extAuth 线上响应。
func (o Options) checkResponse(v admission.Verdict) checkResponse {
	h := o.Headers
	if !v.Allowed {
		headers := map[string]string{h.DenyReason: string(v.Reason)}
		if v.RateLimit != nil {
			headers[h.RateLimit] = string(v.RateLimit.Scope) + "/" + string(v.RateLimit.Kind)
			headers["retry-after"] = strconv.Itoa(int(math.Ceil(v.RetryAfter.Seconds())))
		}
		return checkResponse{
			status:  o.statusFor(v.Reason),
			headers: headers,
			body:    errorBody(v),
		}
	}
	headers := map[string]string{
		h.Account:   v.AccountName,
		h.APIKeyID:  v.APIKeyID.String(),
		h.RequestID: v.RequestID,
	}
	if v.Model != "" {
		headers[h.Model] = v.Model
	}
	if v.RemainingNanos != nil {
		headers[h.QuotaRemaining] = strconv.FormatInt(*v.RemainingNanos, 10)
	}
	return checkResponse{isAllowed: true, status: http.StatusOK, headers: headers}
}

func (o Options) statusFor(r admission.Reason) int {
	if status, ok := o.DenyStatus[r]; ok {
		return status
	}
	return http.StatusUnauthorized
}

// credential 取第一个非空凭据头，去掉大小写不敏感的 "Bearer " 前缀。
func credential(headers map[string]string, names []string) string {
	for _, name := range names {
		v := strings.TrimSpace(headers[strings.ToLower(name)])
		if len(v) > len("bearer ") && strings.EqualFold(v[:len("bearer ")], "bearer ") {
			v = strings.TrimSpace(v[len("bearer "):])
		}
		if v != "" {
			return v
		}
	}
	return ""
}

var denyMessages = map[admission.Reason]string{
	admission.ReasonMissingCredential: "missing API key: send Authorization: Bearer <key> or x-api-key",
	admission.ReasonUnknownKey:        "unknown API key",
	admission.ReasonExpiredKey:        "API key expired",
	admission.ReasonInactive:          "account or API key is disabled",
	admission.ReasonModelNotAllowed:   "model not allowed for this API key",
	admission.ReasonModelNotPriced:    "model has no pricing configured",
	admission.ReasonGroupNotPriced:    "account group has no pricing configured",
	admission.ReasonInsufficientQuota: "insufficient quota",
	admission.ReasonRateLimited:       "rate limit exceeded",
	admission.ReasonInternalError:     "internal error",
}

// errorBody 生成 OpenAI 风格错误体，现有 SDK 可直接解析。
func errorBody(v admission.Verdict) []byte {
	r := v.Reason
	message := denyMessages[r]
	errType := "auth_error"
	switch r {
	case admission.ReasonInsufficientQuota:
		errType = "quota_error"
	case admission.ReasonRateLimited:
		errType = "rate_limit_error"
		if v.RateLimit != nil {
			message += ": " + string(v.RateLimit.Scope) + " " + string(v.RateLimit.Kind)
		}
	case admission.ReasonModelNotAllowed, admission.ReasonModelNotPriced, admission.ReasonGroupNotPriced:
		errType = "model_error"
	case admission.ReasonInternalError:
		errType = "server_error"
	}
	b, _ := json.Marshal(map[string]map[string]string{
		"error": {"code": string(r), "message": message, "type": errType},
	})
	return b
}
