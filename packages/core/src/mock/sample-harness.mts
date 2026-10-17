// 示例里各个 harness 的样子：名字、版本、事先声明的会什么不会什么、有哪几档权限预设。
// 照着真的那几个引擎的声明编的（packages/claude、pi、dsh 各自的声明，原生 codex 由设备进程代报的那一份），
// 这样界面上“按声明来”的每条路径在模拟核心里都走得到：
// - Claude Code：都会，认识“拒绝并附说明”；引导时带不了图片；
// - Pi：没有审批，权限只有一档、建好之后换不了；
// - dsh：声明了不会分叉、回退、压缩，也删不了会话——这几个入口界面不出；
// - Codex（设备服务代它报的）：都会，但不认识我们的任何扩展，拒绝带不了说明；
// - 没有声明的（直接连原生 codex 自己的入口）：会什么试了才知道。
import type { Bilingual, HarnessAbilities, HarnessView, PermissionPreset, Said } from '../model.mjs'
import { type PhraseKey, phrase } from '../phrase.mjs'

const ALL: HarnessAbilities = {
  fork: true,
  rollback: true,
  rollbackRestoresFiles: false,
  compact: true,
  steer: true,
  steerImages: true,
  images: true,
  skills: true,
  mentions: true,
  rename: true,
  archive: true,
  remove: true,
  finalOnStart: false,
  turnDiff: true,
}

const DECLARED: Record<string, HarnessAbilities> = {
  // 引导只把文字交给模型，图片到不了
  claude: { ...ALL, steerImages: false },
  // Pi 和 dsh 不发本回合的差异：工作目录不是 git 仓库时，差异面板在它们的会话里没有东西可看
  pi: { ...ALL, turnDiff: false },
  dsh: { ...ALL, fork: false, rollback: false, compact: false, remove: false, turnDiff: false },
  // 原生 codex 的消息一开始就带着准的阶段值：最终回答一开始活动区就收。
  // 它的 mention 不是给文件用的：提到的文件写进正文
  codex: { ...ALL, finalOnStart: true, mentions: false },
}

/** 声明了认识“拒绝并附说明”的 harness */
const TAKES_NOTE: readonly string[] = ['claude']

const KNOWN: Record<string, [name: string, badge: string, version: string]> = {
  claude: ['Claude Code', 'CC', '2.1.282'],
  pi: ['Pi', 'PI', '0.99.1'],
  dsh: ['dsh', 'DS', '0.2.0-rc.2'],
  codex: ['Codex', 'CX', '0.160.0'],
}

export interface SampleHarnessOptions {
  /** 不可用的种类（设备服务给的分类）和它的原话。不给就是可用的 */
  down?: { kind: string; reason: PhraseKey; detail: Said }
  /** 有没有声明。直接连原生 codex 自己的入口时没有 */
  declared?: boolean
}

export function sampleHarness(id: string, options: SampleHarnessOptions = {}): HarnessView {
  const [name, badge, version] = KNOWN[id] ?? [id, id.slice(0, 2).toUpperCase(), '']
  const { down } = options
  return {
    id,
    name,
    badge,
    state: down ? (down.kind === 'disabled' ? 'disabled' : 'unavailable') : 'ready',
    version,
    reason: down ? phrase(down.reason) : null,
    detail: down ? down.detail : null,
    down: down ? down.kind : null,
    abilities: options.declared === false ? null : (DECLARED[id] ?? null),
  }
}

/** 这个 harness 的审批认不认“拒绝并附说明”。没有声明的不认 */
export const takesNote = (harness: HarnessView | undefined): boolean =>
  harness?.abilities != null && TAKES_NOTE.includes(harness.id)

const TITLES: Record<string, Bilingual> = {
  ':read-only': { 'zh-CN': '只读', en: 'Read only' },
  ':workspace': { 'zh-CN': '工作区', en: 'Workspace' },
  ':danger-full-access': { 'zh-CN': '完全访问', en: 'Full access' },
}

const RISKS: Record<string, PermissionPreset['risk']> = {
  ':read-only': 'low',
  ':workspace': 'medium',
  ':danger-full-access': 'high',
}

const preset = (
  id: string,
  note: Bilingual,
  extra: Partial<PermissionPreset> = {},
): PermissionPreset => ({
  id,
  risk: RISKS[id] ?? 'medium',
  title: TITLES[id] ?? null,
  note,
  confirm: id === ':danger-full-access',
  switchable: true,
  ...extra,
})

const PRESETS: Record<string, PermissionPreset[]> = {
  claude: [
    preset(':read-only', {
      'zh-CN': '只能看：可以读文件、搜索，在只读且断网的沙箱里运行命令',
      en: 'Look only: can read files, search, and run commands in a read-only sandbox with no network',
    }),
    preset(':workspace', {
      'zh-CN': '可以改工作区里的文件、运行命令，动手之前先问你',
      en: 'Can change files in the workspace and run commands, asking you first',
    }),
    preset(':danger-full-access', {
      'zh-CN': '不再问你：可以改任何文件、运行任何命令、访问网络，没有沙箱',
      en: 'No more asking: can change any file, run any command and use the network, with no sandbox',
    }),
  ],
  // 只有这一档，没得选：不用确认，建好之后也谈不上换
  pi: [
    preset(
      ':danger-full-access',
      {
        'zh-CN': 'Pi 没有审批也没有沙箱：直接改文件、运行命令、访问网络，不会先问你',
        en: 'Pi has no approvals and no sandbox: it changes files, runs commands and uses the network without asking',
      },
      { confirm: false, switchable: false },
    ),
  ],
  dsh: [
    preset(':read-only', {
      'zh-CN': '不能改文件：读文件、搜索、联网都可以。要写文件时模型得先申请，那时才来问你',
      en: 'Cannot change files: reading, searching and network access are allowed. To write, the model has to request it first, and only then are you asked',
    }),
    preset(':workspace', {
      'zh-CN': '可以直接改工作区里的文件、运行命令、联网，不会先问你',
      en: 'Can change files in the workspace, run commands and use the network without asking',
    }),
    preset(':danger-full-access', {
      'zh-CN': '不再问你：可以改任何文件、运行任何命令、联网，没有沙箱',
      en: 'No more asking: can change any file, run any command and use the network, with no sandbox',
    }),
  ],
  codex: [
    preset(':read-only', {
      'zh-CN': '只能读文件；改文件、联网、运行会写东西的命令都要先问你',
      en: 'Can only read files; changing files, network access and commands that write all ask you first',
    }),
    preset(':workspace', {
      'zh-CN': '可以改工作区里的文件、运行命令；出了工作区或者要联网时先问你',
      en: 'Can change files in the workspace and run commands; asks before leaving the workspace or going online',
    }),
    preset(':danger-full-access', {
      'zh-CN': '不再问你：可以改任何文件、运行任何命令、访问网络，没有沙箱',
      en: 'No more asking: can change any file, run any command and use the network, with no sandbox',
    }),
  ],
}

/** 这个 harness 声明的权限预设。没有声明的是 null：用 Codex 协议内置的三档 */
export const samplePresets = (harness: HarnessView | undefined): PermissionPreset[] | null =>
  harness?.abilities ? (PRESETS[harness.id] ?? null) : null
