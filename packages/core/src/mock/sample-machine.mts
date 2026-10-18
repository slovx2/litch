// 模拟核心里“远程设备操作这台电脑”的示例数据：各台设备的设置、顶栏里在跑的进程和全局待处理、
// 操作记录，以及会话里那几出（关键字见 mock-core.mts 的 MACHINE_ASKS）用的条目和卡片。
// 示例里 build-01 开着（每个会话确认一次、禁止常用敏感位置），nas、gpu-box 关着；本机没有这一项。
import { CLIENT_TOOL_NAMESPACE } from '../../../protocol/src/client-tools.mjs'
import { MACHINE_TOOL } from '../../../protocol/src/client-tools-machine.mjs'
import type { JsonValue, ThreadItem } from '../../../protocol/src/index.mjs'
import { SENSITIVE_PRESETS } from '../device/machine/presets.mjs'
import { clientAskOptions } from '../device/tool-calls.mjs'
import type { ApprovalOption, ClientAskRequest, DeviceView } from '../model.mjs'
import type {
  MachineAccessView,
  MachineActivityView,
  MachineAskView,
  MachineLogEntry,
} from '../model-machine.mjs'

const MINUTE = 60_000

/** 一台远程设备的“操作这台电脑”一项。开着的只有 build */
export function sampleMachineAccess(deviceId: string): MachineAccessView {
  return {
    enabled: deviceId === 'build',
    approval: 'session',
    access: { mode: 'sensitive', custom: [] },
    presets: [...SENSITIVE_PRESETS],
  }
}

/** 全局待处理卡片的选项：和会话里的一样，没有“始终允许” */
export const PENDING_OPTIONS: ApprovalOption[] = [
  { id: 'once', role: 'accept' },
  { id: 'session', role: 'acceptSession' },
  { id: 'decline', role: 'decline', note: true },
]

/**
 * 一开始顶栏里就有的：build-01 上的会话在这台电脑上起的三个进程（一个是命令行调用起的，不知道是哪个会话），
 * 和两张找不到会话的待处理卡片（一张命令里提到了禁止位置，标红）
 */
export function sampleMachineActivity(now: number): MachineActivityView {
  return {
    running: [
      {
        id: 'mp-1',
        deviceId: 'build',
        deviceName: 'build-01',
        sessionId: 'b3',
        harness: 'claude',
        command: 'npm run build -- --watch',
        cwd: '~/work/litch',
        startedAt: now - 14 * MINUTE,
      },
      {
        id: 'mp-2',
        deviceId: 'build',
        deviceName: 'build-01',
        sessionId: 'b2',
        harness: 'pi',
        command: 'python3 -m http.server 8000 --directory ~/work/docs-site/dist',
        cwd: '~/work/docs-site',
        startedAt: now - 3 * MINUTE,
      },
      {
        id: 'mp-3',
        deviceId: 'build',
        deviceName: 'build-01',
        sessionId: null,
        harness: null,
        command: 'tail -f ~/Library/Logs/litch/main.log',
        cwd: '~',
        startedAt: now - 40_000,
      },
    ],
    pending: [
      {
        id: 'mq-1',
        deviceId: 'build',
        deviceName: 'build-01',
        host: 'dev@build-01',
        harness: 'dsh',
        ask: {
          kind: 'machine',
          action: 'exec',
          command: 'cat ~/.ssh/config && ls -la ~/.aws',
          cwd: '~',
          path: null,
          copy: null,
          flagged: ['~/.ssh', '~/.aws'],
        },
        options: PENDING_OPTIONS,
        expiresAt: now + 9 * MINUTE,
      },
      {
        id: 'mq-2',
        deviceId: 'build',
        deviceName: 'build-01',
        host: 'dev@build-01',
        harness: 'codex',
        ask: {
          kind: 'machine',
          action: 'copy',
          command: null,
          cwd: null,
          path: null,
          copy: {
            from: { machine: 'build-01', path: '/srv/work/litch/apps/desktop/out/Litch-0.9.0.dmg' },
            to: { machine: 'macbook', path: '~/Downloads/Litch-0.9.0.dmg' },
          },
          flagged: [],
        },
        options: PENDING_OPTIONS,
        expiresAt: now + 4 * MINUTE,
      },
    ],
  }
}

/** build-01 最近的操作记录，新的在前。几种结果各有一条，有一条碰到了禁止位置 */
export function sampleMachineLog(now: number): MachineLogEntry[] {
  const at = (minutes: number) => now - minutes * MINUTE
  const entry = (
    minutes: number,
    sessionId: string | null,
    harness: string | null,
    tool: string,
    summary: string,
    result: MachineLogEntry['result'],
    flagged = false,
  ): MachineLogEntry => ({
    at: at(minutes),
    deviceId: 'build',
    sessionId,
    harness,
    tool,
    summary,
    result,
    flagged,
  })
  return [
    entry(
      3,
      'b2',
      'pi',
      'exec',
      'python3 -m http.server 8000 --directory ~/work/docs-site/dist',
      'ok',
    ),
    entry(6, 'b3', 'claude', 'read_file', '~/work/litch/package.json', 'ok'),
    entry(9, null, 'dsh', 'read_file', '~/.ssh/id_ed25519', 'blocked', true),
    entry(14, 'b3', 'claude', 'exec', 'npm run build -- --watch', 'ok'),
    entry(22, 'b3', 'claude', 'exec', 'rm -rf ~/work/litch/node_modules', 'declined'),
    entry(31, 'b1', 'claude', 'list_dir', '~/work/litch/apps', 'ok'),
    entry(
      47,
      null,
      'opencode',
      'copy',
      'build-01:/srv/out/report.pdf → ~/Downloads/report.pdf',
      'expired',
    ),
    entry(65, 'b6', 'codex', 'exec', 'make check', 'failed'),
  ]
}

/** 会话里那几出各是哪一种：跑一个不会自己结束的命令、命令里提到禁止位置、把文件从远程搬到这台电脑 */
export type MachineDemo = 'exec' | 'flagged' | 'copy'

const DEMOS: Record<MachineDemo, { tool: string; args: JsonValue; ask: MachineAskView }> = {
  exec: {
    tool: MACHINE_TOOL.exec,
    args: { command: 'npm run dev -- --port 5173', cwd: '~/work/litch', yield_ms: 5000 },
    ask: {
      kind: 'machine',
      action: 'exec',
      command: 'npm run dev -- --port 5173',
      cwd: '~/work/litch',
      path: null,
      copy: null,
      flagged: [],
    },
  },
  flagged: {
    tool: MACHINE_TOOL.exec,
    args: { command: 'grep -n "Host " ~/.ssh/config | head -20' },
    ask: {
      kind: 'machine',
      action: 'exec',
      command: 'grep -n "Host " ~/.ssh/config | head -20',
      cwd: '~',
      path: null,
      copy: null,
      flagged: ['~/.ssh'],
    },
  },
  copy: {
    tool: MACHINE_TOOL.copy,
    args: {
      from: { machine: 'session', path: '/srv/work/litch/apps/desktop/out/Litch-0.9.0.dmg' },
      to: { machine: 'desktop', path: '~/Downloads/Litch-0.9.0.dmg' },
    },
    ask: {
      kind: 'machine',
      action: 'copy',
      command: null,
      cwd: null,
      path: null,
      copy: {
        from: { machine: 'build-01', path: '/srv/work/litch/apps/desktop/out/Litch-0.9.0.dmg' },
        to: { machine: 'macbook', path: '~/Downloads/Litch-0.9.0.dmg' },
      },
      flagged: [],
    },
  },
}

export const machineDemoAsk = (demo: MachineDemo): MachineAskView => DEMOS[demo].ask

/** 写进操作记录、顶栏进程里的那一句：命令、路径，或者“从哪到哪” */
export function machineSummary(ask: MachineAskView): string {
  if (ask.copy) {
    const { from, to } = ask.copy
    return `${from.machine}:${from.path} → ${to.machine}:${to.path}`
  }
  return ask.command ?? ask.path ?? ''
}

/**
 * 那一次工具调用。result：还在等（null）、用户答应了或者不用问（done）、拒绝了（declined）、
 * 开关关着（disabled）。说明照真的执行器的写法，第一行是 [litch:种类]
 */
export function machineToolCall(
  demo: MachineDemo,
  id: string,
  result: 'done' | 'declined' | 'disabled' | null,
  processId?: string,
): ThreadItem {
  const call = DEMOS[demo]
  const finished = result !== null
  const text =
    result === 'done'
      ? demo === 'exec'
        ? `Still running after 5s (process_id ${processId ?? 'mp-0'}).\n  VITE v6.3.5  ready in 412 ms\n  ➜  Local:   http://localhost:5173/`
        : demo === 'flagged'
          ? '3:Host build-01\n9:Host gpu-box\n15:Host nas.lan\n(exit 0)'
          : 'Copied 2,418,512 bytes from session:/srv/work/litch/apps/desktop/out/Litch-0.9.0.dmg to desktop:~/Downloads/Litch-0.9.0.dmg'
      : result === 'declined'
        ? '[litch:declined] The user declined this request.'
        : result === 'disabled'
          ? '[litch:disabled] The user has not allowed this device to operate the computer running Litch. Ask the user to turn it on in Litch: Devices → this device → Operate this computer.'
          : null
  return {
    type: 'dynamicToolCall',
    id,
    namespace: CLIENT_TOOL_NAMESPACE.machine,
    tool: call.tool,
    arguments: call.args,
    status: finished ? (result === 'done' ? 'completed' : 'failed') : 'inProgress',
    contentItems: text === null ? null : [{ type: 'inputText', text }],
    success: finished ? result === 'done' : null,
    durationMs: finished ? 820 : null,
  }
}

/** 那一次调用要用户点头的卡片。选项用真的核心那一份（clientAskOptions），拒绝能附一句理由 */
export function machineAskRequest(
  demo: MachineDemo,
  id: string,
  itemId: string,
  device: DeviceView,
): ClientAskRequest {
  const ask = DEMOS[demo].ask
  return {
    id,
    kind: 'clientAsk',
    itemId,
    device: { name: device.name, kind: device.kind, host: device.host },
    tool: { namespace: CLIENT_TOOL_NAMESPACE.machine, name: DEMOS[demo].tool },
    ask,
    options: clientAskOptions(ask).map((option) =>
      option.role === 'decline' ? { ...option, note: true } : option,
    ),
  }
}
