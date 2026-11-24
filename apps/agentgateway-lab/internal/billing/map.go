package billing

// MapLogRecord turns one gateway access-log record into a Usage. It reads the
// documented cost-tracking attributes first (agw.ai.usage.*), then falls back to
// generic access-log field names, so the pipeline keeps working when only the
// log preset changes.
func MapLogRecord(rec LogRecord, res Attrs) Usage {
	return UsageFromAttrs(Flatten(rec.Attributes), res)
}

// UsageFromAttrs is the protocol-independent half of the mapping: both the
// OTLP/HTTP JSON path and the OTLP/gRPC path funnel into it.
func UsageFromAttrs(attrs, res Attrs) Usage {
	merged := Attrs{}
	for k, v := range res {
		merged[k] = v
	}
	for k, v := range attrs {
		merged[k] = v
	}

	u := Usage{
		RequestID:    merged.First("agw.request.id", "request_id", "trace_id"),
		ClientID:     merged.First("agw.client.id", "client_id", "api_key.client_id"),
		Tenant:       merged.First("agw.tenant.id", "tenant_id", "tenant"),
		Model:        merged.First("agw.ai.model", "gen_ai.request.model", "model", "llm.model"),
		Provider:     merged.First("agw.ai.provider", "gen_ai.provider.name", "provider"),
		InputTokens:  merged.IntFirst("agw.ai.usage.input_tokens", "gen_ai.usage.input_tokens", "input_tokens"),
		OutputTokens: merged.IntFirst("agw.ai.usage.output_tokens", "gen_ai.usage.output_tokens", "output_tokens"),
		CachedTokens: merged.IntFirst(
			"agw.ai.usage.cache_read_tokens",
			"gen_ai.usage.cache_read_input_tokens",
			"gen_ai.usage.cache_read.input_tokens",
			"cached_tokens"),
	}
	if f, ok := merged.FloatFirst("agw.ai.usage.cost.total", "cost_total", "realized_cost"); ok {
		u.RealizedCostMicros = int64(f * 1_000_000)
		u.HasRealizedCost = true
	}
	if u.ClientID == "" {
		u.ClientID = merged.First("lab.client.id", "x-client-id", "api_key.client_id")
	}
	if u.Tenant == "" {
		u.Tenant = merged.First("client.tenant", "x-tenant-id")
	}
	return u
}
