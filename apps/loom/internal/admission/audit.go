package admission

import (
	"context"
	"log/slog"
	"time"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/telemetry"
)

const (
	auditBatchSize     = 200
	auditFlushInterval = time.Second
	auditWriteTimeout  = 5 * time.Second

	// 未识别出 Key 的拒绝按分钟聚合；每分钟最多保留这么多组，其余并入凭据前缀为 * 的溢出组，
	// 无效 Key 洪水因此最多放大为每分钟 auditMaxGroups+1 行。
	auditAggregateWindow = time.Minute
	auditMaxGroups       = 100
	auditPreviewLen      = 8
	auditOverflowPreview = "*"
)

type auditInserter interface {
	InsertAudit(ctx context.Context, rows []store.Audit) error
}

// auditEntry 是进入写入队列的一条审计；aggregate 为 true 时按分钟聚合后再写。
type auditEntry struct {
	row       store.Audit
	aggregate bool
}

// auditGroup 聚合行的分组键。
type auditGroup struct {
	window            time.Time
	reason            string
	credentialPreview string
	protocol          string
}

// auditWriter 异步批量写入准入审计；队列满时丢弃，绝不阻塞准入路径。
type auditWriter struct {
	store   auditInserter
	queue   chan auditEntry
	metrics *telemetry.Metrics
	log     *slog.Logger
	now     func() time.Time
}

func newAuditWriter(st auditInserter, queueSize int, metrics *telemetry.Metrics, log *slog.Logger) *auditWriter {
	w := &auditWriter{
		store:   st,
		metrics: metrics,
		log:     log,
		now:     time.Now,
	}
	if queueSize > 0 {
		w.queue = make(chan auditEntry, queueSize)
	}
	return w
}

func (w *auditWriter) record(req Request, v Verdict) {
	if w.queue == nil {
		return
	}
	entry := auditEntry{row: store.Audit{
		Time:            w.now(),
		RequestID:       v.RequestID,
		ClientRequestID: req.ClientRequestID,
		Protocol:        req.Protocol,
		Model:           v.Model,
		Allowed:         v.Allowed,
		Reason:          string(v.Reason),
		Count:           1,
	}}
	if v.hasKey() {
		entry.row.APIKeyID = new(v.APIKeyID)
		entry.row.AccountID = new(v.AccountID)
	} else if !v.Allowed {
		// 未识别出 Key 的拒绝没有归属可查，逐条记录只会把无效 Key 洪水原样放大成写入
		entry.aggregate = true
		entry.row.CredentialPreview = credentialPreview(req.Credential)
	}
	select {
	case w.queue <- entry:
	default:
		w.log.Warn("audit queue full, dropping row", "request_id", v.RequestID)
	}
}

// credentialPreview 取凭据前缀，足以辨认来源，又不暴露完整凭据。
func credentialPreview(credential string) string {
	if len(credential) > auditPreviewLen {
		return credential[:auditPreviewLen]
	}
	return credential
}

// run 批量刷写；ctx 结束后把队列与未满一分钟的聚合组全部写完再返回。
func (w *auditWriter) run(ctx context.Context) {
	if w.queue == nil {
		<-ctx.Done()
		return
	}
	ticker := time.NewTicker(auditFlushInterval)
	defer ticker.Stop()
	batch := make([]store.Audit, 0, auditBatchSize)
	groups := map[auditGroup]*store.Audit{}
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
	// closeWindows 把窗口已结束（或全部，all 为 true 时）的聚合组移入批次
	closeWindows := func(all bool) {
		current := w.now().Truncate(auditAggregateWindow)
		for group, row := range groups {
			if all || group.window.Before(current) {
				batch = append(batch, *row)
				delete(groups, group)
			}
		}
	}
	accept := func(entry auditEntry) {
		if entry.aggregate {
			w.aggregate(groups, entry.row)
			return
		}
		batch = append(batch, entry.row)
		if len(batch) >= auditBatchSize {
			flush()
		}
	}
	for {
		select {
		case <-ctx.Done():
			for drained := false; !drained; {
				select {
				case entry := <-w.queue:
					accept(entry)
				default:
					drained = true
				}
			}
			closeWindows(true)
			flush()
			return
		case entry := <-w.queue:
			accept(entry)
		case <-ticker.C:
			closeWindows(false)
			flush()
		}
	}
}

// aggregate 把一条未识别出 Key 的拒绝并入所在分钟的分组；分组数达到上限后并入溢出组。
func (w *auditWriter) aggregate(groups map[auditGroup]*store.Audit, row store.Audit) {
	w.metrics.AuditAggregated.Inc()
	window := row.Time.Truncate(auditAggregateWindow)
	group := auditGroup{
		window:            window,
		reason:            row.Reason,
		credentialPreview: row.CredentialPreview,
		protocol:          row.Protocol,
	}
	if _, exists := groups[group]; !exists && len(groups) >= auditMaxGroups {
		group.credentialPreview = auditOverflowPreview
	}
	if existing, ok := groups[group]; ok {
		existing.Count++
		return
	}
	groups[group] = &store.Audit{
		Time:              window,
		Protocol:          row.Protocol,
		Allowed:           false,
		Reason:            row.Reason,
		CredentialPreview: group.credentialPreview,
		Count:             1,
	}
}
