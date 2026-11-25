// Package auth 实现鉴权决策引擎（协议无关）以及 HTTP / gRPC 两个门面共用的类型。
package auth

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/ai-hermes/pi-lessons/apps/loom/pkg/loom"
)

// Request 一次鉴权请求的协议无关表示。
type Request struct {
	Headers         map[string]string // 键统一小写
	Body            []byte
	Path            string
	Method          string
	Source          string // http | grpc
	ClientRequestID string
	Now             time.Time
}

// Decision 鉴权结论。
type Decision struct {
	Allow        bool
	Status       int
	Reason       string
	Headers      map[string]string
	Body         []byte
	KeyID        uuid.UUID
	AccountID    uuid.UUID
	ClientID     string
	KeyPreview   string
	Model        string
	RequestID    string
	ReserveNanos int64
}

// HashKey 对明文 key 做 sha256。
func HashKey(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

// Credential 从请求头提取凭据：Authorization: Bearer xxx 优先，其次裸 key 头（默认 x-api-key）。
func Credential(headers map[string]string, sources []string) (string, bool) {
	for _, h := range sources {
		v, ok := headers[strings.ToLower(h)]
		if !ok || v == "" {
			continue
		}
		lower := strings.ToLower(v)
		if strings.HasPrefix(lower, "bearer ") {
			v = strings.TrimSpace(v[7:])
		}
		if v != "" {
			return v, true
		}
	}
	return "", false
}

type bodyModel struct {
	Model string `json:"model"`
}

// ExtractModel 解析模型名：优先网关 CEL 注入的头，其次请求体 JSON 的 model 字段。
func ExtractModel(headers map[string]string, body []byte) string {
	if v := headers[loom.HdrModel]; v != "" {
		return v
	}
	if len(body) == 0 || body[0] != '{' {
		return ""
	}
	var b bodyModel
	if err := json.Unmarshal(body, &b); err != nil {
		return ""
	}
	return b.Model
}

// ErrorBody 生成 OpenAI 风格错误体。
type errorBody struct {
	Error errorValue `json:"error"`
}

type errorValue struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Type    string `json:"type"`
}

// ErrorBody 返回 OpenAI 风格错误体。
func ErrorBody(reason, message string) []byte {
	typ := "auth_error"
	switch reason {
	case loom.ReasonInsufficientQuota:
		typ = "quota_error"
	case loom.ReasonModelNotAllowed, loom.ReasonModelNotPriced:
		typ = "model_error"
	case loom.ReasonInternalError:
		typ = "server_error"
	}
	b, _ := json.Marshal(errorBody{Error: errorValue{Code: reason, Message: message, Type: typ}})
	return b
}

// NewRequestID 生成 loom 请求 ID。
func NewRequestID() string { return uuid.NewString() }
