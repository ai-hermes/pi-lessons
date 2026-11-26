// Package migrations 以 embed.FS 形式携带 goose 迁移脚本，供二进制启动时自动执行。
package migrations

import "embed"

// FS 嵌入的迁移脚本目录。
//
//go:embed *.sql
var FS embed.FS
