// 自检：不显示窗口，把整条链路走一遍，结果打到标准输出后退出。
// mock：界面在渲染进程里，核心在工具进程里，两边经消息端口通了，快照和流式增量都到了界面。
// entry：核心经套接字连上了一个真实的入口，会话目录和会话内容一路到了界面。
// 这两种都先看一眼启动是不是落在新建对话页（没有哪个会话被自动选中），再点开一个会话看内容。
//
// 另有几种“验收”：scroll 对着模拟核心量对话区在流式输出、点开条目、切换会话时有没有飘；
// scroll-entry 对着真实入口量真实会话的滚动；compose 和 compose-entry 量输入区：发送、排队、
// 打断、草稿和请求卡片，后面接着量会话操作（附说明的拒绝、撤销归档、右键菜单、看已归档的对话、
// 待办、分叉、回退、压缩）。量的办法在 probe-scroll.mts、probe-entry.mts、probe-compose.mts、probe-session.mts。
// compose 这两种最前面先量新建对话页（probe-home.mts，模拟核心上再量它的样子：probe-home-look.mts），
// 最后量请求卡片和输入框并存（probe-cards.mts：平常大小、最小的窗口、模拟核心上再开着终端面板）。
// remote 对着假的远程机器量远程设备：添加、经 ssh 连上、断线自己连回来、分阶段的失败、
// 在详情里改名换色、改连接、重新连接、移除，见 probe-remote.mts。
// remote-service 是远程设备的第二遍，对面装了适配器（设备服务）：预览和列表说得出对面是哪一种、连上是完整模式、
// 管理页、整理工作区、新建会话发消息、回合中断线、在远程设备上开终端并在断线后接回、
// 对面从“只有 codex”变成“装了适配器”之后自己换过去、设备服务用不了的三种说法，见 probe-remote-service.mts。
// full 对着隔离的多 harness 设备量完整模式：两个 harness 的会话、新建时选 harness、一个 harness 掉线和恢复；
// full-mock 对着模拟核心看同样这些东西在界面上有没有。见 probe-full.mts。
// full 和 full-mock 后面都接着量整理侧栏（置顶、分区、工作区）、按声明给入口、不可用之后的下一步，
// 见 probe-organize.mts、probe-organize-mock.mts。
// full-mock 后面接着量设备列表：一行上有什么、键盘、忙闲跟着会话变、六套皮肤、最窄的窗口，见 probe-devices.mts。
// manage-mock 对着模拟核心把设备详情页上管理 harness 和设置的各种状态、控件过一遍（probe-manage-mock.mts）；
// manage 对着带设置接口的隔离设备走真的读写、重启、诊断和日志（probe-manage.mts）。
// 这两种后面各接一段“设备服务”：在跑的是哪一版、哪来的，本机这次连接换没换版本（probe-service.mts）。
// terminal 对着模拟核心量终端面板（probe-terminal.mts）；terminal-device 对着隔离的多 harness 设备量
// 可重连的终端：断线挂回、缺口、核心重启之后恢复成标签、关标签的两种意思（probe-terminal-device.mts）；
// terminal-entry 对着单个 harness 的入口量随连接结束的终端（同一个文件）。这三种由 scripts/check-terminal.mjs 起。
// files 对着模拟核心量侧面板和里面的文件标签（probe-files*.mts）；files-device 对着隔离的多 harness 设备、
// files-entry 对着单个 harness 的入口量真的文件系统上的文件树和查看。这三种由 scripts/check-files.mjs 起。
// sidebar 对着模拟核心量侧栏自己：收起的工作区和设备那一行上的汇总，见 probe-sidebar*.mts。
// diff 对着模拟核心量侧面板里的差异标签（probe-diff*.mts）；diff-device 对着隔离的多 harness 设备、
// diff-entry 对着单个 harness 的入口量真的 git 仓库上的差异、暂存和还原。这三种由 scripts/check-diff.mjs 起。
// settings 对着模拟核心量设置页和外观：页面的开合与五个分组、各个控件当场生效、皮肤预览、快捷键一览和应用菜单对账、
// 关于与许可、回合进行中换外观、六套组合下各屏的溢出与对比度、缩放到最大最小；settings-cold 用同一份用户数据目录
// 冷启动，看窗口一建出来是不是就按上次的皮肤、明暗和缩放来（probe-settings*.mts）。这两种由 scripts/check-settings.mjs 起。
// engines 对着由真的适配器主进程管着的三引擎隔离设备（真的 Claude Code、Pi、dsh，模型是假的），
// 在界面里把三家各走一遍：建会话、审批、提问、技能、打断、读历史、计划、改文件、图片、分叉回退压缩，
// 每一步三家的结果并排打出来（probe-engines*.mts）。由 scripts/check-engines.mjs 起。
// tasks 对着模拟核心量定时任务：侧栏入口、按设备分开的列表、新建、立即运行、去会话、会话顶上那一条（probe-tasks.mts）。
// first-turn 对着同一种隔离设备，只走主路径：每个真的 harness（含原生 codex）从界面新建会话、发头一句、收到回话
// （probe-first-turn.mts）。由 scripts/check-first-turn.mjs 起。
import { OUTPUT_KEEP, PART_CHARS } from '@litch/core'
import { app, type BrowserWindow } from 'electron'
import { activityProbe, judgeActivity } from './probe-activity.mjs'
import { cardRoomProbe, cardsProbe, judgeCards } from './probe-cards.mjs'
import { composeProbe, judgeCompose } from './probe-compose.mjs'
import { askProbe, judgeAsk } from './probe-compose-ask.mjs'
import { type AttachLook, attachLook, attachProbe, judgeAttach } from './probe-compose-attach.mjs'
import { runComposeFilesChecks } from './probe-compose-files.mjs'
import { judgeMention, mentionProbe } from './probe-compose-mention.mjs'
import {
  judgeSheetLook,
  judgeSlash,
  type SlashLook,
  slashLook,
  slashProbe,
} from './probe-compose-more.mjs'
import { judgePlan, planProbe } from './probe-compose-plan.mjs'
import { devicesProbe, judgeDevices, narrowDevicesProbe } from './probe-devices.mjs'
import { type DiffMode, runDiffChecks } from './probe-diff-run.mjs'
import { runEnginesChecks } from './probe-engines-run.mjs'
import { entryProbe, judgeEntry } from './probe-entry.mjs'
import { type FilesMode, runFilesChecks } from './probe-files-run.mjs'
import { runFirstTurnChecks } from './probe-first-turn.mjs'
import { fullProbe, judgeFull, judgeMockFull, mockFullProbe } from './probe-full.mjs'
import { harnessSettingsProbe, judgeHarnessSettings } from './probe-harness-settings.mjs'
import { homeProbe, judgeHome } from './probe-home.mjs'
import { homeLook, judgeHomeLook } from './probe-home-look.mjs'
import { homeMoreProbe, judgeHomeMore } from './probe-home-more.mjs'
import { manageProbe } from './probe-manage.mjs'
import { judgeManage, judgeMockManage } from './probe-manage-judge.mjs'
import { mockManageProbe } from './probe-manage-mock.mjs'
import { judgeOnboard, onboardProbe } from './probe-onboard.mjs'
import { judgeOrganize, organizeProbe } from './probe-organize.mjs'
import { judgeOrganizeMock, organizeMockProbe, PICKED_FOLDER } from './probe-organize-mock.mjs'
import { judgeOutput, outputProbe } from './probe-output.mjs'
import { judgeRemote, remoteProbe } from './probe-remote.mjs'
import { type ServiceAliases, serviceConnect } from './probe-remote-service.mjs'
import { serviceFailures, serviceGrow } from './probe-remote-service-ends.mjs'
import { judgeRemoteService, type ServiceSeen } from './probe-remote-service-judge.mjs'
import { serviceSession } from './probe-remote-service-more.mjs'
import { judgeScroll, scrollProbe } from './probe-scroll.mjs'
import { judgeMockService, judgeService, mockServiceProbe, serviceProbe } from './probe-service.mjs'
import { judgeSession, sessionProbe } from './probe-session.mjs'
import { runSettingsChecks, type SettingsMode } from './probe-settings-run.mjs'
import { runSidebarChecks } from './probe-sidebar-run.mjs'
import { judgeTasks, TASK_NAME, tasksProbe } from './probe-tasks.mjs'
import { installTerminalKit } from './probe-terminal-kit.mjs'
import { runTerminalChecks, type TerminalMode } from './probe-terminal-run.mjs'
import { judgeTools, toolsProbe } from './probe-tools.mjs'
import { runTreeChecks } from './probe-tree.mjs'
import type { QuitOutcome } from './quit-terminals.mjs'

type ProbeMode =
  | 'scroll'
  | 'scroll-entry'
  | 'compose'
  | 'compose-entry'
  | 'remote'
  | 'remote-service'
  | 'full'
  | 'full-mock'
  | 'manage'
  | 'manage-mock'
  | 'sidebar'
  | 'tasks'
  | 'tree'
  | 'onboard'
  | 'harness-settings'
  | 'engines'
  | 'first-turn'
  | TerminalMode
  | FilesMode
  | DiffMode
  | SettingsMode
export type SmokeMode = 'mock' | 'entry' | ProbeMode

/** 验收里要主进程帮忙做的事 */
export interface SmokeHooks {
  /** 走一遍“退出前清点终端”，当作用户点了这一项。不真的退出 */
  quit(answer: 'leave' | 'end' | 'cancel'): Promise<QuitOutcome>
  /** 把核心进程杀掉重起：窗口会重新加载，和应用重开差不多 */
  restartCore(): void
  /** 当作用户点了应用菜单里的一项（按菜单项的标识找）。没有这一项返回 false */
  menu(id: string): boolean
  /**
   * 把页面重新加载一遍，地址里只带这里给的临时指定（平时自检固定带着“语言是中文”，
   * 要量“换了语言重开还在”就得不带它）
   */
  load(params: Record<string, string>): Promise<void>
  /** 窗口刚建出来时用的底色、缩放、最小的大小 */
  born(): { backdrop: string; zoom: number; minSize: [number, number] } | null
  /** 100% 缩放下窗口最小多大 */
  minSize: { width: number; height: number }
  /** 应用的版本 */
  version: string
}

const TERMINAL_MODES: readonly string[] = ['terminal', 'terminal-device', 'terminal-entry']
const FILES_MODES: readonly string[] = ['files', 'files-device', 'files-entry']
const DIFF_MODES: readonly string[] = ['diff', 'diff-device', 'diff-entry']
const SETTINGS_MODES: readonly string[] = ['settings', 'settings-cold']

const PROBE_MODES: readonly string[] = [
  'scroll',
  'scroll-entry',
  'compose',
  'compose-entry',
  'remote',
  'remote-service',
  'full',
  'full-mock',
  'manage',
  'manage-mock',
  'sidebar',
  'tasks',
  'tree',
  'onboard',
  'harness-settings',
  'engines',
  'first-turn',
  ...TERMINAL_MODES,
  ...FILES_MODES,
  ...DIFF_MODES,
  ...SETTINGS_MODES,
]
export const SMOKE_MODES: readonly string[] = ['mock', 'entry', ...PROBE_MODES]
/** 对着模拟核心跑、不连任何设备的那几种 */
export const MOCK_MODES: readonly string[] = [
  'mock',
  'scroll',
  'compose',
  'full-mock',
  'manage-mock',
  'sidebar',
  'tasks',
  'tree',
  'onboard',
  'harness-settings',
  'terminal',
  'files',
  'diff',
  ...SETTINGS_MODES,
]

/** 长输出那一段：展开着的输出框里最多可以有多少个字（核心留着的头尾，加上省略记号上的字） */
const OUTPUT_SHOWN_LIMIT = OUTPUT_KEEP + 100
/**
 * 工具大结果那一段：结果框里最多多少个字（文字段，省略记号和图片说明不算），图片说明最多几行
 * （每一段连同和下一段之间的分隔至少算 2 × PART_CHARS 个字，见 packages/core/src/text/tool-cap.mts）
 */
const TOOL_LIMITS = { chars: OUTPUT_KEEP, blobs: Math.ceil(OUTPUT_KEEP / (2 * PART_CHARS)) + 2 }

/** 界面进程和核心进程现在各占多少内存（常驻的、到现在为止最多的，MB）。只报数 */
function processMemory(window: BrowserWindow) {
  const renderer = window.webContents.getOSProcessId()
  const metrics = app.getAppMetrics()
  const of = (metric: Electron.ProcessMetric | undefined) =>
    metric
      ? {
          workingMB: Math.round(metric.memory.workingSetSize / 102.4) / 10,
          peakMB: Math.round(metric.memory.peakWorkingSetSize / 102.4) / 10,
        }
      : null
  return {
    ui: of(metrics.find((metric) => metric.pid === renderer)),
    // 工具进程的名字是起它时给的（main.mts 的 startCore）
    core: of(metrics.find((metric) => metric.type === 'Utility' && metric.name === 'Litch core')),
  }
}

/** 把一个自给自足的函数送进页面里执行，拿回它的结果。参数要能写成 JSON */
export async function runInPage<T, A extends unknown[]>(
  window: BrowserWindow,
  probe: (...args: A) => Promise<T> | T,
  ...args: A
): Promise<T> {
  const list = args.map((arg) => JSON.stringify(arg)).join(', ')
  return (await window.webContents.executeJavaScript(`(${probe.toString()})(${list})`, true)) as T
}

/**
 * 远程设备的第二遍：页面里的脚本分四段送进去，在同一个窗口里接着量。
 * 哪一段等不到就把前面已经量到的一并报出来，好知道走到了哪
 */
async function measureRemoteService(window: BrowserWindow): Promise<readonly [object, string[]]> {
  const aliases = JSON.parse(process.env.LITCH_SMOKE_ALIASES ?? '{}') as ServiceAliases
  const work = process.env.LITCH_SMOKE_WORK ?? ''
  // 在远程设备上建的那个会话的头一句，也是它的标题：后面按它找这个会话
  const opening = '远程设备服务上的头一句'
  const seen: Partial<ServiceSeen> = {}
  try {
    // 等、找、读终端这几样手，用终端验收的那一套
    await runInPage(window, installTerminalKit)
    seen.connect = await runInPage(window, serviceConnect, aliases, work)
    seen.session = await runInPage(window, serviceSession, aliases.svc, opening)
    seen.grow = await runInPage(window, serviceGrow, aliases, opening)
    seen.failures = await runInPage(window, serviceFailures, aliases)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`${reason}（已经量到的：${JSON.stringify(seen)}）`)
  }
  return [seen, judgeRemoteService(seen as ServiceSeen, aliases)]
}

/** 跑一种验收，返回量到的数字和不合格的项 */
async function measure(
  window: BrowserWindow,
  mode: ProbeMode,
  hooks: SmokeHooks,
): Promise<readonly [object, string[]]> {
  if (mode === 'terminal' || mode === 'terminal-device' || mode === 'terminal-entry') {
    return runTerminalChecks(window, mode, hooks)
  }
  if (mode === 'files' || mode === 'files-device' || mode === 'files-entry') {
    return runFilesChecks(window, mode, hooks)
  }
  if (mode === 'sidebar') return runSidebarChecks(window, hooks)
  if (mode === 'tasks') {
    const result = await runInPage(window, tasksProbe, TASK_NAME)
    return [result, judgeTasks(result, TASK_NAME)]
  }
  if (mode === 'tree') return runTreeChecks(window)
  if (mode === 'onboard') {
    const result = await runInPage(window, onboardProbe)
    return [result, judgeOnboard(result)]
  }
  if (mode === 'harness-settings') {
    const result = await runInPage(window, harnessSettingsProbe)
    return [result, judgeHarnessSettings(result)]
  }
  if (mode === 'engines') return runEnginesChecks(window, hooks)
  if (mode === 'first-turn') return runFirstTurnChecks(window)
  if (mode === 'diff' || mode === 'diff-device' || mode === 'diff-entry') {
    return runDiffChecks(window, mode)
  }
  if (mode === 'settings' || mode === 'settings-cold') {
    return runSettingsChecks(window, mode, hooks)
  }
  if (mode === 'scroll') {
    const result = await runInPage(window, scrollProbe)
    // 命令输出很长的那一段接在后面，在同一个窗口里接着量。两个进程的内存只报数
    const before = processMemory(window)
    const output = await runInPage(window, outputProbe)
    const after = processMemory(window)
    // 同一条命令打得快八倍：一帧来几百 KB，通道只给界面发头尾
    const burst = await runInPage(window, outputProbe, true, '猛打日志')
    const burstAfter = processMemory(window)
    // 工具调用的结果很大的那一段也接在后面
    const tools = await runInPage(window, toolsProbe)
    const toolsAfter = processMemory(window)
    return [
      {
        ...result,
        output: { ...output, memory: { before, after } },
        burst: { ...burst, memory: { before: after, after: burstAfter } },
        tools: { ...tools, memory: { before: burstAfter, after: toolsAfter } },
      },
      [
        ...judgeScroll(result),
        ...judgeOutput(output, OUTPUT_SHOWN_LIMIT),
        ...judgeOutput(burst, OUTPUT_SHOWN_LIMIT).map((line) => `（猛打）${line}`),
        ...judgeTools(tools, TOOL_LIMITS),
      ],
    ]
  }
  if (mode === 'scroll-entry') {
    const result = await runInPage(window, entryProbe)
    return [result, judgeEntry(result, process.env.CI === 'true')]
  }
  if (mode === 'remote') {
    // 假的远程机器上有哪些别名，由起自检的脚本告诉我们
    const aliases = JSON.parse(process.env.LITCH_SMOKE_ALIASES ?? '{}') as {
      ok: string
      bare: string
      old: string
    }
    const result = await runInPage(window, remoteProbe, aliases)
    return [result, judgeRemote(result)]
  }
  if (mode === 'remote-service') return measureRemoteService(window)
  if (mode === 'full') {
    const result = await runInPage(window, fullProbe)
    // 整理侧栏那一组跟在后面，在同一个窗口里接着量：工作区从空开始建
    const organize = await runInPage(window, organizeProbe, result.harnesses[1]?.id ?? '')
    return [{ ...result, organize }, [...judgeFull(result), ...judgeOrganize(organize)]]
  }
  if (mode === 'full-mock') {
    const result = await runInPage(window, mockFullProbe)
    // 设备列表那一组跟在后面，在同一个窗口里接着量；最后把窗口缩到允许的最窄再量一遍
    const devices = await runInPage(window, devicesProbe)
    const [width = 0, height = 0] = window.getSize()
    const [minWidth = 0] = window.getMinimumSize()
    window.setSize(minWidth, height)
    const narrow = await runInPage(window, narrowDevicesProbe)
    window.setSize(width, height)
    // 整理侧栏、按声明给入口那一组排在最后：它会改侧栏（置顶、加工作区），放前面会动到上面几组量的数
    // 添加项目时的“选择…”：系统的选文件夹对话框在自检里不弹，由这个变量代答（main.mts 的 PICK_FOLDER）
    process.env.LITCH_PICK_FOLDER = PICKED_FOLDER
    const organize = await runInPage(window, organizeMockProbe)
    delete process.env.LITCH_PICK_FOLDER
    return [
      { ...result, devices, narrow, organize },
      [
        ...judgeMockFull(result),
        ...judgeDevices(devices, narrow, minWidth),
        ...judgeOrganizeMock(organize),
      ],
    ]
  }
  // 设备管理的两段后面各接一段“设备服务”（probe-service.mts）：在跑的是哪一版，这次连接换没换版本
  if (mode === 'manage-mock') {
    const result = await runInPage(window, mockManageProbe)
    const service = await runInPage(window, mockServiceProbe)
    return [{ ...result, service }, [...judgeMockManage(result), ...judgeMockService(service)]]
  }
  if (mode === 'manage') {
    const result = await runInPage(window, manageProbe)
    const service = await runInPage(window, serviceProbe)
    return [{ ...result, service }, [...judgeManage(result), ...judgeService(service)]]
  }
  const real = mode === 'compose-entry'
  // 新建对话页那一组排最前面：它要量的是刚启动的样子，量完把自己建的会话删掉、回到那一页
  const home = await runInPage(window, homeProbe, real)
  const homeFailed = judgeHome(home, real)
  // 后补的两件事（harness 按工作区记、选择器里添加工作区）只对着模拟核心量：要几台设备、几个工作区
  let homeMore: object | null = null
  // 样子只对着模拟核心量（要一台没连上的设备）：平常大小量一遍，窗口缩到允许的最小再量一遍
  let looks: object | null = null
  if (!real) {
    const more = await runInPage(window, homeMoreProbe)
    homeMore = more
    homeFailed.push(...judgeHomeMore(more))
    const wide = await runInPage(window, homeLook)
    const [width = 0, height = 0] = window.getSize()
    const [minWidth = 0, minHeight = 0] = window.getMinimumSize()
    window.setSize(minWidth, minHeight)
    const narrow = await runInPage(window, homeLook)
    window.setSize(width, height)
    looks = { wide, narrow }
    homeFailed.push(...judgeHomeLook(wide, narrow, minWidth))
  }
  const result = await runInPage(window, composeProbe, real)
  // 会话操作那一组跟在后面，在同一个窗口里接着量
  const session = await runInPage(window, sessionProbe, real)
  // 活动区里跟“回合正在跑”有关的两件事（命令已经跑了多久、活动块什么时候收）：只对着模拟核心量，
  // 要一条不出输出地跑上两秒多的命令，和一个声明了“最终回答一开始就知道”的 harness
  const activity = real ? null : await runInPage(window, activityProbe)
  // 请求卡片和输入框并存那一组排最后：平常大小量一遍，窗口缩到允许的最小再让请求出现一次，
  // 模拟核心上再开着终端面板来一次（打开面板会顺手开一个终端，真实入口上不这样做）
  const cards = await runInPage(window, cardsProbe, real)
  const [fullWidth = 0, fullHeight = 0] = window.getSize()
  const [leastWidth = 0, leastHeight = 0] = window.getMinimumSize()
  window.setSize(leastWidth, leastHeight)
  const short = await runInPage(window, cardRoomProbe, real, false)
  const withTerminal = real ? null : await runInPage(window, cardRoomProbe, real, true)
  window.setSize(fullWidth, fullHeight)
  // 输入区第二批功能排在最后：先量行为（头一回打斜杠要看得到“正在取”），再量样子（只对着模拟核心）
  const slash = await runInPage(window, slashProbe, real)
  const plan = await runInPage(window, planProbe, real)
  const attach = await runInPage(window, attachProbe, real)
  const [files, filesFailed] = await runComposeFilesChecks(window, real)
  const mention = await runInPage(window, mentionProbe, real)
  // 模型边干活边问的题（只对着模拟核心）：对话里的问题卡片
  const ask = await runInPage(window, askProbe, real)
  let slashLooks: { wide: SlashLook; narrow: SlashLook } | null = null
  let attachLooks: { wide: AttachLook; narrow: AttachLook } | null = null
  let mentionLooks: { wide: SlashLook; narrow: SlashLook } | null = null
  if (!real) {
    const wide = await runInPage(window, slashLook, 'slash')
    const wideAttach = await runInPage(window, attachLook)
    const wideMention = await runInPage(window, slashLook, 'at')
    window.setSize(leastWidth, leastHeight)
    const narrow = await runInPage(window, slashLook, 'slash')
    const narrowAttach = await runInPage(window, attachLook)
    const narrowMention = await runInPage(window, slashLook, 'at')
    window.setSize(fullWidth, fullHeight)
    slashLooks = { wide, narrow }
    attachLooks = { wide: wideAttach, narrow: narrowAttach }
    mentionLooks = { wide: wideMention, narrow: narrowMention }
  }
  return [
    {
      home,
      homeMore,
      looks,
      ...result,
      ...session,
      activity,
      cardsBeside: cards,
      cardRoom: { short, withTerminal },
      slash,
      plan,
      slashLooks,
      attach,
      attachLooks,
      files,
      mention,
      mentionLooks,
      ask,
    },
    [
      ...homeFailed,
      ...judgeCompose(result),
      ...judgeSession(session),
      ...(activity ? judgeActivity(activity) : []),
      ...judgeCards(cards, short, withTerminal, real),
      ...judgeSlash(slash, real, slashLooks),
      ...judgePlan(plan, real),
      ...judgeAttach(attach, real, attachLooks),
      ...filesFailed,
      ...judgeMention(mention, real),
      ...judgeAsk(ask),
      ...judgeSheetLook('找文件的单子', mentionLooks),
    ],
  ]
}

async function runProbe(
  window: BrowserWindow,
  mode: ProbeMode,
  hooks: SmokeHooks,
): Promise<boolean> {
  let ok = false
  try {
    // 页面一直加载不完的话不死等：到点照实报出来
    let giveUp: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      new Promise<void>((resolve) => {
        if (window.webContents.isLoading())
          window.webContents.once('did-finish-load', () => resolve())
        else resolve()
      }),
      new Promise<void>((_resolve, reject) => {
        giveUp = setTimeout(
          () =>
            reject(
              new Error(
                `页面 90 秒没有加载完（地址：${window.webContents.getURL() || '还没有'}；${
                  window.webContents.isLoading() ? '还在加载' : '不在加载'
                }；进程起来 ${Math.round(process.uptime())} 秒）`,
              ),
            ),
          90_000,
        )
      }),
    ]).finally(() => clearTimeout(giveUp))
    const [probe, failed] = await measure(window, mode, hooks)
    ok = failed.length === 0
    console.log(`LITCH_SMOKE ${JSON.stringify({ ok, failed, probe })}`)
  } catch (error) {
    const failed = [error instanceof Error ? error.message : String(error)]
    console.log(`LITCH_SMOKE ${JSON.stringify({ ok: false, failed })}`)
  }
  return ok
}

interface Probe {
  shell: string
  /** 侧栏的会话刚到的时候，主区域是不是新建对话页、侧栏里是不是没有选中的会话。会话还没到是 null */
  landed: boolean | null
  rows: number
  turns: number
  answer: number
  /** 代码块里上了色的片段有多少 */
  painted: number
  core: string
  /** 侧栏里每台设备的标题和说明。自检不过时靠它看设备连上没有、出了什么错 */
  devices: string[]
}

/**
 * 看一眼页面。启动落在新建对话页，没有哪个会话是选中的：先记下这一点，再把标题里带 title 的那个会话点开，
 * 后面看的是它的内容
 */
const probeOf = (title: string) => `(() => {
  const rows = [...document.querySelectorAll('.ss-row')]
  const picked = () => Boolean(document.querySelector('.ss-row.sel'))
  if (rows.length > 0 && window.__litchLanded === undefined) {
    window.__litchLanded = Boolean(document.querySelector('.new-hero')) && !picked()
  }
  if (!picked()) rows.find((row) => row.textContent?.includes(${JSON.stringify(title)}))?.click()
  return {
    shell: document.documentElement.dataset.shell ?? '',
    landed: window.__litchLanded ?? null,
    rows: rows.length,
    turns: document.querySelectorAll('.turn').length,
    answer: [...document.querySelectorAll('.md')].at(-1)?.textContent?.length ?? 0,
    painted: document.querySelectorAll('.code code span[class^="hljs-"]').length,
    core: document.querySelector('.sb-foot')?.textContent ?? '',
    devices: [...document.querySelectorAll('.dev-group')].map((group) =>
      [group.querySelector('.dev-row'), group.querySelector('.dev-note')]
        .map((element) => element?.textContent ?? '')
        .join(' | '),
    ),
  }
})()`

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** 跑一遍自检，返回过没过。退出进程由调用的一方负责 */
export async function runSmoke(
  window: BrowserWindow,
  mode: SmokeMode,
  hooks: SmokeHooks,
): Promise<boolean> {
  // 页面加载失败和页面里的报错都打出来，自检不过时好找原因
  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error(`页面加载失败：${code} ${description} ${url}`)
  })
  // 页面的进程、外壳的辅助进程（网络、图形、核心）没了也打出来。
  // 机器被别的活占满的时候出过页面一直加载不完、量到一半停住：要知道是谁没了、怎么没的
  window.webContents.on('render-process-gone', (_event, details) => {
    console.error(`页面的进程没了：${details.reason}（退出码 ${details.exitCode}）`)
  })
  app.on('child-process-gone', (_event, details) => {
    const name = details.name ?? details.serviceName ?? ''
    console.error(
      `辅助进程没了：${details.type} ${name}，${details.reason}（退出码 ${details.exitCode}），进程起来第 ${Math.round(process.uptime())} 秒`,
    )
  })
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error') console.error(`页面报错：${event.message}`)
    // 验收脚本要外面帮忙做的事（比如把 ssh 断掉），原样转给起自检的脚本
    else if (event.message.startsWith('LITCH_SIGNAL ')) console.log(event.message)
  })
  if (PROBE_MODES.includes(mode)) return runProbe(window, mode as ProbeMode, hooks)
  // 模拟核心里点开那个一打开就在流的会话；隔离入口里点开带工具调用的那个
  const script = probeOf(mode === 'entry' ? '给首页加一个状态条' : '把运行时与')
  const deadline = Date.now() + 20_000
  let last: Probe | null = null
  let firstAnswer: number | null = null
  let grew = false
  while (Date.now() < deadline) {
    try {
      // 页面没加载完时这个调用会一直不返回，所以每次最多等一秒
      last = (await Promise.race([
        window.webContents.executeJavaScript(script),
        sleep(1000).then(() => last),
      ])) as Probe | null
    } catch {
      // 页面还没加载好
    }
    if (last?.shell === 'electron' && last.turns >= 1) {
      if (mode === 'entry') {
        // 隔离入口里造了四个会话；侧栏底部不该有“模拟核心”的标记
        if (last.rows >= 4 && last.answer > 0 && !last.core.includes('模拟核心')) {
          grew = true
          break
        }
      } else if (last.rows >= 10 && last.core.includes('模拟核心')) {
        firstAnswer ??= last.answer
        // 回答的字数在涨，说明流式增量是从工具进程一路到了界面
        if (last.answer > firstAnswer) grew = true
        // 示例回答里有一个代码块：等它流出来并上了色（上色库是用到时才装载的那一块）
        if (grew && last.painted > 0) break
      }
    }
    await sleep(100)
  }
  const ok = grew && last?.landed === true && (mode === 'entry' || (last?.painted ?? 0) > 0)
  console.log(`LITCH_SMOKE ${JSON.stringify({ ok, grew, ...last })}`)
  return ok
}
