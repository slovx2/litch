// 输入区里“打一个符号弹出一张单子”的接线：认出触发词、凑条目、管按键、把选中的那一项办掉。
// 单子本身（Suggest.tsx）只管画；这里把它和输入框、底栏、核心接起来。
import { type DeviceView, keys, type MessageExtra, type SkillOption } from '@litch/core'
import { type KeyboardEvent, type ReactNode, type RefObject, useEffect, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { downHarness } from '../app/device.ts'
import { whyNot } from '../app/errors.ts'
import { useKey } from '../app/services.tsx'
import { showToast } from '../app/toasts.tsx'
import { GOAL_PREFIX } from '../goal/logic.ts'
import type { MessageKey } from '../i18n/index.ts'
import { togglePanel } from '../terminal/panel.ts'
import type { Compaction } from './ContextMeter.tsx'
import { type BuiltinId, builtinCommands, PICKER_OF } from './commands.ts'
import { Suggest, type SuggestEntry, type SuggestGroup, useSuggestKeys } from './Suggest.tsx'
import { insertMention } from './session-hits.ts'
import { cutTrigger, findTrigger, rank, standsAlone } from './suggest.ts'
import { useFileHits } from './useFileHits.ts'
import { useSessionHits } from './useSessionHits.ts'
import { useSkills } from './useSkills.ts'

export interface SuggestHost {
  deviceId: string
  /** 当前会话。新建对话页上没有。`@` 列会话时不列它自己 */
  sessionId?: string | undefined
  /** 这条消息里已经提到的会话（随消息带的 session）：`@` 不再列它们，满了不再列 */
  mentioned: readonly string[]
  harness: string | undefined
  /** 技能按哪个工作目录取（没有就由对面按它自己的当前目录看）；`@` 找文件也在这个目录里找，没有就找不了 */
  cwd: string | null
  /** 这是在新建对话页上 */
  fresh?: boolean | undefined
  text: string
  input: RefObject<HTMLTextAreaElement | null>
  /** 底栏上现在有哪几个选择器 */
  pickers: readonly string[]
  /** 这个会话能不能设持续目标。不给就按 harness 的声明（新建对话页上） */
  goal?: boolean | undefined
  /** 计划模式的开关：这个 harness 会才给。on 是现在开没开 */
  plan?: { on: boolean; toggle(): void } | undefined
  compact?: Compaction | undefined
  /** 开一个新对话。新建对话页上不给 */
  onNew?: (() => void) | undefined
  /** 把输入框里的字换掉，光标落到 caret */
  edit(text: string, caret: number): void
  addExtra(extra: MessageExtra): void
}

export interface SuggestControl {
  /** 要画在输入区里的单子；没开就是 null */
  popup: ReactNode
  /** 返回真表示这个键归单子，输入框不要再处理 */
  onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean
  /** 人打了字，打完是 value、光标在 caret。只认人打出来的触发词 */
  typed(value: string, caret: number): void
  /** 光标动了。选了一段的时候给 null */
  moved(caret: number | null): void
  focus(on: boolean): void
}

const COMMAND_TEXT: Record<BuiltinId, MessageKey> = {
  new: 'slash.new',
  compact: 'slash.compact',
  plan: 'slash.plan',
  goal: 'slash.goal',
  model: 'slash.model',
  effort: 'slash.effort',
  permissions: 'slash.permissions',
  terminal: 'slash.terminal',
}

const command = (id: string): BuiltinId | null =>
  id.startsWith('cmd:') ? (id.slice(4) as BuiltinId) : null

/**
 * 点开底栏上的一个选择器。它收起来之后焦点会落在它自己的按钮上，这里再把焦点还给输入框：
 * 从输入框里叫出来的，办完回到输入框接着写。
 */
function openPicker(area: HTMLTextAreaElement | null, kind: string): void {
  const button = area
    ?.closest('.cmp')
    ?.querySelector<HTMLButtonElement>(`.pick[data-kind="${kind}"] .pick-btn`)
  if (!area || !button) return
  button.click()
  const watcher = new MutationObserver(() => {
    if (button.getAttribute('aria-expanded') === 'true') return
    watcher.disconnect()
    // 等选择器自己把焦点放回按钮之后再拿：人已经点到别处去了的不抢
    requestAnimationFrame(() => {
      if (document.activeElement === button || document.activeElement === document.body) {
        area.focus()
      }
    })
  })
  watcher.observe(button, { attributes: true, attributeFilter: ['aria-expanded'] })
}

export function useSuggest(host: SuggestHost): SuggestControl {
  const { deviceId, harness, cwd, text, input } = host
  const t = useT()
  const [caret, setCaret] = useState<number | null>(null)
  /**
   * 人最后一次打完字时输入框里是什么。和现在的字一样才认触发词：
   * 程序换进来的字（翻出来的输入历史、放回来的草稿）不弹单子
   */
  const [typedText, setTypedText] = useState<string | null>(null)
  // 字被程序换过之后，上一次打的就不作数了：免得后来翻出一条一模一样的输入历史时被当成刚打的
  useEffect(() => {
    setTypedText((typed) => (typed === text ? typed : null))
  }, [text])
  const [focused, setFocused] = useState(false)
  /** 按 Esc 关掉的那个触发词在哪。同一个词接着打不再弹，删掉重打才弹 */
  const [dismissed, setDismissed] = useState<number | null>(null)

  const found = typedText === text && focused && caret !== null ? findTrigger(text, caret) : null
  const trigger = found && found.start !== dismissed ? found : null
  useEffect(() => {
    if (!found) setDismissed(null)
  }, [found])

  const device = useKey<DeviceView>(keys.device(deviceId))
  const reachable = device?.connection === 'online' && !downHarness(device, harness)
  const declared = device?.harnesses.find((entry) => entry.id === harness)?.abilities
  // 它声明了带不了技能：不去问
  const askable = Boolean(reachable) && declared?.skills !== false
  // 两种单子：行首的 `/` 列命令和技能，词开头的 `@` 找会话和文件
  const slash = trigger?.kind === 'slash' ? trigger : null
  const at = trigger?.kind === 'at' ? trigger : null
  const { skills, again } = useSkills({ deviceId, harness, cwd }, slash !== null && askable)
  const sessions = useSessionHits(
    { deviceId, current: host.sessionId ?? null, bound: host.mentioned },
    at ? at.query : null,
  )
  const files = useFileHits(
    { deviceId, root: cwd, online: device?.connection === 'online', fresh: host.fresh === true },
    at ? at.query : null,
  )

  const query = slash?.query ?? ''
  const commands: SuggestEntry[] = slash
    ? builtinCommands({
        inSession: Boolean(host.onNew),
        canCompact: Boolean(host.compact?.able && !host.compact.busy),
        plan: Boolean(host.plan),
        goal: host.goal ?? declared?.goals === true,
        pickers: host.pickers,
        alone: standsAlone(text, slash),
      }).map((id) => ({
        id: `cmd:${id}`,
        kind: 'command',
        title: `/${id}`,
        // /plan 是个开关：单子上写的是按下去会怎样
        note: t(id === 'plan' && host.plan?.on ? 'slash.plan.off' : COMMAND_TEXT[id]),
        words: [id, t(COMMAND_TEXT[id])],
      }))
    : []

  const listed: SkillOption[] =
    skills.state === 'ready'
      ? skills.skills
      : skills.state === 'loading'
        ? (skills.skills ?? [])
        : []
  const skillEntries: SuggestEntry[] = listed.map((skill) => ({
    id: `skill:${skill.path}`,
    kind: 'skill',
    title: `/${skill.name}`,
    note: skill.note || skill.title,
    facts: [
      ...(skill.scope ? [{ label: t('skill.from'), value: t(`skill.scope.${skill.scope}`) }] : []),
      { label: t('skill.path'), value: skill.path },
    ],
    words: [skill.name, skill.title],
  }))

  const shownCommands = rank(commands, query)
  const shownSkills = rank(skillEntries, query)
  /** 技能这一组现在的状况。没什么要交代的就是 undefined */
  let status: SuggestGroup['status']
  let retry: SuggestEntry[] = []
  if (!reachable) status = { text: t('slash.skills.offline') }
  else if (!askable || skills.state === 'unsupported') {
    status = { text: t('slash.skills.unsupported') }
  } else if (skills.state === 'loading' && skills.skills === null) {
    status = { text: t('slash.skills.loading') }
  } else if (skills.state === 'failed') {
    status = { text: t('slash.skills.failed', { reason: skills.reason }), tone: 'err' }
    retry = [{ id: 'again', kind: 'again', title: t('slash.skills.retry'), note: '', words: [] }]
  } else if (skills.state === 'ready' && skills.problems.length > 0) {
    // 有没列出来的：说几项、头一项的原因；全部的位置和原因鼠标停上去看
    const [first] = skills.problems
    status = {
      text: t(skills.problems.length === 1 ? 'slash.skills.skipped.one' : 'slash.skills.skipped', {
        count: skills.problems.length,
        reason: first?.message ?? '',
      }),
      detail: skills.problems
        .map((entry) => (entry.path ? `${entry.path}\n  ${entry.message}` : entry.message))
        .join('\n'),
    }
  } else if (skills.state === 'ready' && skills.skills.length === 0) {
    status = { text: t('slash.skills.empty') }
  }
  // 打了字而什么都没对上：对面有没有技能这时不是要说的事，说“没有叫这个的”。
  // 正在取、没取到的照样交代：要找的那一项可能就在还没到的那一份里
  const settled = skills.state !== 'loading' && skills.state !== 'failed'
  const nothing = shownCommands.length === 0 && shownSkills.length === 0
  if (query && nothing && settled) status = undefined

  // 会话在前：没打字时列最近的几个，文件那一组这时只是一句“输入以搜索”
  const groups: SuggestGroup[] = at
    ? [sessions.group, files.group]
    : [
        { id: 'commands', title: t('slash.group.commands'), entries: shownCommands },
        {
          id: 'skills',
          title: t('slash.group.skills'),
          entries: [...shownSkills, ...retry],
          ...(status ? { status } : {}),
        },
      ]
  const entries = groups.flatMap((group) => group.entries)

  const run = (id: BuiltinId) => {
    if (id === 'new') return host.onNew?.()
    if (id === 'terminal') return togglePanel()
    if (id === 'plan') return host.plan?.toggle()
    if (id === 'compact') {
      host.compact?.run().catch((error: unknown) => {
        showToast({
          id: 'compact-failed',
          tone: 'err',
          lifeMs: 8000,
          text: (say) => say('context.compactFailed', { reason: whyNot(error, say) }),
        })
      })
      return
    }
    const picker = PICKER_OF[id]
    if (picker) openPicker(input.current, picker)
  }

  const pick = (entry: SuggestEntry) => {
    if (!trigger) return
    if (entry.kind === 'again') return again()
    // 会话：`@查询` 换成正文里的 @[标题]，另外记下是哪个会话（发出去时按标题对上）
    if (entry.kind === 'session') {
      const extra = sessions.extraOf(entry.id)
      if (!extra) return
      const next = insertMention(text, trigger, extra.title)
      host.edit(next.text, next.caret)
      setCaret(next.caret)
      host.addExtra(extra)
      return
    }
    const cut = cutTrigger(text, trigger)
    host.edit(cut.text, cut.caret)
    setCaret(cut.caret)
    if (entry.kind === 'skill') {
      const skill = listed.find((item) => `skill:${item.path}` === entry.id)
      if (skill) host.addExtra({ kind: 'skill', name: skill.name, path: skill.path })
      return
    }
    if (entry.kind === 'file' || entry.kind === 'dir') {
      const file = files.extraOf(entry.id)
      if (file) host.addExtra(file)
      return
    }
    const id = command(entry.id)
    // /goal 不是马上办的事：留下前缀，人接着写目标，发出去时再设（goal/send.ts）
    if (id === 'goal') {
      host.edit(GOAL_PREFIX, GOAL_PREFIX.length)
      setCaret(GOAL_PREFIX.length)
      return
    }
    if (id) run(id)
  }

  const open = trigger !== null
  const nav = useSuggestKeys(open, entries, pick, () => setDismissed(trigger?.start ?? null))

  return {
    popup: open ? (
      <Suggest
        label={t(at ? 'at.label' : 'slash.label')}
        groups={groups}
        active={nav.active}
        empty={t(at ? 'at.none' : 'slash.none')}
        onActive={nav.setActive}
        onPick={pick}
      />
    ) : null,
    onKeyDown: nav.onKeyDown,
    typed: (value, at) => {
      setTypedText(value)
      setCaret(at)
      // 打得了字，焦点就在这里（窗口不在前台时页面收不到“得了焦点”的事件）
      setFocused(true)
    },
    moved: setCaret,
    focus: setFocused,
  }
}
