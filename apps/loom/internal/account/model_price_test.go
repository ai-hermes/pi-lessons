package account

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestModelPriceInputDefaultsAndFree(t *testing.T) {
	zero, half := 0.0, 0.5
	in := ModelPriceInput{ModelRatio: &half, CompletionRatio: &zero}

	price, err := in.modelPrice("m")

	require.NoError(t, err)
	assert.InDelta(t, 0.5, price.ModelRatio, 1e-9)
	assert.InDelta(t, 0.0, price.CompletionRatio, 1e-9, "explicit 0 means free output")
	assert.InDelta(t, 1.0, price.CacheRatio, 1e-9, "unset ratio defaults to 1")
	assert.Nil(t, price.ModelPrice)
}

func TestModelPriceInputRejectsInvalidValues(t *testing.T) {
	negative := -1.0
	tests := []struct {
		name  string
		model string
		in    ModelPriceInput
	}{
		{name: "missing model", model: "", in: ModelPriceInput{}},
		{name: "negative ratio", model: "m", in: ModelPriceInput{CacheRatio: &negative}},
		{name: "negative price", model: "m", in: ModelPriceInput{ModelPrice: &negative}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := tt.in.modelPrice(tt.model)
			require.ErrorIs(t, err, ErrInvalidInput)
		})
	}
}
