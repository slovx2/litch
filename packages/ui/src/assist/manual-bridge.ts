// 桌面外壳的预加载脚本挂在 window.litchManual 上的产品手册接口（apps/desktop/src/preload.mts，
// 消息名和形状在 apps/desktop/src/manual-ipc.mts，主进程那一侧在 manual-skill.mts），这里是界面这边抄的一份类型，
// 改一边要改另一边。设置页“配置助手”一节要它的状态和开关，配置助手按钮从状态里取手册的目录。
// 普通浏览器里（对着模拟核心看界面）没有外壳，给一份假的：开关能拨，目录是个示例。

/**
 * 一处技能目录上的结果。installed：放了一份实体；linked：建了指向实体的链接；skipped：没装（reason 说为什么）；
 * failed：装或删的时候出错了；removed：关掉开关时删掉了；foreign：那里已经有一个不是 Litch 放的同名目录，不碰
 */
export type ManualTargetState =
  | 'installed'
  | 'linked'
  | 'skipped'
  | 'failed'
  | 'removed'
  | 'foreign'

export interface ManualTarget {
  /** harness 的标识（claude-code、codex、pi、dsh、opencode、gemini、qwen） */
  harness: string
  /** 手册在这个 harness 读的技能目录里的位置 */
  path: string
  state: ManualTargetState
  reason?: string
}

export interface ManualStatus {
  /** 设置里的开关，默认开 */
  enabled: boolean
  name: 'litch-manual'
  /** 实体在哪（~/.agents/skills/litch-manual）。没装、关着、装不成是 null */
  dir: string | null
  /** 手册的版本，就是应用的版本 */
  version: string
  targets: ManualTarget[]
  /** 整件事没做成的原因，给设置页那一节显示 */
  error?: string
}

export interface ManualBridge {
  /** 第一次调用最长要等八秒上下（主进程要等登录 shell 的环境） */
  status(): Promise<ManualStatus>
  setEnabled(on: boolean): Promise<ManualStatus>
}

declare global {
  interface Window {
    litchManual?: ManualBridge
  }
}

const FAKE_DIR = '~/.agents/skills/litch-manual'

/** 普通浏览器里的假接口：开关记在内存里，目录和各 harness 的情况是示例 */
function fakeBridge(): ManualBridge {
  let enabled = true
  const status = (): ManualStatus => ({
    enabled,
    name: 'litch-manual',
    dir: enabled ? FAKE_DIR : null,
    version: '0.0.0',
    targets: enabled
      ? [
          { harness: 'claude-code', path: '~/.claude/skills/litch-manual', state: 'linked' },
          { harness: 'codex', path: FAKE_DIR, state: 'installed' },
          { harness: 'pi', path: '~/.pi/agent/skills/litch-manual', state: 'linked' },
          {
            harness: 'qwen',
            path: '~/.qwen/skills/litch-manual',
            state: 'skipped',
            reason: '~/.qwen does not exist',
          },
        ]
      : [{ harness: 'claude-code', path: '~/.claude/skills/litch-manual', state: 'removed' }],
  })
  return {
    status: async () => status(),
    async setEnabled(on) {
      enabled = on
      return status()
    },
  }
}

let fake: ManualBridge | null = null

/** 外壳给的接口；普通浏览器里是假的那一份。不在页面里（单元测试直接在 Node 里读源文件）时没有 */
export function manualBridge(): ManualBridge | undefined {
  if (typeof window === 'undefined') return undefined
  if (window.litchManual) return window.litchManual
  if (window.litchShell) return undefined
  fake ??= fakeBridge()
  return fake
}
