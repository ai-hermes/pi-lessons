package pricing

import "math"

// 金额单位：额度与结算金额均为整数 nano-USD；单 token 单价保留小数，整笔请求算完再取整一次。
const (
	// NanosPerUSD 一美元对应的 nano-USD 数量。
	NanosPerUSD int64 = 1_000_000_000
	// nanosPerRatioToken one-api 基准：model_ratio 1 == $2 / 1M tokens == 2000 nano-USD / token。
	nanosPerRatioToken = 2000
)

// PriceSource 单价卡的定价来源，落库到 usage_events.pricing_source。
type PriceSource string

// 定价来源取值。
const (
	SourceConfigMap PriceSource = "configmap" // pricing.yaml
	SourceDatabase  PriceSource = "pg"        // PG model_pricing 兜底表
	SourceDefault   PriceSource = "default"   // defaults（unknown_model: default）
)

// TokenUsage 一次请求的 token 用量；Cached 是 Input 中命中缓存的部分。
type TokenUsage struct {
	Input  int64
	Cached int64
	Output int64
}

// UnitPrice 是 (model, group) 的预计算单价卡，同时保留算出它的倍率，结算时作为账单快照落库。
// 按 token 计费时 PerCall 为 false；按次计费时 PerCall 为 true、三个 token 单价为 0。
// 任一单价为 0 表示该部分免费。
type UnitPrice struct {
	Model       string      `json:"model"`
	Group       string      `json:"group"`
	PriceSource PriceSource `json:"source"`

	ModelRatio      float64  `json:"model_ratio"`
	CompletionRatio float64  `json:"completion_ratio"`
	CacheRatio      float64  `json:"cache_ratio"`
	ModelPrice      *float64 `json:"model_price"` // USD/次；按 token 计费时为 nil
	GroupRatio      float64  `json:"group_ratio"`

	// 单 token 单价（nano-USD），保留小数以免取整误差随 token 数放大。
	InputNanos  float64 `json:"input_nanos_per_token"`
	CachedNanos float64 `json:"cached_nanos_per_token"`
	OutputNanos float64 `json:"output_nanos_per_token"`

	PerCall      bool  `json:"per_call"`
	PerCallNanos int64 `json:"per_call_nanos"`
	ReserveNanos int64 `json:"reserve_nanos"` // 准入阶段预扣额
}

// IsPerCall 是否按次计费。
func (c UnitPrice) IsPerCall() bool { return c.PerCall }

// Cost 计算一次请求的金额（nano-USD），整笔算完后只取整一次。
func (c UnitPrice) Cost(t TokenUsage) int64 {
	if c.IsPerCall() {
		return c.PerCallNanos
	}
	cached := min(t.Cached, t.Input)
	uncached := t.Input - cached
	return roundNanos(float64(uncached)*c.InputNanos + float64(cached)*c.CachedNanos + float64(t.Output)*c.OutputNanos)
}

// unitPriceInput 构造单价卡所需的全部输入。
type unitPriceInput struct {
	model      string
	group      string
	groupRatio float64
	rate       ModelRate // 已补齐 defaults；0 表示免费
	reserve    ReserveEstimate
	source     PriceSource
}

func newUnitPrice(in unitPriceInput) UnitPrice {
	unitPrice := UnitPrice{
		Model:           in.model,
		Group:           in.group,
		PriceSource:     in.source,
		ModelRatio:      in.rate.ModelRatio,
		CompletionRatio: in.rate.CompletionRatio,
		CacheRatio:      in.rate.CacheRatio,
		ModelPrice:      in.rate.ModelPrice,
		GroupRatio:      in.groupRatio,
	}
	if price := in.rate.ModelPrice; price != nil {
		unitPrice.PerCall = true
		unitPrice.PerCallNanos = roundNanos(*price * in.groupRatio * float64(NanosPerUSD))
		unitPrice.ReserveNanos = unitPrice.PerCallNanos
		return unitPrice
	}

	unitPrice.InputNanos = in.rate.ModelRatio * in.groupRatio * nanosPerRatioToken
	unitPrice.CachedNanos = unitPrice.InputNanos * in.rate.CacheRatio
	unitPrice.OutputNanos = unitPrice.InputNanos * in.rate.CompletionRatio

	reserve := mergeReserveEstimate(in.reserve, in.rate.Reserve)
	unitPrice.ReserveNanos = roundNanos(
		float64(reserve.Input)*unitPrice.InputNanos + float64(reserve.Output)*unitPrice.OutputNanos,
	)
	return unitPrice
}

// mergeReserveEstimate 用模型级覆盖值（非负字段）替换全局预扣估值。
func mergeReserveEstimate(global ReserveEstimate, override *ReserveEstimate) ReserveEstimate {
	if override == nil {
		return global
	}
	if override.Input >= 0 {
		global.Input = override.Input
	}
	if override.Output >= 0 {
		global.Output = override.Output
	}
	return global
}

func roundNanos(v float64) int64 { return int64(math.Round(v)) }
