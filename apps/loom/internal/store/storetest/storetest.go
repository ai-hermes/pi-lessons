// Package storetest 是 store.Store 的一致性测试：所有实现（memstore、postgres，以及以后的 MySQL）必须通过同一套用例。
//
// 用例只断言自己创建的数据，可以在已有数据的数据库上运行；名称都带随机后缀，避免互相冲突。
package storetest

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
)

// Run 对 newStore 返回的实现执行全部一致性用例；每个用例调用一次 newStore。
func Run(t *testing.T, newStore func(t *testing.T) store.Store) {
	t.Helper()
	cases := []struct {
		name string
		run  func(t *testing.T, s store.Store)
	}{
		{"accounts", testAccounts},
		{"api keys", testAPIKeys},
		{"reserve respects the limit", testReserveRespectsLimit},
		{"reserve rejects inactive key and account", testReserveRejectsInactive},
		{"two-level reserve is all or nothing", testReserveQuotaIsAtomic},
		{"release reservation by request id is idempotent", testReleaseReservation},
		{"rate limit settings round trip", testRateLimitSettings},
		{"concurrency limits count open reservations", testConcurrencyLimits},
		{"quota reset keeps both levels consistent", testQuotaResetKeepsLevelsConsistent},
		{"rate counters are shared and all or nothing", testRateCounters},
		{"settle replaces reservation and is idempotent", testSettleIsIdempotent},
		{"settle without reservation charges directly", testSettleWithoutReservation},
		{"release expired reservations", testReleaseExpired},
		{"usage listing, summary and pricing snapshot", testUsage},
		{"admission audit", testAdmissionAudit},
		{"fallback model pricing", testModelPricing},
		{"quota adjustments", testQuotaAdjustments},
		{"admin tokens", testAdminTokens},
		{"admin audit", testAdminAudit},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) { c.run(t, newStore(t)) })
	}
}

var ctx = context.Background()

func unique(prefix string) string { return prefix + "-" + uuid.NewString()[:8] }

func newAccount(t *testing.T, s store.Store, limit *int64) store.Account {
	t.Helper()
	account, err := s.CreateAccount(ctx, store.Account{
		ID:         uuid.New(),
		Name:       unique("account"),
		Group:      "default",
		Status:     store.StatusActive,
		QuotaLimit: limit,
	})
	require.NoError(t, err)
	return account
}

func newAPIKey(t *testing.T, s store.Store, accountID uuid.UUID, limit *int64) store.APIKey {
	t.Helper()
	plaintext := unique("key")
	apiKey, err := s.CreateAPIKey(ctx, store.APIKey{
		ID:         uuid.New(),
		AccountID:  accountID,
		Name:       unique("name"),
		KeyHash:    store.HashAPIKey(plaintext),
		KeyPreview: plaintext[:8],
		Status:     store.StatusActive,
		QuotaLimit: limit,
	})
	require.NoError(t, err)
	return apiKey
}

func quotaOf(
	t *testing.T,
	s store.Store,
	apiKeyID uuid.UUID,
) (keyUsed, keyReserved, accountUsed, accountReserved int64) {
	t.Helper()
	apiKey, err := s.GetAPIKey(ctx, apiKeyID)
	require.NoError(t, err)
	account, err := s.GetAccount(ctx, apiKey.AccountID)
	require.NoError(t, err)
	return apiKey.QuotaUsed, apiKey.Reserved, account.QuotaUsed, account.Reserved
}

func testAccounts(t *testing.T, s store.Store) {
	account := newAccount(t, s, new(int64(100)))

	byName, err := s.GetAccountByName(ctx, account.Name)
	require.NoError(t, err)
	assert.Equal(t, account.ID, byName.ID)
	assert.Equal(t, int64(100), *byName.QuotaLimit)

	_, err = s.CreateAccount(ctx, store.Account{ID: uuid.New(), Name: account.Name, Group: "default"})
	require.ErrorIs(t, err, store.ErrConflict)

	updated, err := s.UpdateAccount(ctx, account.ID, store.AccountSettings{Status: store.StatusDisabled, Group: "vip"})
	require.NoError(t, err)
	assert.Equal(t, store.StatusDisabled, updated.Status)
	assert.Equal(t, "vip", updated.Group)
	assert.Nil(t, updated.QuotaLimit, "settings replace the quota limit as a whole")

	_, err = s.GetAccount(ctx, uuid.New())
	require.ErrorIs(t, err, store.ErrNotFound)
}

func testAPIKeys(t *testing.T, s store.Store) {
	account := newAccount(t, s, nil)
	apiKey := newAPIKey(t, s, account.ID, new(int64(50)))

	byHash, err := s.GetAPIKeyByHash(ctx, apiKey.KeyHash)
	require.NoError(t, err)
	assert.Equal(t, apiKey.ID, byHash.ID)
	assert.Equal(t, account.Name, byHash.Account.Name, "API keys carry an account snapshot")
	assert.Equal(t, "default", byHash.Account.Group)

	listed, err := s.ListAPIKeys(ctx, &account.ID, 10)
	require.NoError(t, err)
	require.Len(t, listed, 1)

	_, err = s.CreateAPIKey(ctx, store.APIKey{
		ID:        uuid.New(),
		AccountID: account.ID,
		Name:      unique("dup"),
		KeyHash:   apiKey.KeyHash,
		Status:    store.StatusActive,
	})
	require.ErrorIs(t, err, store.ErrConflict)

	settings := byHash.Settings()
	settings.ModelAllowlist = []string{"m1", "m2"}
	updated, err := s.UpdateAPIKey(ctx, apiKey.ID, settings)
	require.NoError(t, err)
	assert.Equal(t, []string{"m1", "m2"}, updated.ModelAllowlist)
	assert.True(t, updated.AllowsModel("m2"))
	assert.False(t, updated.AllowsModel("m3"))

	_, err = s.GetAPIKeyByHash(ctx, store.HashAPIKey("missing"))
	require.ErrorIs(t, err, store.ErrNotFound)
}

// tryReserve 以 nanos 预扣一次（不限并发），返回请求号与错误。
func tryReserve(s store.Store, apiKey store.APIKey, nanos int64) (string, store.QuotaReservation, error) {
	requestID := unique("req")
	reserved, err := s.ReserveQuota(ctx, store.Reservation{
		RequestID: requestID,
		APIKeyID:  apiKey.ID,
		AccountID: apiKey.AccountID,
		Model:     "m",
		Nanos:     nanos,
		ExpiresAt: time.Now().Add(time.Hour),
	}, store.ConcurrencyLimits{})
	return requestID, reserved, err
}

func testReserveRespectsLimit(t *testing.T, s store.Store) {
	account := newAccount(t, s, new(int64(1000)))
	apiKey := newAPIKey(t, s, account.ID, new(int64(100)))

	first, reserved, err := tryReserve(s, apiKey, 60)
	require.NoError(t, err)
	remaining, bounded := reserved.APIKey.Remaining()
	assert.True(t, bounded)
	assert.Equal(t, int64(40), remaining)

	_, _, err = tryReserve(s, apiKey, 60)
	require.ErrorIs(t, err, store.ErrInsufficientQuota)

	_, err = s.ReleaseReservation(ctx, first)
	require.NoError(t, err)
	_, _, err = tryReserve(s, apiKey, 100)
	require.NoError(t, err, "released quota is available again")

	other := newAPIKey(t, s, account.ID, nil)
	_, _, err = tryReserve(s, other, 901)
	require.ErrorIs(t, err, store.ErrInsufficientQuota, "the account has 900 left")
	_, _, err = tryReserve(s, other, 900)
	require.NoError(t, err)

	unlimited := newAPIKey(t, s, newAccount(t, s, nil).ID, nil)
	_, reserved, err = tryReserve(s, unlimited, 1<<40)
	require.NoError(t, err)
	_, bounded = reserved.Account.Remaining()
	assert.False(t, bounded)
}

func testReserveRejectsInactive(t *testing.T, s store.Store) {
	account := newAccount(t, s, nil)
	disabled := newAPIKey(t, s, account.ID, nil)
	settings := disabled.Settings()
	settings.Status = store.StatusDisabled
	_, err := s.UpdateAPIKey(ctx, disabled.ID, settings)
	require.NoError(t, err)
	_, _, err = tryReserve(s, disabled, 1)
	require.ErrorIs(t, err, store.ErrInsufficientQuota)

	expired := newAPIKey(t, s, account.ID, nil)
	settings = expired.Settings()
	settings.ExpiresAt = new(time.Now().Add(-time.Minute))
	_, err = s.UpdateAPIKey(ctx, expired.ID, settings)
	require.NoError(t, err)
	_, _, err = tryReserve(s, expired, 1)
	require.ErrorIs(t, err, store.ErrInsufficientQuota)

	active := newAPIKey(t, s, account.ID, nil)
	_, err = s.UpdateAccount(ctx, account.ID, store.AccountSettings{Status: store.StatusDisabled, Group: "default"})
	require.NoError(t, err)
	_, _, err = tryReserve(s, active, 0)
	require.ErrorIs(t, err, store.ErrInsufficientQuota, "a disabled account admits not even free requests")

	_, _, err = tryReserve(s, store.APIKey{ID: uuid.New(), AccountID: account.ID}, 1)
	require.ErrorIs(t, err, store.ErrInsufficientQuota, "an unknown key reserves nothing")
}

func testReserveQuotaIsAtomic(t *testing.T, s store.Store) {
	account := newAccount(t, s, new(int64(100)))
	apiKey := newAPIKey(t, s, account.ID, new(int64(1000)))
	reservation := func(nanos int64) store.Reservation {
		return store.Reservation{
			RequestID: unique("req"),
			APIKeyID:  apiKey.ID,
			AccountID: account.ID,
			Model:     "m",
			Nanos:     nanos,
			ExpiresAt: time.Now().Add(time.Hour),
		}
	}

	ok := reservation(60)
	reserved, err := s.ReserveQuota(ctx, ok, store.ConcurrencyLimits{})
	require.NoError(t, err)
	assert.Equal(t, int64(60), reserved.APIKey.Reserved)
	assert.Equal(t, int64(60), reserved.Account.Reserved)
	_, err = s.GetReservation(ctx, ok.RequestID)
	require.NoError(t, err)

	tooMuchForAccount := reservation(60) // API Key 还剩 940，账户只剩 40
	_, err = s.ReserveQuota(ctx, tooMuchForAccount, store.ConcurrencyLimits{})
	require.ErrorIs(t, err, store.ErrInsufficientQuota)
	_, keyReserved, _, accountReserved := quotaOf(t, s, apiKey.ID)
	assert.Equal(t, [2]int64{60, 60}, [2]int64{keyReserved, accountReserved}, "the api key part is rolled back too")
	_, err = s.GetReservation(ctx, tooMuchForAccount.RequestID)
	require.ErrorIs(t, err, store.ErrNotFound)

	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	_, err = s.ReserveQuota(cancelled, reservation(10), store.ConcurrencyLimits{})
	require.Error(t, err)
	_, keyReserved, _, accountReserved = quotaOf(t, s, apiKey.ID)
	assert.Equal(t, [2]int64{60, 60}, [2]int64{keyReserved, accountReserved}, "a cancelled reserve changes nothing")
}

func testReleaseReservation(t *testing.T, s store.Store) {
	account := newAccount(t, s, new(int64(1000)))
	apiKey := newAPIKey(t, s, account.ID, new(int64(1000)))
	r := store.Reservation{
		RequestID: unique("req"),
		APIKeyID:  apiKey.ID,
		AccountID: account.ID,
		Model:     "m",
		Nanos:     70,
		ExpiresAt: time.Now().Add(time.Hour),
	}
	_, err := s.ReserveQuota(ctx, r, store.ConcurrencyLimits{})
	require.NoError(t, err)

	released, err := s.ReleaseReservation(ctx, r.RequestID)
	require.NoError(t, err)
	assert.True(t, released)
	_, keyReserved, _, accountReserved := quotaOf(t, s, apiKey.ID)
	assert.Equal(t, [2]int64{0, 0}, [2]int64{keyReserved, accountReserved})

	released, err = s.ReleaseReservation(ctx, r.RequestID)
	require.NoError(t, err)
	assert.False(t, released, "a second release finds nothing")
	_, keyReserved, _, accountReserved = quotaOf(t, s, apiKey.ID)
	assert.Equal(t, [2]int64{0, 0}, [2]int64{keyReserved, accountReserved}, "and changes nothing")
}

func reserveFor(t *testing.T, s store.Store, apiKey store.APIKey, nanos int64, expiresAt time.Time) string {
	t.Helper()
	requestID := unique("req")
	_, err := s.ReserveQuota(ctx, store.Reservation{
		RequestID: requestID,
		APIKeyID:  apiKey.ID,
		AccountID: apiKey.AccountID,
		Model:     "m",
		Nanos:     nanos,
		ExpiresAt: expiresAt,
	}, store.ConcurrencyLimits{})
	require.NoError(t, err)
	return requestID
}

func usageEvent(apiKey store.APIKey, requestID string, cost int64) store.UsageEvent {
	return store.UsageEvent{
		Time:          time.Now(),
		RequestID:     requestID,
		AccountID:     &apiKey.AccountID,
		APIKeyID:      &apiKey.ID,
		Model:         "m",
		InputTokens:   10,
		OutputTokens:  5,
		CostNanos:     cost,
		PricingSource: "configmap",
	}
}

func testSettleIsIdempotent(t *testing.T, s store.Store) {
	account := newAccount(t, s, new(int64(1000)))
	apiKey := newAPIKey(t, s, account.ID, new(int64(1000)))
	requestID := reserveFor(t, s, apiKey, 300, time.Now().Add(time.Hour))

	inserted, err := s.SettleUsage(ctx, usageEvent(apiKey, requestID, 120))
	require.NoError(t, err)
	assert.True(t, inserted)
	keyUsed, keyReserved, accountUsed, accountReserved := quotaOf(t, s, apiKey.ID)
	assert.Equal(t, [4]int64{120, 0, 120, 0}, [4]int64{keyUsed, keyReserved, accountUsed, accountReserved},
		"the reservation is replaced by the actual cost")
	_, err = s.GetReservation(ctx, requestID)
	require.ErrorIs(t, err, store.ErrNotFound)

	inserted, err = s.SettleUsage(ctx, usageEvent(apiKey, requestID, 120))
	require.NoError(t, err)
	assert.False(t, inserted, "a request is settled only once")
	keyUsed, _, accountUsed, _ = quotaOf(t, s, apiKey.ID)
	assert.Equal(t, [2]int64{120, 120}, [2]int64{keyUsed, accountUsed})

	updated, err := s.BackfillAgentGatewayCost(ctx, requestID, 99)
	require.NoError(t, err)
	assert.True(t, updated)
	updated, err = s.BackfillAgentGatewayCost(ctx, requestID, 98)
	require.NoError(t, err)
	assert.False(t, updated, "only an empty gateway cost is backfilled")
}

func testSettleWithoutReservation(t *testing.T, s store.Store) {
	account := newAccount(t, s, nil)
	apiKey := newAPIKey(t, s, account.ID, nil)

	inserted, err := s.SettleUsage(ctx, usageEvent(apiKey, unique("req"), 70))
	require.NoError(t, err)
	assert.True(t, inserted)

	keyUsed, keyReserved, accountUsed, accountReserved := quotaOf(t, s, apiKey.ID)
	assert.Equal(t, [4]int64{70, 0, 70, 0}, [4]int64{keyUsed, keyReserved, accountUsed, accountReserved})
}

func testReleaseExpired(t *testing.T, s store.Store) {
	account := newAccount(t, s, nil)
	apiKey := newAPIKey(t, s, account.ID, nil)
	expired := reserveFor(t, s, apiKey, 300, time.Now().Add(-time.Minute))
	live := reserveFor(t, s, apiKey, 50, time.Now().Add(time.Hour))

	released, err := s.ReleaseExpiredReservations(ctx, time.Now(), 1000)
	require.NoError(t, err)
	assert.GreaterOrEqual(t, released, 1)

	_, err = s.GetReservation(ctx, expired)
	require.ErrorIs(t, err, store.ErrNotFound)
	_, err = s.GetReservation(ctx, live)
	require.NoError(t, err)
	_, keyReserved, _, accountReserved := quotaOf(t, s, apiKey.ID)
	assert.Equal(t, [2]int64{50, 50}, [2]int64{keyReserved, accountReserved}, "only the expired reservation is released")
}

func testUsage(t *testing.T, s store.Store) {
	account := newAccount(t, s, nil)
	apiKey := newAPIKey(t, s, account.ID, nil)
	first := usageEvent(apiKey, unique("req"), 100)
	first.Time = time.Now().Add(-time.Second)
	first.Pricing = &store.PricingSnapshot{
		Group:           "vip",
		GroupRatio:      0.9,
		ModelRatio:      0.5,
		CompletionRatio: 2,
		CacheRatio:      0.1,
	}
	second := usageEvent(apiKey, unique("req"), 40)
	second.Model = "image"
	second.Pricing = &store.PricingSnapshot{Group: "vip", GroupRatio: 0.9, ModelPrice: new(0.04)}
	unpriced := usageEvent(apiKey, unique("req"), 0)
	for _, ev := range []store.UsageEvent{first, second, unpriced} {
		_, err := s.SettleUsage(ctx, ev)
		require.NoError(t, err)
	}

	events, err := s.ListUsage(ctx, &apiKey.ID, nil, 10)
	require.NoError(t, err)
	require.Len(t, events, 3)
	byRequest := map[string]store.UsageEvent{}
	for _, ev := range events {
		byRequest[ev.RequestID] = ev
	}
	assert.Equal(t, first.Pricing, byRequest[first.RequestID].Pricing)
	assert.Equal(t, second.Pricing, byRequest[second.RequestID].Pricing)
	assert.Nil(t, byRequest[unpriced.RequestID].Pricing, "unpriced usage has no snapshot")

	rows, err := s.SummaryUsage(ctx, store.UsageFilter{APIKeyID: &apiKey.ID})
	require.NoError(t, err)
	totals := map[string]int64{}
	for _, row := range rows {
		totals[row.Model] += row.CostNanos
	}
	assert.Equal(t, map[string]int64{"m": 100, "image": 40}, totals)
}

func testAdmissionAudit(t *testing.T, s store.Store) {
	account := newAccount(t, s, nil)
	apiKey := newAPIKey(t, s, account.ID, nil)
	require.NoError(t, s.InsertAudit(ctx, []store.Audit{
		{
			Time:      time.Now(),
			RequestID: unique("req"),
			APIKeyID:  &apiKey.ID,
			AccountID: &account.ID,
			Protocol:  "grpc",
			Model:     "m",
			Allowed:   false,
			Reason:    "insufficient_quota",
		},
	}))

	rows, err := s.ListAudit(ctx, &apiKey.ID, 10)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	assert.Equal(t, "insufficient_quota", rows[0].Reason)
	assert.Equal(t, "grpc", rows[0].Protocol)
}

func testModelPricing(t *testing.T, s store.Store) {
	model := unique("model")
	price := store.ModelPrice{
		Model:           model,
		ModelRatio:      0, // 0 表示免费，必须原样保存
		CompletionRatio: 2,
		CacheRatio:      0.1,
		ModelPrice:      new(0.5),
	}
	require.NoError(t, s.UpsertModelPricing(ctx, price))

	got, err := s.GetModelPrice(ctx, model)
	require.NoError(t, err)
	assert.InDelta(t, 0.0, got.ModelRatio, 1e-12)
	assert.InDelta(t, 2.0, got.CompletionRatio, 1e-12)
	require.NotNil(t, got.ModelPrice)
	assert.InDelta(t, 0.5, *got.ModelPrice, 1e-12)
	assert.True(t, got.Enabled)

	listed, err := s.ListModelPricing(ctx)
	require.NoError(t, err)
	found := false
	for _, p := range listed {
		found = found || p.Model == model
	}
	assert.True(t, found)

	require.NoError(t, s.DeleteModelPricing(ctx, model))
	_, err = s.GetModelPrice(ctx, model)
	require.ErrorIs(t, err, store.ErrNotFound)
}

func testQuotaAdjustments(t *testing.T, s store.Store) {
	account := newAccount(t, s, new(int64(100)))
	apiKey := newAPIKey(t, s, account.ID, new(int64(10)))
	reserveFor(t, s, apiKey, 5, time.Now().Add(time.Hour))

	_, err := s.AddAccountQuotaLimit(ctx, account.ID, 50, "finance")
	require.NoError(t, err)
	require.NoError(t, s.SetAccountQuota(ctx, account.ID, store.QuotaChange{LimitNanos: nil, UsedNanos: 3, Actor: "ops"}))
	require.NoError(t, s.SetAPIKeyQuota(ctx, apiKey.ID, store.QuotaChange{LimitNanos: new(int64(20)), Actor: "ops"}))

	adjustments, err := s.ListQuotaAdjustments(ctx, store.QuotaAdjustmentFilter{AccountID: &account.ID}, 10)
	require.NoError(t, err)
	require.Len(t, adjustments, 3, "key adjustments are listed under their account too")
	keyReset, accountReset, topUp := adjustments[0], adjustments[1], adjustments[2]

	assert.Equal(t, store.QuotaTopUp, topUp.Kind)
	assert.Equal(t, "finance", topUp.Actor)
	assert.Equal(t, [2]int64{100, 150}, [2]int64{*topUp.LimitBefore, *topUp.LimitAfter})

	assert.Equal(t, store.QuotaReset, accountReset.Kind)
	assert.Equal(t, int64(150), *accountReset.LimitBefore)
	assert.Nil(t, accountReset.LimitAfter, "nil means unlimited")
	assert.Equal(t, int64(3), accountReset.UsedAfter)

	require.NotNil(t, keyReset.APIKeyID)
	assert.Equal(t, apiKey.ID, *keyReset.APIKeyID)
	assert.Equal(t, [2]int64{10, 20}, [2]int64{*keyReset.LimitBefore, *keyReset.LimitAfter})

	byKey, err := s.ListQuotaAdjustments(ctx, store.QuotaAdjustmentFilter{APIKeyID: &apiKey.ID}, 10)
	require.NoError(t, err)
	assert.Len(t, byKey, 1)

	_, keyReserved, _, accountReserved := quotaOf(t, s, apiKey.ID)
	assert.Equal(t, [2]int64{0, 0}, [2]int64{keyReserved, accountReserved}, "resets clear reservations")
}

func testAdminTokens(t *testing.T, s store.Store) {
	name := unique("operator")
	adminToken, err := s.CreateAdminToken(ctx, store.AdminToken{
		ID:           uuid.New(),
		Name:         name,
		TokenHash:    store.HashSecret(name),
		TokenPreview: "loom-admin-xxxx",
		Role:         "read",
	})
	require.NoError(t, err)
	assert.False(t, adminToken.CreatedAt.IsZero())

	_, err = s.CreateAdminToken(ctx, store.AdminToken{
		ID:        uuid.New(),
		Name:      name,
		TokenHash: store.HashSecret(unique("other")),
		Role:      "read",
	})
	require.ErrorIs(t, err, store.ErrConflict)

	got, err := s.GetAdminTokenByHash(ctx, store.HashSecret(name))
	require.NoError(t, err)
	assert.Equal(t, "read", got.Role)

	require.NoError(t, s.RevokeAdminToken(ctx, adminToken.ID))
	_, err = s.GetAdminTokenByHash(ctx, store.HashSecret(name))
	require.ErrorIs(t, err, store.ErrNotFound)
	require.ErrorIs(t, s.RevokeAdminToken(ctx, adminToken.ID), store.ErrNotFound)

	tokens, err := s.ListAdminTokens(ctx)
	require.NoError(t, err)
	var revoked *store.AdminToken
	for i := range tokens {
		if tokens[i].ID == adminToken.ID {
			revoked = &tokens[i]
		}
	}
	require.NotNil(t, revoked)
	assert.NotNil(t, revoked.RevokedAt)
}

func testAdminAudit(t *testing.T, s store.Store) {
	actor := unique("operator")
	require.NoError(t, s.InsertAdminAudit(ctx, store.AdminAudit{
		Actor:   actor,
		Method:  "POST",
		Route:   "/v1/accounts",
		Request: `{"name":"x"}`,
		Status:  201,
	}))

	rows, err := s.ListAdminAudit(ctx, 1000)
	require.NoError(t, err)
	var got *store.AdminAudit
	for i := range rows {
		if rows[i].Actor == actor {
			got = &rows[i]
		}
	}
	require.NotNil(t, got)
	assert.Equal(t, 201, got.Status)
	assert.Equal(t, "/v1/accounts", got.Route)
	assert.False(t, got.Time.IsZero())
}

func limits(rpm, tpm, concurrency int64) store.RateLimits {
	return store.RateLimits{RPM: &rpm, TPM: &tpm, MaxConcurrency: &concurrency}
}

func testRateLimitSettings(t *testing.T, s store.Store) {
	account, err := s.CreateAccount(ctx, store.Account{
		ID:     uuid.New(),
		Name:   unique("account"),
		Group:  "default",
		Status: store.StatusActive,
		Limits: limits(60, 6000, 3),
	})
	require.NoError(t, err)
	assert.Equal(t, limits(60, 6000, 3), account.Limits)

	apiKey := newAPIKey(t, s, account.ID, nil)
	assert.True(t, apiKey.Limits.IsZero(), "a key without limits inherits nothing at the store level")
	settings := apiKey.Settings()
	settings.Limits = store.RateLimits{RPM: new(int64(10))}
	_, err = s.UpdateAPIKey(ctx, apiKey.ID, settings)
	require.NoError(t, err)

	byHash, err := s.GetAPIKeyByHash(ctx, apiKey.KeyHash)
	require.NoError(t, err)
	assert.Equal(t, store.RateLimits{RPM: new(int64(10))}, byHash.Limits)
	assert.Equal(t, limits(60, 6000, 3), byHash.Account.Limits, "the key carries its account's limits")

	accountSettings := account.Settings()
	accountSettings.Limits = store.RateLimits{}
	updated, err := s.UpdateAccount(ctx, account.ID, accountSettings)
	require.NoError(t, err)
	assert.True(t, updated.Limits.IsZero(), "updating with empty limits removes them")
}

func testConcurrencyLimits(t *testing.T, s store.Store) {
	account := newAccount(t, s, nil)
	apiKey := newAPIKey(t, s, account.ID, nil)
	other := newAPIKey(t, s, account.ID, nil)
	reserveWithin := func(k store.APIKey, nanos int64, c store.ConcurrencyLimits) (string, error) {
		requestID := unique("req")
		_, err := s.ReserveQuota(ctx, store.Reservation{
			RequestID: requestID,
			APIKeyID:  k.ID,
			AccountID: k.AccountID,
			Model:     "m",
			Nanos:     nanos,
			ExpiresAt: time.Now().Add(time.Hour),
		}, c)
		return requestID, err
	}
	keyMax := store.ConcurrencyLimits{APIKey: new(int64(2)), Account: new(int64(3))}

	first, err := reserveWithin(apiKey, 0, keyMax)
	require.NoError(t, err, "free requests take a slot too")
	_, err = reserveWithin(apiKey, 10, keyMax)
	require.NoError(t, err)
	_, err = reserveWithin(apiKey, 10, keyMax)
	var limited *store.RateLimitError
	require.ErrorAs(t, err, &limited)
	assert.Equal(t, store.RateLimitError{Scope: store.RateScopeAPIKey, Kind: store.RateLimitConcurrency}, *limited)
	require.ErrorIs(t, err, store.ErrRateLimited)

	_, err = reserveWithin(other, 10, keyMax)
	require.NoError(t, err, "the account has a third slot")
	_, err = reserveWithin(other, 10, keyMax)
	require.ErrorAs(t, err, &limited)
	assert.Equal(t, store.RateScopeAccount, limited.Scope)

	inserted, err := s.SettleUsage(ctx, store.UsageEvent{
		RequestID: first,
		APIKeyID:  &apiKey.ID,
		AccountID: &account.ID,
		Model:     "m",
	})
	require.NoError(t, err)
	require.True(t, inserted)
	_, err = reserveWithin(other, 10, keyMax)
	require.NoError(t, err, "settlement frees the slot")

	key, err := s.GetAPIKey(ctx, apiKey.ID)
	require.NoError(t, err)
	assert.Equal(t, [2]int64{1, 3}, [2]int64{key.InFlight, key.Account.InFlight})
}

func testQuotaResetKeepsLevelsConsistent(t *testing.T, s store.Store) {
	account := newAccount(t, s, nil)
	first := newAPIKey(t, s, account.ID, nil)
	second := newAPIKey(t, s, account.ID, nil)
	reserveFor(t, s, first, 30, time.Now().Add(time.Hour))
	reserveFor(t, s, second, 70, time.Now().Add(time.Hour))

	require.NoError(t, s.SetAPIKeyQuota(ctx, first.ID, store.QuotaChange{Actor: "test"}))
	accountAfter, err := s.GetAccount(ctx, account.ID)
	require.NoError(t, err)
	assert.Equal(t, [2]int64{70, 1}, [2]int64{accountAfter.Reserved, accountAfter.InFlight},
		"resetting a key takes its reservations off the account too")

	require.NoError(t, s.SetAccountQuota(ctx, account.ID, store.QuotaChange{Actor: "test"}))
	secondAfter, err := s.GetAPIKey(ctx, second.ID)
	require.NoError(t, err)
	assert.Equal(t, [2]int64{0, 0}, [2]int64{secondAfter.Reserved, secondAfter.InFlight},
		"resetting the account takes its reservations off every key")
	assert.Equal(t, [2]int64{0, 0}, [2]int64{secondAfter.Account.Reserved, secondAfter.Account.InFlight})
}

func testRateCounters(t *testing.T, s store.Store) {
	window := time.Now().UTC().Truncate(time.Minute)
	keyID, accountID := uuid.New(), uuid.New()
	claims := func(tokens int64, keyRPM, accountTPM *int64) []store.RateClaim {
		return []store.RateClaim{
			{Scope: store.RateScopeAPIKey, Subject: keyID, Tokens: tokens, RPM: keyRPM},
			{Scope: store.RateScopeAccount, Subject: accountID, Tokens: tokens, TPM: accountTPM},
		}
	}
	rpm, tpm := new(int64(3)), new(int64(100))

	require.NoError(t, s.AcquireRate(ctx, window, claims(40, rpm, tpm)))
	require.NoError(t, s.AcquireRate(ctx, window, claims(40, rpm, tpm)))
	err := s.AcquireRate(ctx, window, claims(40, rpm, tpm))
	var limited *store.RateLimitError
	require.ErrorAs(t, err, &limited)
	assert.Equal(t, store.RateLimitError{Scope: store.RateScopeAccount, Kind: store.RateLimitTPM}, *limited)

	require.NoError(t, s.AcquireRate(ctx, window, claims(20, rpm, tpm)),
		"the denied attempt counted neither a request nor tokens, on either level")
	err = s.AcquireRate(ctx, window, claims(0, rpm, nil))
	require.ErrorAs(t, err, &limited)
	assert.Equal(t, store.RateLimitError{Scope: store.RateScopeAPIKey, Kind: store.RateLimitRPM}, *limited)

	require.NoError(t, s.ReleaseRate(ctx, window, claims(20, rpm, tpm)))
	require.NoError(t, s.AcquireRate(ctx, window, claims(0, rpm, nil)), "released request is available again")

	require.NoError(t, s.AddRateTokens(ctx, window, claims(-1000, nil, nil)), "corrections never go below zero")
	require.NoError(t, s.AcquireRate(ctx, window, claims(100, nil, tpm)))

	next := window.Add(time.Minute)
	require.NoError(t, s.AcquireRate(ctx, next, claims(100, rpm, tpm)), "a new window starts from zero")

	_, err = s.DeleteRateWindows(ctx, next)
	require.NoError(t, err)
	require.NoError(t, s.AcquireRate(ctx, window, claims(100, new(int64(1)), tpm)), "deleted windows start over")
	err = s.AcquireRate(ctx, next, claims(1, rpm, tpm))
	require.ErrorAs(t, err, &limited, "windows from before are kept")
}
