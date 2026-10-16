// 设备设置的草稿：用户改了、还没保存的那些栏。
// 一台设备一份，只放在这次运行的内存里——不落盘、不进本地存储：里面可能有刚填的新密钥。
// 离开详情页再回来草稿还在；保存成功或者放弃之后清掉。
// 每一栏草稿记着开始改的那一刻这一项“被动过几次”（见核心的 ManageRevisions）和当时存着的值：
// 之后次数变了，就是别处在这期间动过它，这一栏要让用户看着最新的值再决定。
// 次数只在详情页开着的那一段里算数；页面关掉再打开，靠当时存着的值来认（adoptDrafts）。
import {
  type EnvEntryView,
  looksSecret,
  type SettingEditView,
  type SettingSpecView,
  type SettingValueView,
} from '@litch/core'
import { useSyncExternalStore } from 'react'
import type { Args, MessageKey } from '../../i18n/index.ts'

/** 环境变量表里的一行 */
export interface EnvRow {
  /** 这一行在界面上的标识：改名字时行不换 */
  id: number
  name: string
  /** 输入框里的值。原来就存着的密钥这里是空的：它的值界面上没有 */
  value: string
  secret: boolean
  /** 原来就存着的密钥，值没有重新填：保存时不带值，让对面保留原来的 */
  kept: boolean
}

/** 一栏草稿里的东西 */
export type DraftEdit =
  /** 清掉，回到默认值 */
  | { kind: 'reset' }
  | { kind: 'boolean'; value: boolean }
  /** 一行字、路径、单选、密钥；整数也先原样留着输入框里的字，保存时才认 */
  | { kind: 'text'; value: string }
  | { kind: 'env'; rows: EnvRow[] }

export interface Draft {
  /** 开始改的时候这一项被动过几次。STALE：这一项在详情页关着的时候被别处改过 */
  base: number
  /** 开始改的时候存着的值，写成一串字。密钥的值本来就不在里面 */
  was: string
  edit: DraftEdit
}

const STALE = -1

/** 一次保存没成 */
export interface SaveFailure {
  /** 通道给的错误，显示的时候才按当前语言说 */
  error: unknown
  /** 是哪一项不合规矩。说不出是哪一项时是 null */
  key: string | null
  /** 是不是因为别处先改了 */
  conflict: boolean
}

export interface DeviceDrafts {
  drafts: Readonly<Record<string, Draft>>
  saving: boolean
  /** 上一次保存没成的原因。再改一栏或者再保存就清掉 */
  failure: SaveFailure | null
}

const EMPTY: DeviceDrafts = { drafts: {}, saving: false, failure: null }
const states = new Map<string, DeviceDrafts>()
const listeners = new Set<() => void>()

const put = (deviceId: string, next: DeviceDrafts) => {
  states.set(deviceId, next)
  for (const listener of listeners) listener()
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const draftsOf = (deviceId: string): DeviceDrafts => states.get(deviceId) ?? EMPTY

/** 这台设备的草稿。哪一栏变了，用它的组件都会重画 */
export function useDrafts(deviceId: string): DeviceDrafts {
  return useSyncExternalStore(subscribe, () => draftsOf(deviceId))
}

const written = (stored: SettingValueView | undefined): string => JSON.stringify(stored ?? null)

/** 一栏开始改的那一刻：这一项被动过几次、当时存着什么 */
export interface Origin {
  revision: number
  stored: SettingValueView | undefined
}

/** 记下一栏的草稿。这一栏已经有草稿的话，开始改的那一刻不变 */
export function setDraft(deviceId: string, key: string, edit: DraftEdit, origin: Origin): void {
  const state = draftsOf(deviceId)
  const before = state.drafts[key]
  const draft: Draft = {
    base: before?.base ?? origin.revision,
    was: before?.was ?? written(origin.stored),
    edit,
  }
  put(deviceId, { ...state, drafts: { ...state.drafts, [key]: draft }, failure: null })
}

/** 用户动了一栏的控件：改回和存着的一样就不算改过，否则记成草稿 */
export function editDraft(
  deviceId: string,
  spec: SettingSpecView,
  edit: DraftEdit,
  origin: Origin,
): void {
  if (sameAsStored(spec, edit, origin.stored)) dropDrafts(deviceId, [spec.key])
  else setDraft(deviceId, spec.key, edit, origin)
}

/** 放弃几栏的草稿；不说哪几栏就是全部 */
export function dropDrafts(deviceId: string, only?: readonly string[]): void {
  const state = draftsOf(deviceId)
  const drafts = only
    ? Object.fromEntries(Object.entries(state.drafts).filter(([key]) => !only.includes(key)))
    : {}
  if (Object.keys(drafts).length === Object.keys(state.drafts).length) return
  // 没成的那一项放弃了，或者一栏都不剩了：上次没成的原因也不用再挂着
  const { failure } = state
  const moot =
    Object.keys(drafts).length === 0 || (failure?.key != null && !(failure.key in drafts))
  put(deviceId, { ...state, drafts, failure: moot ? null : failure })
}

/** 把放弃了的草稿拿回来（“撤销”）。这期间又改过的栏以新改的为准 */
export function restoreDrafts(deviceId: string, drafts: Readonly<Record<string, Draft>>): void {
  const state = draftsOf(deviceId)
  put(deviceId, { ...state, drafts: { ...drafts, ...state.drafts } })
}

/** “保留我的”：看过别处改成的值了，这一栏的草稿从现在算起 */
export function rebaseDraft(deviceId: string, key: string, origin: Origin): void {
  const state = draftsOf(deviceId)
  const draft = state.drafts[key]
  if (!draft) return
  const next: Draft = { ...draft, base: origin.revision, was: written(origin.stored) }
  put(deviceId, { ...state, drafts: { ...state.drafts, [key]: next } })
}

/**
 * 详情页重新打开、管理数据重新订阅上了：“被动过几次”从头算起，留下来的草稿要重新对一遍。
 * 当时存着的值和现在的一样，就当没被动过；不一样的标成 STALE，这一栏会说它被别处改过了。
 */
export function adoptDrafts(
  deviceId: string,
  values: Readonly<Record<string, SettingValueView>>,
  revisions: Readonly<Record<string, number>>,
): void {
  const state = draftsOf(deviceId)
  const entries = Object.entries(state.drafts)
  if (entries.length === 0) return
  const drafts = Object.fromEntries(
    entries.map(([key, draft]) => [
      key,
      { ...draft, base: draft.was === written(values[key]) ? (revisions[key] ?? 0) : STALE },
    ]),
  )
  put(deviceId, { ...state, drafts })
}

export function setSaving(deviceId: string, saving: boolean): void {
  put(deviceId, { ...draftsOf(deviceId), saving })
}

export function setFailure(deviceId: string, failure: SaveFailure | null): void {
  put(deviceId, { ...draftsOf(deviceId), failure })
}

let rowSeq = 0

/** 读到的环境变量表变成可以改的行 */
export function rowsOf(value: SettingValueView | undefined): EnvRow[] {
  if (!Array.isArray(value)) return []
  return value.map((entry) => {
    const secret = entry.secret === true || looksSecret(entry.name)
    return {
      id: ++rowSeq,
      name: entry.name,
      value: secret ? '' : (entry.value ?? ''),
      secret,
      kept: secret,
    }
  })
}

export const newRow = (): EnvRow => ({
  id: ++rowSeq,
  name: '',
  value: '',
  secret: false,
  kept: false,
})

/** 这一行按不按密钥存：自己勾了的，和名字看着像密钥的（设备服务对后一种不问就按密钥处理） */
export const rowIsSecret = (row: EnvRow): boolean => row.secret || looksSecret(row.name)

/** 草稿和现在存着的值是不是一回事：是的话这一栏就不算改过 */
export function sameAsStored(
  spec: SettingSpecView,
  edit: DraftEdit,
  stored: SettingValueView | undefined,
): boolean {
  if (edit.kind === 'boolean') return edit.value === stored
  if (edit.kind === 'text') {
    // 密钥：没填就是没改
    if (spec.type === 'secret') return edit.value === ''
    if (spec.type === 'integer') return edit.value.trim() === String(stored)
    return edit.value === stored
  }
  if (edit.kind === 'env') {
    const before = Array.isArray(stored) ? stored : []
    if (before.length !== edit.rows.length) return false
    return edit.rows.every((row, index) => {
      const entry = before[index]
      if (!entry || entry.name !== row.name) return false
      const secret = entry.secret === true || looksSecret(entry.name)
      return secret ? row.kept : !rowIsSecret(row) && row.value === (entry.value ?? '')
    })
  }
  return false
}

/** 一栏填得不对：哪一句话 */
export interface Problem {
  key: MessageKey
  args?: Args
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

function envEdit(rows: readonly EnvRow[]): EnvEntryView[] | Problem {
  const seen = new Set<string>()
  const entries: EnvEntryView[] = []
  for (const row of rows) {
    const name = row.name.trim()
    if (!name) return { key: 'manage.env.problem.noName' }
    if (!NAME.test(name)) return { key: 'manage.env.problem.badName', args: { name } }
    if (seen.has(name)) return { key: 'manage.env.problem.twice', args: { name } }
    seen.add(name)
    if (row.kept) entries.push({ name, secret: true })
    else if (rowIsSecret(row)) {
      if (!row.value) return { key: 'manage.env.problem.noValue', args: { name } }
      entries.push({ name, value: row.value, secret: true })
    } else entries.push({ name, value: row.value })
  }
  return entries
}

const isProblem = (value: unknown): value is Problem =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && 'key' in value

/**
 * 一栏草稿要写进去的值。填得不对就给出问题，不写。
 * 这里只按类型查界面自己看得出来的毛病；别的规矩（端口不能相同之类）由设备服务把关
 */
export function editOf(spec: SettingSpecView, edit: DraftEdit): SettingEditView['value'] | Problem {
  if (edit.kind === 'reset') return null
  if (edit.kind === 'boolean') return edit.value
  if (edit.kind === 'env') return envEdit(edit.rows)
  if (spec.type !== 'integer') return edit.value
  const text = edit.value.trim()
  if (!/^-?\d+$/.test(text)) return { key: 'manage.problem.integer' }
  const value = Number(text)
  if (!Number.isSafeInteger(value)) return { key: 'manage.problem.integer' }
  const { minimum, maximum } = spec
  if (minimum !== null && value < minimum) return { key: 'manage.problem.min', args: { minimum } }
  if (maximum !== null && value > maximum) return { key: 'manage.problem.max', args: { maximum } }
  return value
}

/** 一栏草稿填得对不对。对就是 null */
export function problemOf(spec: SettingSpecView, edit: DraftEdit): Problem | null {
  const value = editOf(spec, edit)
  return isProblem(value) ? value : null
}

/** 把草稿变成一次写入的改动。有哪一栏填得不对就返回 null */
export function editsOf(
  settings: readonly SettingSpecView[],
  drafts: Readonly<Record<string, Draft>>,
): SettingEditView[] | null {
  const edits: SettingEditView[] = []
  for (const spec of settings) {
    const draft = drafts[spec.key]
    if (!draft) continue
    const value = editOf(spec, draft.edit)
    if (isProblem(value)) return null
    edits.push({ key: spec.key, value })
  }
  return edits
}
