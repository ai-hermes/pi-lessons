package auth

import (
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/ai-hermes/pi-lessons/apps/loom/pkg/loom"
)

// HTTPHandler 返回 extAuth HTTP 门面处理器：网关 POST /check，2xx 放行并复制 identity headers，其他状态码原样回给调用方。
func (e *Engine) HTTPHandler(ready func() bool) http.Handler {
	mux := http.NewServeMux()
	// 网关对无请求体的请求（如 GET /echo）可能以原方法发起 /check，因此不限方法
	mux.HandleFunc("/check", e.handleCheck)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		if ready != nil && !ready() {
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte("not ready"))
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ready"))
	})
	return mux
}

func (e *Engine) handleCheck(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, e.cfg.BodyLimit+1))
	if err != nil || int64(len(body)) > e.cfg.BodyLimit {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	headers := make(map[string]string, len(r.Header))
	for k, v := range r.Header {
		if len(v) > 0 {
			headers[strings.ToLower(k)] = v[0]
		}
	}
	dec := e.Evaluate(r.Context(), Request{Headers: headers, Body: body, Path: headers[":path"], Method: r.Method,
		Source: "http", ClientRequestID: r.Header.Get(loom.HdrClientReqID), Now: time.Now()})
	for k, v := range dec.Headers {
		w.Header().Set(k, v)
	}
	if dec.Allow {
		w.WriteHeader(http.StatusOK)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(dec.Status)
	_, _ = w.Write(dec.Body)
}
