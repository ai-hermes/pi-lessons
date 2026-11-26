package main

import (
	"encoding/json"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/pricing"
)

func loadSpec(path string) (*pricing.Spec, error) { return pricing.LoadSpec(path) }

func marshalCatalog(spec *pricing.Spec) ([]byte, error) {
	return json.MarshalIndent(pricing.RenderCatalog(spec), "", "  ")
}

func sortedModels(spec *pricing.Spec) []string { return spec.SortedModels() }

func modelRatio(spec *pricing.Spec, m string) float64 {
	if v := spec.Models[m].ModelRatio; v > 0 {
		return v
	}
	return spec.Defaults.ModelRatio
}

func completion(spec *pricing.Spec, m string) float64 {
	if v := spec.Models[m].CompletionRatio; v > 0 {
		return v
	}
	return spec.Defaults.CompletionRatio
}

func cache(spec *pricing.Spec, m string) float64 {
	if v := spec.Models[m].CacheRatio; v > 0 {
		return v
	}
	return spec.Defaults.CacheRatio
}
