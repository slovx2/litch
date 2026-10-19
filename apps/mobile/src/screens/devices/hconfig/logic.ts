// 详情设置在手机上不靠界面就能测的那几样（test/hconfig.test.mjs 直接引）：provider 怎么分“一眼要看的”和
// “连接其他 provider”、筛选；一次登录在手机上能不能走完（要回调转发的不能）；一个值写成一小段字；配置项怎么分组。
// 草稿、解析、MCP 表单这些和桌面一样的，用桌面界面那一份（packages/ui/src/devices/hconfig/logic.ts）。
import type {
  HarnessConfigTopicView,
  HcAttempt,
  HcConfigView,
  HcGroup,
  HcProvider,
  HcSettingSpec,
  HcValue,
} from '@litch/core'
import { secretSet } from '../../../../../../packages/ui/src/devices/hconfig/logic.ts'
import type { Translator } from '../../../ui/i18n'

/** 其余的 provider 不超过这么多时直接列出来，多了收进“连接其他 provider”（照桌面端） */
export const OTHERS_INLINE = 6

/** 一眼要看的：在用的、登录了的、自定义的、正在登录的；其余（内置但没登录的）收起来 */
export const isPrimary = (provider: HcProvider, attempts: readonly HcAttempt[]): boolean =>
  provider.active ||
  provider.auth.signedIn ||
  provider.kind === 'custom' ||
  attempts.some((one) => one.providerId === provider.id)

export interface ProviderSplit {
  primary: HcProvider[]
  others: HcProvider[]
  /** others 多到要收起来 */
  folded: boolean
  /** 收起来的那些里按名字筛出来的（没筛就是全部 others） */
  shown: HcProvider[]
}

export function splitProviders(
  providers: readonly HcProvider[],
  attempts: readonly HcAttempt[],
  filter: string,
  titleOf: (provider: HcProvider) => string,
): ProviderSplit {
  const primary = providers.filter((one) => isPrimary(one, attempts))
  const others = providers.filter((one) => !isPrimary(one, attempts))
  const needle = filter.trim().toLowerCase()
  const shown = needle
    ? others.filter((one) =>
        [one.id, titleOf(one)].some((name) => name.toLowerCase().includes(needle)),
      )
    : others
  return { primary, others, folded: others.length > OTHERS_INLINE, shown }
}

/** 还在进行的登录（没成也没败） */
export const isLive = (attempt: HcAttempt): boolean =>
  attempt.step.kind !== 'done' && attempt.step.kind !== 'failed'

/**
 * 这一步授权完要回调到设备上的端口，设备又不是本机（核心给了转发状态）：手机转不了端口。
 * 同时能粘贴授权码的还能在手机上走完（粘贴地址栏里的回调地址），不能粘贴的只能去桌面端
 */
export function callbackOf(attempt: HcAttempt): { port: number; paste: boolean } | null {
  const { step, forward } = attempt
  if (step.kind !== 'openUrl' || step.callbackPort === null || forward === null) return null
  return { port: step.callbackPort, paste: step.prompt.length > 0 }
}

/** 一个值写成一小段字：默认值、被盖住时实际生效的值（照桌面端的 useHcValueText） */
export function valueText(
  spec: HcSettingSpec,
  value: HcValue | null | undefined,
  t: Translator,
): string {
  if (value === null || value === undefined) return t('hc.value.unset')
  if (typeof value === 'boolean') return t(value ? 'manage.value.on' : 'manage.value.off')
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') {
    const option = spec.options.find((entry) => entry.value === value)
    if (option) return t.said(option.title)
    return value === '' ? t('manage.value.empty') : value
  }
  if (Array.isArray(value))
    return value.length === 0 ? t('hc.value.none') : value.map(String).join(', ')
  if (spec.type === 'secret')
    return t(secretSet(value) ? 'manage.secret.set' : 'manage.secret.unset')
  const json = JSON.stringify(value)
  return json.length > 80 ? `${json.slice(0, 77)}…` : json
}

/** 配置项按对面声明的分组摆；没声明分组的（和动作）归进最后一组“其他”（id 是空串） */
export function groupsOf(
  data: HcConfigView,
  other: string,
): { group: HcGroup; specs: HcSettingSpec[]; actions: HcConfigView['actions'] }[] {
  const known = new Set(data.groups.map((group) => group.id))
  const inGroup = (id: string, group: string) => (id === '' ? !known.has(group) : group === id)
  const groups: HcGroup[] = [
    ...data.groups,
    { id: '', title: { 'zh-CN': other, en: other }, description: null },
  ]
  return groups.flatMap((group) => {
    const specs = data.settings.filter((spec) => inGroup(group.id, spec.group))
    const actions = data.actions.filter((action) => inGroup(group.id, action.group))
    return specs.length === 0 && actions.length === 0 ? [] : [{ group, specs, actions }]
  })
}

/** 页面整体处在哪一种：还在订、设备没连上、不支持、能用 */
export function pageState(
  view: HarnessConfigTopicView | undefined | 'error',
): 'loading' | 'offline' | 'unsupported' | 'ready' {
  if (view === undefined) return 'loading'
  if (view === 'error' || view.supported === null) return 'offline'
  return view.supported ? 'ready' : 'unsupported'
}
