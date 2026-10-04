/**
 * 主键生成：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突。
 * 独立成文件，避免 db.ts 与 migrate.ts 之间的循环依赖。
 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}
