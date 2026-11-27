package account

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/google/uuid"
	"gopkg.in/yaml.v3"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/pricing"
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
	APIKeys    []SeedAPIKey `yaml:"keys"`
}

// SeedAPIKey 种子 Key；明文只存在于 seed 文件（演示环境）。
type SeedAPIKey struct {
	Name           string   `yaml:"name"`
	Plaintext      string   `yaml:"plaintext"`
	QuotaNanos     *int64   `yaml:"quota_limit_nanos"`
	ModelAllowlist []string `yaml:"model_allowlist"`
	ExpiresAt      string   `yaml:"expires_at"` // RFC3339，可空
}

// SeedPrice PG 兜底定价种子；取值口径同 ModelPriceInput。
type SeedPrice struct {
	Model           string `yaml:"model"`
	ModelPriceInput `yaml:",inline"`
}

// Seed 幂等写入 seed 文件：账户按名字、Key 按「账户 + 名字」对齐，返回每一步的操作摘要。
func (s *Service) Seed(ctx context.Context, path string) ([]string, error) {
	raw, err := os.ReadFile(path) //nolint:gosec // Seed path is explicitly supplied by the CLI operator.
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
		if err := s.UpsertModelPrice(ctx, p.Model, p.ModelPriceInput); err != nil {
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
		acct, err = s.CreateAccount(ctx, CreateAccountInput{
			Name:       a.Name,
			Tenant:     a.Tenant,
			Group:      a.Group,
			Status:     a.Status,
			QuotaNanos: a.QuotaNanos,
		})
		log = append(log, fmt.Sprintf("account %s created", a.Name))
	}
	if err != nil {
		return nil, err
	}

	// 每次都把状态、分组、额度上限对齐到 seed 文件（QuotaNanos 为 nil 表示不限额）
	settings := store.AccountSettings{
		Status:     orDefault(a.Status, store.StatusActive),
		Group:      orDefault(a.Group, pricing.DefaultGroup),
		QuotaLimit: a.QuotaNanos,
	}
	if err := s.validateGroup(settings.Group); err != nil {
		return nil, err
	}
	if _, err := s.store.UpdateAccount(ctx, acct.ID, settings); err != nil {
		return nil, err
	}
	s.invalidateAccount(acct.ID)

	existing, err := s.store.ListAPIKeys(ctx, &acct.ID, 1000)
	if err != nil {
		return nil, err
	}
	byName := make(map[string]store.APIKey, len(existing))
	for _, k := range existing {
		byName[k.Name] = k
	}
	for _, k := range a.APIKeys {
		line, err := s.seedAPIKey(ctx, acct, k, byName[k.Name])
		if err != nil {
			return nil, fmt.Errorf("api key %q: %w", k.Name, err)
		}
		log = append(log, line)
	}
	return log, nil
}

// seedAPIKey 创建或对齐一把 API Key；existing 为零值表示该 Key 尚不存在。
func (s *Service) seedAPIKey(
	ctx context.Context,
	acct store.Account,
	k SeedAPIKey,
	existing store.APIKey,
) (string, error) {
	if k.Plaintext == "" {
		return "", fmt.Errorf("%w: plaintext is required in seed", ErrInvalidInput)
	}
	expiresAt, err := parseOptionalTime(k.ExpiresAt)
	if err != nil {
		return "", err
	}

	if existing.ID != uuid.Nil {
		if existing.KeyHash != store.HashAPIKey(k.Plaintext) {
			return "", fmt.Errorf("%w: exists with a different plaintext; delete it before reseeding", ErrConflict)
		}
		settings := store.APIKeySettings{
			Name:           k.Name,
			Status:         store.StatusActive,
			ModelAllowlist: k.ModelAllowlist,
			QuotaLimit:     k.QuotaNanos,
			ExpiresAt:      expiresAt,
		}
		if _, err := s.store.UpdateAPIKey(ctx, existing.ID, settings); err != nil {
			return "", err
		}
		s.invalidateAPIKey(existing.ID)
		return fmt.Sprintf("api key %s/%s updated", acct.Name, k.Name), nil
	}

	issued, err := s.CreateAPIKey(ctx, CreateAPIKeyInput{
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
	preview := issued.APIKey.KeyPreview
	return fmt.Sprintf("api key %s/%s created (preview=%s)", acct.Name, k.Name, preview), nil
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
