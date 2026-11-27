// Command loom-mock 是验收用的伪 OpenAI 后端：chat（流式 / 非流式）、embeddings、images 与 /echo。
// token 用量固定（可由环境变量或请求体 mock_usage 覆盖），便于断言精确金额；
// /echo 原样回显收到的请求头，用于验证网关是否删除了调用方凭据。
//
// 契约测试用请求头（chat）：
//   - x-mock-status：非 2xx 时直接返回该状态码与 OpenAI 风格错误体，不产生用量；
//   - x-mock-stream-chunks / x-mock-stream-delay-ms：流式输出的内容 chunk 数与间隔，
//     用于在带 usage 的结束 chunk 之前断开客户端。
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

var (
	addr         = envString("MOCK_ADDR", ":8080")
	defaultUsage = usageOverride{
		Input:  envInt("MOCK_INPUT_TOKENS", 1000),
		Output: envInt("MOCK_OUTPUT_TOKENS", 500),
		Cached: envInt("MOCK_CACHED_TOKENS", 200),
	}
)

func main() {
	mux := http.NewServeMux()
	for _, prefix := range []string{"/v1", "/pg/v1"} {
		mux.HandleFunc("POST "+prefix+"/chat/completions", chat)
		mux.HandleFunc("POST "+prefix+"/completions", chat)
		mux.HandleFunc("POST "+prefix+"/embeddings", embeddings)
		mux.HandleFunc("POST "+prefix+"/images/generations", images)
		mux.HandleFunc("POST "+prefix+"/contents/generations/tasks", images)
	}
	mux.HandleFunc("/echo", echo)
	mux.HandleFunc("/healthz", healthz)

	log.Printf(
		"loom-mock listening on %s (in=%d cached=%d out=%d)",
		addr,
		defaultUsage.Input,
		defaultUsage.Cached,
		defaultUsage.Output,
	)
	server := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	log.Fatal(server.ListenAndServe())
}

// ---- OpenAI 响应结构 ----

type openAIUsage struct {
	PromptTokens        int64        `json:"prompt_tokens"`
	CompletionTokens    int64        `json:"completion_tokens"`
	TotalTokens         int64        `json:"total_tokens"`
	PromptTokensDetails promptDetail `json:"prompt_tokens_details"`
}

type promptDetail struct {
	CachedTokens int64 `json:"cached_tokens"`
}

type message struct {
	Role    string `json:"role,omitempty"`
	Content string `json:"content,omitempty"`
}

type choice struct {
	Index        int      `json:"index"`
	Message      *message `json:"message,omitempty"`
	Delta        *message `json:"delta,omitempty"`
	FinishReason *string  `json:"finish_reason"`
}

type completion struct {
	ID      string       `json:"id"`
	Object  string       `json:"object"`
	Created int64        `json:"created"`
	Model   string       `json:"model"`
	Choices []choice     `json:"choices"`
	Usage   *openAIUsage `json:"usage,omitempty"`
}

// ---- 请求 ----

type usageOverride struct {
	Input  int64 `json:"input"`
	Output int64 `json:"output"`
	Cached int64 `json:"cached"`
}

type chatRequest struct {
	Model     string         `json:"model"`
	Stream    bool           `json:"stream"`
	MockUsage *usageOverride `json:"mock_usage"` // 测试用：覆盖固定用量
}

func (r chatRequest) usage() openAIUsage {
	t := defaultUsage
	if r.MockUsage != nil {
		t = *r.MockUsage
	}
	return openAIUsage{
		PromptTokens:        t.Input,
		CompletionTokens:    t.Output,
		TotalTokens:         t.Input + t.Output,
		PromptTokensDetails: promptDetail{CachedTokens: t.Cached},
	}
}

// ---- handlers ----

func chat(w http.ResponseWriter, r *http.Request) {
	var req chatRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpError(w, http.StatusBadRequest, "invalid_json", err.Error())
		return
	}
	if req.Model == "" {
		httpError(w, http.StatusBadRequest, "MissingParameter", "model is required")
		return
	}

	if status := headerInt(r, "x-mock-status", http.StatusOK); status >= http.StatusMultipleChoices {
		httpError(w, int(status), "mock_upstream_error", "upstream failure requested by x-mock-status")
		return
	}

	tokenUsage := req.usage()
	id := fmt.Sprintf("chatcmpl-mock-%d", time.Now().UnixNano())
	stop := "stop"
	if req.Stream {
		pacing := streamPacing{
			contentChunks: max(headerInt(r, "x-mock-stream-chunks", 1), 1),
			delay:         time.Duration(headerInt(r, "x-mock-stream-delay-ms", 0)) * time.Millisecond,
		}
		streamChat(r.Context(), w, id, req.Model, tokenUsage, pacing)
		return
	}
	writeJSON(w, completion{
		ID:      id,
		Object:  "chat.completion",
		Created: time.Now().Unix(),
		Model:   req.Model,
		Choices: []choice{{Message: &message{Role: "assistant", Content: "OK"}, FinishReason: &stop}},
		Usage:   &tokenUsage,
	})
}

// streamPacing 控制流式输出的节奏。
type streamPacing struct {
	contentChunks int64
	delay         time.Duration
}

// streamChat 依次输出内容 chunk、带 usage 的结束 chunk 和 [DONE]；客户端断开后立即停止。
func streamChat(
	ctx context.Context,
	w http.ResponseWriter,
	id, model string,
	tokenUsage openAIUsage,
	pacing streamPacing,
) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	flusher, _ := w.(http.Flusher)

	stop := "stop"
	chunks := make([]completion, 0, pacing.contentChunks+1)
	for range pacing.contentChunks {
		chunks = append(chunks, completion{Choices: []choice{{Delta: &message{Content: "OK"}}}})
	}
	chunks = append(chunks, completion{
		Choices: []choice{{Delta: &message{}, FinishReason: &stop}},
		Usage:   &tokenUsage,
	})
	for i, c := range chunks {
		if i > 0 && pacing.delay > 0 {
			select {
			case <-ctx.Done():
				return
			case <-time.After(pacing.delay):
			}
		}
		c.ID = id
		c.Object = "chat.completion.chunk"
		c.Created = time.Now().Unix()
		c.Model = model
		b, _ := json.Marshal(c)
		if _, err := fmt.Fprintf(w, "data: %s\n\n", b); err != nil {
			return
		}
		if flusher != nil {
			flusher.Flush()
		}
	}
	_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
}

func embeddings(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Model string `json:"model"`
		Input []any  `json:"input"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Model == "" {
		httpError(w, http.StatusBadRequest, "MissingParameter", "model is required")
		return
	}

	type embedding struct {
		Object    string    `json:"object"`
		Index     int       `json:"index"`
		Embedding []float64 `json:"embedding"`
	}
	n := max(len(req.Input), 1)
	data := make([]embedding, 0, n)
	for i := range n {
		vector := []float64{0.1, 0.1, 0.1, 0.1}
		data = append(data, embedding{Object: "embedding", Index: i, Embedding: vector})
	}
	promptTokens := int64(n) * 10
	writeJSON(w, map[string]any{
		"object": "list",
		"data":   data,
		"model":  req.Model,
		"usage":  openAIUsage{PromptTokens: promptTokens, TotalTokens: promptTokens},
	})
}

func images(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Model string `json:"model"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Model == "" {
		httpError(w, http.StatusBadRequest, "MissingParameter", "model is required")
		return
	}
	writeJSON(w, map[string]any{
		"created": time.Now().Unix(),
		"data":    []map[string]string{{"url": "https://example.invalid/mock.png"}},
		"model":   req.Model,
	})
}

func echo(w http.ResponseWriter, r *http.Request) {
	headers := make(map[string]string, len(r.Header))
	for name, values := range r.Header {
		headers[strings.ToLower(name)] = strings.Join(values, ",")
	}
	writeJSON(w, map[string]any{"method": r.Method, "path": r.URL.Path, "headers": headers})
}

func healthz(w http.ResponseWriter, _ *http.Request) {
	_, _ = w.Write([]byte("ok"))
}

// ---- helpers ----

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func httpError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	body := map[string]any{"error": map[string]string{"code": code, "message": message, "type": "invalid_request_error"}}
	_ = json.NewEncoder(w).Encode(body)
}

func envInt(name string, fallback int64) int64 {
	if n, err := strconv.ParseInt(os.Getenv(name), 10, 64); err == nil {
		return n
	}
	return fallback
}

func envString(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

// headerInt 读取整数请求头；缺失或非法时返回 fallback。
func headerInt(r *http.Request, name string, fallback int64) int64 {
	if n, err := strconv.ParseInt(r.Header.Get(name), 10, 64); err == nil {
		return n
	}
	return fallback
}
