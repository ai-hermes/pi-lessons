package admission

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/telemetry"
)

type capturedAudit struct {
	mu   sync.Mutex
	rows []store.Audit
}

func (c *capturedAudit) InsertAudit(_ context.Context, rows []store.Audit) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.rows = append(c.rows, rows...)
	return nil
}

// runAudit 在 writer 运行期间执行 feed，然后停止 writer 并返回写入的全部行。
func runAudit(t *testing.T, w *auditWriter, sink *capturedAudit, feed func()) []store.Audit {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { w.run(ctx); close(done) }()
	feed()
	cancel()
	<-done
	return sink.rows
}

func newTestAuditWriter(now func() time.Time) (*auditWriter, *capturedAudit) {
	sink := &capturedAudit{}
	w := newAuditWriter(sink, 10_000, telemetry.NewMetrics("test", "test"), slog.New(slog.DiscardHandler))
	w.now = now
	return w, sink
}

func TestAuditAggregatesUnidentifiedDenials(t *testing.T) {
	minute := time.Date(2026, 11, 27, 12, 0, 0, 0, time.UTC)
	w, sink := newTestAuditWriter(func() time.Time { return minute.Add(30 * time.Second) })
	keyID := uuid.New()

	rows := runAudit(t, w, sink, func() {
		for range 250 {
			w.record(Request{Credential: "sk-flood-0123456789", Protocol: "http"}, Verdict{Reason: ReasonUnknownKey})
		}
		for range 3 {
			w.record(Request{Protocol: "http"}, Verdict{Allowed: true, Reason: ReasonAllowed, APIKeyID: keyID})
		}
	})

	require.Len(t, rows, 4, "3 identified rows + 1 aggregated row instead of 250")
	var aggregated []store.Audit
	for _, row := range rows {
		if row.APIKeyID == nil {
			aggregated = append(aggregated, row)
		}
	}
	require.Len(t, aggregated, 1)
	assert.Equal(t, 250, aggregated[0].Count)
	assert.Equal(t, "sk-flood", aggregated[0].CredentialPreview, "only the prefix is kept")
	assert.Equal(t, minute, aggregated[0].Time, "aggregated rows are stamped with their minute")
}

func TestAuditCapsGroupsPerMinute(t *testing.T) {
	minute := time.Date(2026, 11, 27, 12, 0, 0, 0, time.UTC)
	w, sink := newTestAuditWriter(func() time.Time { return minute })

	rows := runAudit(t, w, sink, func() {
		for i := range 150 {
			w.record(Request{Credential: fmt.Sprintf("k%07d-random", i)}, Verdict{Reason: ReasonUnknownKey})
		}
	})

	assert.Len(t, rows, auditMaxGroups+1)
	var overflow int
	for _, row := range rows {
		if row.CredentialPreview == auditOverflowPreview {
			overflow = row.Count
		}
	}
	assert.Equal(t, 50, overflow, "groups beyond the cap fold into the * row")
}

func TestAuditSplitsAggregatesByMinute(t *testing.T) {
	start := time.Date(2026, 11, 27, 12, 0, 50, 0, time.UTC)
	var mu sync.Mutex
	now := start
	w, sink := newTestAuditWriter(func() time.Time { mu.Lock(); defer mu.Unlock(); return now })

	rows := runAudit(t, w, sink, func() {
		w.record(Request{}, Verdict{Reason: ReasonMissingCredential})
		mu.Lock()
		now = start.Add(20 * time.Second)
		mu.Unlock()
		w.record(Request{}, Verdict{Reason: ReasonMissingCredential})
	})

	require.Len(t, rows, 2)
	assert.Equal(t, [2]int{1, 1}, [2]int{rows[0].Count, rows[1].Count})
}
