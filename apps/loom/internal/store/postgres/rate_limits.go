package postgres

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store/sqlcgen"
)

// RPM / TPM 的分钟窗口计数（rate_counters 表）。

// AcquireRate 见 store.Store：一条自动提交的 upsert 计数后逐项比较上限，超出时逐行撤销本次计数。
// 不用显式事务：热点计数行的锁只在语句执行期间持有，不跨 BEGIN / COMMIT 的网络往返。
// 代价是被拒的请求在撤销前短暂计入，只会让临界点上并发的请求偶尔多拒，不会多放行。
func (d *DB) AcquireRate(ctx context.Context, window time.Time, claims []store.RateClaim) error {
	if len(claims) == 0 {
		return nil
	}
	subjects, scopes, tokens := rateColumns(claims)
	rows, err := d.q.IncrementRateCounters(ctx, sqlcgen.IncrementRateCountersParams{
		WindowStart: window,
		Subjects:    subjects,
		Scopes:      scopes,
		Tokens:      tokens,
	})
	if err != nil {
		return d.fail("AcquireRate", err)
	}
	counted := make(map[uuid.UUID]sqlcgen.IncrementRateCountersRow, len(rows))
	for _, row := range rows {
		counted[row.Subject] = row
	}
	for _, claim := range claims {
		row := counted[claim.Subject]
		if limited := exceeded(claim, row.Requests, row.Tokens); limited != nil {
			if err := d.ReleaseRate(context.WithoutCancel(ctx), window, claims); err != nil {
				return err
			}
			return limited
		}
	}
	return nil
}

// exceeded 计数之后是否超出 claim 的上限。
func exceeded(claim store.RateClaim, requests, tokens int64) error {
	switch {
	case claim.RPM != nil && requests > *claim.RPM:
		return &store.RateLimitError{Scope: claim.Scope, Kind: store.RateLimitRPM}
	case claim.TPM != nil && tokens > *claim.TPM:
		return &store.RateLimitError{Scope: claim.Scope, Kind: store.RateLimitTPM}
	}
	return nil
}

// ReleaseRate 见 store.Store：逐行撤销，每条语句只锁一行。
func (d *DB) ReleaseRate(ctx context.Context, window time.Time, claims []store.RateClaim) error {
	for _, claim := range claims {
		err := d.q.DecrementRateCounter(ctx, sqlcgen.DecrementRateCounterParams{
			Tokens:      claim.Tokens,
			Subject:     claim.Subject,
			WindowStart: window,
		})
		if err != nil {
			return d.fail("ReleaseRate", err)
		}
	}
	return nil
}

// AddRateTokens 见 store.Store：逐行修正；窗口还不存在且修正为正时新建。
func (d *DB) AddRateTokens(ctx context.Context, window time.Time, claims []store.RateClaim) error {
	for _, claim := range claims {
		n, err := d.q.AdjustRateTokens(ctx, sqlcgen.AdjustRateTokensParams{
			Tokens:      claim.Tokens,
			Subject:     claim.Subject,
			WindowStart: window,
		})
		if err != nil {
			return d.fail("AddRateTokens", err)
		}
		if n > 0 || claim.Tokens <= 0 {
			continue
		}
		err = d.q.InsertRateTokens(ctx, sqlcgen.InsertRateTokensParams{
			Subject:     claim.Subject,
			WindowStart: window,
			Scope:       string(claim.Scope),
			Tokens:      claim.Tokens,
		})
		if err != nil {
			return d.fail("AddRateTokens.insert", err)
		}
	}
	return nil
}

// DeleteRateWindows 见 store.Store。
func (d *DB) DeleteRateWindows(ctx context.Context, before time.Time) (int64, error) {
	n, err := d.q.DeleteRateWindows(ctx, before)
	return n, d.fail("DeleteRateWindows", err)
}

// rateColumns 把 claims 拆成 unnest 需要的并列数组。
func rateColumns(claims []store.RateClaim) (subjects []uuid.UUID, scopes []string, tokens []int64) {
	for _, claim := range claims {
		subjects = append(subjects, claim.Subject)
		scopes = append(scopes, string(claim.Scope))
		tokens = append(tokens, claim.Tokens)
	}
	return subjects, scopes, tokens
}
