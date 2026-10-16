import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { ProtocolError } from './protocol-contract.mjs'

interface HookMetadata {
  readonly key: string
  readonly eventName: string
  readonly handlerType: 'command' | 'prompt' | 'agent'
  readonly matcher: string | null
  readonly command: string | null
  readonly timeoutSec: number
  readonly statusMessage: string | null
  readonly sourcePath: string
  readonly source: 'system' | 'user' | 'project' | 'plugin' | 'unknown'
  readonly pluginId: string | null
  readonly displayOrder: number
  readonly enabled: boolean
  readonly isManaged: boolean
  readonly currentHash: string
  readonly trustStatus: 'managed' | 'untrusted' | 'trusted' | 'modified'
}

interface HooksListEntry {
  readonly cwd: string
  readonly hooks: readonly HookMetadata[]
  readonly warnings: readonly string[]
  readonly errors: ReadonlyArray<{ readonly path: string; readonly message: string }>
}

// Claude events without a Codex hook surface, such as Notification, are intentionally dropped.
const HOOK_EVENT_MAP: Record<string, string> = {
  PreToolUse: 'preToolUse',
  PostToolUse: 'postToolUse',
  PermissionRequest: 'permissionRequest',
  PreCompact: 'preCompact',
  PostCompact: 'postCompact',
  SessionStart: 'sessionStart',
  SessionEnd: 'sessionEnd',
  SubagentStart: 'subagentStart',
  SubagentStop: 'subagentStop',
  UserPromptSubmit: 'userPromptSubmit',
  Stop: 'stop',
}

export function listClaudeHooks(
  params: Record<string, unknown>,
  fallback = process.cwd(),
): HooksListEntry[] {
  const roots = cwdsFromParams(params, fallback)
  const userSources = [
    {
      path: join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json'),
      source: 'user' as const,
    },
  ]
  return roots.map((cwd) => {
    const sources = [
      ...userSources,
      { path: join(cwd, '.claude', 'settings.json'), source: 'project' as const },
      { path: join(cwd, '.claude', 'settings.local.json'), source: 'project' as const },
    ]
    const hooks: HookMetadata[] = []
    const warnings: string[] = []
    const errors: Array<{ path: string; message: string }> = []
    let order = 0
    let disabled = false
    for (const { path, source } of sources) {
      if (!existsSync(path)) continue
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(readFileSync(path, 'utf8'))
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
          throw new Error('Hook 配置必须是对象')
      } catch (error) {
        errors.push({ path, message: messageOf(error) })
        continue
      }
      if (typeof parsed.disableAllHooks === 'boolean') disabled = parsed.disableAllHooks
      const hookConfig = asRecord(parsed.hooks)
      for (const [claudeEvent, eventName] of Object.entries(HOOK_EVENT_MAP)) {
        const matchers = hookConfig[claudeEvent]
        if (!Array.isArray(matchers)) continue
        for (const rawMatcher of matchers) {
          const matcherEntry = asRecord(rawMatcher)
          const matcher = typeof matcherEntry.matcher === 'string' ? matcherEntry.matcher : null
          const handlers = Array.isArray(matcherEntry.hooks) ? matcherEntry.hooks : []
          for (const rawHandler of handlers) {
            const handler = asRecord(rawHandler)
            if (!['command', 'prompt', 'agent'].includes(String(handler.type))) {
              warnings.push(
                `${path}: ${claudeEvent} 的 ${String(handler.type)} Hook 无对应的客户端处理器类型`,
              )
              continue
            }
            const handlerType = handler.type as 'command' | 'prompt' | 'agent'
            const command = typeof handler.command === 'string' ? handler.command : null
            if (
              (handlerType === 'command' && !command) ||
              (handlerType !== 'command' && typeof handler.prompt !== 'string') ||
              (handler.timeout != null &&
                (typeof handler.timeout !== 'number' ||
                  !Number.isSafeInteger(handler.timeout) ||
                  handler.timeout < 0))
            ) {
              errors.push({ path, message: `${claudeEvent} 的 Hook 命令、提示词或超时无效` })
              continue
            }
            hooks.push({
              key: `${source}:${eventName}:${order}`,
              eventName,
              handlerType,
              matcher,
              command,
              // 原生默认值：https://code.claude.com/docs/en/hooks#common-fields
              timeoutSec:
                typeof handler.timeout === 'number'
                  ? handler.timeout
                  : handlerType === 'prompt' || claudeEvent === 'UserPromptSubmit'
                    ? 30
                    : handlerType === 'agent'
                      ? 60
                      : 600,
              statusMessage:
                typeof handler.statusMessage === 'string' ? handler.statusMessage : null,
              sourcePath: path,
              source,
              pluginId: null,
              displayOrder: order,
              enabled: true,
              isManaged: false,
              currentHash: createHash('sha256')
                .update(JSON.stringify([eventName, matcher, handler]))
                .digest('hex'),
              trustStatus: 'trusted',
            })
            order += 1
          }
        }
      }
    }
    return { cwd, hooks: hooks.map((hook) => ({ ...hook, enabled: !disabled })), warnings, errors }
  })
}

function cwdsFromParams(params: Record<string, unknown>, fallback: string): string[] {
  if (params.cwds == null) return [fallback]
  if (
    !Array.isArray(params.cwds) ||
    params.cwds.some((cwd) => typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.includes('\0'))
  )
    throw new ProtocolError(-32602, 'cwds 必须是绝对路径字符串数组')
  return params.cwds.length ? [...new Set(params.cwds as string[])] : [fallback]
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
