package cachesync

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/telemetry"
)

// memoryBroadcast 模拟 PG LISTEN / NOTIFY：发布的消息投递给所有订阅者（包括发布者自己）。
type memoryBroadcast struct {
	mu          sync.Mutex
	subscribers []chan string
	publishErr  error
}

func (b *memoryBroadcast) PublishInvalidation(_ context.Context, payload string) error {
	if b.publishErr != nil {
		return b.publishErr
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, ch := range b.subscribers {
		ch <- payload
	}
	return nil
}

func (b *memoryBroadcast) ListenInvalidations(ctx context.Context, handle func(string)) error {
	ch := make(chan string, 16)
	b.mu.Lock()
	b.subscribers = append(b.subscribers, ch)
	b.mu.Unlock()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case payload := <-ch:
			handle(payload)
		}
	}
}

func (b *memoryBroadcast) subscriberCount() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.subscribers)
}

// replica 是一个副本的本地缓存，记录被清理的对象。
type replica struct {
	mu       sync.Mutex
	apiKeys  []uuid.UUID
	accounts []uuid.UUID
	models   []string
	syncer   *Syncer
	metrics  *telemetry.Metrics
}

func newReplica(broadcast Broadcast) *replica {
	r := &replica{metrics: telemetry.NewMetrics("test", "test")}
	caches := Caches{
		APIKey:     []func(uuid.UUID){func(id uuid.UUID) { r.record(&r.apiKeys, id) }},
		Account:    []func(uuid.UUID){func(id uuid.UUID) { r.record(&r.accounts, id) }},
		ModelPrice: []func(string){func(model string) { r.mu.Lock(); r.models = append(r.models, model); r.mu.Unlock() }},
	}
	r.syncer = New(broadcast, caches, r.metrics, slog.New(slog.DiscardHandler))
	return r
}

func (r *replica) record(target *[]uuid.UUID, id uuid.UUID) {
	r.mu.Lock()
	defer r.mu.Unlock()
	*target = append(*target, id)
}

func (r *replica) accountCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.accounts)
}

func startReplicas(t *testing.T, broadcast *memoryBroadcast, n int) []*replica {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	replicas := make([]*replica, n)
	for i := range replicas {
		replicas[i] = newReplica(broadcast)
		go replicas[i].syncer.Run(ctx)
	}
	require.Eventually(t, func() bool { return broadcast.subscriberCount() == n }, time.Second, 10*time.Millisecond)
	return replicas
}

func TestInvalidationReachesOtherReplicasOnce(t *testing.T) {
	broadcast := &memoryBroadcast{}
	replicas := startReplicas(t, broadcast, 2)
	accountID := uuid.New()

	replicas[0].syncer.InvalidateAccount(context.Background(), accountID)

	require.Eventually(t, func() bool { return replicas[1].accountCount() == 1 }, time.Second, 10*time.Millisecond)
	time.Sleep(50 * time.Millisecond) // 给自己发出的消息留出到达时间
	assert.Equal(t, 1, replicas[0].accountCount(), "the publisher applies locally and ignores its own broadcast")
	assert.InDelta(t, 1, testutil.ToFloat64(replicas[0].metrics.CacheInvalidations.WithLabelValues("account", "local")), 0)
	assert.InDelta(t, 1, testutil.ToFloat64(replicas[1].metrics.CacheInvalidations.WithLabelValues("account", "remote")), 0)
}

func TestModelPriceAndAPIKeyInvalidations(t *testing.T) {
	broadcast := &memoryBroadcast{}
	replicas := startReplicas(t, broadcast, 2)
	apiKeyID := uuid.New()

	replicas[0].syncer.InvalidateAPIKey(context.Background(), apiKeyID)
	replicas[0].syncer.InvalidateModelPrice(context.Background(), "pg-model")

	require.Eventually(t, func() bool {
		replicas[1].mu.Lock()
		defer replicas[1].mu.Unlock()
		return len(replicas[1].apiKeys) == 1 && len(replicas[1].models) == 1
	}, time.Second, 10*time.Millisecond)
	assert.Equal(t, apiKeyID, replicas[1].apiKeys[0])
	assert.Equal(t, "pg-model", replicas[1].models[0])
}

func TestPublishFailureStillInvalidatesLocally(t *testing.T) {
	r := newReplica(&memoryBroadcast{publishErr: errors.New("pg down")})

	r.syncer.InvalidateAccount(context.Background(), uuid.New())

	assert.Equal(t, 1, r.accountCount())
}

func TestMalformedAndUnknownMessagesAreIgnored(t *testing.T) {
	r := newReplica(&memoryBroadcast{})

	r.syncer.receive("not json")
	r.syncer.receive(`{"kind":"account","id":"not-a-uuid","origin":"other"}`)
	r.syncer.receive(`{"kind":"unknown","id":"x","origin":"other"}`)

	assert.Zero(t, r.accountCount())
}
