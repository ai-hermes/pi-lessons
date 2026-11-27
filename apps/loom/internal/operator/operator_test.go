package operator

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store/memstore"
)

const bootstrap = "bootstrap-secret"

func TestAuthenticate(t *testing.T) {
	s := New(memstore.New(), bootstrap)
	ctx := context.Background()
	reader, err := s.IssueToken(ctx, IssueTokenInput{Name: "grafana", Role: RoleRead})
	require.NoError(t, err)

	tests := []struct {
		name     string
		token    string
		expected Operator
		err      error
	}{
		{name: "bootstrap", token: bootstrap, expected: Operator{Name: BootstrapName, Role: RoleWrite}},
		{name: "issued", token: reader.Plaintext, expected: Operator{Name: "grafana", Role: RoleRead}},
		{name: "empty", token: "", err: ErrUnauthenticated},
		{name: "unknown", token: "loom-admin-nope", err: ErrUnauthenticated},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			op, err := s.Authenticate(ctx, tt.token)
			if tt.err != nil {
				require.ErrorIs(t, err, tt.err)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, tt.expected, op)
		})
	}
}

func TestRevokedTokenIsRejectedImmediately(t *testing.T) {
	s := New(memstore.New(), bootstrap)
	ctx := context.Background()
	issued, err := s.IssueToken(ctx, IssueTokenInput{Name: "ci", Role: RoleWrite})
	require.NoError(t, err)

	require.NoError(t, s.RevokeToken(ctx, issued.Token.ID))

	_, err = s.Authenticate(ctx, issued.Plaintext)
	require.ErrorIs(t, err, ErrUnauthenticated)
	tokens, err := s.ListTokens(ctx)
	require.NoError(t, err)
	require.Len(t, tokens, 1)
	assert.NotNil(t, tokens[0].RevokedAt, "revoked tokens stay listed for traceability")
}

func TestIssueTokenValidation(t *testing.T) {
	s := New(memstore.New(), bootstrap)
	for _, in := range []IssueTokenInput{
		{Name: "", Role: RoleRead},
		{Name: BootstrapName, Role: RoleRead},
		{Name: "x", Role: "admin"},
	} {
		_, err := s.IssueToken(context.Background(), in)
		require.ErrorIs(t, err, ErrInvalidInput, "%+v", in)
	}
}

func TestIssuedTokenIsStoredOnlyAsHash(t *testing.T) {
	s := New(memstore.New(), bootstrap)
	issued, err := s.IssueToken(context.Background(), IssueTokenInput{Name: "x", Role: RoleRead})
	require.NoError(t, err)

	assert.NotContains(t, issued.Token.TokenHash, issued.Plaintext)
	assert.Equal(t, issued.Plaintext[:tokenPreviewLen], issued.Token.TokenPreview)
}

func TestRoleAllows(t *testing.T) {
	assert.True(t, RoleWrite.Allows(RoleRead))
	assert.True(t, RoleRead.Allows(RoleRead))
	assert.False(t, RoleRead.Allows(RoleWrite))
}

func TestActorName(t *testing.T) {
	assert.Equal(t, SystemName, ActorName(context.Background()))
	ctx := WithOperator(context.Background(), Operator{Name: "ops", Role: RoleWrite})
	assert.Equal(t, "ops", ActorName(ctx))
}
