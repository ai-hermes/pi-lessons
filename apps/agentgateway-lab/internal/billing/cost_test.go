package billing

import (
	"testing"
)

func TestCostFromCatalog(t *testing.T) {
	price := Price{Model: "lab-model", InputMicrosPerTok: 3, OutputMicrosPerTok: 12, CacheReadMicrosPerTok: 1}
	cases := []struct {
		name string
		u    Usage
		want int64
	}{
		{"no tokens", Usage{}, 0},
		{"input only", Usage{InputTokens: 1000}, 3000},
		{"output only", Usage{OutputTokens: 1000}, 12000},
		{"cached input discounts", Usage{InputTokens: 1000, CachedTokens: 800, OutputTokens: 10}, 200*3 + 800*1 + 10*12},
		{"cached above input is clamped", Usage{InputTokens: 100, CachedTokens: 500}, 100},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := CostFromCatalog(tc.u, price); got != tc.want {
				t.Fatalf("cost = %d, want %d", got, tc.want)
			}
		})
	}
}

func TestTotalCostPrefersGatewayValue(t *testing.T) {
	u := Usage{InputTokens: 10, OutputTokens: 10, RealizedCostMicros: 42, HasRealizedCost: true}
	price := &Price{InputMicrosPerTok: 100, OutputMicrosPerTok: 100}
	if got := TotalCost(u, price); got != 42 {
		t.Fatalf("cost = %d, want gateway value 42", got)
	}
	if got := TotalCost(Usage{InputTokens: 10}, nil); got != 0 {
		t.Fatalf("unknown model must cost 0, got %d", got)
	}
}

func TestMapLogRecord(t *testing.T) {
	res := Flatten([]KeyValue{
		{Key: "agw.tenant.id", Value: AnyValue{StringValue: ptr("tenant-a")}},
	})
	rec := LogRecord{
		Attributes: []KeyValue{
			{Key: "agw.client.id", Value: AnyValue{StringValue: ptr("alice")}},
			{Key: "agw.ai.model", Value: AnyValue{StringValue: ptr("lab-model")}},
			{Key: "agw.ai.usage.input_tokens", Value: AnyValue{IntValue: ptr("1200")}},
			{Key: "agw.ai.usage.output_tokens", Value: AnyValue{IntValue: ptr("300")}},
			{Key: "agw.ai.usage.cache_read_tokens", Value: AnyValue{IntValue: ptr("400")}},
			{Key: "agw.ai.usage.cost.total", Value: AnyValue{DoubleValue: ptrF(0.0042)}},
		},
	}
	u := MapLogRecord(rec, res)
	if u.ClientID != "alice" || u.Tenant != "tenant-a" || u.Model != "lab-model" {
		t.Fatalf("identity mapping wrong: %+v", u)
	}
	if u.InputTokens != 1200 || u.OutputTokens != 300 || u.CachedTokens != 400 {
		t.Fatalf("token mapping wrong: %+v", u)
	}
	if !u.HasRealizedCost || u.RealizedCostMicros != 4200 {
		t.Fatalf("cost mapping wrong: %+v", u)
	}
}

func TestUsageFromMetrics(t *testing.T) {
	res := Resource{Attributes: []KeyValue{
		{Key: "client_id", Value: AnyValue{StringValue: ptr("alice")}},
		{Key: "gen_ai.request.model", Value: AnyValue{StringValue: ptr("lab-model")}},
	}}
	inPoint := NumberDataPoint{AsInt: ptr("1000"), Attributes: []KeyValue{
		{Key: "gen_ai.token.type", Value: AnyValue{StringValue: ptr("input")}},
	}}
	outPoint := NumberDataPoint{AsInt: ptr("250"), Attributes: []KeyValue{
		{Key: "gen_ai.token.type", Value: AnyValue{StringValue: ptr("output")}},
	}}
	sum := &Sum{DataPoints: []NumberDataPoint{inPoint, outPoint}}
	scope := ScopeMetric{Metrics: []Metric{{Name: "gen_ai.client.token.usage", Sum: sum}}}
	req := &ExportMetricsServiceRequest{ResourceMetrics: []ResourceMetric{
		{Resource: res, ScopeMetrics: []ScopeMetric{scope}},
	}}

	usages := UsageFromMetrics(req)
	if len(usages) != 2 {
		t.Fatalf("usages = %d, want 2", len(usages))
	}
	if usages[0].InputTokens != 1000 || usages[0].ClientID != "alice" || usages[0].Model != "lab-model" {
		t.Fatalf("input point wrong: %+v", usages[0])
	}
	if usages[1].OutputTokens != 250 {
		t.Fatalf("output point wrong: %+v", usages[1])
	}
}

func ptr[T any](v T) *T       { return &v }
func ptrF(v float64) *float64 { return &v }
