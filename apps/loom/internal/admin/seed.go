package admin

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/google/uuid"
	"gopkg.in/yaml.v3"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/auth"
	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
	"github.com/ai-hermes/pi-lessons/apps/loom/pkg/loom"
)

// SeedSpec seed.yaml 结构。
type SeedSpec struct {
	Accounts []SeedAccount `yaml:"accounts"`
	Pricing  []SeedPricing `yaml:"pricing"`
}

// SeedAccount 种子账户。
type SeedAccount struct {
	Name       string    `yaml:"name"`
	Tenant     string    `yaml:"tenant"`
	Group      string    `yaml:"group"`
	Status     string    `yaml:"status"`
	QuotaNanos *int64    `yaml:"quota_limit_nanos"`
	Keys       []SeedKey `yaml:"keys"`
}

// SeedKey 种子 Key；Plaintext 必填且只存在于 seed 文件（演示环境）。
type SeedKey struct {
	Name           string   `yaml:"name"`
	Plaintext      string   `yaml:"plaintext"`
	QuotaNanos     *int64   `yaml:"quota_limit_nanos"`
	ModelAllowlist []string `yaml:"model_allowlist"`
	ExpiresAt      *string  `yaml:"expires_at"`
}

// SeedPricing PG 兜底定价种子。
type SeedPricing struct {
	Model           string   `yaml:"model"`
	ModelRatio      float64  `yaml:"model_ratio"`
	CompletionRatio float64  `yaml:"completion_ratio"`
	CacheRatio      float64  `yaml:"cache_ratio"`
	ModelPrice      *float64 `yaml:"model_price"`
}

// Seed 幂等写入种子数据，返回操作摘要。
func Seed(ctx context.Context, s *Service, path string) ([]string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var spec SeedSpec
	if err := yaml.Unmarshal(b, &spec); err != nil {
		return nil, fmt.Errorf("parse seed yaml: %w", err)
	}
	var out []string
	for _, a := range spec.Accounts {
		if a.Group == "" {
			a.Group = "default"
		}
		if a.Status == "" {
			a.Status = loom.StatusActive
		}
		cur, err := s.st.GetAccountByName(ctx, a.Name)
		if errors.Is(err, loom.ErrNotFound) {
			cur, err = s.st.CreateAccount(ctx, store.Account{ID: uuid.New(), Name: a.Name, Tenant: a.Tenant, Group: a.Group,
				Status: a.Status, QuotaLimit: a.QuotaNanos})
			if err != nil {
				return nil, fmt.Errorf("create account %s: %w", a.Name, err)
			}
			out = append(out, fmt.Sprintf("account %s created (id=%s)", a.Name, cur.ID))
		} else if err != nil {
			return nil, err
		}
		if cur, err = s.st.UpdateAccount(ctx, cur.ID, a.Status, a.QuotaNanos, a.Group); err != nil {
			return nil, err
		}
		existing, err := s.st.ListKeys(ctx, &cur.ID, 1000)
		if err != nil {
			return nil, err
		}
		byName := map[string]store.Key{}
		for _, k := range existing {
			byName[k.Name] = k
		}
		for _, k := range a.Keys {
			if k.Plaintext == "" {
				return nil, fmt.Errorf("key %s/%s: plaintext is required in seed", a.Name, k.Name)
			}
			var exp *time.Time
			if k.ExpiresAt != nil {
				t, err := time.Parse(time.RFC3339, *k.ExpiresAt)
				if err != nil {
					return nil, fmt.Errorf("key %s/%s expires_at (RFC3339): %w", a.Name, k.Name, err)
				}
				exp = &t
			}
			preview := k.Plaintext
			if len(preview) > 12 {
				preview = preview[:12]
			}
			hash := auth.HashKey(k.Plaintext)
			if old, ok := byName[k.Name]; ok {
				if old.KeyHash != hash {
					return nil, fmt.Errorf("key %s/%s exists with a different plaintext; delete it before reseeding", a.Name, k.Name)
				}
				if _, err := s.st.UpdateKey(ctx, old.ID, loom.StatusActive, k.ModelAllowlist, k.QuotaNanos, exp, k.Name); err != nil {
					return nil, err
				}
				out = append(out, fmt.Sprintf("key %s/%s updated (id=%s)", a.Name, k.Name, old.ID))
				continue
			}
			created, err := s.st.CreateKey(ctx, store.Key{ID: uuid.New(), AccountID: cur.ID, Name: k.Name, KeyHash: hash,
				KeyPreview: preview, Status: loom.StatusActive, QuotaLimit: k.QuotaNanos, ExpiresAt: exp}, k.ModelAllowlist)
			if err != nil {
				return nil, fmt.Errorf("create key %s/%s: %w", a.Name, k.Name, err)
			}
			out = append(out, fmt.Sprintf("key %s/%s created (id=%s preview=%s)", a.Name, k.Name, created.ID, preview))
		}
	}
	for _, p := range spec.Pricing {
		if p.ModelRatio == 0 {
			p.ModelRatio = 1
		}
		if p.CompletionRatio == 0 {
			p.CompletionRatio = 1
		}
		if p.CacheRatio == 0 {
			p.CacheRatio = 1
		}
		if err := s.UpsertPricing(ctx, store.ModelPrice{Model: p.Model, ModelRatio: p.ModelRatio, CompletionRatio: p.CompletionRatio,
			CacheRatio: p.CacheRatio, ModelPrice: p.ModelPrice}); err != nil {
			return nil, err
		}
		out = append(out, fmt.Sprintf("pg pricing %s upserted", p.Model))
	}
	return out, nil
}
