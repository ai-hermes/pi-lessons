package admission

import (
	"context"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
)

const (
	auditBatchSize     = 200
	auditFlushInterval = time.Second
	auditWriteTimeout  = 5 * time.Second
)

type auditInserter interface {
	InsertAudit(ctx context.Context, rows []store.Audit) error
}

// auditWriter 异步批量写入准入审计；队列满时丢弃，绝不阻塞准入路径。
type auditWriter struct {
	store auditInserter
	queue chan store.Audit
	log   *slog.Logger
}

func newAuditWriter(st auditInserter, queueSize int, log *slog.Logger) *auditWriter {
	w := &auditWriter{store: st, log: log}
	if queueSize > 0 {
		w.queue = make(chan store.Audit, queueSize)
	}
	return w
}

func (w *auditWriter) record(req Request, v Verdict) {
	if w.queue == nil {
		return
	}
	row := store.Audit{
		Time:            time.Now(),
		RequestID:       v.RequestID,
		ClientRequestID: req.ClientRequestID,
		Protocol:        req.Protocol,
		Model:           v.Model,
		Allowed:         v.Allowed,
		Reason:          string(v.Reason),
	}
	if v.hasKey() {
		row.KeyID = ptr(v.KeyID)
		row.AccountID = ptr(v.AccountID)
	}
	select {
	case w.queue <- row:
	default:
		w.log.Warn("audit queue full, dropping row", "request_id", v.RequestID)
	}
}

// run 批量刷写；ctx 结束后把队列中剩余记录写完再返回。
func (w *auditWriter) run(ctx context.Context) {
	if w.queue == nil {
		<-ctx.Done()
		return
	}
	ticker := time.NewTicker(auditFlushInterval)
	defer ticker.Stop()
	batch := make([]store.Audit, 0, auditBatchSize)
	flush := func() {
		if len(batch) == 0 {
			return
		}
		writeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), auditWriteTimeout)
		defer cancel()
		if err := w.store.InsertAudit(writeCtx, batch); err != nil {
			w.log.Warn("audit insert failed", "err", err, "rows", len(batch))
		}
		batch = batch[:0]
	}
	for {
		select {
		case <-ctx.Done():
			for drained := false; !drained; {
				select {
				case row := <-w.queue:
					batch = append(batch, row)
				default:
					drained = true
				}
			}
			flush()
			return
		case row := <-w.queue:
			batch = append(batch, row)
			if len(batch) >= auditBatchSize {
				flush()
			}
		case <-ticker.C:
			flush()
		}
	}
}

func ptr(id uuid.UUID) *uuid.UUID { return &id }
