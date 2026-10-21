// “从别的浏览器导入”的真实窗口验收（scripts/check-browser.mjs --import，窗口不显示）：真的界面（packages/ui/dist，
// 对着页面里的模拟核心）、真的主进程那一半（installBrowser 连同导入管线），读取器是假的、来源是样本：
// 启动脚本给 LITCH_BROWSER_IMPORT_FAKE=<临时目录>，主进程在那里摆一套自造的样本资料（browser-import/test/sample.mts），
// 不碰这台电脑上任何真实浏览器的资料。用户数据目录是临时的，Cookie 写进的是它里面的内置浏览器分区。
// 走一遍：浏览器面板的横幅和菜单 → 设置页“从浏览器导入” → 导入 Chrome 的默认资料、核对条数和分区里的 Cookie →
// 再导一次都算“已存在” → 浏览器开着（locked）、授权被拒（denied）给“重试” → 导入中连按两次 Esc 不关不停 → 导到一半停下。
// 结果打一行 LITCH_BROWSER {ok, checks}；LITCH_BROWSER_SHOTS 给了目录时存几张截图。
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, net, protocol, session } from 'electron'
import { PARTITION } from './browser/electron-tab.mjs'
import { installBrowser } from './browser/install.mjs'

if (process.env.LITCH_PROFILE) app.setPath('userData', process.env.LITCH_PROFILE)
const uiRoot = normalize(process.env.LITCH_UI_ROOT ?? '')
const preload = process.env.LITCH_PROBE_PRELOAD ?? ''
const shots = process.env.LITCH_BROWSER_SHOTS

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

interface Check {
  name: string
  ok: boolean
  detail?: unknown
}
const checks: Check[] = []
const check = (name: string, ok: boolean, detail?: unknown) => {
  checks.push({ name, ok, ...(ok ? {} : { detail }) })
  return ok
}
/** 不判对错、只记下来的数（结果里带出去，看样本导了多少） */
const seen: Record<string, unknown> = {}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** 结果页上逐类的一行，从 data 属性里读 */
interface Line {
  kind: string
  status: string
  tone: string
  imported: number
  existing: number
  invalid: number
  failed: number
}

const READ_RESULT = `(() => {
  const res = document.querySelector('dialog.bimp-dialog .bimp-result')
  if (!res) return null
  return {
    overall: res.dataset.overall,
    lines: [...res.querySelectorAll('.bimp-line')].map((li) => ({
      kind: li.dataset.kind, status: li.dataset.status, tone: li.dataset.tone,
      imported: Number(li.dataset.imported), existing: Number(li.dataset.existing),
      invalid: Number(li.dataset.invalid), failed: Number(li.dataset.failed),
    })),
    retry: (() => { const b = document.querySelector('dialog.bimp-dialog [data-act="bimp-retry"]'); return b ? !b.disabled : null })(),
  }
})()`

void app.whenReady().then(async () => {
  app.dock?.hide()
  const limit = setTimeout(() => {
    console.log(`LITCH_BROWSER ${JSON.stringify({ ok: false, checks, seen, error: '超时' })}`)
    app.exit(1)
  }, 150_000)
  protocol.handle('app', (request) => {
    const url = new URL(request.url)
    const path = decodeURIComponent(url.pathname)
    const file = normalize(join(uiRoot, path === '/' ? 'index.html' : path))
    if (!file.startsWith(uiRoot + sep)) return new Response('forbidden', { status: 403 })
    return net.fetch(pathToFileURL(file).toString())
  })
  installBrowser({
    isUiUrl: (url) => url.startsWith('app://ui/'),
    userData: app.getPath('userData'),
  })
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  const page = (code: string) => window.webContents.executeJavaScript(code)
  /** 等页面里一个条件成立；到点回 false */
  const until = async (code: string, ms = 8000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await page(`!!(${code})`)) return true
      await pause(100)
    }
    return false
  }
  const click = (selector: string) =>
    page(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) el.click(); return !!el })()`,
    )
  const shot = async (name: string) => {
    if (!shots) return
    mkdirSync(shots, { recursive: true })
    const image = await window.webContents.capturePage()
    writeFileSync(join(shots, `import-${name}.png`), image.toPNG())
  }
  const cookieCount = async () => (await session.fromPartition(PARTITION).cookies.get({})).length
  const DIALOG = 'dialog.bimp-dialog[open]'
  const stepIs = (step: string) => `document.querySelector('${DIALOG}')?.dataset.step === '${step}'`
  /** 设置页那一行打开对话框，等到能选 */
  const openFromSettings = async () => {
    await click('.set-content [data-act="browser-import"]')
    return until(stepIs('pick'))
  }
  /** 表单上选一个来源，资料选名字里含 profileName 的那份（不给就用默认的） */
  const choose = (browser: string, profileName?: string) =>
    page(`(() => {
      const radio = document.querySelector('${DIALOG} input[name="bimp-source"][value="${browser}"]')
      if (!radio || radio.disabled) return false
      radio.click()
      return true
    })()`).then(async (picked: boolean) => {
      if (!picked || !profileName) return picked
      await pause(100)
      return page(`(() => {
        const select = document.querySelector('${DIALOG} #bimp-profile')
        const option = select && [...select.options].find((one) => one.textContent.includes(${JSON.stringify(profileName)}))
        if (!option || option.disabled) return false
        const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
        set.call(select, option.value)
        select.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      })()`)
    })
  /** 点“导入”，等结果出来 */
  const runImport = async (
    stopAfter?: number,
  ): Promise<{ overall: string; lines: Line[]; retry: boolean | null } | null> => {
    await click(`${DIALOG} [data-act="bimp-start"]`)
    if (stopAfter !== undefined) {
      await until(stepIs('running'), 3000)
      await pause(stopAfter)
      await click(`${DIALOG} [data-act="bimp-stop"]`)
    }
    if (!(await until(stepIs('done'), 30_000))) return null
    return page(READ_RESULT)
  }
  const line = (result: { lines: Line[] } | null, kind: string) =>
    result?.lines.find((one) => one.kind === kind)

  try {
    await window.loadURL('app://ui/index.html?lang=zh-CN&onboarding=off')
    check('界面起来了', await until("document.querySelector('.tb-side')", 15_000))
    const hasImport = await page("typeof window.litchBrowser?.import?.sources === 'function'")
    if (!check('外壳给了导入接口（window.litchBrowser.import）', hasImport)) {
      throw new Error('主进程还没有导入接口：管线（browser-import）合进来之后再跑')
    }

    // ---------- 浏览器面板：横幅和菜单 ----------
    await click('.tb-side')
    await until("document.querySelector('.side:not([hidden])')")
    await click('.side-tab[data-tab="browser"]')
    check('浏览器标签装上了', await until("document.querySelector('.bw-address')"))
    check(
      '从没导过：面板上出横幅',
      await until("document.querySelector('[data-browser-import-banner]')"),
    )
    await shot('banner')
    await click('[data-act="browser-menu"]')
    check('工具栏的菜单打开了', await until('document.querySelector(\'.bimp-menu [role="menu"]\')'))
    await click('.bimp-menu [data-act="browser-import"]')
    check('菜单里的“导入 Cookie 和密码…”打开对话框', await until(stepIs('pick')))
    const sources = (await page(
      `[...document.querySelectorAll('${DIALOG} .bimp-source')].map((l) => l.dataset.browser + (l.classList.contains('off') ? ':off' : ':on'))`,
    )) as string[]
    seen.sources = sources
    check(
      '样本里的来源都列出来了',
      ['chrome', 'edge', 'brave', 'firefox'].every((id) => sources.includes(`${id}:on`)),
      sources,
    )
    check('什么都没有的资料标成导不了', sources.includes('vivaldi:off'), sources)
    await shot('pick')
    await click(`${DIALOG} [data-act="bimp-close"]`)
    check('对话框关上了', await until(`!document.querySelector('${DIALOG}')`))
    await click('[data-act="banner-import"]')
    check('横幅上的“导入”打开对话框', await until(stepIs('pick')))
    await click(`${DIALOG} [data-act="bimp-close"]`)
    await until(`!document.querySelector('${DIALOG}')`)
    await click('[data-act="banner-later"]')
    check(
      '“以后再说”收起横幅',
      await until("!document.querySelector('[data-browser-import-banner]')"),
    )
    const dismissed = await page(
      'window.litchBrowser.import.state().then((s) => s.bannerDismissedAt)',
    )
    check('主进程记下了横幅关过', typeof dismissed === 'number', dismissed)
    await click('.side-tab[data-tab="files"]')
    await pause(200)
    await click('.side-tab[data-tab="browser"]')
    await pause(600)
    check(
      '关过之后再打开面板不出横幅',
      !(await page("!!document.querySelector('[data-browser-import-banner]')")),
    )

    // ---------- 设置页：导入 Chrome 的默认资料 ----------
    await click('.sb-settings')
    await until("document.querySelector('.set-page')")
    await click('.set-nav [data-section="browser"]')
    check(
      '设置页“内置浏览器”里有“从浏览器导入”',
      await until('document.querySelector(\'.set-content [data-act="browser-import"]\')'),
    )
    check(
      '设置页没导过时不写上次导入',
      !(await page("!!document.querySelector('[data-last-import]')")),
    )
    check('设置页打开对话框', await openFromSettings())
    const form = await page(`(() => ({
      source: document.querySelector('${DIALOG} input[name="bimp-source"]:checked')?.value,
      kinds: Object.fromEntries([...document.querySelectorAll('${DIALOG} input[data-kind]')].map((i) => [i.dataset.kind, i.checked])),
      elevate: !!document.querySelector('${DIALOG} [data-field="allow-elevated"]'),
    }))()`)
    seen.defaultForm = form
    check(
      '默认选 Chrome，Cookie 和密码都勾上，没有浏览记录那一项',
      form.source === 'chrome' &&
        form.kinds.cookies === true &&
        form.kinds.passwords === true &&
        !('history' in form.kinds),
      form,
    )
    // 这一版不提权读 Windows 上的应用绑定数据，对话框里没有管理员同意的勾
    check('没有“允许用管理员权限读取”的勾', form.elevate === false, form)
    const before = await cookieCount()
    const first = await runImport()
    seen.first = first
    const firstCookies = line(first, 'cookies')
    check(
      'Chrome 的 Cookie 导进来了',
      firstCookies?.status === 'ok' && firstCookies.imported > 0,
      first,
    )
    check('样本里过期、不合规的 Cookie 算无效', (firstCookies?.invalid ?? 0) > 0, first)
    const after = await cookieCount()
    seen.cookies = { before, after }
    check(
      '内置浏览器的分区里多了这么多 Cookie',
      after - before === (firstCookies?.imported ?? -1),
      { before, after, firstCookies },
    )
    const firstPasswords = line(first, 'passwords')
    check('密码那一类有结果', !!firstPasswords && firstPasswords.tone !== 'err', first)
    check('全成或部分成', first?.overall === 'ok' || first?.overall === 'partial', first)
    await shot('result')
    await click(`${DIALOG} [data-act="bimp-close"]`)
    check('设置页写上了上次导入的日子', await until("document.querySelector('[data-last-import]')"))

    // ---------- 再导一次：已有的不覆盖，算“已存在” ----------
    await openFromSettings()
    const second = await runImport()
    seen.second = second
    const secondCookies = line(second, 'cookies')
    check(
      '再导一次 Cookie 都算已存在',
      secondCookies?.imported === 0 && secondCookies.existing === firstCookies?.imported,
      { first: firstCookies, second: secondCookies },
    )
    check('再导一次分区里的 Cookie 没变多', (await cookieCount()) === after)
    check('再导一次整体说“没有新的”，不说“导入完成”', second?.overall === 'existing', second)
    await click(`${DIALOG} [data-act="bimp-back"]`)
    await until(stepIs('pick'))

    // ---------- 浏览器开着：给“重试” ----------
    check('选得上 Chrome 的“工作”资料', await choose('chrome', '工作'))
    const locked = await runImport()
    seen.locked = locked
    check('“工作”的 Cookie 报浏览器开着', line(locked, 'cookies')?.status === 'locked', locked)
    check('浏览器开着时给“重试”', locked?.retry === true, locked)
    await shot('locked')
    await click(`${DIALOG} [data-act="bimp-back"]`)
    await until(stepIs('pick'))

    // ---------- 授权被拒 ----------
    check('选得上 Edge', await choose('edge'))
    const denied = await runImport()
    seen.denied = denied
    check('Edge 报系统授权被拒', line(denied, 'cookies')?.status === 'denied', denied)
    check('授权被拒时给“重试”', denied?.retry === true, denied)
    await click(`${DIALOG} [data-act="bimp-back"]`)
    await until(stepIs('pick'))

    // ---------- 导入中连按两次 Esc：对话框不关、导入不停 ----------
    // Chromium 第二次的 cancel 事件拦不住，对话框得自己重新打开（BrowserImportDialog.tsx 的 onClose）
    check('选得上 Brave（读之前要等几秒）', await choose('brave'))
    await click(`${DIALOG} [data-act="bimp-start"]`)
    check('Brave 开始导了', await until(stepIs('running'), 3000))
    window.webContents.focus()
    for (let i = 0; i < 2; i++) {
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
      await pause(120)
    }
    await pause(300)
    check(
      '导入中连按两次 Esc 对话框还开着、还在导',
      await page(`${stepIs('running')} || ${stepIs('done')}`),
      await page(`document.querySelector('dialog.bimp-dialog')?.dataset.step ?? 'gone'`),
    )
    check(
      '对话框还是模态的',
      await page(`!!document.querySelector('${DIALOG}')?.matches(':modal')`),
    )
    check('Esc 没把导入停下', await until(stepIs('done'), 30_000))
    const escaped = await page(READ_RESULT)
    seen.escaped = escaped
    check('连按 Esc 之后的结果不是“已停止”', escaped?.overall !== 'cancelled', escaped)
    await click(`${DIALOG} [data-act="bimp-back"]`)
    await until(stepIs('pick'))

    // ---------- 导到一半停下 ----------
    check('选得上 Brave', await choose('brave'))
    const stopped = await runImport(600)
    seen.stopped = stopped
    check('停下之后整体说“已停止”', stopped?.overall === 'cancelled', stopped)
    await click(`${DIALOG} [data-act="bimp-close"]`)
    check('最后对话框关上了', await until(`!document.querySelector('${DIALOG}')`))
  } catch (error) {
    check('没有意外出错', false, error instanceof Error ? error.stack : String(error))
  }
  clearTimeout(limit)
  const ok = checks.every((one) => one.ok)
  console.log(
    `LITCH_BROWSER ${JSON.stringify({ ok, passed: checks.filter((one) => one.ok).length, checks: checks.filter((one) => !one.ok), seen })}`,
  )
  app.exit(ok ? 0 : 1)
})
