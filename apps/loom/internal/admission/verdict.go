// Package admission 是请求准入门：凭据 → Key → 状态 → 模型 → 定价 → 限流 → 预扣，给出放行或拒绝的 Verdict。
//
// 本包与传输协议无关：凭据、模型提示等由 transport 层从请求头中抽出后传入；
// Verdict 如何映射为 HTTP 状态码、响应头和错误体也由 transport 层决定。
package admission

import (
	"time"

	"github.com/google/uuid"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
)

// Request 一次准入请求。
type Request struct {
	Credential string // 调用方 API Key 明文，空表示未携带
	ModelHint  string // 网关预先提取的模型名（可选），优先于请求体
	Body       []byte // 请求体；为 JSON 时从 model 字段取模型名

	// 以下字段只用于审计与日志。
	Protocol        string // 门面协议：http | grpc
	Path            string
	ClientRequestID string // 调用方的 x-request-id
}

// Reason 准入结论的原因码；拒绝时会作为稳定枚举返回给调用方。
type Reason string

// 准入原因码；取值是对外契约（x-loom-deny-reason 响应头与错误体 code）。
const (
	ReasonAllowed           Reason = "ok"
	ReasonMissingCredential Reason = "missing_credential"
	ReasonUnknownKey        Reason = "unknown_api_key"
	ReasonExpiredKey        Reason = "expired_api_key"
	ReasonInactive          Reason = "client_inactive"
	ReasonModelNotAllowed   Reason = "model_not_allowed"
	ReasonModelNotPriced    Reason = "model_not_priced"
	ReasonGroupNotPriced    Reason = "group_not_priced"
	ReasonInsufficientQuota Reason = "insufficient_quota"
	ReasonRateLimited       Reason = "rate_limited"
	ReasonInternalError     Reason = "internal_error"
)

// Verdict 准入结论。放行时 RequestID 是本次预扣的结算关联键。
type Verdict struct {
	Allowed   bool
	Reason    Reason
	RequestID string

	APIKeyID    uuid.UUID // 未识别出 Key 时为零值
	AccountID   uuid.UUID
	AccountName string
	Model       string

	ReservedNanos  int64
	RemainingNanos *int64 // 两级额度中较小的剩余值；不限额时为 nil

	// 以下字段仅在 Reason 为 rate_limited 时有值。
	RateLimit  *store.RateLimitError // 触发的层级与限流项
	RetryAfter time.Duration         // 建议的重试等待时间
}

func (v Verdict) allow() Verdict {
	v.Allowed, v.Reason = true, ReasonAllowed
	return v
}

func (v Verdict) deny(r Reason) Verdict {
	v.Allowed, v.Reason = false, r
	return v
}

// hasKey 是否已识别出调用方 Key。
func (v Verdict) hasKey() bool { return v.APIKeyID != uuid.Nil }
