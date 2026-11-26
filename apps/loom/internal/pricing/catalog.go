package pricing

import (
	"context"
	"fmt"
	"math"
	"strconv"
)

// GatewayCatalog 是 agentgateway modelCatalog 的 catalog.json 结构：
// providers.<provider>.models.<model>.rates.{input,output,cacheRead}，单位 USD / 1M tokens（字符串）。
type GatewayCatalog struct {
	Providers map[string]GatewayProvider `json:"providers"`
}

// GatewayProvider 一个 provider 下的模型价格。
type GatewayProvider struct {
	Models map[string]GatewayModel `json:"models"`
}

// GatewayModel 单个模型的价格。
type GatewayModel struct {
	Rates GatewayRates `json:"rates"`
}

// GatewayRates 绝对单价（USD / 1M tokens）。
type GatewayRates struct {
	Input     string `json:"input"`
	Output    string `json:"output"`
	CacheRead string `json:"cacheRead"`
}

// RenderGatewayCatalog 把 pricing.yaml 中按 token 计价的模型渲染为网关目录。
// 按次计费（model_price）与分组倍率无法在网关目录中表达，不渲染。
func RenderGatewayCatalog(spec *Spec) GatewayCatalog {
	catalog := GatewayCatalog{Providers: map[string]GatewayProvider{}}
	for name, m := range spec.Models {
		catalog.add(spec.Catalog.Provider, name, m.withDefaults(spec.Defaults))
	}
	return catalog
}

// GatewayCatalog 渲染当前价目表（含 PG 兜底中按 token 计价的模型）。
func (t *Table) GatewayCatalog(ctx context.Context) (GatewayCatalog, error) {
	spec := t.Spec()
	catalog := RenderGatewayCatalog(spec)
	if !t.opts.StoreFallback || t.store == nil {
		return catalog, nil
	}
	rows, err := t.store.ListModelPricing(ctx)
	if err != nil {
		return GatewayCatalog{}, fmt.Errorf("list model pricing: %w", err)
	}
	for _, row := range rows {
		if _, inFile := spec.Models[row.Model]; inFile {
			continue
		}
		catalog.add(spec.Catalog.Provider, row.Model, modelSpecFromStore(row).withDefaults(spec.Defaults))
	}
	return catalog, nil
}

func (c GatewayCatalog) add(provider, model string, m ModelSpec) {
	if m.ModelPrice != nil {
		return
	}
	p, ok := c.Providers[provider]
	if !ok {
		p = GatewayProvider{Models: map[string]GatewayModel{}}
		c.Providers[provider] = p
	}
	inputUSD := m.ModelRatio * 2 // ratio 1 == $2 / 1M tokens
	p.Models[model] = GatewayModel{Rates: GatewayRates{
		Input:     formatUSD(inputUSD),
		Output:    formatUSD(inputUSD * m.CompletionRatio),
		CacheRead: formatUSD(inputUSD * m.CacheRatio),
	}}
}

// formatUSD 消除二进制浮点噪声：0.14×2 = 0.28000000000000003 → "0.28"。
func formatUSD(v float64) string {
	return strconv.FormatFloat(math.Round(v*1e10)/1e10, 'f', -1, 64)
}
