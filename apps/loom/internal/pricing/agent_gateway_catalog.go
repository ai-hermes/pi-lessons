package pricing

import (
	"context"
	"fmt"
	"math"
	"strconv"
)

// AgentGatewayCatalog 是 agentgateway modelCatalog 的 catalog.json 结构：
// providers.<provider>.models.<model>.rates.{input,output,cacheRead}，单位 USD / 1M tokens（字符串）。
type AgentGatewayCatalog struct {
	Providers map[string]AgentGatewayProvider `json:"providers"`
}

// AgentGatewayProvider 一个 provider 下的模型价格。
type AgentGatewayProvider struct {
	Models map[string]AgentGatewayModel `json:"models"`
}

// AgentGatewayModel 单个模型的价格。
type AgentGatewayModel struct {
	Rates AgentGatewayRates `json:"rates"`
}

// AgentGatewayRates 绝对单价（USD / 1M tokens）。
type AgentGatewayRates struct {
	Input     string `json:"input"`
	Output    string `json:"output"`
	CacheRead string `json:"cacheRead"`
}

// RenderAgentGatewayCatalog 把 pricing.yaml 中按 token 计价的模型渲染为网关目录。
// 按次计费（model_price）与分组倍率无法在网关目录中表达，不渲染。
func RenderAgentGatewayCatalog(priceConfig *PriceConfig) AgentGatewayCatalog {
	catalog := AgentGatewayCatalog{Providers: map[string]AgentGatewayProvider{}}
	for name, m := range priceConfig.Models {
		catalog.add(priceConfig.Catalog.Provider, name, m)
	}
	return catalog
}

// AgentGatewayCatalog 渲染当前价目表（含 PG 兜底中按 token 计价的模型）。
func (t *PriceTable) AgentGatewayCatalog(ctx context.Context) (AgentGatewayCatalog, error) {
	priceConfig := t.PriceConfig()
	catalog := RenderAgentGatewayCatalog(priceConfig)
	if !t.opts.DatabaseFallbackEnabled || t.store == nil {
		return catalog, nil
	}
	rows, err := t.store.ListModelPricing(ctx)
	if err != nil {
		return AgentGatewayCatalog{}, fmt.Errorf("list model pricing: %w", err)
	}
	for _, row := range rows {
		if _, inFile := priceConfig.Models[row.Model]; inFile {
			continue
		}
		modelRate, err := modelRateFromDatabase(row)
		if err != nil {
			return AgentGatewayCatalog{}, err
		}
		catalog.add(priceConfig.Catalog.Provider, row.Model, modelRate)
	}
	return catalog, nil
}

func (c AgentGatewayCatalog) add(provider, model string, m ModelRate) {
	if m.ModelPrice != nil {
		return
	}
	p, ok := c.Providers[provider]
	if !ok {
		p = AgentGatewayProvider{Models: map[string]AgentGatewayModel{}}
		c.Providers[provider] = p
	}
	inputUSD := m.ModelRatio * 2 // ratio 1 == $2 / 1M tokens
	p.Models[model] = AgentGatewayModel{Rates: AgentGatewayRates{
		Input:     formatUSD(inputUSD),
		Output:    formatUSD(inputUSD * m.CompletionRatio),
		CacheRead: formatUSD(inputUSD * m.CacheRatio),
	}}
}

// formatUSD 消除二进制浮点噪声：0.14×2 = 0.28000000000000003 → "0.28"。
func formatUSD(v float64) string {
	return strconv.FormatFloat(math.Round(v*1e10)/1e10, 'f', -1, 64)
}
