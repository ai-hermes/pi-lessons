package billing

// Price is the catalog entry for one model, expressed in micro-USD (1e-6 USD)
// per token. Micros keep every intermediate value an integer, so chargeback
// totals never drift through float rounding.
type Price struct {
	Model                 string
	InputMicrosPerTok     int64
	OutputMicrosPerTok    int64
	CacheReadMicrosPerTok int64
}

// Usage is one normalized LLM call, independent of the telemetry protocol it
// arrived through (access log over OTLP, OTLP metrics, or a simulator).
type Usage struct {
	RequestID    string
	ClientID     string
	Tenant       string
	Model        string
	Provider     string
	InputTokens  int64
	OutputTokens int64
	CachedTokens int64
	// RealizedCostMicros is set when the telemetry already carries a
	// gateway-computed cost (agw.ai.usage.cost.total); otherwise it is derived
	// from the catalog.
	RealizedCostMicros int64
	HasRealizedCost    bool
}

// CostFromCatalog computes realized cost for a usage record. Cached input
// tokens are billed at the cache-read rate and are part of InputTokens (this is
// how OpenAI-compatible providers report them).
func CostFromCatalog(u Usage, p Price) int64 {
	cached := u.CachedTokens
	if cached > u.InputTokens {
		cached = u.InputTokens
	}
	uncached := u.InputTokens - cached
	cost := uncached*p.InputMicrosPerTok + cached*p.CacheReadMicrosPerTok + u.OutputTokens*p.OutputMicrosPerTok
	return cost
}

// TotalCost returns the realized cost, preferring the gateway-provided value so
// chargeback matches what the gateway already reported to its own metrics.
func TotalCost(u Usage, p *Price) int64 {
	if u.HasRealizedCost {
		return u.RealizedCostMicros
	}
	if p == nil {
		return 0
	}
	return CostFromCatalog(u, *p)
}
