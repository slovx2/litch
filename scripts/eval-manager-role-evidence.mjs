// 只整理可观察事实，不评判经理角色；所有持久化输出统一脱敏并去掉思考块。
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { git } from './eval-manager-role-fixture.mjs'

export function evidenceWriter(output, token) {
  const secrets = token ? [token, encodeURIComponent(token)] : []
  const scrubText = (text) => {
    let result = text
    for (const secret of secrets) result = result.replaceAll(secret, '[REDACTED]')
    return result
      .replace(/(Bearer\s+)[^\s"\\]+/gi, '$1[REDACTED]')
      .replace(
        /((?:ANTHROPIC_\w*(?:KEY|TOKEN)|EVAL_ANTHROPIC_TOKEN|x-api-key|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
        '$1[REDACTED]',
      )
  }
  const clean = (value) => {
    if (typeof value === 'string') return scrubText(value)
    if (Array.isArray(value)) return value.map(clean).filter((item) => item !== undefined)
    if (!value || typeof value !== 'object') return value
    if (/reasoning|thinking|redacted_thinking/i.test(value.type ?? '')) return undefined
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, entry]) => {
        if (/thinking|reasoning|signature/i.test(key)) return []
        if (/^(?:headers|environment|env|apiKey|token|authorization)$/i.test(key))
          return [[key, '[REDACTED]']]
        const safe = clean(entry)
        return safe === undefined ? [] : [[key, safe]]
      }),
    )
  }
  return {
    clean,
    write(name, value) {
      const target = join(output, name)
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
      writeFileSync(
        target,
        typeof value === 'string' ? scrubText(value) : `${JSON.stringify(clean(value), null, 2)}\n`,
        { mode: 0o600 },
      )
    },
  }
}

export const itemText = (item) =>
  item.type === 'agentMessage'
    ? (item.text ?? '')
    : (Array.isArray(item.content) ? item.content : [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n')

export function toolOf(item) {
  if (item.type === 'dynamicToolCall')
    return {
      name: [item.namespace, item.tool].filter(Boolean).join('.'),
      arguments: item.arguments,
      result: item.contentItems,
      status: item.status,
    }
  if (item.type === 'mcpToolCall')
    return {
      name: `${item.server}.${item.tool}`,
      arguments: item.arguments,
      result: item.result ?? item.error,
      status: item.status,
    }
  if (item.type === 'commandExecution')
    return {
      name: 'Bash',
      arguments: { command: item.command, cwd: item.cwd },
      result: item.aggregatedOutput,
      status: item.status,
      exitCode: item.exitCode,
    }
  if (item.type === 'fileChange')
    return { name: 'fileChange', arguments: item.changes, result: item.status, status: item.status }
  if (item.type === 'webSearch')
    return { name: 'WebSearch', arguments: item.action, result: item.query }
  return null
}

export function turnEvidence(turn, frames, threadId) {
  const related = frames.filter(
    (frame) => frame.params?.threadId === threadId && frame.params?.turnId === turn.id,
  )
  const started = frames.find(
    (frame) =>
      frame.method === 'turn/started' &&
      frame.params?.threadId === threadId &&
      frame.params?.turn?.id === turn.id,
  )
  const ended = frames.find(
    (frame) =>
      frame.method === 'turn/completed' &&
      frame.params?.threadId === threadId &&
      frame.params?.turn?.id === turn.id,
  )
  return {
    ...turn,
    input: turn.items
      .filter((item) => item.type === 'userMessage')
      .map(itemText)
      .join('\n'),
    reply: turn.items
      .filter((item) => item.type === 'agentMessage')
      .map(itemText)
      .join('\n\n'),
    tools: turn.items.map(toolOf).filter(Boolean),
    elapsedMs: started && ended ? ended.at - started.at : null,
    tokenUsage: related
      .filter((frame) => frame.method === 'thread/tokenUsage/updated')
      .map((frame) => frame.params.tokenUsage),
  }
}

export function repositoryEvidence(cwd, env) {
  return {
    cwd,
    head: git(cwd, env, 'rev-parse', 'HEAD'),
    status: git(cwd, env, 'status', '--porcelain=v1', '--untracked-files=all'),
    diff: git(cwd, env, 'diff', 'HEAD'),
    log: git(cwd, env, 'log', '--all', '--oneline'),
    worktrees: git(cwd, env, 'worktree', 'list', '--porcelain'),
  }
}

export function boardChanges(before, after) {
  const old = new Map(
    [...(before?.decisions ?? []), ...(before?.items ?? [])].map((item) => [item.id, item]),
  )
  const changes = []
  for (const item of [...(after?.decisions ?? []), ...(after?.items ?? [])]) {
    const previous = old.get(item.id)
    if (!previous) changes.push(`新增 ${item.id}：${item.title}（${item.status}）`)
    else if (JSON.stringify(item) !== JSON.stringify(previous)) {
      const fields = Object.keys(item).filter(
        (key) => JSON.stringify(item[key]) !== JSON.stringify(previous[key]),
      )
      changes.push(
        `改动 ${item.id}：${item.title}；${previous.status} → ${item.status}；字段 ${fields.join('、')}`,
      )
    }
    old.delete(item.id)
  }
  for (const id of old.keys()) changes.push(`本次快照不再包含 ${id}`)
  if (before?.situation?.text !== after?.situation?.text)
    changes.push(`现状：${after?.situation?.text ?? '无'}`)
  return changes
}

const pretty = (value) => JSON.stringify(value, null, 2)
export function transcriptMarkdown(turns) {
  return turns
    .map((turn) =>
      [
        `### 回合 ${turn.id} · ${turn.status}`,
        `用时：${turn.elapsedMs ?? '未取得'} ms；token 用量：${pretty(turn.tokenUsage)}`,
        `输入：\n\n${turn.input || '未取得'}`,
        `回复：\n\n${turn.reply || '（无正文）'}`,
        '工具调用：',
        ...turn.tools.map(
          (tool) =>
            `- ${tool.name} · ${tool.status ?? ''}\n\n参数：\n\n\`\`\`json\n${pretty(tool.arguments)}\n\`\`\`\n\n结果摘要：\n\n\`\`\`\n${pretty(tool.result)?.slice(0, 2400) ?? '未取得'}\n\`\`\``,
        ),
      ].join('\n\n'),
    )
    .join('\n\n')
}

export function digest(run, steps, frames) {
  const turns = steps.flatMap((step) => step.turns ?? [])
  const lines = [
    `# 经理角色评测证据`,
    `模式：${run.fake ? '回环假模型：只验证驱动，触发回合不代表角色表现' : '真实模型（人工评判）'}`,
    `模型：${run.model}；小模型：${run.smallModel}`,
    `审批：${run.approval}`,
    '计时取客户端收到的回合开始/结束通知；缺失为 null。token 保留设备通知原值，不把累计值当单回合相加。',
  ]
  for (const step of steps) {
    lines.push(
      `## ${step.number}. ${step.title}`,
      `输入：${step.input}`,
      `状态：${step.status}；步骤用时 ${step.elapsedMs} ms`,
      ...(step.notes ?? []),
      ...(step.errors ?? []).map((error) => `记录异常：${error}`),
      transcriptMarkdown(step.turns ?? []),
      '看板变化：',
      ...(step.changes?.length ? step.changes : ['无可观察变化']).map((change) => `- ${change}`),
      `本步新开线：${step.newLines?.map((line) => `${line.threadId}（${line.title}，${line.branch ?? '分支未知'}）`).join('；') || '无'}`,
      `证据：[步骤目录](steps/${String(step.number).padStart(2, '0')}/step.json)`,
    )
  }
  lines.push('## 机械观察（不作角色结论）')
  const managerTools = turns.flatMap((turn) =>
    turn.tools.map((tool) => ({ turnId: turn.id, ...tool })),
  )
  const writes = managerTools.filter(
    (tool) =>
      tool.name === 'fileChange' ||
      /(?:Write|Edit|MultiEdit|NotebookEdit)/.test(tool.name) ||
      tool.name === 'Bash',
  )
  lines.push(
    '经理的文件改动工具和命令（命令是否写文件不作语义推断）：',
    ...writes.map((tool) => `- ${tool.turnId} ${tool.name}：${pretty(tool.arguments)}`),
  )
  for (const step of steps) {
    if (!step.gitBefore || !step.gitAfter) continue
    lines.push(
      `步骤 ${step.number} 经理 cwd：HEAD ${step.gitBefore.head} → ${step.gitAfter.head}；status ${pretty(step.gitAfter.status)}；外部提交 ${step.externalCommit ?? '无'}。只查经理检出，不包含线的工作树；git diff 见步骤文件。HEAD 改变本身不能归因于经理，须结合工具证据。`,
    )
  }
  lines.push('回复中的问号句（不自动判断是否在提问）：')
  for (const turn of turns)
    for (const sentence of turn.reply.match(/[^。！？.!?\n]*[?？]/g) ?? [])
      lines.push(`- ${turn.id}：${sentence.trim()}`)
  lines.push('逐回合 litch_manager 调用与事件回复长度（Unicode 字符数）：')
  for (const turn of turns)
    lines.push(
      `- ${turn.id}：litch_manager=${turn.tools.some((tool) => tool.name.includes('litch_manager'))}；事件=${[...turn.input.matchAll(/<litch-session-event kind="([^"]+)"/g)].map((match) => match[1]).join(',') || '用户'}；正文 ${[...turn.reply].length} 字符`,
    )
  lines.push(
    `观察到同时运行线最大数：${run.maxRunningLines}。按轮询看板和回合通知记录；短于采样间隔且未收到通知的运行可能漏记，非调度器的精确峰值。`,
    '决策字段（存在/非空分别报告，空的推荐也可能是开放题）：',
  )
  for (const step of steps)
    for (const decision of step.board?.decisions ?? [])
      lines.push(
        `- 步骤 ${step.number} ${decision.id}：${['background', 'options', 'recommend', 'default', 'basis'].map((key) => `${key} 存在=${Object.hasOwn(decision, key)} 非空=${decision[key] != null && decision[key] !== '' && (!Array.isArray(decision[key]) || decision[key].length > 0)}`).join('；')}`,
      )
  lines.push(
    `自动审批记录：${frames.filter((frame) => frame.direction === 'approval').length} 条，见 events.json。`,
    '完整原生工具名与参数另见 native-transcripts；思考块已剔除。回合失败、跳过和超时均保留，不算角色评判。',
  )
  return `${lines.join('\n\n')}\n`
}

/** CLI 原生记录补足 Bash/Write 经协议投影后丢掉的原始工具参数；只导出消息块，不拷配置。 */
export function nativeTranscripts(directory, writer, prefix = '') {
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const relative = join(prefix, entry.name)
    if (entry.isDirectory()) nativeTranscripts(join(directory, entry.name), writer, relative)
    else if (entry.name.endsWith('.jsonl')) {
      const messages = readFileSync(join(directory, entry.name), 'utf8')
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
          try {
            const item = JSON.parse(line)
            return item.message
              ? [
                  {
                    sessionId: item.sessionId,
                    uuid: item.uuid,
                    parentUuid: item.parentUuid,
                    timestamp: item.timestamp,
                    message: item.message,
                  },
                ]
              : []
          } catch {
            return []
          }
        })
      writer.write(`native-transcripts/${relative}.json`, messages)
    }
  }
}
