package account

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
)

// SeedFile 是 seed.yaml 的结构。
type SeedFile struct {
	Accounts []SeedAccount `yaml:"accounts"`
	Pricing  []SeedPrice   `yaml:"pricing"`
}

// SeedAccount 种子账户。
type SeedAccount struct {
	Name       string       `yaml:"name"`
	Tenant     string       `yaml:"tenant"`
	Group      string       `yaml:"group"`
	Status     store.Status `yaml:"status"`
	QuotaNanos *int64       `yaml:"quota_limit_nanos"`
	Keys       []SeedKey    `yaml:"keys"`
}

// SeedKey 种子 Key；明文只存在于 seed 文件（演示环境）。
type SeedKey struct {
	Name           string   `yaml:"name"`
	Plaintext      string   `yaml:"plaintext"`
	QuotaNanos     *int64   `yaml:"quota_limit_nanos"`
	ModelAllowlist []string `yaml:"model_allowlist"`
	ExpiresAt      string   `yaml:"expires_at"` // RFC3339，可空
}

// SeedPrice PG 兜底定价种子。
type SeedPrice struct {
	Model           string   `yaml:"model"`
	ModelRatio      float64  `yaml:"model_ratio"`
	CompletionRatio float64  `yaml:"completion_ratio"`
	CacheRatio      float64  `yaml:"cache_ratio"`
	ModelPrice      *float64 `yaml:"model_price"`
}

// Seed 幂等写入 seed 文件：账户按名字、Key 按「账户 + 名字」对齐，返回每一步的操作摘要。
func (s *Service) Seed(ctx context.Context, path string) ([]string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read seed file: %w", err)
	}
	var file SeedFile
	if err := yaml.Unmarshal(raw, &file); err != nil {
		return nil, fmt.Errorf("parse seed file: %w", err)
	}

	var log []string
	for _, a := range file.Accounts {
		lines, err := s.seedAccount(ctx, a)
		if err != nil {
			return nil, fmt.Errorf("seed account %q: %w", a.Name, err)
		}
		log = append(log, lines...)
	}
	for _, p := range file.Pricing {
		if err := s.UpsertStorePrice(ctx, p.modelPrice()); err != nil {
			return nil, fmt.Errorf("seed price %q: %w", p.Model, err)
		}
		log = append(log, fmt.Sprintf("pg pricing %s upserted", p.Model))
	}
	return log, nil
}

func (s *Service) seedAccount(ctx context.Context, a SeedAccount) ([]string, error) {
	var log []string
	acct, err := s.store.GetAccountByName(ctx, a.Name)
	if errors.Is(err, store.ErrNotFound) {
		acct, err = s.CreateAccount(
			ctx,
			NewAccount{Name: a.Name, Tenant: a.Tenant, Group: a.Group, Status: a.Status, QuotaNanos: a.QuotaNanos},
		)
		log = append(log, fmt.Sprintf("account %s created", a.Name))
	}
	if err != nil {
		return nil, err
	}
	// 每次都把状态、分组、额度上限对齐到 seed 文件（QuotaNanos 为 nil 表示不限额）
	status, group := orDefault(a.Status, store.StatusActive), orDefault(a.Group, defaultGroup)
	if _, err := s.store.UpdateAccount(ctx, acct.ID, status, a.QuotaNanos, group); err != nil {
		return nil, err
	}

	existing, err := s.store.ListKeys(ctx, &acct.ID, 1000)
	if err != nil {
		return nil, err
	}
	byName := make(map[string]store.Key, len(existing))
	for _, k := range existing {
		byName[k.Name] = k
	}
	for _, k := range a.Keys {
		line, err := s.seedKey(ctx, acct, k, byName)
		if err != nil {
			return nil, fmt.Errorf("key %q: %w", k.Name, err)
		}
		log = append(log, line)
	}
	return log, nil
}

func (s *Service) seedKey(
	ctx context.Context,
	acct store.Account,
	k SeedKey,
	existing map[string]store.Key,
) (string, error) {
	if k.Plaintext == "" {
		return "", fmt.Errorf("%w: plaintext is required in seed", ErrInvalidInput)
	}
	expiresAt, err := parseOptionalTime(k.ExpiresAt)
	if err != nil {
		return "", err
	}

	if old, ok := existing[k.Name]; ok {
		if old.KeyHash != store.HashAPIKey(k.Plaintext) {
			return "", fmt.Errorf("%w: exists with a different plaintext; delete it before reseeding", ErrConflict)
		}
		_, err := s.store.UpdateKey(ctx, old.ID, store.StatusActive, k.ModelAllowlist, k.QuotaNanos, expiresAt, k.Name)
		if err != nil {
			return "", err
		}
		s.invalidateKey(old.ID)
		return fmt.Sprintf("key %s/%s updated", acct.Name, k.Name), nil
	}

	issued, err := s.CreateKey(ctx, NewKey{
		AccountID:      acct.ID,
		Name:           k.Name,
		QuotaNanos:     k.QuotaNanos,
		ModelAllowlist: k.ModelAllowlist,
		ExpiresAt:      expiresAt,
		Plaintext:      k.Plaintext,
	})
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("key %s/%s created (preview=%s)", acct.Name, k.Name, issued.Key.KeyPreview), nil
}

func (p SeedPrice) modelPrice() store.ModelPrice {
	return store.ModelPrice{
		Model:           p.Model,
		ModelRatio:      positiveOr(p.ModelRatio, 1),
		CompletionRatio: positiveOr(p.CompletionRatio, 1),
		CacheRatio:      positiveOr(p.CacheRatio, 1),
		ModelPrice:      p.ModelPrice,
	}
}

func parseOptionalTime(v string) (*time.Time, error) {
	if v == "" {
		return nil, nil
	}
	t, err := time.Parse(time.RFC3339, v)
	if err != nil {
		return nil, fmt.Errorf("%w: expires_at must be RFC3339: %w", ErrInvalidInput, err)
	}
	return &t, nil
}

func positiveOr(v, fallback float64) float64 {
	if v > 0 {
		return v
	}
	return fallback
}
