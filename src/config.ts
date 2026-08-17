import Schema from '@deepseek-ai/schemastery'

export interface Config {
  maxRequestBytes: number
  sseHeartbeatMs: number
  runtimeConcurrency: number
  directMemberChatDefault: boolean
}

export const Config: Schema<Config> = Schema.object({
  maxRequestBytes: Schema.number().min(1024).max(1024 * 1024).default(128 * 1024),
  sseHeartbeatMs: Schema.number().min(5_000).max(120_000).default(20_000),
  runtimeConcurrency: Schema.number().min(1).max(32).default(4),
  directMemberChatDefault: Schema.boolean().default(true),
})
