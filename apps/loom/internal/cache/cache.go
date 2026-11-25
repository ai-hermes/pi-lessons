// Package cache 提供带 TTL 的 LRU 缓存封装，用于 Key 查找、负缓存、定价与账户。
package cache

import (
	"time"

	lru "github.com/hashicorp/golang-lru/v2/expirable"
)

// TTLCache 是对 expirable.LRU 的薄封装：Get 返回值与是否命中。
type TTLCache[K comparable, V any] struct {
	lru *lru.LRU[K, V]
}

// New 创建容量 size、TTL ttl 的缓存。
func New[K comparable, V any](size int, ttl time.Duration) *TTLCache[K, V] {
	if ttl < time.Second {
		ttl = time.Second // expirable.LRU 内部按 ttl 分桶，过小会 panic
	}
	return &TTLCache[K, V]{lru: lru.NewLRU[K, V](size, nil, ttl)}
}

// Get 读取。
func (c *TTLCache[K, V]) Get(k K) (V, bool) {
	if c == nil || c.lru == nil {
		var zero V
		return zero, false
	}
	return c.lru.Get(k)
}

// Add 写入。
func (c *TTLCache[K, V]) Add(k K, v V) {
	if c == nil || c.lru == nil {
		return
	}
	c.lru.Add(k, v)
}

// Remove 删除。
func (c *TTLCache[K, V]) Remove(k K) {
	if c == nil || c.lru == nil {
		return
	}
	c.lru.Remove(k)
}

// Len 当前条目数。
func (c *TTLCache[K, V]) Len() int {
	if c == nil || c.lru == nil {
		return 0
	}
	return c.lru.Len()
}

// Enabled 判断缓存是否启用；禁用时调用方应持有 nil 指针，Get 永远未命中。
func (c *TTLCache[K, V]) Enabled() bool { return c != nil && c.lru != nil }
