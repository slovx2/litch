// 模拟核心用的示例数据：诊断的结果、日志的末尾、给 Codex 桌面端的 ssh 配置片段。内容全是编出来的。
import type { HarnessView } from '../model.mjs'
import type {
  DiagnosticCheckView,
  LogSource,
  LogTailView,
  SettingsSnapshotView,
  SshConfigView,
} from '../model-manage.mjs'
import { both } from './sample-manage.mjs'

const STATE_DIR = '~/.codex-harness-adapter'
const LOG_DIR = `${STATE_DIR}/logs`

/** 一个 harness 的三项检查：引擎的命令行和运行环境、终端、它的 SSH 入口 */
function checksOf(harness: HarnessView, snapshot: SettingsSnapshotView): DiagnosticCheckView[] {
  const scope = { kind: 'harness', harness: harness.id } as const
  const up = harness.state === 'ready'
  const stopped = harness.state === 'disabled'
  const entry = snapshot.sshEntries.find((item) => item.harness === harness.id)
  const checks: DiagnosticCheckView[] = [
    {
      id: 'runtime',
      scope,
      status: up ? 'ok' : stopped ? 'skipped' : 'failed',
      title: both('引擎的命令行和运行环境', 'Engine CLI and runtime environment'),
      detail: up
        ? harness.version
          ? both(`版本 ${harness.version}`, `Version ${harness.version}`)
          : null
        : stopped
          ? both('已经在设置里停用，没有检查', 'Turned off in settings, so it was not checked')
          : both(
              `${harness.name} 的命令行能找到，但它说还没有登录。在这台设备的终端里登录一次，再回来重启它。`,
              `The ${harness.name} CLI was found, but it reports that it is not signed in. Sign in once from a terminal on this device, then restart it here.`,
            ),
      logPath: up || stopped ? null : `${LOG_DIR}/${harness.id}/diagnostics.log`,
    },
    {
      id: 'terminal',
      scope,
      status: up ? 'ok' : 'skipped',
      title: both('终端', 'Terminal'),
      detail: null,
      logPath: null,
    },
  ]
  if (!entry) return checks
  const failed = entry.state === 'failed'
  checks.push({
    id: 'sshEntry',
    scope,
    status: entry.state === 'listening' ? 'ok' : failed ? 'failed' : 'skipped',
    title: both('给 Codex 桌面端的 SSH 入口', 'SSH entry for the Codex desktop app'),
    detail:
      entry.state === 'listening'
        ? both(`在 127.0.0.1:${entry.port} 上监听`, `Listening on 127.0.0.1:${entry.port}`)
        : failed
          ? (entry.reason?.text ?? null)
          : entry.state === 'off'
            ? both('入口在设置里关着', 'The entry is turned off in settings')
            : both(
                '运行时没在跑，入口没有起',
                'The runtime is not running, so the entry is not up',
              ),
    logPath: failed ? `${LOG_DIR}/${harness.id}/runtime.log` : null,
  })
  return checks
}

/** 诊断的结果。only 给了就只查那一个 harness */
export function sampleChecks(
  harnesses: HarnessView[],
  snapshot: SettingsSnapshotView,
  only: string | undefined,
): DiagnosticCheckView[] {
  return harnesses
    .filter((harness) => only === undefined || harness.id === only)
    .flatMap((harness) => checksOf(harness, snapshot))
}

const stamp = (now: number, secondsAgo: number): string =>
  new Date(now - secondsAgo * 1000).toISOString().replace('T', ' ').slice(0, 19)

/** 一份日志的末尾。要的那一份不存在时，文字是空的 */
export function sampleLog(
  now: number,
  harnesses: HarnessView[],
  source: LogSource,
  harnessId: string | undefined,
): LogTailView {
  const harness = harnesses.find((entry) => entry.id === harnessId)
  const lines: string[] = []
  const file: Partial<Record<LogSource, string>> = {
    control: 'control.jsonl',
    requests: 'device.jsonl',
    rpc: 'rpc.jsonl',
    debug: 'debug.jsonl',
    agent: 'agent.log',
  }
  const name = file[source] ?? `${source}.log`
  let path = `${LOG_DIR}/${name}`
  /** 摘要日志的一行（和设备上的格式一样） */
  const json = (ago: number, src: string, event: string, fields: Record<string, unknown>) =>
    JSON.stringify({
      ts: new Date(now - ago * 1000).toISOString(),
      level: fields.ok === false ? 'warn' : 'info',
      src,
      pid: 4711,
      event,
      ...fields,
    })
  if (source === 'control') {
    lines.push(
      json(5398, 'control', 'start', { version: '0.0.0' }),
      json(1320, 'control', 'control', { method: 'settings.read', ok: true, ms: 3 }),
      json(95, 'control', 'control', { method: 'settings.write', ok: true, ms: 412 }),
    )
  } else if (source === 'requests') {
    lines.push(
      json(1320, 'device', 'peer.ready', { conn: '7f3a91c0', client: 'litch', extensions: 9 }),
      json(1319, 'device', 'rpc', {
        method: 'thread/list',
        conn: '7f3a91c0',
        id: 3,
        ok: true,
        ms: 41,
      }),
      json(2710, 'device', 'rpc', {
        method: 'thread/resume',
        conn: '7f3a91c0',
        id: 12,
        harness: harnesses[0]?.id ?? 'pi',
        threadId: '019a3f…c2',
        ok: true,
        ms: 230,
      }),
    )
  } else if (source === 'device') {
    lines.push(
      `${stamp(now, 5400)} [litch-device] listening on ${STATE_DIR}/device/device.sock`,
      ...harnesses.map((entry, index) =>
        entry.state === 'ready'
          ? `${stamp(now, 5399 - index)} [litch-device] ${entry.id} ready, version ${entry.version ?? '?'}`
          : `${stamp(now, 5399 - index)} [litch-device] ${entry.id} unavailable (${entry.state})`,
      ),
      `${stamp(now, 1320)} [litch-device] connection 7f3a handshake done: litch 0.0.0`,
      `${stamp(now, 1319)} [litch-device] connection 7f3a declared extensions: harness, deviceSettings`,
      `${stamp(now, 95)} [litch-device] settings changed, version 12`,
    )
  } else if (source === 'service') {
    lines.push(
      `${stamp(now, 5402)} codex-harness-adapter start --ssh=off`,
      `${stamp(now, 5401)} state directory: ${STATE_DIR}`,
      ...harnesses.map(
        (entry, index) =>
          `${stamp(now, 5400 - index)} ${entry.name}: ${entry.state === 'ready' ? 'runtime started' : 'not started'}`,
      ),
      `${stamp(now, 5396)} device service ready`,
    )
  } else if (harness) {
    path = `${LOG_DIR}/${harness.id}/${name}`
    if (source === 'rpc' && harness.id !== 'codex') {
      lines.push(
        json(2710, harness.id, 'rpc', {
          method: 'thread/resume',
          peer: '5c2e0d4a',
          id: 12,
          ok: true,
          ms: 182,
        }),
        json(2708, harness.id, 'rpc', {
          method: 'turn/start',
          peer: '5c2e0d4a',
          id: 13,
          ok: true,
          ms: 9,
        }),
        json(2700, harness.id, 'serverRequest', {
          method: 'item/commandExecution/requestApproval',
          peer: '5c2e0d4a',
          id: 0,
          ok: true,
          ms: 6120,
        }),
      )
    } else if (source === 'runtime') {
      lines.push(
        `${stamp(now, 5400)} [codex-harness-adapter] listening on ${STATE_DIR}/${harness.id}/runtime.sock`,
        `${stamp(now, 2710)} [${harness.id}] thread/resume 019a3f…c2 ok`,
        `${stamp(now, 2708)} [${harness.id}] turn started`,
        `${stamp(now, 2655)} [${harness.id}] turn completed in 53.1s`,
        `${stamp(now, 310)} [${harness.id}] model/list 3 models`,
      )
    } else if (harness.state !== 'ready') {
      lines.push(
        `${stamp(now, 5401)} checking ${harness.name} CLI`,
        `${stamp(now, 5400)} found, version ${harness.version ?? '?'}`,
        `${stamp(now, 5399)} auth status: not signed in`,
      )
    }
  }
  const text = lines.length > 0 ? `${lines.join('\n')}\n` : ''
  // 运行日志演示“前面还有没取的内容”
  const truncated = source === 'runtime' && text !== ''
  return { path, text, truncated, size: truncated ? 184_320 : text.length, directory: LOG_DIR }
}

/** 给 Codex 桌面端的 ssh 配置片段：开着而且起来了的入口各一段 */
export function sampleSshConfig(
  harnesses: HarnessView[],
  snapshot: SettingsSnapshotView,
): SshConfigView {
  const entries = snapshot.sshEntries.map((entry) => {
    const alias = `codex-harness-adapter-${entry.harness}`
    const name = harnesses.find((harness) => harness.id === entry.harness)?.name ?? entry.harness
    if (!entry.enabled) {
      const unavailable = both('这个入口在设置里关着', 'This entry is turned off in settings')
      return { harness: entry.harness, alias, port: entry.port, config: null, unavailable }
    }
    if (entry.state === 'idle') {
      const unavailable = both(
        `这个入口还没有初始化过：${name} 起来一次之后才有身份和主机密钥`,
        `This entry has not been initialised yet: its identity and host key are created the first time ${name} starts`,
      )
      return { harness: entry.harness, alias, port: entry.port, config: null, unavailable }
    }
    const config = [
      `Host ${alias}`,
      '  HostName 127.0.0.1',
      `  Port ${entry.port}`,
      '  User codex',
      `  IdentityFile ${STATE_DIR}/${entry.harness}/client_ed25519`,
      `  UserKnownHostsFile ${STATE_DIR}/${entry.harness}/known_hosts`,
      '  IdentitiesOnly yes',
      '',
    ].join('\n')
    return { harness: entry.harness, alias, port: entry.port, config, unavailable: null }
  })
  return {
    entries,
    text: entries.flatMap((entry) => (entry.config ? [entry.config] : [])).join('\n'),
  }
}
