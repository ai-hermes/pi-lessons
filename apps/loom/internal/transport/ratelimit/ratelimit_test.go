package ratelimit

import (
	"context"
	"errors"
	"log/slog"
	"testing"

	rlscommon "github.com/envoyproxy/go-control-plane/envoy/extensions/common/ratelimit/v3"
	rlsv3 "github.com/envoyproxy/go-control-plane/envoy/service/ratelimit/v3"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/types/known/wrapperspb"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/ledger"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/pricing"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/telemetry"
)

type fakeSettler struct {
	got []ledger.UsageReport
	err error
}

func (f *fakeSettler) Settle(_ context.Context, u ledger.UsageReport) (bool, error) {
	f.got = append(f.got, u)
	return f.err == nil, f.err
}

func descriptor(requestID, apiKeyID, kind string, hits uint64) *rlscommon.RateLimitDescriptor {
	return &rlscommon.RateLimitDescriptor{
		Entries: []*rlscommon.RateLimitDescriptor_Entry{
			{Key: "request_id", Value: requestID},
			{Key: "key_id", Value: apiKeyID},
			{Key: "model", Value: "lab-model"},
			{Key: "kind", Value: kind},
		},
		HitsAddend: wrapperspb.UInt64(hits),
	}
}

func newServer(settler Settler) *Server {
	metrics := telemetry.NewMetrics("test", "test")
	log := slog.New(slog.DiscardHandler)
	return NewServer(settler, "loom-billing", metrics, log)
}

func TestCheckPhaseDoesNotSettle(t *testing.T) {
	settler := &fakeSettler{}
	resp, err := newServer(settler).ShouldRateLimit(context.Background(), &rlsv3.RateLimitRequest{
		Domain:      "loom-billing",
		Descriptors: []*rlscommon.RateLimitDescriptor{descriptor("req-1", "", "input", 0)},
	})

	require.NoError(t, err)
	assert.Equal(t, rlsv3.RateLimitResponse_OK, resp.OverallCode)
	assert.Empty(t, settler.got)
}

func TestAmendMergesDescriptorsIntoOneUsageReport(t *testing.T) {
	settler := &fakeSettler{}
	apiKeyID := uuid.New()
	resp, err := newServer(settler).ShouldRateLimit(context.Background(), &rlsv3.RateLimitRequest{
		Domain: "loom-billing",
		Descriptors: []*rlscommon.RateLimitDescriptor{
			descriptor("req-1", apiKeyID.String(), "input", 1000),
			descriptor("req-1", apiKeyID.String(), "cached", 200),
			descriptor("req-1", apiKeyID.String(), "output", 500),
		},
	})

	require.NoError(t, err)
	assert.Equal(t, rlsv3.RateLimitResponse_OK, resp.OverallCode)
	assert.Len(t, resp.Statuses, 3)
	require.Len(t, settler.got, 1)
	u := settler.got[0]
	assert.Equal(t, "req-1", u.RequestID)
	assert.Equal(t, apiKeyID, u.APIKeyID)
	assert.Equal(t, Channel, u.Channel)
	assert.Equal(t, pricing.TokenUsage{Input: 1000, Cached: 200, Output: 500}, u.TokenUsage)
}

func TestCompletionOnlyAmendSettlesZeroUsage(t *testing.T) {
	settler := &fakeSettler{}
	apiKeyID := uuid.New()
	// 上游报错或客户端中途断开：token 描述符为 0（或求值失败被网关丢弃），只有 completion=1
	_, err := newServer(settler).ShouldRateLimit(context.Background(), &rlsv3.RateLimitRequest{
		Domain: "loom-billing",
		Descriptors: []*rlscommon.RateLimitDescriptor{
			descriptor("req-1", apiKeyID.String(), "input", 0),
			descriptor("req-1", apiKeyID.String(), "completion", 1),
		},
	})

	require.NoError(t, err)
	require.Len(t, settler.got, 1, "the request is settled (and its reservation released) by RLS")
	assert.Equal(t, pricing.TokenUsage{}, settler.got[0].TokenUsage, "completion never counts as tokens")
}

func TestOtherDomainIsIgnored(t *testing.T) {
	settler := &fakeSettler{}
	resp, err := newServer(settler).ShouldRateLimit(context.Background(), &rlsv3.RateLimitRequest{
		Domain:      "other",
		Descriptors: []*rlscommon.RateLimitDescriptor{descriptor("req-x", "", "input", 999)},
	})

	require.NoError(t, err)
	assert.Equal(t, rlsv3.RateLimitResponse_OK, resp.OverallCode)
	assert.Empty(t, resp.Statuses)
	assert.Empty(t, settler.got)
}

func TestSettlementFailureReturnsError(t *testing.T) {
	settler := &fakeSettler{err: errors.New("db down")}
	resp, err := newServer(settler).ShouldRateLimit(context.Background(), &rlsv3.RateLimitRequest{
		Domain:      "loom-billing",
		Descriptors: []*rlscommon.RateLimitDescriptor{descriptor("req-9", "", "input", 10)},
	})

	require.NoError(t, err)
	assert.Equal(t, codeError, resp.OverallCode)
	assert.Equal(t, codeError, resp.Statuses[0].Code)
}
