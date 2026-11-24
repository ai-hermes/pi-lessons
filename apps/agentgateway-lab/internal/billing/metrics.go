package billing

import "encoding/json"

// Minimal OTLP/HTTP JSON metrics shape, limited to the counters FinOps needs:
// gen_ai.client.token.usage sums carrying token-type attributes.
type ExportMetricsServiceRequest struct {
	ResourceMetrics []ResourceMetric `json:"resourceMetrics"`
}

type ResourceMetric struct {
	Resource     Resource      `json:"resource"`
	ScopeMetrics []ScopeMetric `json:"scopeMetrics"`
}

type ScopeMetric struct {
	Metrics []Metric `json:"metrics"`
}

type Metric struct {
	Name string `json:"name"`
	Sum  *Sum   `json:"sum"`
}

type Sum struct {
	DataPoints []NumberDataPoint `json:"dataPoints"`
}

type NumberDataPoint struct {
	TimeUnixNano string     `json:"timeUnixNano"`
	AsInt        *string    `json:"asInt"`
	AsDouble     *float64   `json:"asDouble"`
	Attributes   []KeyValue `json:"attributes"`
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

func (p NumberDataPoint) Value() int64 {
	if p.AsInt != nil {
		var i int64
		for _, c := range *p.AsInt {
			if c < '0' || c > '9' {
				break
			}
			i = i*10 + int64(c-'0')
		}
		return i
	}
	if p.AsDouble != nil {
		return int64(*p.AsDouble)
	}
	return 0
}

// ParseMetrics decodes an OTLP/HTTP JSON metrics payload.
func ParseMetrics(body []byte) (*ExportMetricsServiceRequest, error) {
	var req ExportMetricsServiceRequest
	if err := json.Unmarshal(body, &req); err != nil {
		return nil, err
	}
	return &req, nil
}

// UsageFromMetrics converts token-usage counters into Usage rows. Each data
// point is one (client, model, token-type) counter, so we fold input/output
// points into a single usage record keyed by request id when present.
func UsageFromMetrics(req *ExportMetricsServiceRequest) []Usage {
	out := make([]Usage, 0, len(req.ResourceMetrics))
	for _, rm := range req.ResourceMetrics {
		res := Flatten(rm.Resource.Attributes)
		for _, sm := range rm.ScopeMetrics {
			for _, m := range sm.Metrics {
				if m.Sum == nil {
					continue
				}
				switch m.Name {
				case "gen_ai.client.token.usage", "agw.ai.usage.tokens":
					for _, dp := range m.Sum.DataPoints {
						a := Flatten(dp.Attributes)
						u := Usage{
							RequestID:    a.First("agw.request.id", "request_id"),
							ClientID:     a.First("agw.client.id", "client_id", "api_key.client_id"),
							Tenant:       a.First("agw.tenant.id", "tenant_id"),
							Model:        firstNonEmpty(a.First("gen_ai.request.model", "agw.ai.model", "model"), res.First("gen_ai.request.model", "agw.ai.model", "model")),
							Provider:     a.First("gen_ai.provider.name", "agw.ai.provider"),
							InputTokens:  res.IntFirst("agw.ai.usage.input_tokens"),
							OutputTokens: res.IntFirst("agw.ai.usage.output_tokens"),
						}
						if u.ClientID == "" {
							u.ClientID = res.First("client_id")
						}
						switch a.First("gen_ai.token.type", "token_type") {
						case "input", "prompt":
							u.InputTokens = dp.Value()
						case "output", "completion":
							u.OutputTokens = dp.Value()
						}
						u.CachedTokens = a.IntFirst("gen_ai.usage.cache_read_input_tokens", "cached_tokens")
						out = append(out, u)
					}
				}
			}
		}
	}
	return out
}
