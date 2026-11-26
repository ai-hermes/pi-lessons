// Package config 负责加载与校验 loom 配置：默认值 → config.yaml → 环境变量覆盖。
package config

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/knadh/koanf/parsers/yaml"
	"github.com/knadh/koanf/providers/confmap"
	"github.com/knadh/koanf/providers/env"
	"github.com/knadh/koanf/providers/file"
	"github.com/knadh/koanf/v2"
)

// Config 是 loom 的完整配置模型。
type Config struct {
	Server     Server     `koanf:"server"`
	Log        Log        `koanf:"log"`
	Postgres   Postgres   `koanf:"postgres"`
	Migrations Migrations `koanf:"migrations"`
	Auth       Auth       `koanf:"auth"`
	Pricing    Pricing    `koanf:"pricing"`
	Quota      Quota      `koanf:"quota"`
	Billing    Billing    `koanf:"billing"`
	Telemetry  Telemetry  `koanf:"telemetry"`
	Admin      Admin      `koanf:"admin"`
}

type Server struct {
	ExtAuthHTTPAddr string        `koanf:"extauth_http_addr"`
	ExtAuthGRPCAddr string        `koanf:"extauth_grpc_addr"`
	AdminAddr       string        `koanf:"admin_addr"`
	OTLPGRPCAddr    string        `koanf:"otlp_grpc_addr"`
	MetricsAddr     string        `koanf:"metrics_addr"`
	ShutdownTimeout time.Duration `koanf:"shutdown_timeout"`
}

type Log struct {
	Level  string `koanf:"level"`
	Format string `koanf:"format"`
}

type Postgres struct {
	DSN                string        `koanf:"dsn"`
	DSNFile            string        `koanf:"dsn_file"`
	MinConns           int32         `koanf:"min_conns"`
	MaxConns           int32         `koanf:"max_conns"`
	MaxConnLifetime    time.Duration `koanf:"max_conn_lifetime"`
	StatementTimeout   time.Duration `koanf:"statement_timeout"`
	MigrateConcurrency int           `koanf:"migrate_concurrency"`
}

type Migrations struct {
	Auto bool `koanf:"auto"`
}

type Auth struct {
	HeaderSources   []string   `koanf:"header_sources"`
	Cache           CacheCfg   `koanf:"cache"`
	IdentityHeaders Identity   `koanf:"identity_headers"`
	DenyStatus      DenyStatus `koanf:"deny_status"`
	AuditQueue      int        `koanf:"audit_queue"`
	BodyLimit       int64      `koanf:"body_limit"`
	ReserveDisabled bool       `koanf:"reserve_disabled"`
}

type CacheCfg struct {
	Enabled     bool          `koanf:"enabled"`
	TTL         time.Duration `koanf:"ttl"`
	NegativeTTL time.Duration `koanf:"negative_ttl"`
	Size        int           `koanf:"size"`
	PricingTTL  time.Duration `koanf:"pricing_ttl"`
	AccountTTL  time.Duration `koanf:"account_ttl"`
}

type Identity struct {
	ClientID       string `koanf:"client_id"`
	KeyID          string `koanf:"key_id"`
	RequestID      string `koanf:"request_id"`
	QuotaRemaining string `koanf:"quota_remaining"`
	DenyReason     string `koanf:"deny_reason"`
}

type DenyStatus struct {
	UnknownKey    int `koanf:"unknown_key"`
	Inactive      int `koanf:"inactive"`
	Quota         int `koanf:"quota"`
	NotPriced     int `koanf:"not_priced"`
	NotAllowed    int `koanf:"not_allowed"`
	InternalError int `koanf:"internal_error"`
}

type Pricing struct {
	ConfigMapPath   string        `koanf:"configmap_path"`
	ReloadInterval  time.Duration `koanf:"reload_interval"`
	PGFallback      bool          `koanf:"pg_fallback"`
	AccountCacheTTL time.Duration `koanf:"account_cache_ttl"`
}

type Quota struct {
	ReserveTokens   ReserveTokens `koanf:"reserve_tokens"`
	ReservationTTL  time.Duration `koanf:"reservation_ttl"`
	ReaperInterval  time.Duration `koanf:"reaper_interval"`
	ReaperBatch     int           `koanf:"reaper_batch"`
	ReleaseOnExpire bool          `koanf:"release_on_expire"`
}

type ReserveTokens struct {
	Input  int64 `koanf:"input"`
	Output int64 `koanf:"output"`
}

type Billing struct {
	CostSource    string        `koanf:"cost_source"`
	RequireLoomID bool          `koanf:"require_loom_request_id"`
	Protocols     []string      `koanf:"protocols"`
	QueueSize     int           `koanf:"queue_size"`
	BatchSize     int           `koanf:"batch_size"`
	FlushInterval time.Duration `koanf:"flush_interval"`
	Attributes    AttributeMap  `koanf:"attributes"`
}

type AttributeMap struct {
	InputTokens  string `koanf:"input_tokens"`
	OutputTokens string `koanf:"output_tokens"`
	CachedTokens string `koanf:"cached_tokens"`
	GatewayCost  string `koanf:"gateway_cost"`
	Model        string `koanf:"model"`
	Provider     string `koanf:"provider"`
	RequestID    string `koanf:"request_id"`
	ClientID     string `koanf:"client_id"`
	KeyID        string `koanf:"key_id"`
	Route        string `koanf:"route"`
	Gateway      string `koanf:"gateway"`
	TraceID      string `koanf:"trace_id"`
	SpanID       string `koanf:"span_id"`
	Duration     string `koanf:"duration"`
}

type Telemetry struct {
	Metrics Metrics `koanf:"metrics"`
}

type Metrics struct {
	Enabled bool `koanf:"enabled"`
}

type Admin struct {
	Token            string `koanf:"token"`
	TokenFile        string `koanf:"token_file"`
	DefaultKeyPrefix string `koanf:"default_key_prefix"`
}

// ResolveDSN 返回最终 PG 连接串：内联 dsn 优先，其次 dsn_file。
func (p Postgres) ResolveDSN() (string, error) {
	if p.DSN != "" {
		return p.DSN, nil
	}
	if p.DSNFile != "" {
		b, err := os.ReadFile(p.DSNFile)
		if err != nil {
			return "", fmt.Errorf("read postgres.dsn_file: %w", err)
		}
		s := strings.TrimSpace(string(b))
		if s == "" {
			return "", errors.New("postgres.dsn_file is empty")
		}
		return s, nil
	}
	return "", errors.New("postgres.dsn or postgres.dsn_file is required")
}

// AdminToken 返回管理 token：内联优先，其次 token_file。
func (a Admin) AdminToken() (string, error) {
	if a.Token != "" {
		return a.Token, nil
	}
	if a.TokenFile != "" {
		b, err := os.ReadFile(a.TokenFile)
		if err != nil {
			return "", fmt.Errorf("read admin.token_file: %w", err)
		}
		return strings.TrimSpace(string(b)), nil
	}
	return "", errors.New("admin.token or admin.token_file is required")
}

// Load 按默认值 → yaml → 环境变量顺序加载并校验。
func Load(path string) (*Config, error) {
	cfg, err := load(path)
	if err != nil {
		return nil, err
	}
	if err := cfg.validate(); err != nil {
		return nil, err
	}
	return cfg, nil
}

// LoadDefaults 只加载默认值与环境变量，不做必填校验（测试与文档用）。
func LoadDefaults() (*Config, error) { return load("") }

func load(path string) (*Config, error) {
	k := koanf.New(".")
	if err := k.Load(confmap.Provider(defaults(), "."), nil); err != nil {
		return nil, err
	}
	if path != "" {
		if err := k.Load(file.Provider(path), yaml.Parser()); err != nil {
			return nil, fmt.Errorf("load config %s: %w", path, err)
		}
	}
	if err := k.Load(env.Provider("LOOM_", ".", envMapping), nil); err != nil {
		return nil, err
	}
	var cfg Config
	if err := k.Unmarshal("", &cfg); err != nil {
		return nil, fmt.Errorf("decode config: %w", err)
	}
	return &cfg, nil
}

func envMapping(s string) string {
	switch s {
	case "LOOM_POSTGRES_DSN":
		return "postgres.dsn"
	case "LOOM_ADMIN_TOKEN":
		return "admin.token"
	default:
		return strings.ToLower(strings.ReplaceAll(strings.TrimPrefix(s, "LOOM_"), "_", "."))
	}
}

func defaults() map[string]any {
	return map[string]any{
		"server": map[string]any{
			"extauth_http_addr": ":9001", "extauth_grpc_addr": ":9002",
			"admin_addr": ":9100", "otlp_grpc_addr": ":9101", "metrics_addr": ":9102",
			"shutdown_timeout": "15s",
		},
		"log":        map[string]any{"level": "info", "format": "json"},
		"postgres":   map[string]any{"min_conns": 2, "max_conns": 20, "max_conn_lifetime": "30m", "statement_timeout": "5s"},
		"migrations": map[string]any{"auto": true},
		"auth": map[string]any{
			"header_sources": []string{"authorization", "x-api-key"},
			"cache":          map[string]any{"enabled": true, "ttl": "30s", "negative_ttl": "5s", "size": 10000, "pricing_ttl": "30s", "account_ttl": "60s"},
			"identity_headers": map[string]any{
				"client_id": "x-loom-client-id", "key_id": "x-loom-key-id", "request_id": "x-loom-request-id",
				"quota_remaining": "x-loom-quota-remaining", "deny_reason": "x-loom-deny-reason",
			},
			"deny_status":      map[string]any{"unknown_key": 401, "inactive": 403, "quota": 403, "not_priced": 403, "not_allowed": 403, "internal_error": 500},
			"audit_queue":      1024,
			"body_limit":       1 << 20,
			"reserve_disabled": false,
		},
		"pricing": map[string]any{"configmap_path": "/etc/loom/pricing.yaml", "reload_interval": "30s", "pg_fallback": true},
		"quota": map[string]any{
			"reserve_tokens":  map[string]any{"input": 1024, "output": 1024},
			"reservation_ttl": "15m", "reaper_interval": "1m", "reaper_batch": 200,
		},
		"billing": map[string]any{
			"cost_source": "loom", "queue_size": 4096, "batch_size": 200, "flush_interval": "2s",
			"attributes": map[string]any{
				"input_tokens": "gen_ai.usage.input_tokens", "output_tokens": "gen_ai.usage.output_tokens",
				"cached_tokens": "gen_ai.usage.cache_read.input_tokens", "gateway_cost": "agw.ai.usage.cost.total",
				"model": "gen_ai.request.model", "provider": "gen_ai.provider.name",
				"request_id": "loom.request.id", "client_id": "loom.client.id", "key_id": "loom.key.id",
			},
		},
		"telemetry": map[string]any{"metrics": map[string]any{"enabled": true}},
		"admin":     map[string]any{"default_key_prefix": "loom-"},
	}
}

func (c *Config) validate() error {
	if _, err := c.Postgres.ResolveDSN(); err != nil {
		return err
	}
	if _, err := c.Admin.AdminToken(); err != nil {
		return err
	}
	if c.Pricing.ConfigMapPath == "" {
		return errors.New("pricing.configmap_path is required")
	}
	if c.Quota.ReserveTokens.Input < 0 || c.Quota.ReserveTokens.Output < 0 {
		return errors.New("quota.reserve_tokens must be >= 0")
	}
	if c.Billing.QueueSize <= 0 || c.Billing.BatchSize <= 0 || c.Billing.FlushInterval <= 0 {
		return errors.New("billing queue_size/batch_size/flush_interval must be positive")
	}
	switch c.Billing.CostSource {
	case "loom", "gateway_prefer":
	default:
		return errors.New("billing.cost_source must be loom or gateway_prefer")
	}
	return nil
}
