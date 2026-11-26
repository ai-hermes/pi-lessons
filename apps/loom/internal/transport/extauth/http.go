package extauth

import (
	"io"
	"net/http"
	"strings"
)

// CheckPath 是 HTTP 门面的检查端点。
const CheckPath = "/check"

// HTTPHandler 处理网关的 HTTP 外挂鉴权：2xx 放行并通过响应头携带身份；
// 其他状态码与响应体由网关原样返回给调用方。
//
// 不限制方法：网关对无请求体的请求（如 GET）会以原方法调用 /check。
type HTTPHandler struct {
	gate Admitter
	opts Options
}

// NewHTTPHandler 创建 HTTP 门面。
func NewHTTPHandler(gate Admitter, opts Options) *HTTPHandler {
	return &HTTPHandler{gate: gate, opts: opts}
}

// ServeHTTP 实现 http.Handler。
func (h *HTTPHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, h.opts.BodyLimit+1))
	if err != nil || int64(len(body)) > h.opts.BodyLimit {
		http.Error(w, "request body too large", http.StatusRequestEntityTooLarge)
		return
	}
	headers := make(map[string]string, len(r.Header))
	for name, values := range r.Header {
		if len(values) > 0 {
			headers[strings.ToLower(name)] = values[0]
		}
	}

	verdict := h.gate.Admit(r.Context(), h.opts.request(headers, body, "http", r.URL.Path))
	resp := h.opts.response(verdict)

	for name, value := range resp.headers {
		w.Header().Set(name, value)
	}
	if resp.allowed {
		w.WriteHeader(http.StatusOK)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.status)
	_, _ = w.Write(resp.body)
}
