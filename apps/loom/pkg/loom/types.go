// Package loom 定义对外共享的常量与基础类型：拒绝原因、状态、identity header 名、金额单位。
package loom

import "errors"

// NanoUSD 一美元对应的 nano-USD 数量；所有额度与金额都以整数 nano-USD 存储。
const NanoUSDPerUSD int64 = 1_000_000_000

// RatioBaseNanoPerToken one-api 口径：model_ratio 1 == $2 / 1M input tokens == 2000 nano-USD/token。
const RatioBaseNanoPerToken float64 = 2000

// 拒绝原因（稳定枚举，出现在响应头 X-Loom-Deny-Reason 与错误体 code 中）。
const (
	ReasonMissingCredential  = "missing_credential"
	ReasonUnknownAPIKey      = "unknown_api_key"
	ReasonExpiredAPIKey      = "expired_api_key"
	ReasonClientInactive     = "client_inactive"
	ReasonModelNotAllowed    = "model_not_allowed"
	ReasonModelNotPriced     = "model_not_priced"
	ReasonInsufficientQuota  = "insufficient_quota"
	ReasonInternalError      = "internal_error"
	ReasonUnsupportedModel   = "unsupported_model"
	ReasonReservationMissing = "reservation_missing"
)

// 凭据来源。
const (
	SourceAPIKey = "api_key"
	SourceNone   = "none"
)

// Key / 账户状态。
const (
	StatusActive   = "active"
	StatusDisabled = "disabled"
)

// 放行时注入上游请求的头（需在策略 allowedResponseHeaders 中列出）。
const (
	HdrClientID       = "x-loom-client-id"
	HdrKeyID          = "x-loom-key-id"
	HdrRequestID      = "x-loom-request-id"
	HdrQuotaRemaining = "x-loom-quota-remaining"
	HdrDenyReason     = "x-loom-deny-reason"
	HdrModel          = "x-loom-model" // 可选：网关 CEL 提取的 model
	HdrClientReqID    = "x-request-id"
)

// 定价来源。
const (
	PriceSourceConfigMap = "configmap"
	PriceSourcePG        = "pg"
	PriceSourceDefault   = "default"
)

// ErrNotFound 记录不存在。
var ErrNotFound = errors.New("not found")

// ErrInsufficientQuota 预扣时额度不足。
var ErrInsufficientQuota = errors.New("insufficient quota")
