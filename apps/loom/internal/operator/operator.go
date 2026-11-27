// Package operator 管理管理面的操作者：管理 token 的认证、签发与吊销，以及管理操作审计。
//
// 配置文件里的 admin.token 是引导 token（读写权限），用于初始化与紧急情况；其余 token 通过管理 API 签发，
// 库中只存哈希，明文只在签发时返回一次。
package operator

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"

	"github.com/ai-hermes/pi-lessons/apps/loom/internal/store"
)

// Role 是管理 token 的权限。
type Role string

// 角色取值。
const (
	RoleRead  Role = "read"  // 只读：GET 请求、pprof
	RoleWrite Role = "write" // 读写：全部管理操作
)

// Allows 判断该角色是否满足 required。
func (r Role) Allows(required Role) bool { return r == RoleWrite || r == required }

const (
	// BootstrapName 是引导 token 的操作者名称。
	BootstrapName = "bootstrap"
	// SystemName 是不经过管理 API 的内部操作（如 seed）的操作者名称。
	SystemName = "system"

	tokenPrefix     = "loom-admin-"
	tokenPreviewLen = 16
)

var (
	// ErrUnauthenticated 未携带 token，或 token 无效、已吊销。
	ErrUnauthenticated = errors.New("operator: unauthenticated")
	// ErrInvalidInput 请求参数不合法。
	ErrInvalidInput = errors.New("operator: invalid input")
)

// Operator 是一次管理请求的操作者。
type Operator struct {
	Name string
	Role Role
}

// Store 是操作者管理所需的持久化能力。
type Store interface {
	CreateAdminToken(ctx context.Context, t store.AdminToken) (store.AdminToken, error)
	GetAdminTokenByHash(ctx context.Context, hash string) (store.AdminToken, error)
	ListAdminTokens(ctx context.Context) ([]store.AdminToken, error)
	RevokeAdminToken(ctx context.Context, id uuid.UUID) error
	InsertAdminAudit(ctx context.Context, row store.AdminAudit) error
	ListAdminAudit(ctx context.Context, limit int) ([]store.AdminAudit, error)
}

// Service 认证操作者、管理 token 与审计。
type Service struct {
	store          Store
	bootstrapToken string
}

// New 创建操作者服务；bootstrapToken 为配置文件中的 admin.token。
func New(storage Store, bootstrapToken string) *Service {
	return &Service{store: storage, bootstrapToken: bootstrapToken}
}

// Authenticate 校验 token 并返回对应的操作者。
func (s *Service) Authenticate(ctx context.Context, token string) (Operator, error) {
	if token == "" {
		return Operator{}, ErrUnauthenticated
	}
	if s.bootstrapToken != "" && subtle.ConstantTimeCompare([]byte(token), []byte(s.bootstrapToken)) == 1 {
		return Operator{Name: BootstrapName, Role: RoleWrite}, nil
	}
	adminToken, err := s.store.GetAdminTokenByHash(ctx, store.HashSecret(token))
	switch {
	case errors.Is(err, store.ErrNotFound):
		return Operator{}, ErrUnauthenticated
	case err != nil:
		return Operator{}, err
	}
	return Operator{Name: adminToken.Name, Role: Role(adminToken.Role)}, nil
}

// IssueTokenInput 签发管理 token 的参数。
type IssueTokenInput struct {
	Name string `json:"name"`
	Role Role   `json:"role"`
}

// IssuedToken 新签发的 token；Plaintext 只在签发时返回这一次。
type IssuedToken struct {
	Token     store.AdminToken
	Plaintext string
}

// IssueToken 签发一把新的管理 token。
func (s *Service) IssueToken(ctx context.Context, in IssueTokenInput) (IssuedToken, error) {
	name := strings.TrimSpace(in.Name)
	switch {
	case name == "":
		return IssuedToken{}, fmt.Errorf("%w: name is required", ErrInvalidInput)
	case name == BootstrapName || name == SystemName:
		return IssuedToken{}, fmt.Errorf("%w: name %q is reserved", ErrInvalidInput, name)
	case in.Role != RoleRead && in.Role != RoleWrite:
		return IssuedToken{}, fmt.Errorf("%w: role must be read or write", ErrInvalidInput)
	}
	secret := make([]byte, 24)
	if _, err := rand.Read(secret); err != nil {
		return IssuedToken{}, fmt.Errorf("generate admin token: %w", err)
	}
	plaintext := tokenPrefix + hex.EncodeToString(secret)
	adminToken, err := s.store.CreateAdminToken(ctx, store.AdminToken{
		ID:           uuid.New(),
		Name:         name,
		TokenHash:    store.HashSecret(plaintext),
		TokenPreview: plaintext[:tokenPreviewLen],
		Role:         string(in.Role),
	})
	if err != nil {
		return IssuedToken{}, err
	}
	return IssuedToken{Token: adminToken, Plaintext: plaintext}, nil
}

// ListTokens 列出全部管理 token（含已吊销），不含明文与哈希。
func (s *Service) ListTokens(ctx context.Context) ([]store.AdminToken, error) {
	return s.store.ListAdminTokens(ctx)
}

// RevokeToken 吊销管理 token，立即生效（认证不缓存）。
func (s *Service) RevokeToken(ctx context.Context, id uuid.UUID) error {
	return s.store.RevokeAdminToken(ctx, id)
}

// RecordAudit 记录一条管理操作审计。
func (s *Service) RecordAudit(ctx context.Context, row store.AdminAudit) error {
	return s.store.InsertAdminAudit(ctx, row)
}

// ListAudit 列出最近的管理操作审计。
func (s *Service) ListAudit(ctx context.Context, limit int) ([]store.AdminAudit, error) {
	return s.store.ListAdminAudit(ctx, limit)
}

type contextKey struct{}

// WithOperator 把操作者放进 context，供下游（如额度变更流水）记录操作者。
func WithOperator(ctx context.Context, op Operator) context.Context {
	return context.WithValue(ctx, contextKey{}, op)
}

// FromContext 取出 context 中的操作者。
func FromContext(ctx context.Context) (Operator, bool) {
	op, ok := ctx.Value(contextKey{}).(Operator)
	return op, ok
}

// ActorName 返回 context 中操作者的名称；没有操作者时为 SystemName。
func ActorName(ctx context.Context) string {
	if op, ok := FromContext(ctx); ok {
		return op.Name
	}
	return SystemName
}
