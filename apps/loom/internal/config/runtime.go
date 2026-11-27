package config

import (
	"os"
	"sync/atomic"
)

var current atomic.Pointer[Config]

// Init 按 --config → LOOM_CONFIG → ./config.yaml 的顺序加载进程配置。
// 只有加载和校验全部成功后，Current 才会切换到新配置。
func Init(path string) (*Config, error) {
	if path == "" {
		path = os.Getenv("LOOM_CONFIG")
	}
	if path == "" {
		if _, err := os.Stat("config.yaml"); err == nil {
			path = "config.yaml"
		}
	}

	cfg, err := Load(path)
	if err != nil {
		return nil, err
	}
	current.Store(cfg)
	return cfg, nil
}

// MustGet 返回最近一次 Init 成功加载的配置。
// 启动流程必须先调用 Init；未初始化表示程序装配错误，因此直接 panic。
func MustGet() *Config {
	cfg := current.Load()
	if cfg == nil {
		panic("config: MustGet called before Init")
	}
	return cfg
}
