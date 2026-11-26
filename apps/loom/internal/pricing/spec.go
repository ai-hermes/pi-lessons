// Package pricing 实现 one-api 口径的计价：pricing.yaml（ConfigMap）为主、PG model_pricing 表兜底，
// 按 (model, group) 预计算整数单价卡 Card，供准入预扣与结算使用。
//
// 计价规则：输入单价 = model_ratio × group_ratio × $2 / 1M tokens；
// 缓存命中单价 = 输入单价 × cache_ratio；输出单价 = 输入单价 × completion_ratio；
// 设置了 model_price 的模型按次计费：单次价 = model_price × group_ratio。
package pricing

import (
	"fmt"
	"os"
	"sort"

	"gopkg.in/yaml.v3"
)

// UnknownModelPolicy 决定未定价模型的处理方式。
type UnknownModelPolicy string

const (
	// UnknownModelDeny 拒绝未定价模型（默认）。
	UnknownModelDeny UnknownModelPolicy = "deny"
	// UnknownModelDefault 按 defaults 计价。
	UnknownModelDefault UnknownModelPolicy = "default"
)

// ReserveTokens 准入阶段预扣使用的 token 估值。
type ReserveTokens struct {
	Input  int64 `yaml:"input"  json:"input"`
	Output int64 `yaml:"output" json:"output"`
}

// ModelSpec 单个模型的计价配置。
type ModelSpec struct {
	ModelRatio      float64  `yaml:"model_ratio"      json:"model_ratio"`
	CompletionRatio float64  `yaml:"completion_ratio" json:"completion_ratio"`
	CacheRatio      float64  `yaml:"cache_ratio"      json:"cache_ratio"`
	ModelPrice      *float64 `yaml:"model_price"      json:"model_price"` // USD/次；设置后按次计费
	// ReserveTokens 覆盖全局预扣估值；字段为负表示沿用全局值。
	ReserveTokens *ReserveTokens `yaml:"reserve_tokens"   json:"reserve_tokens"`
}

// GroupSpec 分组倍率。
type GroupSpec struct {
	Ratio float64 `yaml:"ratio" json:"ratio"`
}

// Defaults 模型未指定字段时的默认值。
type Defaults struct {
	ModelRatio      float64            `yaml:"model_ratio"      json:"model_ratio"`
	CompletionRatio float64            `yaml:"completion_ratio" json:"completion_ratio"`
	CacheRatio      float64            `yaml:"cache_ratio"      json:"cache_ratio"`
	UnknownModel    UnknownModelPolicy `yaml:"unknown_model"    json:"unknown_model"`
}

// GatewayCatalogOptions 渲染 agentgateway modelCatalog 的参数。
type GatewayCatalogOptions struct {
	Provider string `yaml:"provider" json:"provider"`
}

// Spec 是 pricing.yaml 的完整结构。
type Spec struct {
	Defaults Defaults              `yaml:"defaults" json:"defaults"`
	Groups   map[string]GroupSpec  `yaml:"groups"   json:"groups"`
	Models   map[string]ModelSpec  `yaml:"models"   json:"models"`
	Catalog  GatewayCatalogOptions `yaml:"catalog"  json:"catalog"`
}

// LoadSpec 读取并规范化 pricing.yaml。
func LoadSpec(path string) (*Spec, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read pricing file: %w", err)
	}
	return ParseSpec(b)
}

// ParseSpec 解析 pricing.yaml 并填充默认值。
func ParseSpec(b []byte) (*Spec, error) {
	var s Spec
	if err := yaml.Unmarshal(b, &s); err != nil {
		return nil, fmt.Errorf("parse pricing yaml: %w", err)
	}
	s.Defaults.ModelRatio = positiveOr(s.Defaults.ModelRatio, 1)
	s.Defaults.CompletionRatio = positiveOr(s.Defaults.CompletionRatio, 1)
	s.Defaults.CacheRatio = positiveOr(s.Defaults.CacheRatio, 1)

	switch s.Defaults.UnknownModel {
	case "":
		s.Defaults.UnknownModel = UnknownModelDeny
	case UnknownModelDeny, UnknownModelDefault:
	default:
		return nil, fmt.Errorf("defaults.unknown_model must be deny or default, got %q", s.Defaults.UnknownModel)
	}

	if len(s.Groups) == 0 {
		s.Groups = map[string]GroupSpec{"default": {Ratio: 1}}
	}
	for name, g := range s.Groups {
		s.Groups[name] = GroupSpec{Ratio: positiveOr(g.Ratio, 1)}
	}
	if s.Models == nil {
		s.Models = map[string]ModelSpec{}
	}
	if s.Catalog.Provider == "" {
		s.Catalog.Provider = "openai"
	}
	return &s, nil
}

// SortedModels 返回排序后的模型名。
func (s *Spec) SortedModels() []string {
	names := make([]string, 0, len(s.Models))
	for name := range s.Models {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// GroupRatio 返回分组倍率；未定义的分组为 1。
func (s *Spec) GroupRatio(group string) float64 {
	if g, ok := s.Groups[group]; ok {
		return g.Ratio
	}
	return 1
}

// withDefaults 用 Defaults 补齐模型未填写的倍率。
func (m ModelSpec) withDefaults(d Defaults) ModelSpec {
	m.ModelRatio = positiveOr(m.ModelRatio, d.ModelRatio)
	m.CompletionRatio = positiveOr(m.CompletionRatio, d.CompletionRatio)
	m.CacheRatio = positiveOr(m.CacheRatio, d.CacheRatio)
	return m
}

func positiveOr(v, fallback float64) float64 {
	if v > 0 {
		return v
	}
	return fallback
}
