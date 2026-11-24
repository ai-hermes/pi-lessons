package billing

import (
	"encoding/json"
	"strconv"
	"strings"
)

// ExportLogsServiceRequest / ExportMetricsServiceRequest are the OTLP/HTTP JSON
// shapes emitted by an OpenTelemetry Collector (`otlphttp` exporter with
// `encoding: json`). Only the parts the billing pipeline needs are decoded; the
// full protobuf schema is intentionally not vendored.
type ExportLogsServiceRequest struct {
	ResourceLogs []ResourceLog `json:"resourceLogs"`
}

type ResourceLog struct {
	Resource  Resource   `json:"resource"`
	ScopeLogs []ScopeLog `json:"scopeLogs"`
}

type Resource struct {
	Attributes []KeyValue `json:"attributes"`
}

type ScopeLog struct {
	LogRecords []LogRecord `json:"logRecords"`
}

type LogRecord struct {
	TimeUnixNano string     `json:"timeUnixNano"`
	Body         AnyValue   `json:"body"`
	Attributes   []KeyValue `json:"attributes"`
}

type AnyValue struct {
	StringValue *string  `json:"stringValue"`
	IntValue    *string  `json:"intValue"`
	DoubleValue *float64 `json:"doubleValue"`
	BoolValue   *bool    `json:"boolValue"`
}

type KeyValue struct {
	Key   string   `json:"key"`
	Value AnyValue `json:"value"`
}

func (v AnyValue) String() string {
	switch {
	case v.StringValue != nil:
		return *v.StringValue
	case v.IntValue != nil:
		return *v.IntValue
	case v.DoubleValue != nil:
		return strconv.FormatFloat(*v.DoubleValue, 'f', -1, 64)
	case v.BoolValue != nil:
		return strconv.FormatBool(*v.BoolValue)
	}
	return ""
}

func (v AnyValue) Int() int64 {
	if v.IntValue != nil {
		if i, err := strconv.ParseInt(*v.IntValue, 10, 64); err == nil {
			return i
		}
	}
	if v.DoubleValue != nil {
		return int64(*v.DoubleValue)
	}
	if v.StringValue != nil {
		if i, err := strconv.ParseInt(*v.StringValue, 10, 64); err == nil {
			return i
		}
	}
	return 0
}

// Attrs is a flattened view over a set of OTLP attributes. Attribute names are
// matched case-insensitively because the gateway emits both
// `agw.ai.usage.cost.total` and shorter access-log presets.
type Attrs map[string]string

func Flatten(kvs []KeyValue) Attrs {
	out := Attrs{}
	for _, kv := range kvs {
		out[strings.ToLower(kv.Key)] = kv.Value.String()
	}
	return out
}

// First returns the first non-empty value among the provided keys.
func (a Attrs) First(keys ...string) string {
	for _, k := range keys {
		if v, ok := a[strings.ToLower(k)]; ok && v != "" {
			return v
		}
	}
	return ""
}

func (a Attrs) IntFirst(keys ...string) int64 {
	if v := a.First(keys...); v != "" {
		if i, err := strconv.ParseInt(v, 10, 64); err == nil {
			return i
		}
	}
	return 0
}

func (a Attrs) FloatFirst(keys ...string) (float64, bool) {
	if v := a.First(keys...); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return f, true
		}
	}
	return 0, false
}

// ParseLogs decodes an OTLP/HTTP JSON logs payload.
func ParseLogs(body []byte) (*ExportLogsServiceRequest, error) {
	var req ExportLogsServiceRequest
	if err := json.Unmarshal(body, &req); err != nil {
		return nil, err
	}
	return &req, nil
}

func itoa(v int64) string { return formatInt(v) }
func ftoa(v float64) string {
	return strconv.FormatFloat(v, 'f', -1, 64)
}

func formatInt(v int64) string { return strconv.FormatInt(v, 10) }
