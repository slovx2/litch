// 独立验收引导：加载正式桌面主入口。页面步骤只点 DOM，不调用核心或设备命令。
// 与引擎验收相同，函数序列化送入沙箱页面；截图由主进程 capturePage 保存。
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import { type EnginesKit, installEnginesKit } from './probe-engines-kit.mjs'
import { type FilesKit, installFilesKit } from './probe-files-kit.mjs'

interface Fixture {
  ids: string[]
  cwd: string
  directory: string
  show: boolean
  main: string
}
interface PageState {
  managerId: string
  lineId: string
  pending: number
}
const steps = [
  '01-open',
  '02-decision',
  '03-answers',
  '04-line',
  '05-origin',
  '06-rules',
  '07-ending',
  '07-ended',
]

/** 每一步都等正式页面呈现预期事实；超时把页面正文附在错误里。 */
async function managerRealStep(step: string, harness: string, cwd: string): Promise<object> {
  const page = window as unknown as {
    __filesKit: FilesKit
    __enginesKit: EnginesKit
    __managerReal?: PageState
    __litchLook: { set(patch: { lang: string }): void }
  }
  const { one, all, text, write, frame } = page.__filesKit
  const kit = page.__enginesKit
  const state = (page.__managerReal ??= { managerId: '', lineId: '', pending: 0 })
  const wait = async <T,>(what: string, read: () => T | null | false | undefined): Promise<T> => {
    const end = Date.now() + 90_000
    while (Date.now() < end) {
      const value = read()
      if (value) return value
      await new Promise((done) => setTimeout(done, 25))
    }
    throw new Error(`等不到 ${what}；页面：${document.body.innerText.slice(-9000)}`)
  }
  const assert = (ok: unknown, what: string) => {
    if (!ok) throw new Error(what)
  }
  const click = async (selector: string) => {
    const button = await wait(selector, () => one<HTMLButtonElement>(selector))
    assert(!button.disabled, `按钮不可用：${selector}`)
    button.click()
    await frame()
  }
  const field = (label: string) =>
    all('.mg-form label').find((entry) => entry.firstChild?.textContent?.trim() === label)
  const fill = async (label: string, value: string) => {
    const input = await wait(label, () =>
      field(label)?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea'),
    )
    write(input, value)
    await frame()
  }
  const row = () => one(`.mg-sidebar-manager[data-manager-id="${CSS.escape(state.managerId)}"]`)
  const pending = () => Number(text(one('[data-sidebar-mode="manager"] .pill')) || 0)
  const reply = async (expected: string, event?: string) => {
    await wait(expected, () =>
      all('.mg-chat .turn > .md').some((entry) => text(entry).includes(expected)),
    )
    await kit.idle()
    assert(kit.foot().includes('完成'), `回合未完成：${kit.where()}`)
    if (event) assert(one(`[data-event="${event}"]`), `未显示 ${event} 事件卡`)
  }
  if (step === '01-open') {
    page.__litchLook.set({ lang: 'zh-CN' })
    await click('[data-sidebar-mode="manager"]')
    await wait('全部经理页', () => one('[data-manager="list"]'))
    state.pending = pending()
    await click('.sb-top .new')
    await wait('新建经理表单', () => one('[data-manager="form"]'))
    await fill('名字', `${harness} 真实界面经理`)
    await fill('范围', '在隔离仓库验收决策、答复、工作线回报和结束流程。')
    await fill('工作目录', cwd)
    const picker = await wait('经理 harness 选择项', () => {
      const candidate = [...document.querySelectorAll<HTMLSelectElement>('.mg-form select')].find(
        (entry) => [...entry.options].some((option) => option.value === harness),
      )
      return candidate
    })
    picker.value = harness
    picker.dispatchEvent(new Event('change', { bubbles: true }))
    await frame()
    // 夹具只验会话回报，不创建额外工作树；通过正式派活选项关闭。
    for (const label of all('.mg-form label')) {
      const checkbox = one<HTMLInputElement>('input[type="checkbox"]', label)
      if (checkbox?.checked && /工作树|桌面通知/.test(text(label))) checkbox.click()
    }
    await frame()
    await click('.mg-form button[type="submit"]')
    const manager = await wait('创建后进入经理页', () =>
      one<HTMLElement>('[data-manager="session"]'),
    )
    state.managerId = manager.dataset.managerId ?? ''
    assert(state.managerId, '经理页没有标识')
    await reply('经理已就绪，等待开始。', 'manager-open')
    const actualHarness = one('.crumb .chip')?.getAttribute('title')
    assert(
      actualHarness === (harness === 'codex' ? 'Codex' : 'Claude Code'),
      `实际 harness 不符：${actualHarness}`,
    )
    return {
      managerId: state.managerId,
      harness,
      actualHarness,
      opening: kit.lastAnswer(),
      foot: kit.foot(),
    }
  }
  if (step === '02-decision') {
    await kit.send(
      `经理：add ${JSON.stringify({
        kind: 'decision',
        decision: {
          title: '是否开始真实界面验收工作线？',
          background: '先由用户在看板确认，再由经理启动隔离工作线并收取回报。',
          options: [{ id: 'go', label: '开始验收', description: '只使用夹具仓库与回环假模型。' }],
          recommend: 'go',
          basis: [{ kind: 'branch', target: 'main', label: '夹具 main 分支' }],
        },
      })}`,
    )
    await reply('经理结果：')
    await click('[data-board-tab="decisions"]')
    await wait(
      '决策与依据',
      () =>
        text(one('.mg-decision')).includes('是否开始真实界面验收工作线？') &&
        text(one('.mg-basis')).includes('夹具 main 分支'),
    )
    await wait(
      '两个待定数增加',
      () => text(one('small', row())).includes('1 待定') && pending() === state.pending + 1,
    )
    return { sidebar: text(row()), pending: pending(), decision: text(one('.mg-decision')) }
  }
  if (step === '03-answers') {
    await click('.mg-decision input[type="radio"]')
    write(
      await wait('自由文字', () => one<HTMLTextAreaElement>('.mg-decision textarea')),
      '按此方案执行，只验隔离目录。',
    )
    await frame()
    await wait(
      '选择与文字草稿',
      () =>
        one('.mg-decision[data-draft="true"] input:checked') &&
        one<HTMLTextAreaElement>('.mg-decision textarea')?.value === '按此方案执行，只验隔离目录。',
    )
    await click('[data-act="manager-submit"]')
    await reply('收到答复：', 'manager-answers')
    await wait(
      '决策已答',
      () =>
        text(one('.mg-decision-filter [aria-pressed="true"]')).includes('已答') &&
        text(one('.mg-decision')).includes('开始验收 按此方案执行，只验隔离目录。'),
    )
    assert(!one('.mg-decision textarea') && !one('.mg-send'), '答复未提交')
    await wait('待定数恢复', () => pending() === state.pending)
    return { answer: text(one('.mg-decision')), reply: kit.lastAnswer(), pending: pending() }
  }
  if (step === '04-line') {
    const title = `${harness} 验收工作线`
    const report = `${harness} 真实界面工作线回报`
    await kit.send(
      `会话：start ${JSON.stringify({
        title,
        kind: 'fresh',
        initiation: 'user_asked',
        background:
          '这是经理真实桌面界面的隔离验收。用户已经在决策看板选择开始并提交自由文字，经理现在开一条工作线，检查回报是否能显示在工作线页和侧栏，不修改真实项目、不访问个人配置、不执行发布。',
        prompt: `${report}：请核对隔离验收背景，汇报完成情况和检查结果。所有操作限定在当前夹具仓库，使用回环假模型，不访问真实项目或个人配置，不发布内容。\n没验：真实模型质量不在本次回环夹具范围内。`,
      })}`,
    )
    await reply('会话结果：')
    await click('[data-board-tab="lines"]')
    const card = await wait('工作线完成及最近回报', () =>
      all('.mg-body .mg-card').find(
        (entry) => text(entry).includes(report) && text(one('.pill', entry)) === '空闲',
      ),
    )
    const line = await wait('侧栏经理的工作线', () =>
      all('[data-session]', row()).find((entry) => text(entry).includes(title)),
    )
    state.lineId = line.dataset.session ?? ''
    assert(state.lineId, '侧栏工作线没有会话标识')
    const shown = text(card)
    await click('[data-sidebar-mode="chat"]')
    await wait('普通对话侧栏', () => !one('.mg-sidebar-group'))
    assert(!one(`.sb-scroll [data-session="${CSS.escape(state.lineId)}"]`), '工作线漏入普通对话')
    assert(!text(one('.sb-scroll')).includes(`${harness} 真实界面经理`), '经理漏入普通对话')
    await click('[data-sidebar-mode="manager"]')
    await click(`.mg-sidebar-manager[data-manager-id="${CSS.escape(state.managerId)}"] .mg-pick`)
    await click('[data-board-tab="lines"]')
    await wait('返回经理后工作线看板重新读完', () =>
      all('.mg-body .mg-card').some(
        (entry) => text(entry).includes(report) && text(one('.pill', entry)) === '空闲',
      ),
    )
    one('.mg-body')?.scrollTo({ top: 0 })
    await frame()
    return { lineId: state.lineId, report: shown, ordinaryChatsExcludeLine: true }
  }
  if (step === '05-origin') {
    await click('.mg-body .mg-card button')
    await wait('来源条', () => text(one('.mg-origin')).includes('由经理开出'))
    await wait('工作线对话读完', () => kit.lastAnswer().includes(`${harness} 真实界面工作线回报`))
    await kit.idle()
    return { origin: text(one('.mg-origin')) }
  }
  if (step === '06-rules') {
    await click('.mg-origin button')
    await wait('返回原经理', () =>
      one(`[data-manager="session"][data-manager-id="${CSS.escape(state.managerId)}"]`),
    )
    await wait('返回后对话和看板读完', () => one('.mg-chat .turn') && one('.mg-body .mg-card'))
    await kit.idle()
    const controls = all('.mg-title button, .tb button').map(text)
    assert(!controls.some((label) => /规矩|范围/.test(label)), '新增了编辑入口，应补齐改规矩验收')
    return {
      skipped: '没验：第一版经理页没有编辑范围或规矩的入口，未验证 manager-rules 事件卡',
      returned: state.managerId,
    }
  }
  if (step === '07-ending') {
    await click('.mg-title button')
    await click('.mg-end button:last-child')
    await wait('结束中', () => one('[data-manager-status="ending"]'))
    assert(
      !one('.mg-chat textarea') && !one('.mg-title button') && one('.mg-readonly'),
      '结束中仍可写入',
    )
    assert(text(row()).includes('结束中'), '侧栏没有结束中状态')
    return { status: 'ending', readOnly: true }
  }
  if (step === '07-ended') {
    await wait('已结束', () => one('[data-manager-status="ended"]'))
    await wait(
      '结束回复与事件',
      () =>
        text(one('.mg-chat')).includes('经理已结束，未完成事项与决策保留在只读看板。') &&
        one('[data-event="manager-end"]'),
    )
    assert(
      !one('.mg-chat textarea') && !one('.mg-title button') && one('.mg-readonly'),
      '已结束仍可写入',
    )
    const toggle = one<HTMLButtonElement>('.mg-sidebar-group:last-child .head-toggle')
    if (toggle?.getAttribute('aria-expanded') !== 'true') toggle?.click()
    await wait('已结束侧栏分组', () =>
      one(`.mg-sidebar-group:last-child [data-manager-id="${CSS.escape(state.managerId)}"]`),
    )
    assert(
      !one(`.mg-sidebar-group:first-child [data-manager-id="${CSS.escape(state.managerId)}"]`),
      '已结束仍在进行中',
    )
    one('[data-event="manager-end"]')?.scrollIntoView({ block: 'center' })
    await frame()
    return { status: 'ended', readOnly: true, sidebarEnded: true }
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
  const rows: Record<
    string,
    Record<string, { status: string; evidence?: object; screenshot: string }>
  > = {}
  const failed: string[] = []
  for (const id of fixture.ids) {
    const row: NonNullable<(typeof rows)[string]> = (rows[id] = {})
    for (const step of steps) {
      const screenshot = join(fixture.directory, `${id}-${step}.png`)
      try {
        const evidence = await inPage(managerRealStep, step, id, fixture.cwd)
        await writeFile(screenshot, (await window.webContents.capturePage()).toPNG())
        row[step] = {
          status: 'skipped' in evidence ? String(evidence.skipped) : '通过',
          evidence,
          screenshot,
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        failed.push(`${id} ${step}：${reason}`)
        await writeFile(screenshot, (await window.webContents.capturePage()).toPNG()).catch(
          () => {},
        )
        row[step] = { status: `失败：${reason}`, screenshot }
      }
      console.log(`LITCH_MANAGER_REAL ${JSON.stringify({ harness: id, step, ...row[step] })}`)
      if (row[step]?.status.startsWith('失败')) break
    }
  }
  console.log(`LITCH_MANAGER_RESULT ${JSON.stringify({ steps, rows, failed })}`)
  // 正式退出路径负责停止核心；没有仍在运行的经理时不会弹退出确认。
  app.quit()
}

const fixture = JSON.parse(process.env.LITCH_MANAGER_REAL ?? '{}') as Fixture
if (!fixture.main || !fixture.directory || !fixture.ids?.length)
  throw new Error('缺少经理验收夹具配置')
let attached = false
app.on('browser-window-created', (_event, window) => {
  if (attached) return
  attached = true
  window.setSize(1500, 1000)
  window.webContents.setBackgroundThrottling(false)
  // 仅独立验收引导里控制显示；正式主入口仍照常创建沙箱窗口、核心与预加载。
  if (!fixture.show) {
    window.show = () => {}
    app.dock?.hide()
  }
  window.webContents.once('did-finish-load', () => {
    void (async () => {
      // 与其它桌面自检相同跳过首次配置向导，保留正式界面和真实核心。
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
