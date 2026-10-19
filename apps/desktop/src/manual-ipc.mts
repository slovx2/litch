// 产品手册（skills/litch-manual）注入到本机各 harness 的那件事，界面和主进程之间的约定：消息名和状态的形状。
// 预加载脚本在沙箱里只认打包进去的纯代码，所以这里不引 Node 的模块；实现在 manual-skill.mts。
// 界面经预加载脚本拿到 window.litchManual = { status(), setEnabled(on) }，两个都回 ManualStatus。

/** 界面 → 主进程，等应答：手册现在装在哪、各 harness 的情况 */
export const MANUAL_STATUS = 'litch:manual:status'
/** 界面 → 主进程，等应答：设置页“向本机的 harness 安装产品手册”的开关。开就装，关就删掉带记号的那几份 */
export const MANUAL_SET_ENABLED = 'litch:manual:set-enabled'

/**
 * 一处技能目录上的结果。
 * installed：放了一份实体（~/.agents/skills 下的那一份，或者 Windows 上复制过去的）；
 * linked：建了指向实体的链接；skipped：没装（那个 harness 的配置目录不在，或者实体没装成），reason 说为什么；
 * failed：装或删的时候出错了；removed：关掉开关时删掉了；
 * foreign：那里已经有一个同名的，不是 Litch 放的（没有记号），不碰
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
  /** 手册在这个 harness 读的技能目录里的位置（…/skills/litch-manual） */
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
  /** 整件事没做成的原因（没有内置的适配器、实体目录写不进去……），给设置页那一节显示 */
  error?: string
}
