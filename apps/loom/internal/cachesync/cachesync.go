// Package cachesync 在多副本之间同步缓存失效：本副本立即清理，再经广播通知其他副本清理。
//
// 广播由存储层实现（PostgreSQL 用 LISTEN / NOTIFY）。广播是尽力而为的：发送失败或订阅断线期间，
// 其他副本退回各自缓存的 TTL。
package cachesync

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/telemetry"
)

// Kind 是失效对象的类型。
type Kind string

// 失效对象类型取值。
const (
	KindAPIKey     Kind = "api_key"
	KindAccount    Kind = "account"
	KindModelPrice Kind = "model_price"
)

// Event 是一条失效消息；Origin 是发送方实例 ID，用于忽略自己发出的消息。
type Event struct {
	Kind   Kind   `json:"kind"`
	ID     string `json:"id"`
	Origin string `json:"origin"`
}

// Broadcast 是存储层提供的广播能力。
type Broadcast interface {
	PublishInvalidation(ctx context.Context, payload string) error
	// ListenInvalidations 阻塞接收消息，直到 ctx 结束或连接出错。
	ListenInvalidations(ctx context.Context, handle func(payload string)) error
}

// Caches 是本副本内可清理的缓存；字段可以为空（如 seed 命令没有任何缓存，只负责广播）。
type Caches struct {
	APIKey     []func(apiKeyID uuid.UUID)
	Account    []func(accountID uuid.UUID)
	ModelPrice []func(model string)
}

const (
	publishTimeout   = 2 * time.Second
	minRetryInterval = time.Second
	maxRetryInterval = 30 * time.Second
)

// Syncer 清理本副本缓存并广播失效消息，同时订阅其他副本的消息。
type Syncer struct {
	broadcast Broadcast
	caches    Caches
	origin    string
	metrics   *telemetry.Metrics
	log       *slog.Logger
}

// New 创建 Syncer；每个进程生成唯一的实例 ID。
func New(broadcast Broadcast, caches Caches, metrics *telemetry.Metrics, log *slog.Logger) *Syncer {
	return &Syncer{
		broadcast: broadcast,
		caches:    caches,
		origin:    uuid.NewString(),
		metrics:   metrics,
		log:       log,
	}
}

// InvalidateAPIKey 清理某把 API Key 的缓存。
func (s *Syncer) InvalidateAPIKey(ctx context.Context, apiKeyID uuid.UUID) {
	s.invalidate(ctx, Event{Kind: KindAPIKey, ID: apiKeyID.String()})
}

// InvalidateAccount 清理某账户及其 API Key 的缓存。
func (s *Syncer) InvalidateAccount(ctx context.Context, accountID uuid.UUID) {
	s.invalidate(ctx, Event{Kind: KindAccount, ID: accountID.String()})
}

// InvalidateModelPrice 清理某模型的兜底定价缓存；model 为空时清空全部。
func (s *Syncer) InvalidateModelPrice(ctx context.Context, model string) {
	s.invalidate(ctx, Event{Kind: KindModelPrice, ID: model})
}

func (s *Syncer) invalidate(ctx context.Context, ev Event) {
	s.apply(ev, "local")

	ev.Origin = s.origin
	payload, _ := json.Marshal(ev)
	publishCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), publishTimeout)
	defer cancel()
	if err := s.broadcast.PublishInvalidation(publishCtx, string(payload)); err != nil {
		s.log.Warn(
			"publish cache invalidation failed; other replicas fall back to cache TTL",
			"err", err,
			"kind", ev.Kind,
			"id", ev.ID,
		)
	}
}

// Run 订阅其他副本的失效消息，断线后按指数退避重连，阻塞直到 ctx 结束。
func (s *Syncer) Run(ctx context.Context) {
	retry := minRetryInterval
	for ctx.Err() == nil {
		started := time.Now()
		err := s.broadcast.ListenInvalidations(ctx, s.receive)
		if ctx.Err() != nil {
			return
		}
		if time.Since(started) > maxRetryInterval {
			retry = minRetryInterval // 上一次连接持续了足够长时间，视为恢复正常
		}
		s.metrics.CacheSyncReconnects.Inc()
		s.log.Warn("cache invalidation listener disconnected; retrying", "err", err, "retry_in", retry)
		select {
		case <-ctx.Done():
			return
		case <-time.After(retry):
		}
		retry = min(retry*2, maxRetryInterval)
	}
}

func (s *Syncer) receive(payload string) {
	var ev Event
	if err := json.Unmarshal([]byte(payload), &ev); err != nil {
		s.log.Warn("ignore malformed cache invalidation", "err", err)
		return
	}
	if ev.Origin == s.origin {
		return
	}
	s.apply(ev, "remote")
}

// apply 清理本副本缓存；origin 为 local（本副本发起）或 remote（来自其他副本）。
func (s *Syncer) apply(ev Event, origin string) {
	switch ev.Kind {
	case KindAPIKey, KindAccount:
		id, err := uuid.Parse(ev.ID)
		if err != nil {
			s.log.Warn("ignore cache invalidation with invalid id", "kind", ev.Kind, "id", ev.ID)
			return
		}
		targets := s.caches.APIKey
		if ev.Kind == KindAccount {
			targets = s.caches.Account
		}
		for _, invalidate := range targets {
			invalidate(id)
		}
	case KindModelPrice:
		for _, invalidate := range s.caches.ModelPrice {
			invalidate(ev.ID)
		}
	default:
		s.log.Warn("ignore cache invalidation of unknown kind", "kind", ev.Kind)
		return
	}
	s.metrics.CacheInvalidations.WithLabelValues(string(ev.Kind), origin).Inc()
}
