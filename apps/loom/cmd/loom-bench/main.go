// Command loom-bench 是 loom 的压测工具：按固定并发向网关发送 OpenAI chat 请求，
// 统计吞吐、状态码分布与端到端延迟分位数。
//
// 多个 API Key 用逗号分隔，请求按轮询分摊到各个 Key（模拟多账户）；只给一个 Key 时测的是单账户热点。
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type options struct {
	url         string
	keys        []string
	model       string
	stream      bool
	concurrency int
	duration    time.Duration
	timeout     time.Duration
}

type result struct {
	latency time.Duration
	status  int // 0 表示传输层错误
}

func main() {
	opts := parseFlags()
	results := run(opts)
	report(os.Stdout, opts, results)
}

func parseFlags() options {
	var opts options
	var keys string
	flag.StringVar(&opts.url, "url", "http://127.0.0.1:14001/v1/chat/completions", "chat completions endpoint")
	flag.StringVar(&keys, "keys", "", "comma-separated API keys, used round-robin")
	flag.StringVar(&opts.model, "model", "lab-model", "model name")
	flag.BoolVar(&opts.stream, "stream", false, "request streaming responses")
	flag.IntVar(&opts.concurrency, "c", 8, "concurrent workers")
	flag.DurationVar(&opts.duration, "d", 15*time.Second, "test duration")
	flag.DurationVar(&opts.timeout, "timeout", 30*time.Second, "per-request timeout")
	flag.Parse()

	opts.keys = strings.Split(keys, ",")
	if keys == "" || opts.concurrency < 1 {
		fmt.Fprintln(os.Stderr, "usage: loom-bench -keys KEY[,KEY...] [-c 8] [-d 15s] [-stream]")
		os.Exit(2)
	}
	return opts
}

func run(opts options) []result {
	body, _ := json.Marshal(map[string]any{
		"model":    opts.model,
		"stream":   opts.stream,
		"messages": []map[string]string{{"role": "user", "content": "hi"}},
	})
	transport := &http.Transport{MaxIdleConnsPerHost: opts.concurrency, MaxConnsPerHost: opts.concurrency}
	client := &http.Client{Transport: transport, Timeout: opts.timeout}

	ctx, cancel := context.WithTimeout(context.Background(), opts.duration)
	defer cancel()

	var (
		mu      sync.Mutex
		results []result
		next    atomic.Uint64
		wg      sync.WaitGroup
	)
	for range opts.concurrency {
		wg.Go(func() {
			local := make([]result, 0, 1024)
			for ctx.Err() == nil {
				key := opts.keys[next.Add(1)%uint64(len(opts.keys))]
				local = append(local, send(client, opts.url, key, body))
			}
			mu.Lock()
			results = append(results, local...)
			mu.Unlock()
		})
	}
	wg.Wait()
	return results
}

func send(client *http.Client, url, key string, body []byte) result {
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return result{}
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")

	start := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		return result{latency: time.Since(start)}
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
	return result{latency: time.Since(start), status: resp.StatusCode}
}

func report(w io.Writer, opts options, results []result) {
	statuses := map[int]int{}
	latencies := make([]time.Duration, 0, len(results))
	for _, r := range results {
		statuses[r.status]++
		if r.status == http.StatusOK {
			latencies = append(latencies, r.latency)
		}
	}
	slices.Sort(latencies)

	rps := float64(len(results)) / opts.duration.Seconds()
	_, _ = fmt.Fprintf(w, "keys=%d c=%d d=%s stream=%v requests=%d rps=%.1f\n",
		len(opts.keys), opts.concurrency, opts.duration, opts.stream, len(results), rps)
	_, _ = fmt.Fprintf(w, "status %v\n", statuses)
	if len(latencies) == 0 {
		return
	}
	_, _ = fmt.Fprintf(w, "latency_ms p50=%.1f p90=%.1f p99=%.1f max=%.1f\n",
		ms(percentile(latencies, 0.50)),
		ms(percentile(latencies, 0.90)),
		ms(percentile(latencies, 0.99)),
		ms(latencies[len(latencies)-1]),
	)
}

func percentile(sorted []time.Duration, p float64) time.Duration {
	return sorted[min(int(float64(len(sorted))*p), len(sorted)-1)]
}

func ms(d time.Duration) float64 { return float64(d.Microseconds()) / 1000 }
