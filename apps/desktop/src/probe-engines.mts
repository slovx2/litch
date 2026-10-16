// 三个引擎各走一遍的验收（一）：设备连上之后各个 harness 的样子，和在每个上面新建会话、发头一句。
// 对面是由真的适配器主进程管着的隔离设备（scripts/device-fixture.mjs --managed --engines …）：
// 真的 Claude Code、Pi、DeepSeek Harness，模型是回环上的假模型，话里带哪个词它就做哪件事
// （scripts/client-fixture-anthropic.mjs 开头有全表）。
// 这里只管走、把看到的照实记下来，不通的地方不绕；三家各该是什么写在 probe-engines-judge.mts。
// 起它的是 scripts/check-engines.mjs，主进程这一头的编排在 probe-engines-run.mts。
// 和别的验收一样，下面的函数会被原样送进页面里执行，不能引用函数外面的东西。
import type { EnginesKit, PickerSeen } from './probe-engines-kit.mjs'
import type { FilesKit } from './probe-files-kit.mjs'

/** 夹具报上来的：三家共用的工作目录、里面那项技能，和验收给这个目录起的项目名字 */
export interface EnginesPlace {
  cwd: string
  workspace: string
  skill: { name: string; mark: string }
}

/** 要走的一个 harness：标识、头一句话（也是它那个会话的标题） */
export interface EngineSpec {
  id: string
  opening: string
}

export interface HarnessShown {
  id: string
  name: string
  badge: string
  version: string
  /** 设备服务报的状态（ready、unavailable、disabled…）和标题行上给人看的那个词 */
  state: string
  said: string
}

export interface DeviceSeen {
  /** 设备详情里列的 harness */
  harnesses: HarnessShown[]
  /** 给三家共用的工作目录建的那个项目出现在侧栏里了 */
  workspace: boolean
}

/** 设备详情里各个 harness 的样子；再给三家共用的那个工作目录建一个项目 */
export async function enginesDevice(place: EnginesPlace, wanted: string[]): Promise<DeviceSeen> {
  const files = (window as unknown as { __filesKit: FilesKit }).__filesKit
  const { one, all, text, until, frame, write } = files
  const block = (id: string) => one(`[data-harness-block="${id}"]`)

  // ---- 一、设备详情：要走的那几个 harness 都可用 ----
  ;(await until('侧栏底部的“设备”', () => one<HTMLButtonElement>('.sb-link.devices'))).click()
  const item = await until('设备列表上的本机', () => one('.devp-item[data-device="local"]'))
  one<HTMLButtonElement>('.devp-row', item)?.click()
  await until('管理数据', () => one('[data-manage-state="ready"]'), 60_000)
  // 等不到也往下走：哪个没起来照实记在结果里，由判定去说
  await files.seen(() => wanted.every((id) => block(id)?.dataset.state === 'ready'), 60_000)
  const harnesses = all('[data-harness-block]').map((entry) => ({
    id: entry.dataset.harnessBlock ?? '',
    name: text(one('.mng-h-name', entry)),
    badge: text(one('.mng-h-head .chip', entry)),
    version: text(one('.mng-h-ver', entry)),
    state: entry.dataset.state ?? '',
    said: text(one('[data-harness-state]', entry)),
  }))

  // ---- 二、给三家共用的工作目录建一个项目：新建会话时选它，会话的工作目录就是它 ----
  const local = () => one('.dev-group')
  const line = () => one(':scope > .row-line', local())
  ;(
    await until('本机那一行的“更多”', () => one<HTMLButtonElement>('.row-more > .ibtn', line()))
  ).click()
  ;(
    await until('“添加项目”', () =>
      one<HTMLButtonElement>('.row-more .pick-opt[data-action="addWorkspace"]', line()),
    )
  ).click()
  write(await until('目录那一栏', () => one<HTMLInputElement>('#ws-root')), place.cwd)
  write(await until('名字那一栏', () => one<HTMLInputElement>('#ws-name')), place.workspace)
  await frame()
  one<HTMLButtonElement>('.ws-dialog .btn.primary')?.click()
  await until('对话框关掉', () => !one('dialog.ws-dialog[open]'))
  const workspace = await files.seen(
    () => all('[data-workspace] .name', local()).some((name) => text(name) === place.workspace),
    20_000,
  )
  return { harnesses, workspace }
}

export interface StartSeen {
  /** 新建对话页上：选 harness 的选择器里列了谁、选着谁；标题栏上的徽标是谁 */
  harness: PickerSeen | null
  crumbHarness: string
  /** 输入框底栏：模型、强度、权限这几个选择器里列了什么、选着什么；有没有计划模式的开关 */
  model: PickerSeen | null
  effort: PickerSeen | null
  permission: PickerSeen | null
  plan: boolean
  /** 页上选着的设备和项目 */
  device: string
  workspace: string
  /** 头一句发出去：气泡当场出现、落到了新会话里 */
  bubbled: boolean
  landed: boolean
  /** 回答是一段一段出来的：从头到尾显示成过几种样子，有没有哪一种不是最终文字开头的一截 */
  shapes: number
  stray: string[]
  /** 回合怎么结束的、回答是什么 */
  foot: string
  answer: string
  /** 侧栏里选中的那一行：标题、徽标说的是哪个 harness；标题栏上的标题；所在的项目 */
  rowTitle: string
  rowHarness: string
  crumb: string
  rowWorkspace: string
  /** 建好之后底栏上三个选择器各选着什么（没有这个选择器是空的） */
  modelAfter: string
  effortAfter: string
  permissionAfter: string
}

/** 在一个 harness 上新建会话、发头一句 */
export async function enginesStart(spec: EngineSpec, place: EnginesPlace): Promise<StartSeen> {
  const files = (window as unknown as { __filesKit: FilesKit }).__filesKit
  const kit = (window as unknown as { __enginesKit: EnginesKit }).__enginesKit
  const { one, all, text, until, frame, write, press } = files
  const harnessOn = (root: Element | null) => kit.sub(root, '.chip')?.title ?? ''

  // ---- 一、新建对话页：从项目那一行的加号进，选这个 harness ----
  const add = await until('项目行上的新建按钮', () =>
    all('.row-add').find((button) => button.parentElement?.textContent?.includes(place.workspace)),
  )
  add.click()
  await until('新建会话的页面', () => one('.new-hero'))
  await until('选 harness 的选择器', () => one('.pick[data-kind="harness"] .pick-btn'))
  await kit.pick('harness', spec.id)
  // 底栏的选项是按 harness 问来的：等它换成这个 harness 的那一份
  await files.seen(() => one('.dock .pick[data-kind="model"]'), 15_000)
  await frame()
  const harness = await kit.picker('harness')
  const model = await kit.picker('model')
  const effort = await kit.picker('effort')
  const permission = await kit.picker('permission')
  const plan = Boolean(one('.dock .mode-btn[data-kind="plan"]'))
  const device = text(one('.pick[data-kind="device"] .pick-btn'))
  const workspace = text(one('.pick[data-kind="workspace"] .pick-btn'))
  const crumbHarness = harnessOn(one('.crumb'))

  // ---- 二、发头一句：盯着回答从头到尾显示成过什么样子 ----
  const shapes: string[] = []
  const sample = () => {
    const shown = text(all('.turn > .md').at(-1))
    if (shown && shapes.at(-1) !== shown) shapes.push(shown)
  }
  const observer = new MutationObserver(sample)
  observer.observe(document.body, { subtree: true, childList: true, characterData: true })
  const input = await until('输入框', kit.area)
  write(input, spec.opening)
  await frame()
  press(input, 'Enter')
  const bubbled = await files.seen(
    () => all('.umsg-text').some((entry) => text(entry) === spec.opening),
    5000,
  )
  const landed = await files.seen(() => !one('.new-hero') && one('.ss-row.sel'), 60_000)
  await kit.idle()
  observer.disconnect()
  sample()
  const final = shapes.at(-1) ?? ''
  const stray = shapes
    .filter((shape) => !final.startsWith(shape))
    .map((shape) => shape.slice(0, 60))
  const row = one('.ss-row.sel')
  return {
    harness,
    crumbHarness,
    model,
    effort,
    permission,
    plan,
    device,
    workspace,
    bubbled,
    landed,
    shapes: shapes.length,
    stray: stray.slice(0, 3),
    foot: kit.foot(),
    answer: kit.lastAnswer(),
    rowTitle: text(kit.sub(row, '.title')),
    rowHarness: harnessOn(row),
    crumb: text(one('.crumb b')),
    rowWorkspace: text(kit.sub(row?.closest('[data-group]'), '[data-workspace] .name')),
    modelAfter: text(one('.dock .pick[data-kind="model"] .pick-btn')),
    effortAfter: text(one('.dock .pick[data-kind="effort"] .pick-btn')),
    permissionAfter: text(one('.dock .pick[data-kind="permission"] .pick-btn')),
  }
}
