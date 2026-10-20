// 派子会话弹窗的表单：手动派（session.spawn）和提案的“改了再开始”（session.proposal.accept 带 overrides）
// 共用一张表。这里只有纯函数：表单的初值、提交时发什么。弹窗本身在 SpawnDialog.tsx。
import type {
  HarnessId,
  LineageKind,
  ProposalOverrides,
  SandboxLevel,
  SessionProposalView,
} from '@litch/core'

/** 弹窗里填的东西。空串是“不改、照默认” */
export interface SpawnFields {
  harness: HarnessId
  model: string
  effort: string
  workspaceId: string
  cwd: string
  kind: LineageKind
  title: string
  prompt: string
  /** 任务之前的背景：全新开始时才发，带上下文的不发 */
  background: string
  sandbox: SandboxLevel | ''
  wake: boolean
}

/** 父会话里弹窗要用到的那几样 */
export interface SpawnParent {
  harness: HarnessId
  workspaceId: string | null
}

/** 表单的初值：手动派的全是父会话的默认；提案的照提案预填 */
export function fieldsFor(parent: SpawnParent, proposal: SessionProposalView | null): SpawnFields {
  return {
    harness: proposal?.harness ?? parent.harness,
    model: proposal?.model ?? '',
    effort: '',
    workspaceId: parent.workspaceId ?? '',
    cwd: proposal?.cwd ?? '',
    kind: proposal?.kind ?? 'fresh',
    title: proposal?.title ?? '',
    prompt: proposal?.prompt ?? '',
    background: proposal?.background ?? '',
    sandbox: '',
    wake: proposal?.wakeParent ?? true,
  }
}

/** 带上下文只能同一个 harness：换了别的就是全新开始 */
export const kindOf = (fields: SpawnFields, parent: SpawnParent): LineageKind =>
  fields.harness === parent.harness ? fields.kind : 'fresh'

/** 手动派：session.spawn 的参数（不含设备和父会话）。和父会话一样的不带 */
export function spawnParams(fields: SpawnFields, parent: SpawnParent) {
  const cwd = fields.cwd.trim()
  const kind = kindOf(fields, parent)
  const background = kind === 'fresh' ? fields.background.trim() : ''
  return {
    kind,
    title: fields.title.trim(),
    prompt: fields.prompt.trim(),
    ...(background ? { background } : {}),
    wakeParent: fields.wake,
    ...(fields.harness !== parent.harness ? { harness: fields.harness } : {}),
    ...(fields.model ? { model: fields.model } : {}),
    ...(fields.effort ? { effort: fields.effort } : {}),
    ...(fields.workspaceId && fields.workspaceId !== parent.workspaceId
      ? { workspaceId: fields.workspaceId }
      : {}),
    ...(cwd ? { cwd } : {}),
    ...(fields.sandbox ? { sandbox: fields.sandbox } : {}),
  }
}

/** 改了再开始：和提案不一样的那几项。什么都没改是空对象 */
export function overridesOf(
  fields: SpawnFields,
  parent: SpawnParent,
  proposal: SessionProposalView,
): ProposalOverrides {
  const overrides: ProposalOverrides = {}
  const harnessChanged = fields.harness !== (proposal.harness ?? parent.harness)
  if (harnessChanged) overrides.harness = fields.harness
  if (fields.model && fields.model !== proposal.model) overrides.model = fields.model
  // 换了 harness 又没另选模型：提案原来的模型多半是别家的，空字符串让设备进程清掉、用缺省
  else if (!fields.model && harnessChanged && proposal.model) overrides.model = ''
  if (fields.effort) overrides.effort = fields.effort
  if (fields.workspaceId && fields.workspaceId !== (parent.workspaceId ?? '')) {
    overrides.workspaceId = fields.workspaceId
  }
  const cwd = fields.cwd.trim()
  if (cwd && cwd !== (proposal.cwd ?? '')) overrides.cwd = cwd
  const kind = kindOf(fields, parent)
  if (kind !== proposal.kind) overrides.kind = kind
  const title = fields.title.trim()
  if (title && title !== proposal.title) overrides.title = title
  const prompt = fields.prompt.trim()
  if (prompt && prompt !== proposal.prompt.trim()) overrides.prompt = prompt
  // 背景只有全新开始的才发；清空了是去掉（空字符串），带上下文的不动它（设备进程本来就不用）
  const background = fields.background.trim()
  if (kind === 'fresh' && background !== proposal.background.trim())
    overrides.background = background
  if (fields.sandbox) overrides.sandbox = fields.sandbox
  if (fields.wake !== proposal.wakeParent) overrides.wakeParent = fields.wake
  return overrides
}
