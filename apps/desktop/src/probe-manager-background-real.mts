// 经理后台状态的真实界面验收引导：正式桌面主入口 + 隔离设备 + 真实 Claude Code + 回环假模型。
// 经理自己起一条后台命令后结束回合，再开一条工作线让它也起后台命令；每一步只读正式界面上的事实
// （侧栏经理行的记号与文字、输入框上方那一行、右侧“后台任务”页），由外层 check-manager-background-real.mjs 判定。
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import { type EnginesKit, installEnginesKit } from './probe-engines-kit.mjs'
import { type FilesKit, installFilesKit } from './probe-files-kit.mjs'

interface Fixture {
  cwd: string
  directory: string
  show: boolean
  main: string
}
export const BACKGROUND_STEPS = [
  '01-open',
  '02-own-background',
  '03-own-finished',
  '04-line-background',
  '05-line-page',
] as const

async function backgroundStep(step: string, cwd: string): Promise<object> {
  const page = window as unknown as {
    __filesKit: FilesKit
    __enginesKit: EnginesKit
    __bgReal?: { managerId: string; lineId: string }
    __litchLook: { set(patch: { lang: string }): void }
  }
  const { one, all, text, write, frame } = page.__filesKit
  const kit = page.__enginesKit
  const state = (page.__bgReal ??= { managerId: '', lineId: '' })
  /** 命令审批卡（经理自己的，或工作线经经理页转上来的）一律“本会话内允许”，夹具里只有 sleep */
  const approve = () => {
    for (const button of all('button') as HTMLButtonElement[])
      if (text(button).startsWith('本会话内允许') && !button.disabled) button.click()
  }
  const wait = async <T,>(what: string, read: () => T | null | false | undefined, ms = 120_000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      approve()
      const value = read()
      if (value) return value
      await new Promise((done) => setTimeout(done, 50))
    }
    throw new Error(`等不到 ${what}；页面：${document.body.innerText.slice(-6000)}`)
  }
  const click = async (selector: string) => {
    const button = await wait(selector, () => one<HTMLButtonElement>(selector))
    button.click()
    await frame()
  }
  const field = (label: string) =>
    all('.mg-panel:not([hidden]) label').find(
      (entry) => entry.firstChild?.textContent?.trim() === label,
    )
  const fill = async (label: string, value: string) => {
    const input = await wait(label, () =>
      field(label)?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea'),
    )
    write(input, value)
    await frame()
  }
  const row = () => one(`.mg-sidebar-manager[data-manager-id="${CSS.escape(state.managerId)}"]`)
  /** 侧栏经理行：状态记号的类名与右侧文字 */
  const managerRow = () => ({
    mark: one('.mg-pick > i.st', row())?.className ?? null,
    label: text(one('.mg-sidebar-counts', row())),
  })
  /** 当前页输入框上方那一行，以及右侧“后台任务”页里在跑的行 */
  const bar = () => {
    const element = one('.bgbar')
    return element ? { count: element.dataset.background ?? '', text: text(element) } : null
  }
  const panel = async () => {
    if (!one('.bg-panel')) await click('.bgbar')
    const rows = await wait('后台任务页的行', () => {
      const found = all('.bg-panel .bg-row[data-status="running"]')
      return found.length ? found : null
    })
    return rows.map((entry) => ({
      title: text(one('.t', entry)),
      meta: text(one('.meta', entry)),
      stop: Boolean(one('.bg-stop', entry)),
    }))
  }
  const reply = async (expected: string) => {
    await wait(expected, () =>
      all('.mg-chat .turn .md, .main .turn .md').some((entry) => text(entry).includes(expected)),
    )
    await kit.idle()
  }
  if (step === '01-open') {
    page.__litchLook.set({ lang: 'zh-CN' })
    await click('[data-sidebar-mode="manager"]')
    if (!one('[data-manager="list"]')) await click('.mg-sidebar-group header .ibtn')
    await wait('全部经理页', () => one('[data-manager="list"]'))
    await click('.sb-top .new')
    await wait('新建经理表单', () => one('[data-manager="form"]'))
    await fill('名称', '后台状态验收经理')
    await fill('经理设定', '在隔离仓库验收后台命令与工作线的状态显示。')
    await click('.mg-form button[type="submit"]')
    await wait('运行环境步骤', () => one('[data-manager-step="runtime"]'))
    await fill('工作目录', cwd)
    const picker = await wait('经理 harness 选择项', () =>
      [...document.querySelectorAll<HTMLSelectElement>('.mg-form select')].find((entry) =>
        [...entry.options].some((option) => option.value === 'claude-code'),
      ),
    )
    picker.value = 'claude-code'
    picker.dispatchEvent(new Event('change', { bubbles: true }))
    await frame()
    await click('.mg-form button[type="submit"]')
    await wait('任务分配步骤', () => one('[data-manager-step="dispatch"]'))
    for (const label of all('.mg-form label')) {
      const checkbox = one<HTMLInputElement>('input[type="checkbox"]', label)
      if (checkbox?.checked && /工作树|桌面通知/.test(text(label))) checkbox.click()
    }
    await frame()
    await click('.mg-form button[type="submit"]')
    const manager = await wait('经理页', () => one<HTMLElement>('[data-manager="session"]'))
    state.managerId = manager.dataset.managerId ?? ''
    await reply('经理已就绪，等待开始。')
    return { managerId: state.managerId, row: managerRow(), bar: bar() }
  }
  if (step === '02-own-background') {
    // 经理自己：起后台命令、回一句就结束回合
    await kit.send('后台跑')
    await reply('在后台跑着了，跑完再说。')
    const shown = await wait('输入框上方的后台任务行', () => bar(), 20_000).catch(() => null)
    const tasks = shown ? await panel() : []
    return { row: managerRow(), bar: shown, tasks, foot: kit.foot() }
  }
  if (step === '03-own-finished') {
    // 后台命令跑完：输入框上方那一行消失，侧栏回到空闲
    if (one('.bg-panel')) await click('.bgbar').catch(() => {})
    await wait('经理的后台命令跑完', () => !one('.bgbar'), 180_000)
    await kit.idle()
    return { row: managerRow(), bar: bar() }
  }
  if (step === '04-line-background') {
    const title = '后台状态验收工作线'
    await kit.send(
      `会话：start ${JSON.stringify({
        title,
        kind: 'fresh',
        initiation: 'user_asked',
        background:
          '这是经理后台状态的隔离验收。工作线只在夹具仓库起一条睡眠命令放到后台，不修改任何文件、不访问个人配置、不发布内容。',
        prompt: '后台跑：在后台起一条睡眠命令，起好就结束这一回合。',
      })}`,
    )
    await reply('会话结果：')
    const line = await wait('侧栏里的工作线', () =>
      all('[data-session]', row()).find((entry) => text(entry).includes(title)),
    )
    state.lineId = line.dataset.session ?? ''
    const lineRow = () => one(`[data-session="${CSS.escape(state.lineId)}"]`, row())
    // 工作线的命令审批在它自己的页面里答；回合结束、后台命令在跑时它那一行换成后台记号
    one<HTMLButtonElement>('button', lineRow())?.click()
    await wait('工作线的后台记号', () => one('i.st.bg', lineRow()), 120_000)
    await click(`.mg-sidebar-manager[data-manager-id="${CSS.escape(state.managerId)}"] .mg-pick`)
    await wait('回到经理页', () => one('[data-manager="session"] .mg-chat .turn'))
    await kit.idle()
    await frame()
    return {
      row: managerRow(),
      managerBar: bar(),
      lineMark: one('i.st', lineRow())?.className ?? null,
    }
  }
  if (step === '05-line-page') {
    // 普通对话页（工作线自己的页面）：同样有那一行，右侧页能看到命令、用时并停止
    await click(`.mg-sidebar-manager [data-session="${CSS.escape(state.lineId)}"] button`)
    const shown = await wait('工作线页的后台任务行', () => bar(), 30_000)
    const tasks = await panel()
    await click('.bg-panel .bg-row[data-status="running"] .bg-stop')
    await wait('停止后那一行消失', () => !one('.bgbar'), 60_000)
    await click('[data-sidebar-mode="manager"]')
    await click(`.mg-sidebar-manager[data-manager-id="${CSS.escape(state.managerId)}"] .mg-pick`)
    await wait('经理行回到空闲', () => !managerRow().label.includes('工作线'), 60_000).catch(
      () => {},
    )
    return { bar: shown, tasks, rowAfterStop: managerRow() }
  }
  throw new Error(`未知步骤 ${step}`)
}

async function run(window: BrowserWindow, fixture: Fixture): Promise<void> {
  if (window.isVisible() !== fixture.show) throw new Error('窗口显示状态与 --show 不符')
  const inPage = async <T, A extends unknown[]>(
    fn: (...args: A) => T,
    ...args: A
  ): Promise<Awaited<T>> =>
    window.webContents.executeJavaScript(
      `(${fn.toString()})(${args.map((arg) => JSON.stringify(arg)).join(',')})`,
      true,
    )
  await inPage(installFilesKit)
  await inPage(installEnginesKit)
  const rows: Record<string, { status: string; evidence?: object; screenshot: string }> = {}
  for (const step of BACKGROUND_STEPS) {
    const screenshot = join(fixture.directory, `${step}.png`)
    try {
      const evidence = await inPage(backgroundStep, step, fixture.cwd)
      await writeFile(screenshot, (await window.webContents.capturePage()).toPNG())
      rows[step] = { status: '完成', evidence, screenshot }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await writeFile(screenshot, (await window.webContents.capturePage()).toPNG()).catch(() => {})
      rows[step] = { status: `失败：${reason}`, screenshot }
    }
    console.log(`LITCH_BG_REAL ${JSON.stringify({ step, ...rows[step] })}`)
    if (rows[step]?.status.startsWith('失败')) break
  }
  console.log(`LITCH_BG_RESULT ${JSON.stringify({ rows })}`)
  app.quit()
}

const fixture = JSON.parse(process.env.LITCH_BG_REAL ?? '{}') as Fixture
if (!fixture.main || !fixture.directory) throw new Error('缺少后台状态验收夹具配置')
let attached = false
app.on('browser-window-created', (_event, window) => {
  if (attached) return
  attached = true
  window.setSize(1500, 1000)
  window.webContents.setBackgroundThrottling(false)
  if (!fixture.show) {
    window.show = () => {}
    app.dock?.hide()
  }
  window.webContents.once('did-finish-load', () => {
    void (async () => {
      const url = new URL(window.webContents.getURL())
      url.searchParams.set('onboarding', 'off')
      await window.loadURL(url.href)
      await run(window, fixture)
    })().catch((error: unknown) => {
      console.error(error)
      app.exit(1)
    })
  })
})
await import(fixture.main)
