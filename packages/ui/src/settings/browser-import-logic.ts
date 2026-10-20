// “从浏览器导入”对话框里不靠页面就能算的几样：哪个来源、哪份资料、哪一类能选，不能的原因；默认勾哪几类；
// “只导这些网站的 Cookie”的名单怎么认；拼给主进程的请求；进度怎么往前走；结果归纳成哪一句、哪种颜色、
// 能不能重试；对话框的几个阶段怎么换（importStep）；横幅出不出。
// 纯函数，不依赖 React 和页面，只类型引用：界面测试直接引（packages/ui/test/browser-import.test.mjs）。
import type { MessageKey } from '../i18n/index.ts'
import type {
  ImportKind,
  ImportKindOutcome,
  ImportKindStatus,
  ImportOutcome,
  ImportProfile,
  ImportProgress,
  ImportRequest,
  ImportSource,
  ImportState,
} from '../side/browser/bridge.ts'

/** 两类，按显示的先后 */
export const KINDS: readonly ImportKind[] = ['cookies', 'passwords']

/** 能导的两类都受保护：读它们才会弹系统授权、才要管理员同意 */
const guarded = (kind: ImportKind): boolean => kind === 'cookies' || kind === 'passwords'

// ---------- 选来源、资料、类别 ----------

/** 一类在这份资料上能不能勾：能；读取器在这台电脑上读不了；这份资料里没有 */
export type KindLook = 'ok' | 'unsupported' | 'missing'

export function kindLook(
  source: ImportSource,
  profile: ImportProfile | undefined,
  kind: ImportKind,
): KindLook {
  if (!source.kinds.includes(kind)) return 'unsupported'
  if (!profile?.has[kind]) return 'missing'
  return 'ok'
}

/** 这份资料能导的几类 */
export const importableKinds = (
  source: ImportSource,
  profile: ImportProfile | undefined,
): ImportKind[] => KINDS.filter((kind) => kindLook(source, profile, kind) === 'ok')

/** 一份资料选不了的原因；能选是 null */
export const profileBlock = (source: ImportSource, profile: ImportProfile): 'nothing' | null =>
  importableKinds(source, profile).length > 0 ? null : 'nothing'

/** 一个来源选不了的原因：一份资料都没找到；每份资料都没有能导的；能选是 null */
export function sourceBlock(source: ImportSource): 'noProfiles' | 'nothing' | null {
  if (source.profiles.length === 0) return 'noProfiles'
  return source.profiles.some((profile) => profileBlock(source, profile) === null)
    ? null
    : 'nothing'
}

export const BLOCK_TEXT: Record<'noProfiles' | 'nothing', MessageKey> = {
  noProfiles: 'bimport.block.noProfiles',
  nothing: 'bimport.block.nothing',
}

export const LOOK_TEXT: Record<Exclude<KindLook, 'ok'>, MessageKey> = {
  unsupported: 'bimport.look.unsupported',
  missing: 'bimport.look.missing',
}

/** 来源的先后：能选的在前，其余照主进程给的顺序 */
export const orderSources = (sources: readonly ImportSource[]): ImportSource[] => [
  ...sources.filter((source) => sourceBlock(source) === null),
  ...sources.filter((source) => sourceBlock(source) !== null),
]

/** 一个来源里默认选哪份资料：浏览器自己的默认资料能选就是它，不然第一份能选的 */
export function defaultProfile(source: ImportSource): ImportProfile | undefined {
  const usable = source.profiles.filter((profile) => profileBlock(source, profile) === null)
  return usable.find((profile) => profile.isDefault) ?? usable[0]
}

/** 默认勾选：Cookie、密码都开；能导的才勾 */
export function defaultKinds(
  source: ImportSource,
  profile: ImportProfile | undefined,
): Record<ImportKind, boolean> {
  const can = importableKinds(source, profile)
  return {
    cookies: can.includes('cookies'),
    passwords: can.includes('passwords'),
  }
}

/** 资料在列表里怎么写：名字，带账号的加上账号 */
export const profileLabel = (profile: ImportProfile): string =>
  profile.account ? `${profile.name} (${profile.account})` : profile.name

// ---------- 只导这些网站的 Cookie ----------

/** 主机名（已经是小写的 ASCII，国际化域名换成了 punycode）：每段字母数字和连字符，连字符不在两头 */
const HOST =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/

/** 一项认成主机名：网址取主机，`*.`、前导点、末尾点去掉，端口和路径不要；认不出是 null */
export function domainOf(item: string): string | null {
  const bare = item.trim().replace(/^\*\./, '').replace(/^\.+/, '')
  // 带用户名的（a@b.com）不当网址认：那是写错了，不是 b.com
  if (!bare || bare.includes('@')) return null
  let host: string
  try {
    host = new URL(bare.includes('://') ? bare : `http://${bare}`).hostname
  } catch {
    return null
  }
  host = host.replace(/\.+$/, '')
  return HOST.test(host) ? host : null
}

/** 名单原文拆开认：逗号（中英文）、分号、空白、换行都算分隔；重复的只留一个 */
export function parseDomains(text: string): { domains: string[]; bad: string[] } {
  const domains: string[] = []
  const bad: string[] = []
  for (const item of text.split(/[\s,，;；、]+/)) {
    if (!item) continue
    const host = domainOf(item)
    if (host === null) bad.push(item)
    else if (!domains.includes(host)) domains.push(host)
  }
  return { domains, bad }
}

// ---------- 提示和请求 ----------

/** 勾了的里面有受保护的两类 */
export const touchesGuarded = (kinds: readonly ImportKind[]): boolean => kinds.some(guarded)

/** 要不要提前说“这一版导不了它受保护的那部分”：Windows 上新版 Chrome 系浏览器的应用绑定数据，这一版不提权去读 */
export const hitsAppBound = (source: ImportSource, kinds: readonly ImportKind[]): boolean =>
  source.needsElevation && touchesGuarded(kinds)

/** 要不要提前说“系统会弹授权框” */
export const wantsSystemAuth = (source: ImportSource, kinds: readonly ImportKind[]): boolean =>
  source.promptsSystemAuth && touchesGuarded(kinds)

/** 对话框表单上的样子 */
export interface ImportDraft {
  browser: string
  profileId: string
  kinds: Record<ImportKind, boolean>
  /** 勾了“只导这些网站的 Cookie” */
  onlyDomains: boolean
  /** 网站名单的原文 */
  domainsText: string
}

/** 表单的初值：默认的来源、资料、类别；一个能选的来源都没有是 null */
export function initialDraft(sources: readonly ImportSource[]): ImportDraft | null {
  const source = orderSources(sources).find((one) => sourceBlock(one) === null)
  if (!source) return null
  return draftFor(source, undefined)
}

/** 换了来源或资料之后的表单：类别回到这份资料的默认，名单留着 */
export function draftFor(
  source: ImportSource,
  profileId: string | undefined,
  previous?: ImportDraft,
): ImportDraft {
  const profile =
    source.profiles.find((one) => one.id === profileId && profileBlock(source, one) === null) ??
    defaultProfile(source)
  return {
    browser: source.browser,
    profileId: profile?.id ?? '',
    kinds: defaultKinds(source, profile),
    onlyDomains: previous?.onlyDomains ?? false,
    domainsText: previous?.domainsText ?? '',
  }
}

/** 表单上选着的来源和资料 */
export function chosenOf(
  sources: readonly ImportSource[],
  draft: ImportDraft,
): { source: ImportSource; profile: ImportProfile } | null {
  const source = sources.find((one) => one.browser === draft.browser)
  const profile = source?.profiles.find((one) => one.id === draft.profileId)
  return source && profile ? { source, profile } : null
}

/** 表单上真要导的几类：勾了的、而且这份资料能导的 */
export function pickedKinds(sources: readonly ImportSource[], draft: ImportDraft): ImportKind[] {
  const chosen = chosenOf(sources, draft)
  if (!chosen) return []
  const can = importableKinds(chosen.source, chosen.profile)
  return KINDS.filter((kind) => draft.kinds[kind] && can.includes(kind))
}

export type DraftProblem = 'noSource' | 'noKinds' | 'noDomains' | 'badDomains'

/** 表单拼成请求；拼不成说哪一样不对（名单认不出的那几项带上） */
export function requestOf(
  sources: readonly ImportSource[],
  draft: ImportDraft,
): { request: ImportRequest } | { problem: DraftProblem; bad?: string[] } {
  const chosen = chosenOf(sources, draft)
  if (!chosen || profileBlock(chosen.source, chosen.profile) !== null) {
    return { problem: 'noSource' }
  }
  const kinds = pickedKinds(sources, draft)
  if (kinds.length === 0) return { problem: 'noKinds' }
  const request: ImportRequest = {
    browser: chosen.source.browser,
    profileId: chosen.profile.id,
    kinds,
    // 这一版不提权读
    allowElevated: false,
  }
  if (kinds.includes('cookies') && draft.onlyDomains) {
    const { domains, bad } = parseDomains(draft.domainsText)
    if (bad.length > 0) return { problem: 'badDomains', bad }
    if (domains.length === 0) return { problem: 'noDomains' }
    request.cookieDomains = domains
  }
  return { request }
}

export const PROBLEM_TEXT: Record<DraftProblem, MessageKey> = {
  noSource: 'bimport.problem.noSource',
  noKinds: 'bimport.problem.noKinds',
  noDomains: 'bimport.problem.noDomains',
  badDomains: 'bimport.problem.badDomains',
}

// ---------- 进度 ----------

/** 一类在导入过程中的位置 */
export type KindStage = 'waiting' | 'reading' | 'writing' | 'done'

const STAGE_ORDER: readonly KindStage[] = ['waiting', 'reading', 'writing', 'done']

export const stagesOf = (kinds: readonly ImportKind[]): Partial<Record<ImportKind, KindStage>> =>
  Object.fromEntries(kinds.map((kind) => [kind, 'waiting' as KindStage]))

/** 收到一条进度：只往前走，不是这次要导的类别不理 */
export function advance(
  stages: Partial<Record<ImportKind, KindStage>>,
  progress: ImportProgress,
): Partial<Record<ImportKind, KindStage>> {
  const now = stages[progress.kind]
  if (now === undefined) return stages
  if (STAGE_ORDER.indexOf(progress.phase) <= STAGE_ORDER.indexOf(now)) return stages
  return { ...stages, [progress.kind]: progress.phase }
}

export const STAGE_TEXT: Record<KindStage, MessageKey> = {
  waiting: 'bimport.stage.waiting',
  reading: 'bimport.stage.reading',
  writing: 'bimport.stage.writing',
  done: 'bimport.stage.done',
}

// ---------- 结果 ----------

/** ok：成了；warn：成了一部分；err：没成、能想办法；quiet：没什么可导或没轮上 */
export type Tone = 'ok' | 'warn' | 'err' | 'quiet'

export interface KindReport {
  kind: ImportKind
  status: ImportKindStatus
  tone: Tone
  say: MessageKey
  imported: number
  skippedExisting: number
  skippedInvalid: number
  failed: number
  discovered: number
  /** 照原样再来一次值得 */
  retry: boolean
  /** 主进程给的英文原话，只放进“详情” */
  error?: string
}

/**
 * ok：有导进来的、没有没成的；partial：导进来一些、也有没成的；failed：没导进来、有没成的；
 * existing：没有新的，都已经在 Litch 里了；nothing：什么都没导进来（来源里没有、都无效、读不了）；
 * cancelled：用户停下了；profile-gone、busy：整体性的失败
 */
export type Overall =
  | 'ok'
  | 'partial'
  | 'failed'
  | 'existing'
  | 'nothing'
  | 'cancelled'
  | 'profile-gone'
  | 'busy'

export interface ImportReport {
  overall: Overall
  say: MessageKey
  kinds: KindReport[]
  /** 能照原样重试的几类 */
  again: ImportKind[]
}

const STATUS_LOOK: Record<ImportKindStatus, { tone: Tone; say: MessageKey; retry: boolean }> = {
  ok: { tone: 'ok', say: 'bimport.status.ok', retry: false },
  // partial、failed 管线也拿来报写不进内置浏览器、密码库出错，说法不能只说“读不出来”
  partial: { tone: 'warn', say: 'bimport.status.partial', retry: true },
  missing: { tone: 'quiet', say: 'bimport.status.missing', retry: false },
  locked: { tone: 'err', say: 'bimport.status.locked', retry: true },
  denied: { tone: 'err', say: 'bimport.status.denied', retry: true },
  // Windows 上新版 Chrome 系浏览器的应用绑定数据：这一版不提权读，重试也没用
  'needs-elevation': { tone: 'warn', say: 'bimport.status.needsElevation', retry: false },
  unsupported: { tone: 'quiet', say: 'bimport.status.unsupported', retry: false },
  cancelled: { tone: 'quiet', say: 'bimport.status.cancelled', retry: false },
  failed: { tone: 'err', say: 'bimport.status.failed', retry: true },
  skipped: { tone: 'quiet', say: 'bimport.status.skipped', retry: false },
}

/** 主进程没报这一类：当没成 */
const LOST: ImportKindOutcome = {
  status: 'failed',
  discovered: 0,
  imported: 0,
  skippedExisting: 0,
  skippedInvalid: 0,
  failed: 0,
}

/**
 * 密码库用不了（系统的加密存储不可用，Electron 的 safeStorage）：重试也存不进去。
 * 主进程只给了英文原话（browser/passwords/store.mts 的 PasswordEncryptionUnavailable），只能按它认
 */
export const storeUnavailable = (error: string | undefined): boolean =>
  !!error && /system keystore|encryption (is )?(not )?available|safeStorage/i.test(error)

/** 一类的结果归纳成一行 */
export function kindReport(kind: ImportKind, outcome: ImportKindOutcome | undefined): KindReport {
  const got = outcome ?? LOST
  const look = STATUS_LOOK[got.status] ?? STATUS_LOOK.failed
  let { tone, say, retry } = look
  if (got.status === 'ok') {
    if (got.failed > 0) {
      // 读全了，写的时候有几条没进去
      tone = 'warn'
      say = 'bimport.status.okFailed'
      retry = true
    } else if (got.imported === 0) {
      // 没有新的：来源里没有、都已经有了、都无效
      if (got.skippedExisting > 0) {
        tone = 'quiet'
        say = 'bimport.status.allExisting'
      } else if (got.skippedInvalid > 0) {
        tone = 'warn'
        say = 'bimport.status.allInvalid'
      } else {
        tone = 'quiet'
        say = 'bimport.status.empty'
      }
    }
  }
  if ((got.status === 'partial' || got.status === 'failed') && storeUnavailable(got.error)) {
    say = 'bimport.status.storeUnavailable'
    retry = false
  }
  return {
    kind,
    status: got.status,
    tone,
    say,
    imported: got.imported,
    skippedExisting: got.skippedExisting,
    skippedInvalid: got.skippedInvalid,
    failed: got.failed,
    discovered: got.discovered,
    retry,
    ...(got.error ? { error: got.error } : {}),
  }
}

/** 这一行要不要写条数：有任何一个数，或者成了 */
export const showsCounts = (line: KindReport): boolean =>
  line.tone === 'ok' || line.imported + line.skippedExisting + line.skippedInvalid + line.failed > 0

export const OVERALL_TEXT: Record<Overall, MessageKey> = {
  ok: 'bimport.overall.ok',
  partial: 'bimport.overall.partial',
  failed: 'bimport.overall.failed',
  existing: 'bimport.overall.existing',
  nothing: 'bimport.overall.nothing',
  cancelled: 'bimport.overall.cancelled',
  'profile-gone': 'bimport.overall.profileGone',
  busy: 'bimport.overall.busy',
}

/**
 * 整次导入归纳：kinds 是这次要导的几类，按它的先后出。stopped 是用户点过“停止导入”：
 * 停在两类之间时主进程可能一条 cancelled 都不报（前一类写完了、后一类 skipped），也算停下了
 */
export function reportOf(
  kinds: readonly ImportKind[],
  outcome: ImportOutcome,
  stopped = false,
): ImportReport {
  // 整体性的失败（资料不在、另一个导入在跑）没有逐类的结果
  const lines = outcome.error
    ? []
    : KINDS.filter((kind) => kinds.includes(kind) || outcome.kinds[kind]).map((kind) =>
        kindReport(kind, outcome.kinds[kind]),
      )
  const again = lines.filter((line) => line.retry).map((line) => line.kind)
  let overall: Overall
  if (outcome.error) overall = outcome.error
  else if (
    stopped ||
    lines.some((line) => line.status === 'cancelled' || line.status === 'skipped')
  ) {
    overall = 'cancelled'
  } else {
    const bad = lines.some((line) => line.tone === 'err')
    const imported = lines.some((line) => line.imported > 0)
    const warned = lines.some((line) => line.tone === 'warn')
    if (imported) overall = bad || warned ? 'partial' : 'ok'
    else if (bad) overall = 'failed'
    else if (lines.some((line) => line.skippedExisting > 0) && !warned) overall = 'existing'
    else overall = 'nothing'
  }
  return { overall, say: OVERALL_TEXT[overall], kinds: lines, again }
}

/**
 * 结果页上点“重试”时发的请求：照原样能重试的几类；一类都没有是 null。
 * origin 是表单上点“导入”时的那一份（网站名单从它取）
 */
export function retryRequest(origin: ImportRequest, report: ImportReport): ImportRequest | null {
  const kinds = KINDS.filter((kind) => report.again.includes(kind))
  if (kinds.length === 0) return null
  const request: ImportRequest = {
    browser: origin.browser,
    profileId: origin.profileId,
    kinds,
    allowElevated: false,
  }
  if (kinds.includes('cookies') && origin.cookieDomains) {
    request.cookieDomains = origin.cookieDomains
  }
  return request
}

/** 重试的结果并进上一次的：重试了的几类换成新的，别的照旧；整体性的失败以这一次为准 */
export function mergeOutcome(
  previous: ImportOutcome | undefined,
  next: ImportOutcome,
): ImportOutcome {
  if (!previous || next.error) return next
  return { kinds: { ...previous.kinds, ...next.kinds } }
}

// ---------- 对话框的阶段 ----------

export type ImportStep =
  | { name: 'loading' }
  | { name: 'loadFailed'; reason: string }
  | { name: 'pick'; sources: ImportSource[] }
  | {
      name: 'running'
      sources: ImportSource[]
      /** 这一趟发的请求（重试时只含要重试的几类） */
      request: ImportRequest
      /** 用户在表单上点“导入”时的那一份，重试都从它算 */
      origin: ImportRequest
      stages: Partial<Record<ImportKind, KindStage>>
      stopping: boolean
      /** 重试时上一次的结果，这次的并进去 */
      base?: ImportOutcome
    }
  | {
      name: 'done'
      sources: ImportSource[]
      /** 表单上点“导入”时的那一份 */
      origin: ImportRequest
      outcome: ImportOutcome
      /** 用户点过“停止导入” */
      stopped: boolean
    }
  | { name: 'startFailed'; sources: ImportSource[]; reason: string }

export type ImportEvent =
  | { type: 'load' }
  | { type: 'loaded'; sources: ImportSource[] }
  | { type: 'loadFailed'; reason: string }
  | { type: 'start'; request: ImportRequest }
  | { type: 'retry'; request: ImportRequest }
  | { type: 'progress'; progress: ImportProgress }
  | { type: 'stop' }
  | { type: 'finished'; outcome: ImportOutcome }
  | { type: 'startFailed'; reason: string }
  | { type: 'back' }

const stepSources = (step: ImportStep): ImportSource[] => ('sources' in step ? step.sources : [])

/** 对话框换阶段。不合这一阶段的事件不理（比如结果已经出来之后迟到的进度） */
export function importStep(step: ImportStep, event: ImportEvent): ImportStep {
  switch (event.type) {
    case 'load':
      return step.name === 'running' ? step : { name: 'loading' }
    case 'loaded':
      return step.name === 'loading' ? { name: 'pick', sources: orderSources(event.sources) } : step
    case 'loadFailed':
      return step.name === 'loading' ? { name: 'loadFailed', reason: event.reason } : step
    case 'start':
      if (step.name !== 'pick') return step
      return {
        name: 'running',
        sources: step.sources,
        request: event.request,
        origin: event.request,
        stages: stagesOf(event.request.kinds),
        stopping: false,
      }
    case 'retry':
      if (step.name !== 'done') return step
      return {
        name: 'running',
        sources: step.sources,
        request: event.request,
        origin: step.origin,
        stages: stagesOf(event.request.kinds),
        stopping: false,
        base: step.outcome,
      }
    case 'progress':
      return step.name === 'running'
        ? { ...step, stages: advance(step.stages, event.progress) }
        : step
    case 'stop':
      return step.name === 'running' ? { ...step, stopping: true } : step
    case 'finished':
      if (step.name !== 'running') return step
      return {
        name: 'done',
        sources: step.sources,
        origin: step.origin,
        outcome: mergeOutcome(step.base, event.outcome),
        stopped: step.stopping,
      }
    case 'startFailed':
      return step.name === 'running'
        ? { name: 'startFailed', sources: step.sources, reason: event.reason }
        : step
    case 'back':
      return step.name === 'done' || step.name === 'startFailed'
        ? { name: 'pick', sources: stepSources(step) }
        : step
  }
}

/** 关对话框能不能直接关：正在导的时候不能（要先停） */
export const canClose = (step: ImportStep): boolean => step.name !== 'running'

// ---------- 横幅 ----------

/** 浏览器面板上出不出横幅：状态取到了、从没导过、没关过 */
export const showBanner = (state: ImportState | null): boolean =>
  state !== null && state.lastImportAt === undefined && state.bannerDismissedAt === undefined

// ---------- 主进程给的东西：不信形状 ----------
// 主进程不认这个窗口时 sources 回 []、state 回 {}、start 回 null（browser-import/install.mts），
// 旧的或出了错的也可能回别的。界面这边一律先过一遍，认不出的当没有。

const STATUSES: readonly ImportKindStatus[] = [
  'ok',
  'partial',
  'missing',
  'locked',
  'denied',
  'needs-elevation',
  'unsupported',
  'cancelled',
  'failed',
  'skipped',
]

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0

/** start 的回答；认不出整体是 null（当没开始成），某一类认不出就当主进程没报这一类 */
export function parseOutcome(raw: unknown): ImportOutcome | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as { error?: unknown; kinds?: unknown }
  if (value.error === 'profile-gone' || value.error === 'busy')
    return { error: value.error, kinds: {} }
  if (!value.kinds || typeof value.kinds !== 'object') return null
  const kinds: ImportOutcome['kinds'] = {}
  for (const kind of KINDS) {
    const one = (value.kinds as Record<string, unknown>)[kind]
    if (!one || typeof one !== 'object') continue
    const item = one as Record<string, unknown>
    const status = STATUSES.find((known) => known === item.status)
    if (!status) continue
    kinds[kind] = {
      status,
      discovered: count(item.discovered),
      imported: count(item.imported),
      skippedExisting: count(item.skippedExisting),
      skippedInvalid: count(item.skippedInvalid),
      failed: count(item.failed),
      ...(typeof item.error === 'string' && item.error ? { error: item.error } : {}),
    }
  }
  return { kinds }
}

/** sources 的回答：不是数组当没找到 */
export const parseSources = (raw: unknown): ImportSource[] =>
  Array.isArray(raw)
    ? raw.filter(
        (one): one is ImportSource =>
          !!one &&
          typeof one === 'object' &&
          typeof (one as ImportSource).browser === 'string' &&
          Array.isArray((one as ImportSource).profiles) &&
          Array.isArray((one as ImportSource).kinds),
      )
    : []

/** state 的回答：只取两个时间 */
export function parseState(raw: unknown): ImportState {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const state: ImportState = {}
  if (typeof value.lastImportAt === 'number') state.lastImportAt = value.lastImportAt
  if (typeof value.bannerDismissedAt === 'number') state.bannerDismissedAt = value.bannerDismissedAt
  return state
}
