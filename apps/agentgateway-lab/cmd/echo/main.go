// Command echo is the lab upstream: it proves which headers reached the backend.
package main

import (
	"encoding/json"
	"flag"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	flag.Parse()

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok\n"))
	})
	// Fake OpenAI-compatible chat endpoint: it lets the lab exercise real
	// token accounting and cost attributes without a paid LLM upstream.
	mux.HandleFunc("/v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Model    string `json:"model"`
			Messages []struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"messages"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		model := req.Model
		if model == "" {
			model = "lab-model"
		}
		promptChars := 0
		for _, m := range req.Messages {
			promptChars += len(m.Content)
		}
		// Deterministic pseudo-token counts: 4 chars per token, 400 cached.
		promptTokens := int64(promptChars/4) + 40
		completionTokens := int64(len(req.Messages)*32 + 96)
		cached := int64(400)
		if cached > promptTokens {
			cached = promptTokens
		}
		resp := map[string]any{
			"id":      "chatcmpl-lab-" + strconv.FormatInt(time.Now().UnixNano(), 10),
			"object":  "chat.completion",
			"created": time.Now().Unix(),
			"model":   model,
			"choices": []any{map[string]any{
				"index": 0,
				"message": map[string]string{
					"role": "assistant",
					"content": "lab reply: prompt tokens=" + strconv.FormatInt(promptTokens, 10) +
						" cached=" + strconv.FormatInt(cached, 10),
				},
				"finish_reason": "stop",
			}},
			"usage": map[string]any{
				"prompt_tokens":     promptTokens,
				"completion_tokens": completionTokens,
				"total_tokens":      promptTokens + completionTokens,
				"prompt_tokens_details": map[string]any{
					"cached_tokens": cached,
				},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	})

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/echo" && r.URL.Query().Get("verbose") == "" && r.Header.Get("X-Echo-Verbose") == "" {
			_, _ = w.Write([]byte("agentgateway-k8s-ok\n"))
			return
		}
		headers := map[string][]string{}
		for k, v := range r.Header {
			headers[k] = v
		}
		keys := make([]string, 0, len(headers))
		for k := range headers {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		payload := map[string]any{
			"method":      r.Method,
			"path":        r.URL.Path,
			"query":       r.URL.RawQuery,
			"host":        r.Host,
			"remote":      r.RemoteAddr,
			"headers":     headers,
			"header_keys": strings.Join(keys, ","),
		}
		w.Header().Set("Content-Type", "application/json")
		enc := json.NewEncoder(w)
		enc.SetIndent("", "  ")
		_ = enc.Encode(payload)
	})

	log.Printf("echo-backend listening on %s", *addr)
	srv := &http.Server{Addr: *addr, Handler: mux, ReadHeaderTimeout: 10e9}
	if err := srv.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}
