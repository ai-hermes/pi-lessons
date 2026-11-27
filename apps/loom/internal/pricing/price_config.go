// Package pricing 实现 one-api 口径的计价：pricing.yaml（ConfigMap）为主、PG model_pricing 表兜底，
// 按 (model, group) 预计算整数单价卡 UnitPrice，供准入预扣与结算使用。
//
// 计价规则：输入单价 = model_ratio × group_ratio × $2 / 1M tokens；
// 缓存命中单价 = 输入单价 × cache_ratio；输出单价 = 输入单价 × completion_ratio；
// 设置了 model_price 的模型按次计费：单次价 = model_price × group_ratio。
//
// 倍率与单价的取值口径与 one-api / new-api 一致：未填写时取默认值，0 表示免费，负数是配置错误。
package pricing

import (
	"errors"
	"fmt"
	"os"
	"sort"

	"gopkg.in/yaml.v3"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
)

// UnknownPolicy 决定 pricing.yaml 中未定义的模型或分组如何处理。
type UnknownPolicy string

const (
	// UnknownDeny 拒绝（默认）：未定价的模型返回 ErrNotPriced，未定义的分组返回 ErrGroupNotPriced。
	UnknownDeny UnknownPolicy = "deny"
	// UnknownDefault 按默认计价：模型按 defaults 的倍率，分组按 default 分组的倍率。
	UnknownDefault UnknownPolicy = "default"
)

const (
	// DefaultGroup 是账户未指定分组时使用的分组；pricing.yaml 没写时自动补上，倍率为 DefaultGroupRatio。
	DefaultGroup = "default"
	// DefaultGroupRatio 是分组未填写倍率时使用的倍率。
	DefaultGroupRatio = 1.0
)

// ReserveEstimate 准入阶段预扣使用的 token 估值。
type ReserveEstimate struct {
	Input  int64 `yaml:"input"  json:"input"`
	Output int64 `yaml:"output" json:"output"`
}

// ModelRate 单个模型生效的计价规则；解析时已用 defaults 补齐，0 表示该项免费。
type ModelRate struct {
	ModelRatio      float64  `json:"model_ratio"`
	CompletionRatio float64  `json:"completion_ratio"`
	CacheRatio      float64  `json:"cache_ratio"`
	ModelPrice      *float64 `json:"model_price"` // USD/次；非 nil 时按次计费，0 表示免费
	// Reserve 覆盖全局预扣估值；字段为负表示沿用全局值。
	Reserve *ReserveEstimate `json:"reserve_tokens"`
}

// Group 分组：计价倍率（0 表示该分组免费）与账户级限流默认值（账户自身未配置的项取这里的值）。
type Group struct {
	Ratio  float64          `json:"ratio"`
	Limits store.RateLimits `json:"limits"`
}

// Defaults 模型未填写倍率时使用的默认值，以及未定义的模型 / 分组的处理策略。
type Defaults struct {
	ModelRatio      float64       `json:"model_ratio"`
	CompletionRatio float64       `json:"completion_ratio"`
	CacheRatio      float64       `json:"cache_ratio"`
	UnknownModel    UnknownPolicy `json:"unknown_model"`
	UnknownGroup    UnknownPolicy `json:"unknown_group"`
}

// AgentGatewayCatalogOptions 渲染 agentgateway modelCatalog 的参数。
type AgentGatewayCatalogOptions struct {
	Provider string `yaml:"provider" json:"provider"`
}

// PriceConfig 是 pricing.yaml 解析并补齐默认值后的完整结构。
type PriceConfig struct {
	Defaults Defaults                   `json:"defaults"`
	Groups   map[string]Group           `json:"groups"`
	Models   map[string]ModelRate       `json:"models"`
	Catalog  AgentGatewayCatalogOptions `json:"catalog"`
}

// LoadPriceConfig 读取并规范化 pricing.yaml。
func LoadPriceConfig(path string) (*PriceConfig, error) {
	b, err := os.ReadFile(path) //nolint:gosec // Pricing path comes from trusted deployment configuration.
	if err != nil {
		return nil, fmt.Errorf("read pricing file: %w", err)
	}
	return ParsePriceConfig(b)
}

// ParsePriceConfig 解析 pricing.yaml：未填写的倍率取默认值，0 保留为免费，负数返回错误。
func ParsePriceConfig(b []byte) (*PriceConfig, error) {
	var raw rawPriceConfig
	if err := yaml.Unmarshal(b, &raw); err != nil {
		return nil, fmt.Errorf("parse pricing yaml: %w", err)
	}

	var errs []error
	ratio := func(field string, v *float64, fallback float64) float64 {
		value, err := resolveRatio(field, v, fallback)
		errs = append(errs, err)
		return value
	}

	c := &PriceConfig{
		Defaults: Defaults{
			ModelRatio:      ratio("defaults.model_ratio", raw.Defaults.ModelRatio, 1),
			CompletionRatio: ratio("defaults.completion_ratio", raw.Defaults.CompletionRatio, 1),
			CacheRatio:      ratio("defaults.cache_ratio", raw.Defaults.CacheRatio, 1),
			UnknownModel:    resolvePolicy("defaults.unknown_model", raw.Defaults.UnknownModel, &errs),
			UnknownGroup:    resolvePolicy("defaults.unknown_group", raw.Defaults.UnknownGroup, &errs),
		},
		Groups:  make(map[string]Group, len(raw.Groups)),
		Models:  make(map[string]ModelRate, len(raw.Models)),
		Catalog: raw.Catalog,
	}

	for name, g := range raw.Groups {
		if err := g.Limits.Validate(); err != nil {
			errs = append(errs, fmt.Errorf("groups.%s.limits: %w", name, err))
		}
		c.Groups[name] = Group{
			Ratio:  ratio("groups."+name+".ratio", g.Ratio, DefaultGroupRatio),
			Limits: g.Limits,
		}
	}
	if _, ok := c.Groups[DefaultGroup]; !ok {
		c.Groups[DefaultGroup] = Group{Ratio: DefaultGroupRatio}
	}

	for name, m := range raw.Models {
		field := "models." + name
		rate := ModelRate{
			ModelRatio:      ratio(field+".model_ratio", m.ModelRatio, c.Defaults.ModelRatio),
			CompletionRatio: ratio(field+".completion_ratio", m.CompletionRatio, c.Defaults.CompletionRatio),
			CacheRatio:      ratio(field+".cache_ratio", m.CacheRatio, c.Defaults.CacheRatio),
			ModelPrice:      m.ModelPrice,
			Reserve:         m.Reserve,
		}
		if m.ModelPrice != nil && *m.ModelPrice < 0 {
			errs = append(errs, fmt.Errorf("%s.model_price must be >= 0, got %v", field, *m.ModelPrice))
		}
		c.Models[name] = rate
	}

	if c.Catalog.Provider == "" {
		c.Catalog.Provider = "openai"
	}
	if err := errors.Join(errs...); err != nil {
		return nil, fmt.Errorf("invalid pricing: %w", err)
	}
	return c, nil
}

// SortedModelNames 返回排序后的模型名。
func (c *PriceConfig) SortedModelNames() []string {
	names := make([]string, 0, len(c.Models))
	for name := range c.Models {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// HasGroup 判断分组是否在 groups 中定义（default 分组总是存在）。
func (c *PriceConfig) HasGroup(group string) bool {
	_, ok := c.Groups[group]
	return ok
}

// ValidateGroup 检查账户可以使用该分组：已定义，或 unknown_group 为 default。
func (c *PriceConfig) ValidateGroup(group string) error {
	if c.HasGroup(group) || c.Defaults.UnknownGroup == UnknownDefault {
		return nil
	}
	return fmt.Errorf("%w: %q is not defined in pricing.yaml groups", ErrGroupNotPriced, group)
}

// GroupRatio 返回分组倍率；未定义的分组按 default 分组计价（是否允许由调用方按 ValidateGroup 判断）。
func (c *PriceConfig) GroupRatio(group string) float64 {
	if g, ok := c.Groups[group]; ok {
		return g.Ratio
	}
	return c.Groups[DefaultGroup].Ratio
}

// GroupLimits 返回分组的账户级限流默认值；未定义的分组取 default 分组的值。
func (c *PriceConfig) GroupLimits(group string) store.RateLimits {
	if g, ok := c.Groups[group]; ok {
		return g.Limits
	}
	return c.Groups[DefaultGroup].Limits
}

// defaultModelRate 返回 unknown_model: default 时使用的计价规则。
func (c *PriceConfig) defaultModelRate() ModelRate {
	return ModelRate{
		ModelRatio:      c.Defaults.ModelRatio,
		CompletionRatio: c.Defaults.CompletionRatio,
		CacheRatio:      c.Defaults.CacheRatio,
	}
}

// resolveRatio 区分“未填写”与“填了 0”：nil 取 fallback，0 保留（免费），负数报错。
func resolveRatio(field string, v *float64, fallback float64) (float64, error) {
	switch {
	case v == nil:
		return fallback, nil
	case *v < 0:
		return fallback, fmt.Errorf("%s must be >= 0, got %v", field, *v)
	default:
		return *v, nil
	}
}

// resolvePolicy 未填写时取 deny；只接受 deny / default。
func resolvePolicy(field string, v UnknownPolicy, errs *[]error) UnknownPolicy {
	switch v {
	case "":
		return UnknownDeny
	case UnknownDeny, UnknownDefault:
		return v
	default:
		*errs = append(*errs, fmt.Errorf("%s must be deny or default, got %q", field, v))
		return UnknownDeny
	}
}

// ---- pricing.yaml 原始结构：指针用于区分“未填写”与“0” ----

type rawPriceConfig struct {
	Defaults rawDefaults                `yaml:"defaults"`
	Groups   map[string]rawGroup        `yaml:"groups"`
	Models   map[string]rawModelRate    `yaml:"models"`
	Catalog  AgentGatewayCatalogOptions `yaml:"catalog"`
}

type rawDefaults struct {
	ModelRatio      *float64      `yaml:"model_ratio"`
	CompletionRatio *float64      `yaml:"completion_ratio"`
	CacheRatio      *float64      `yaml:"cache_ratio"`
	UnknownModel    UnknownPolicy `yaml:"unknown_model"`
	UnknownGroup    UnknownPolicy `yaml:"unknown_group"`
}

type rawGroup struct {
	Ratio  *float64         `yaml:"ratio"`
	Limits store.RateLimits `yaml:"limits"`
}

type rawModelRate struct {
	ModelRatio      *float64         `yaml:"model_ratio"`
	CompletionRatio *float64         `yaml:"completion_ratio"`
	CacheRatio      *float64         `yaml:"cache_ratio"`
	ModelPrice      *float64         `yaml:"model_price"`
	Reserve         *ReserveEstimate `yaml:"reserve_tokens"`
}
