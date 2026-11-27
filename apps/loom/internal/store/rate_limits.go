package store

import (
	"errors"
	"fmt"

	"github.com/google/uuid"
)

// ErrRateLimited 超出 RPM / TPM / 并发上限；具体是哪一级、哪一项由 *RateLimitError 给出。
var ErrRateLimited = errors.New("store: rate limited")

// RateLimits 一级（API Key 或账户）的速率与并发上限；字段为 nil 表示该项不限。
type RateLimits struct {
	RPM            *int64 `json:"rpm"             yaml:"rpm"`             // 每分钟请求数
	TPM            *int64 `json:"tpm"             yaml:"tpm"`             // 每分钟 token 数（输入 + 输出）
	MaxConcurrency *int64 `json:"max_concurrency" yaml:"max_concurrency"` // 同时进行中的模型请求数
}

// Validate 已配置的上限必须大于 0。
func (l RateLimits) Validate() error {
	for name, v := range map[string]*int64{"rpm": l.RPM, "tpm": l.TPM, "max_concurrency": l.MaxConcurrency} {
		if v != nil && *v <= 0 {
			return fmt.Errorf("%s must be positive, got %d", name, *v)
		}
	}
	return nil
}

// Or 逐项取值：本级未配置的项沿用 fallback（账户未配置时取分组默认值）。
func (l RateLimits) Or(fallback RateLimits) RateLimits {
	if l.RPM == nil {
		l.RPM = fallback.RPM
	}
	if l.TPM == nil {
		l.TPM = fallback.TPM
	}
	if l.MaxConcurrency == nil {
		l.MaxConcurrency = fallback.MaxConcurrency
	}
	return l
}

// IsZero 三项都不限。
func (l RateLimits) IsZero() bool {
	return l.RPM == nil && l.TPM == nil && l.MaxConcurrency == nil
}

// RateScope 限流作用的层级。
type RateScope string

// 限流层级取值；也是 rate_counters.scope 列与对外响应头的取值。
const (
	RateScopeAPIKey  RateScope = "api_key"
	RateScopeAccount RateScope = "account"
)

// RateLimitKind 被触发的限流项。
type RateLimitKind string

// 限流项取值；也是对外响应头与指标标签的取值。
const (
	RateLimitRPM         RateLimitKind = "rpm"
	RateLimitTPM         RateLimitKind = "tpm"
	RateLimitConcurrency RateLimitKind = "concurrency"
)

// RateLimitError 指出被触发的层级与限流项；errors.Is(err, ErrRateLimited) 为真。
type RateLimitError struct {
	Scope RateScope
	Kind  RateLimitKind
}

func (e *RateLimitError) Error() string {
	return fmt.Sprintf("store: rate limited: %s %s", e.Scope, e.Kind)
}

// Is 让 errors.Is(err, ErrRateLimited) 成立。
func (e *RateLimitError) Is(target error) bool { return target == ErrRateLimited }

// RateClaim 一次请求在一个计数对象（API Key 或账户）上的 RPM / TPM 计数申请。
type RateClaim struct {
	Scope   RateScope
	Subject uuid.UUID // API Key 或账户的 id
	Tokens  int64     // 计入 TPM 的 token 数；AddRateTokens 中可为负（结算修正）
	RPM     *int64
	TPM     *int64
}

// ConcurrencyLimits 预扣时检查的两级并发上限；nil 表示不限。
type ConcurrencyLimits struct {
	APIKey  *int64
	Account *int64
}
