// Package pricing 实现 one-api 口径的计价：ConfigMap 主配置、PG 表兜底、按 (model, group) 预计算的 PriceCard。
package pricing

import (
	"errors"
	"fmt"
	"math"
	"os"
	"sort"
	"strconv"

	"gopkg.in/yaml.v3"

	"github.com/ai-hermes/pi-lessons/apps/loom/pkg/loom"
)

// ErrNotPriced 模型没有定价。
var ErrNotPriced = errors.New("model not priced")

// UnknownModel 策略。
const (
	UnknownDeny    = "deny"
	UnknownDefault = "default"
)

// ReserveTokens 鉴权阶段预扣使用的 token 估值。
type ReserveTokens struct {
	Input  int64 `yaml:"input" json:"input"`
	Output int64 `yaml:"output" json:"output"`
}

// ModelSpec 单个模型的计价配置。
type ModelSpec struct {
	ModelRatio      float64        `yaml:"model_ratio" json:"model_ratio"`
	CompletionRatio float64        `yaml:"completion_ratio" json:"completion_ratio"`
	CacheRatio      float64        `yaml:"cache_ratio" json:"cache_ratio"`
	ModelPrice      *float64       `yaml:"model_price" json:"model_price"`
	ReserveTokens   *ReserveTokens `yaml:"reserve_tokens" json:"reserve_tokens"`
}

// GroupSpec 分组倍率。
type GroupSpec struct {
	Ratio float64 `yaml:"ratio" json:"ratio"`
}

// Defaults 未指定字段时的默认值。
type Defaults struct {
	ModelRatio      float64 `yaml:"model_ratio" json:"model_ratio"`
	CompletionRatio float64 `yaml:"completion_ratio" json:"completion_ratio"`
	CacheRatio      float64 `yaml:"cache_ratio" json:"cache_ratio"`
	UnknownModel    string  `yaml:"unknown_model" json:"unknown_model"`
}

// Spec pricing.yaml 的完整结构。
type Spec struct {
	Defaults Defaults             `yaml:"defaults" json:"defaults"`
	Groups   map[string]GroupSpec `yaml:"groups" json:"groups"`
	Models   map[string]ModelSpec `yaml:"models" json:"models"`
	Catalog  Catalog              `yaml:"catalog" json:"catalog"`
}

// Catalog 网关 modelCatalog 渲染参数。
type Catalog struct {
	Provider string `yaml:"provider" json:"provider"`
}

// LoadSpec 读取并规范化 pricing.yaml。
func LoadSpec(path string) (*Spec, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read pricing file: %w", err)
	}
	return ParseSpec(b)
}

// ParseSpec 解析并填充默认值。
func ParseSpec(b []byte) (*Spec, error) {
	var s Spec
	if err := yaml.Unmarshal(b, &s); err != nil {
		return nil, fmt.Errorf("parse pricing yaml: %w", err)
	}
	if s.Defaults.ModelRatio <= 0 {
		s.Defaults.ModelRatio = 1
	}
	if s.Defaults.CompletionRatio <= 0 {
		s.Defaults.CompletionRatio = 1
	}
	if s.Defaults.CacheRatio <= 0 {
		s.Defaults.CacheRatio = 1
	}
	if s.Defaults.UnknownModel == "" {
		s.Defaults.UnknownModel = UnknownDeny
	}
	if s.Defaults.UnknownModel != UnknownDeny && s.Defaults.UnknownModel != UnknownDefault {
		return nil, fmt.Errorf("defaults.unknown_model must be deny or default, got %q", s.Defaults.UnknownModel)
	}
	if len(s.Groups) == 0 {
		s.Groups = map[string]GroupSpec{"default": {Ratio: 1}}
	}
	for name, g := range s.Groups {
		if g.Ratio <= 0 {
			s.Groups[name] = GroupSpec{Ratio: 1}
		}
	}
	if s.Models == nil {
		s.Models = map[string]ModelSpec{}
	}
	if s.Catalog.Provider == "" {
		s.Catalog.Provider = "openai"
	}
	return &s, nil
}

// PriceCard 预计算的整数单价表：按 token 计费时 PerCallNanos == 0；按次计费时其余为 0。
type PriceCard struct {
	Model        string  `json:"model"`
	Group        string  `json:"group"`
	Source       string  `json:"source"`
	ModelRatio   float64 `json:"model_ratio"`
	GroupRatio   float64 `json:"group_ratio"`
	InputNanos   int64   `json:"input_nanos_per_token"`
	CacheNanos   int64   `json:"cache_nanos_per_token"`
	OutputNanos  int64   `json:"output_nanos_per_token"`
	PerCallNanos int64   `json:"per_call_nanos"`
	ReserveNanos int64   `json:"reserve_nanos"`
}

// PerCall 是否按次计费。
func (c PriceCard) PerCall() bool { return c.PerCallNanos > 0 }

// Cost 计算一次请求的 nano-USD。
func (c PriceCard) Cost(inputTokens, outputTokens, cachedTokens int64) int64 {
	if c.PerCall() {
		return c.PerCallNanos
	}
	cached := cachedTokens
	if cached > inputTokens {
		cached = inputTokens
	}
	uncached := inputTokens - cached
	return uncached*c.InputNanos + cached*c.CacheNanos + outputTokens*c.OutputNanos
}

// BuildCard 由模型规格与分组倍率预计算 PriceCard。
func BuildCard(model, group string, groupRatio float64, m ModelSpec, d Defaults, reserve ReserveTokens, source string) PriceCard {
	if m.ModelRatio <= 0 {
		m.ModelRatio = d.ModelRatio
	}
	if m.CompletionRatio <= 0 {
		m.CompletionRatio = d.CompletionRatio
	}
	if m.CacheRatio <= 0 {
		m.CacheRatio = d.CacheRatio
	}
	card := PriceCard{Model: model, Group: group, Source: source, ModelRatio: m.ModelRatio, GroupRatio: groupRatio}
	if m.ModelPrice != nil && *m.ModelPrice > 0 {
		card.PerCallNanos = int64(math.Round(*m.ModelPrice * groupRatio * float64(loom.NanoUSDPerUSD)))
		card.ReserveNanos = card.PerCallNanos
		return card
	}
	base := m.ModelRatio * groupRatio * loom.RatioBaseNanoPerToken
	card.InputNanos = int64(math.Round(base))
	card.CacheNanos = int64(math.Round(base * m.CacheRatio))
	card.OutputNanos = int64(math.Round(base * m.CompletionRatio))
	if m.ReserveTokens != nil {
		in, out := reserve.Input, reserve.Output
		if m.ReserveTokens.Input >= 0 {
			in = m.ReserveTokens.Input
		}
		if m.ReserveTokens.Output >= 0 {
			out = m.ReserveTokens.Output
		}
		reserve = ReserveTokens{Input: in, Output: out}
	}
	card.ReserveNanos = reserve.Input*card.InputNanos + reserve.Output*card.OutputNanos
	return card
}

// RowFromPG 把 PG 兜底行转换为 ModelSpec。
func RowFromPG(ratios [3]float64, price *float64, ri, ro *int) ModelSpec {
	m := ModelSpec{ModelRatio: ratios[0], CompletionRatio: ratios[1], CacheRatio: ratios[2], ModelPrice: price}
	if ri != nil || ro != nil {
		rt := &ReserveTokens{Input: -1, Output: -1}
		if ri != nil {
			rt.Input = int64(*ri)
		}
		if ro != nil {
			rt.Output = int64(*ro)
		}
		m.ReserveTokens = rt
	}
	return m
}

// Rate 把 nano-USD/token 转为 USD / 1M tokens 的字符串。
func Rate(nanosPerToken int64) string {
	usd := float64(nanosPerToken) * 1_000_000 / float64(loom.NanoUSDPerUSD)
	return strconv.FormatFloat(usd, 'f', -1, 64)
}

// SortedModels 返回排序后的模型名。
func (s *Spec) SortedModels() []string {
	out := make([]string, 0, len(s.Models))
	for m := range s.Models {
		out = append(out, m)
	}
	sort.Strings(out)
	return out
}

// GroupRatio 返回分组倍率，未定义的分组为 1。
func (s *Spec) GroupRatio(group string) float64 {
	if g, ok := s.Groups[group]; ok {
		return g.Ratio
	}
	return 1
}
