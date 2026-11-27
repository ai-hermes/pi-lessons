// Package config 加载并校验 loom 配置：默认值 → config.yaml → 环境变量。
//
// 环境变量：LOOM_<节>_<键>，例如 LOOM_LOG_LEVEL=debug、LOOM_SERVER_OPS_LISTEN=:9091；
// 更深的层级用双下划线分隔，例如 LOOM_LEDGER__RESERVE_TOKENS__INPUT=512。
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

// Config 是 loom 的完整配置。
type Config struct {
	Server     Server     `koanf:"server"`
	Log        Log        `koanf:"log"`
	Store      Store      `koanf:"store"`
	Postgres   Postgres   `koanf:"postgres"`
	Migrations Migrations `koanf:"migrations"`
	Admission  Admission  `koanf:"admission"`
	ExtAuth    ExtAuth    `koanf:"extauth"`
	Pricing    Pricing    `koanf:"pricing"`
	Ledger     Ledger     `koanf:"ledger"`
	RateLimit  RateLimit  `koanf:"ratelimit"`
	OTLP       OTLP       `koanf:"otlp"`
	Admin      Admin      `koanf:"admin"`
}

// Server 监听地址。
type Server struct {
	// Listen 数据面：网关调用的 extauth（HTTP + gRPC）、ratelimit、OTLP 共用一个 h2c 端口。
	Listen string `koanf:"listen"`
	// OpsListen 运维面：管理 API、/metrics、/healthz、/readyz、pprof；不对网关开放。
	OpsListen       string        `koanf:"ops_listen"`
	ShutdownTimeout time.Duration `koanf:"shutdown_timeout"`
	// Pprof 在运维面暴露 /debug/pprof（需要 read 角色的管理 token），默认关闭。
	Pprof bool `koanf:"pprof"`
}

// Log 日志。
type Log struct {
	Level  string `koanf:"level"`  // debug | info | warn | error
	Format string `koanf:"format"` // json | text
}

// Postgres 数据库连接。
type Postgres struct {
	DSN              string        `koanf:"dsn"`
	DSNFile          string        `koanf:"dsn_file"`
	ListenDSN        string        `koanf:"listen_dsn"` // 可选：LISTEN 用的直连地址（主 DSN 经过事务模式连接池时）
	MinConns         int32         `koanf:"min_conns"`
	MaxConns         int32         `koanf:"max_conns"`
	MaxConnLifetime  time.Duration `koanf:"max_conn_lifetime"`
	StatementTimeout time.Duration `koanf:"statement_timeout"`
}

// Store 存储后端；当前只实现 postgres，新驱动须先通过 internal/store/storetest 一致性用例。
type Store struct {
	Driver string `koanf:"driver"`
}

// Migrations 数据库迁移。
type Migrations struct {
	Auto bool `koanf:"auto"` // 启动时自动执行 goose up
}

// Admission 准入。
type Admission struct {
	APIKeyCache APIKeyCache `koanf:"key_cache"`
	AuditQueue  int         `koanf:"audit_queue"`
	// Timeout 单次准入的截止时间，须小于网关 extAuth 超时（AgentGateway 默认 2s）；超时按 internal_error 拒绝。
	Timeout time.Duration `koanf:"timeout"`
}

// APIKeyCache API Key 查找缓存。
type APIKeyCache struct {
	Enabled     bool          `koanf:"enabled"`
	Size        int           `koanf:"size"`
	TTL         time.Duration `koanf:"ttl"`
	NegativeTTL time.Duration `koanf:"negative_ttl"`
}

// ExtAuth 外挂鉴权门面与网关的约定。
type ExtAuth struct {
	CredentialHeaders []string       `koanf:"credential_headers"`
	Headers           ExtAuthHeaders `koanf:"headers"`
	DenyStatus        map[string]int `koanf:"deny_status"` // 拒绝原因 → HTTP 状态码
	BodyLimit         int64          `koanf:"body_limit"`
}

// ExtAuthHeaders 请求头 / 响应头名称；需与网关策略 allowedRequestHeaders / allowedResponseHeaders 一致。
type ExtAuthHeaders struct {
	ClientRequestID string `koanf:"client_request_id"`
	Model           string `koanf:"model"`
	Account         string `koanf:"account"`
	APIKeyID        string `koanf:"key_id"`
	RequestID       string `koanf:"request_id"`
	QuotaRemaining  string `koanf:"quota_remaining"`
	DenyReason      string `koanf:"deny_reason"`
}

// Pricing 价目表。
type Pricing struct {
	File                    string        `koanf:"file"` // pricing.yaml（ConfigMap 挂载点）
	ReloadInterval          time.Duration `koanf:"reload_interval"`
	DatabaseFallbackEnabled bool          `koanf:"store_fallback"` // 查 PG model_pricing 兜底
}

// Ledger 额度账本。
type Ledger struct {
	ReserveEstimate ReserveEstimate `koanf:"reserve_tokens"`
	ReservationTTL  time.Duration   `koanf:"reservation_ttl"`
	ReaperInterval  time.Duration   `koanf:"reaper_interval"`
	ReaperBatch     int             `koanf:"reaper_batch"`
	CostSource      string          `koanf:"cost_source"` // loom | gateway_prefer
	OwnerCacheTTL   time.Duration   `koanf:"owner_cache_ttl"`
}

// ReserveEstimate 准入阶段预扣使用的 token 估值。
type ReserveEstimate struct {
	Input  int64 `koanf:"input"`
	Output int64 `koanf:"output"`
}

// RateLimit 同步结算通道（Envoy RateLimitService）。
type RateLimit struct {
	Domain string `koanf:"domain"` // 需与网关策略 rateLimit.global.domain 一致
}

// OTLP 补账通道（access log）。
type OTLP struct {
	Protocols      []string           `koanf:"protocols"`
	QueueSize      int                `koanf:"queue_size"`
	BatchSize      int                `koanf:"batch_size"`
	FlushInterval  time.Duration      `koanf:"flush_interval"`
	AttributeNames OTLPAttributeNames `koanf:"attributes"`
}

// OTLPAttributeNames access log 属性名映射。
type OTLPAttributeNames struct {
	InputTokens      string `koanf:"input_tokens"`
	OutputTokens     string `koanf:"output_tokens"`
	CachedTokens     string `koanf:"cached_tokens"`
	AgentGatewayCost string `koanf:"gateway_cost"`
	Model            string `koanf:"model"`
	LoomModel        string `koanf:"loom_model"`
	Provider         string `koanf:"provider"`
	Protocol         string `koanf:"protocol"`
	Route            string `koanf:"route"`
	AgentGateway     string `koanf:"gateway"`
	RequestID        string `koanf:"request_id"`
	APIKeyID         string `koanf:"key_id"`
	Account          string `koanf:"account"`
}

// Admin 管理 API。
type Admin struct {
	Token     string `koanf:"token"`
	TokenFile string `koanf:"token_file"`
	KeyPrefix string `koanf:"key_prefix"` // 生成 API Key 的前缀
}

// Load 按默认值 → yaml → 环境变量加载并校验；path 为空时只用默认值与环境变量。
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
	if err := k.Load(env.Provider("LOOM_", ".", envKey), nil); err != nil {
		return nil, err
	}
	var cfg Config
	if err := k.Unmarshal("", &cfg); err != nil {
		return nil, fmt.Errorf("decode config: %w", err)
	}
	return &cfg, nil
}

// envKey 把 LOOM_SECTION_KEY 映射为 section.key：首个 "_" 分隔节，"__" 表示更深一层。
func envKey(name string) string {
	key := strings.ToLower(strings.TrimPrefix(name, "LOOM_"))
	if strings.Contains(key, "__") {
		return strings.ReplaceAll(key, "__", ".")
	}
	return strings.Replace(key, "_", ".", 1)
}

func defaults() map[string]any {
	return map[string]any{
		"server": map[string]any{"listen": ":8080", "ops_listen": ":9090", "shutdown_timeout": "15s"},
		"log":    map[string]any{"level": "info", "format": "json"},
		"store":  map[string]any{"driver": "postgres"},
		"postgres": map[string]any{
			"min_conns": 2, "max_conns": 20, "max_conn_lifetime": "30m", "statement_timeout": "5s",
		},
		"migrations": map[string]any{"auto": true},
		"admission": map[string]any{
			"key_cache":   map[string]any{"enabled": true, "size": 10000, "ttl": "30s", "negative_ttl": "5s"},
			"audit_queue": 1024,
			"timeout":     "1500ms",
		},
		"extauth": map[string]any{
			"credential_headers": []string{"authorization", "x-api-key"},
			"headers": map[string]any{
				"client_request_id": "x-request-id",
				"model":             "x-loom-model",
				"account":           "x-loom-client-id",
				"key_id":            "x-loom-key-id",
				"request_id":        "x-loom-request-id",
				"quota_remaining":   "x-loom-quota-remaining",
				"deny_reason":       "x-loom-deny-reason",
			},
			"deny_status": map[string]any{
				"missing_credential": 401, "unknown_api_key": 401, "expired_api_key": 401,
				"client_inactive": 403, "model_not_allowed": 403, "model_not_priced": 403, "group_not_priced": 403,
				"insufficient_quota": 403, "internal_error": 500,
			},
			"body_limit": 1 << 20,
		},
		"pricing": map[string]any{"file": "/etc/loom/pricing.yaml", "reload_interval": "30s", "store_fallback": true},
		"ledger": map[string]any{
			"reserve_tokens":  map[string]any{"input": 1024, "output": 1024},
			"reservation_ttl": "15m", "reaper_interval": "1m", "reaper_batch": 200,
			"cost_source": "loom", "owner_cache_ttl": "60s",
		},
		"ratelimit": map[string]any{"domain": "loom-billing"},
		"otlp": map[string]any{
			"queue_size": 4096, "batch_size": 200, "flush_interval": "2s",
			"attributes": map[string]any{
				"input_tokens":  "gen_ai.usage.input_tokens",
				"output_tokens": "gen_ai.usage.output_tokens",
				"cached_tokens": "gen_ai.usage.cache_read.input_tokens",
				"gateway_cost":  "agw.ai.usage.cost.total",
				"model":         "gen_ai.request.model",
				"loom_model":    "loom.model",
				"provider":      "gen_ai.provider.name",
				"protocol":      "protocol",
				"route":         "route",
				"gateway":       "gateway",
				"request_id":    "loom.request.id",
				"key_id":        "loom.key.id",
				"account":       "loom.client.id",
			},
		},
		"admin": map[string]any{"key_prefix": "loom-"},
	}
}

func (c *Config) validate() error {
	var errs []error
	if c.Admission.Timeout <= 0 {
		errs = append(errs, errors.New("admission.timeout must be positive"))
	}
	if c.Store.Driver != "postgres" {
		errs = append(errs, fmt.Errorf("store.driver must be postgres, got %q", c.Store.Driver))
	}
	if _, err := c.Postgres.ResolveDSN(); err != nil {
		errs = append(errs, err)
	}
	if _, err := c.Admin.ResolveToken(); err != nil {
		errs = append(errs, err)
	}
	if c.Server.Listen == "" || c.Server.OpsListen == "" {
		errs = append(errs, errors.New("server.listen and server.ops_listen are required"))
	}
	if c.Pricing.File == "" {
		errs = append(errs, errors.New("pricing.file is required"))
	}
	for reason, status := range c.ExtAuth.DenyStatus {
		if status < 100 || status > 599 {
			errs = append(errs, fmt.Errorf("extauth.deny_status.%s must be between 100 and 599", reason))
		}
	}
	if c.Ledger.ReserveEstimate.Input < 0 || c.Ledger.ReserveEstimate.Output < 0 {
		errs = append(errs, errors.New("ledger.reserve_tokens must be >= 0"))
	}
	switch c.Ledger.CostSource {
	case "loom", "gateway_prefer":
	default:
		err := fmt.Errorf("ledger.cost_source must be loom or gateway_prefer, got %q", c.Ledger.CostSource)
		errs = append(errs, err)
	}
	if c.RateLimit.Domain == "" {
		errs = append(errs, errors.New("ratelimit.domain is required"))
	}
	return errors.Join(errs...)
}

// ResolveDSN 返回 PG 连接串：内联 dsn 优先，其次 dsn_file。
func (p Postgres) ResolveDSN() (string, error) {
	return inlineOrFile(p.DSN, p.DSNFile, "postgres.dsn")
}

// ResolveToken 返回管理 token：内联 token 优先，其次 token_file。
func (a Admin) ResolveToken() (string, error) {
	return inlineOrFile(a.Token, a.TokenFile, "admin.token")
}

func inlineOrFile(inline, path, name string) (string, error) {
	if inline != "" {
		return inline, nil
	}
	if path == "" {
		return "", fmt.Errorf("%s or %s_file is required", name, name)
	}
	b, err := os.ReadFile(path) //nolint:gosec // Secret-file path comes from trusted deployment configuration.
	if err != nil {
		return "", fmt.Errorf("read %s_file: %w", name, err)
	}
	v := strings.TrimSpace(string(b))
	if v == "" {
		return "", fmt.Errorf("%s_file %s is empty", name, path)
	}
	return v, nil
}
