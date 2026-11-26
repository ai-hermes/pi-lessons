package pricing

import "math"

// 金额单位：所有额度与金额均为整数 nano-USD。
const (
	// NanosPerUSD 一美元对应的 nano-USD 数量。
	NanosPerUSD int64 = 1_000_000_000
	// nanosPerRatioToken one-api 基准：model_ratio 1 == $2 / 1M tokens == 2000 nano-USD / token。
	nanosPerRatioToken = 2000
)

// Source 单价卡的定价来源，落库到 usage_events.pricing_source。
type Source string

// 定价来源取值。
const (
	SourceConfigMap Source = "configmap" // pricing.yaml
	SourceStore     Source = "pg"        // PG model_pricing 兜底表
	SourceDefault   Source = "default"   // defaults（unknown_model: default）
)

// Tokens 一次请求的 token 用量；Cached 是 Input 中命中缓存的部分。
type Tokens struct {
	Input  int64
	Cached int64
	Output int64
}

// Card 是 (model, group) 的预计算整数单价卡。
// 按 token 计费时 PerCallNanos == 0；按次计费时三个 token 单价为 0。
type Card struct {
	Model        string  `json:"model"`
	Group        string  `json:"group"`
	Source       Source  `json:"source"`
	ModelRatio   float64 `json:"model_ratio"`
	GroupRatio   float64 `json:"group_ratio"`
	InputNanos   int64   `json:"input_nanos_per_token"`
	CachedNanos  int64   `json:"cached_nanos_per_token"`
	OutputNanos  int64   `json:"output_nanos_per_token"`
	PerCallNanos int64   `json:"per_call_nanos"`
	ReserveNanos int64   `json:"reserve_nanos"` // 准入阶段预扣额
}

// IsPerCall 是否按次计费。
func (c Card) IsPerCall() bool { return c.PerCallNanos > 0 }

// Cost 计算一次请求的金额（nano-USD）。
func (c Card) Cost(t Tokens) int64 {
	if c.IsPerCall() {
		return c.PerCallNanos
	}
	cached := min(t.Cached, t.Input)
	uncached := t.Input - cached
	return uncached*c.InputNanos + cached*c.CachedNanos + t.Output*c.OutputNanos
}

// cardInput 构造单价卡所需的全部输入。
type cardInput struct {
	model      string
	group      string
	groupRatio float64
	spec       ModelSpec // 已补齐 defaults
	reserve    ReserveTokens
	source     Source
}

func newCard(in cardInput) Card {
	card := Card{
		Model:      in.model,
		Group:      in.group,
		Source:     in.source,
		ModelRatio: in.spec.ModelRatio,
		GroupRatio: in.groupRatio,
	}
	if price := in.spec.ModelPrice; price != nil && *price > 0 {
		card.PerCallNanos = roundNanos(*price * in.groupRatio * float64(NanosPerUSD))
		card.ReserveNanos = card.PerCallNanos
		return card
	}

	inputNanos := in.spec.ModelRatio * in.groupRatio * nanosPerRatioToken
	card.InputNanos = roundNanos(inputNanos)
	card.CachedNanos = roundNanos(inputNanos * in.spec.CacheRatio)
	card.OutputNanos = roundNanos(inputNanos * in.spec.CompletionRatio)

	reserve := effectiveReserve(in.reserve, in.spec.ReserveTokens)
	card.ReserveNanos = reserve.Input*card.InputNanos + reserve.Output*card.OutputNanos
	return card
}

// effectiveReserve 用模型级覆盖值（非负字段）替换全局预扣估值。
func effectiveReserve(global ReserveTokens, override *ReserveTokens) ReserveTokens {
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
