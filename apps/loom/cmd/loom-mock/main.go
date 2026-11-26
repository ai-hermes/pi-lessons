// Command loom-mock 是验证用的伪 OpenAI 后端：chat（流式/非流式）、embeddings、images，token 用量由请求确定性推导，
// 便于断言精确金额；/echo 原样回显请求头，用于验证网关是否删除了凭据头。
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

type usage struct {
	PromptTokens        int64          `json:"prompt_tokens"`
	CompletionTokens    int64          `json:"completion_tokens"`
	TotalTokens         int64          `json:"total_tokens"`
	PromptTokensDetails map[string]any `json:"prompt_tokens_details"`
}

var (
	inTokens   = envInt("MOCK_INPUT_TOKENS", 1000)
	outTokens  = envInt("MOCK_OUTPUT_TOKENS", 500)
	cachedToks = envInt("MOCK_CACHED_TOKENS", 200)
	addr       = envStr("MOCK_ADDR", ":8080")
)

func main() {
	flag.Parse()
	mux := http.NewServeMux()
	for _, prefix := range []string{"/v1", "/pg/v1"} {
		mux.HandleFunc("POST "+prefix+"/chat/completions", chat)
		mux.HandleFunc("POST "+prefix+"/completions", chat)
		mux.HandleFunc("POST "+prefix+"/embeddings", embeddings)
		mux.HandleFunc("POST "+prefix+"/images/generations", images)
		mux.HandleFunc("POST "+prefix+"/contents/generations/tasks", images)
	}
	mux.HandleFunc("/echo", echo)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) })
	log.Printf("loom-mock listening on %s (in=%d cached=%d out=%d)", addr, inTokens, cachedToks, outTokens)
	log.Fatal(http.ListenAndServe(addr, mux))
}

type chatReq struct {
	Model     string `json:"model"`
	Stream    bool   `json:"stream"`
	MockUsage *struct {
		Input  int64 `json:"input"`
		Output int64 `json:"output"`
		Cached int64 `json:"cached"`
	} `json:"mock_usage"`
}

func (r chatReq) usage() usage {
	in, out, cached := int64(inTokens), int64(outTokens), int64(cachedToks)
	if r.MockUsage != nil {
		in, out, cached = r.MockUsage.Input, r.MockUsage.Output, r.MockUsage.Cached
	}
	return usage{PromptTokens: in, CompletionTokens: out, TotalTokens: in + out,
		PromptTokensDetails: map[string]any{"cached_tokens": int(cached)}}
}

func chat(w http.ResponseWriter, r *http.Request) {
	var req chatReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpError(w, 400, "invalid_json", err.Error())
		return
	}
	if req.Model == "" {
		httpError(w, 400, "MissingParameter", "model is required")
		return
	}
	u := req.usage()
	id := fmt.Sprintf("chatcmpl-mock-%d", time.Now().UnixNano())
	if req.Stream {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		flusher, _ := w.(http.Flusher)
		chunk := func(delta string, finish string) string {
			c := map[string]any{
				"id": id, "object": "chat.completion.chunk", "created": time.Now().Unix(), "model": req.Model,
				"choices": []map[string]any{
					{"index": 0, "delta": map[string]string{"content": delta}, "finish_reason": finish},
				},
			}
			b, _ := json.Marshal(c)
			return "data: " + string(b) + "\n\n"
		}
		_, _ = fmt.Fprint(w, chunk("OK", ""))
		if flusher != nil {
			flusher.Flush()
		}
		final := map[string]any{
			"id": id, "object": "chat.completion.chunk", "created": time.Now().Unix(), "model": req.Model,
			"choices": []map[string]any{{"index": 0, "delta": map[string]string{}, "finish_reason": "stop"}},
			"usage":   u,
		}
		b, _ := json.Marshal(final)
		_, _ = fmt.Fprint(w, "data: "+string(b)+"\n\n")
		_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
		return
	}
	resp := map[string]any{
		"id": id, "object": "chat.completion", "created": time.Now().Unix(), "model": req.Model,
		"choices": []map[string]any{
			{"index": 0, "message": map[string]string{"role": "assistant", "content": "OK"}, "finish_reason": "stop"},
		},
		"usage": u,
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

func embeddings(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Model string `json:"model"`
		Input []any  `json:"input"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Model == "" {
		httpError(w, 400, "MissingParameter", "model is required")
		return
	}
	n := len(req.Input)
	if n == 0 {
		n = 1
	}
	data := make([]map[string]any, 0, n)
	for i := 0; i < n; i++ {
		vec := make([]float64, 8)
		for j := range vec {
			vec[j] = 0.1
		}
		data = append(data, map[string]any{"object": "embedding", "index": i, "embedding": vec})
	}
	u := chatReq{}.usage()
	u.PromptTokens, u.CompletionTokens, u.TotalTokens = int64(n)*10, 0, int64(n)*10
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"object": "list", "data": data, "model": req.Model, "usage": u})
}

func images(w http.ResponseWriter, r *http.Request) {
	var req map[string]any
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req["model"] == nil {
		httpError(w, 400, "MissingParameter", "model is required")
		return
	}
	model, _ := req["model"].(string)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"created": time.Now().Unix(),
		"data":    []map[string]string{{"url": "https://example.invalid/mock.png"}},
		"model":   model,
	})
}

func echo(w http.ResponseWriter, r *http.Request) {
	headers := map[string]string{}
	for k, v := range r.Header {
		headers[strings.ToLower(k)] = strings.Join(v, ",")
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"method": r.Method, "path": r.URL.Path, "headers": headers})
}

func httpError(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	body := map[string]any{"error": map[string]any{"code": code, "message": msg, "type": "invalid_request_error"}}
	_ = json.NewEncoder(w).Encode(body)
}

func envInt(k string, def int64) int64 {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			return n
		}
	}
	return def
}

func envStr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
