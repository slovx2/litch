// 手机首页「最近」组的正式页面预览；隔离无头浏览器，先在 apps/mobile 里运行 npm run preview。
// 查：两台设备的主动操作按时间倒序、跨设备写设备名、按项目聚合、显示更多/收起、短暂查看不进最近、满 5 秒进最近；
// 三种皮肤明暗均检查；仅显式设置 LITCH_RECENT_SHOTS 时保存截图。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { globSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Cdp, until } from './chrome-m0/cdp.mjs'

const base = process.argv[2] ?? 'http://127.0.0.1:5189/'
const binary =
  process.env.LITCH_CHROME_BINARY ??
  globSync(
    join(
      homedir(),
      'Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    ),
  )
    .sort()
    .at(-1)
if (!binary) throw new Error('需要 LITCH_CHROME_BINARY 指向 Chrome for Testing')
const work = mkdtempSync(join(tmpdir(), 'litch-recent-'))
const output = process.env.LITCH_RECENT_SHOTS
if (output) mkdirSync(output, { recursive: true })
const child = spawn(
  binary,
  [
    '--headless=new',
    `--user-data-dir=${work}/profile`,
    '--remote-debugging-port=0',
    '--use-mock-keychain',
    '--password-store=basic',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  {
    env: { HOME: work, PATH: '/usr/bin:/bin', TMPDIR: work },
    stdio: ['ignore', 'ignore', 'pipe'],
  },
)
let endpoint = ''
child.stderr.on('data', (chunk) => {
  endpoint += String(chunk)
})
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
let cdp
let diagnose
try {
  const ws = await until(
    () => endpoint.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1],
    '隔离浏览器',
  )
  cdp = await Cdp.connect(ws)
  const target = (await cdp.call('Target.getTargets')).targetInfos.find((t) => t.type === 'page')
  const { sessionId } = await cdp.call('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  })
  const call = (method, params) => cdp.call(method, params, sessionId)
  const read = async (expression) => {
    const result = await call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  diagnose = () =>
    read('JSON.stringify({url:location.href,body:document.body.innerText.slice(0,6000)})')
  const sel = (id) => `[data-testid=${JSON.stringify(id)}]`
  const wait = (id, timeout = 60000) =>
    until(() => read(`!!document.querySelector(${JSON.stringify(sel(id))})`), id, timeout)
  const tap = async (id) => {
    await wait(id)
    await read(`document.querySelector(${JSON.stringify(sel(id))}).click()`)
    await sleep(200)
  }
  const recentIds = () =>
    read(
      `[...document.querySelectorAll('[data-testid^="recent:"]')].map(e=>e.dataset.testid).filter(id=>/^recent:[^:]+:[^:]+$/.test(id) && !id.startsWith('recent:menu') && !id.startsWith('recent:project'))`,
    )
  const shot = async (name) => {
    await read(
      'document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))',
    )
    if (!output) return
    const picture = await call('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(output, `${name}.png`), Buffer.from(picture.data, 'base64'))
  }
  await call('Emulation.setDeviceMetricsOverride', {
    width: 412,
    height: 915,
    deviceScaleFactor: 2,
    mobile: false,
  })
  const scene = (look) =>
    `${base}?app=1&scene=home-recent&lang=zh-CN&skin=${look.skin}&appearance=${look.theme}`
  const ordered = ['recent:local:s4', 'recent:build:b2', 'recent:local:s2']

  for (const skin of ['standard', 'human', 'retro'])
    for (const theme of ['light', 'dark']) {
      await call('Page.navigate', { url: scene({ skin, theme }) })
      await wait('recent')
      await until(async () => (await recentIds()).length === 3, '三条最近')
      assert.deepEqual(await recentIds(), ordered, '按主动操作倒序，子会话归到主对话')
      const text = await read(`document.querySelector('[data-testid="recent"]').innerText`)
      assert.match(text, /最近/)
      await shot(`recent-${skin}-${theme}`)
      await tap('recent:menu')
      await tap('recent:menu:project')
      await until(
        () => read(`document.querySelectorAll('[data-testid^="recent:project:"]').length >= 2`),
        '项目标题',
      )
      // 等动作单淡出
      await sleep(500)
      await shot(`recent-project-${skin}-${theme}`)
      await tap('recent:menu')
      await tap('recent:menu:project')
    }

  // 跨设备时第二行写设备名；“显示更多 / 收起”；收起整组
  await call('Page.navigate', { url: scene({ skin: 'standard', theme: 'light' }) })
  await until(async () => (await recentIds()).length === 3, '三条最近')
  assert.ok(
    await read(
      `document.querySelector('[data-testid="recent:build:b2"]').innerText.includes('build-01 · ')`,
    ),
    '跨设备时远程设备写设备名',
  )
  assert.ok(
    await read(
      `!document.querySelector('[data-testid="recent:local:s4"]').innerText.includes('本机 · ')`,
    ),
    '本机的行不写设备名',
  )
  // 两节标题同一种样式；入口右边不再重复计数
  assert.equal(
    await read(
      `(()=>{const a=document.querySelector('[data-testid="recent:head"]').parentElement,b=document.querySelector('[data-testid="devices:head"]').parentElement;return getComputedStyle(a).backgroundColor===getComputedStyle(b).backgroundColor&&a.getBoundingClientRect().height===b.getBoundingClientRect().height})()`,
    ),
    true,
    '最近与设备的标题同样式',
  )
  assert.equal(
    await read(
      `document.querySelector('[data-testid="recent:head"]').getAttribute('aria-expanded')`,
    ),
    'true',
  )
  assert.ok(
    await read(
      `!/\\n\\d+$/.test(document.querySelector('[data-testid="devices:managers"]').innerText.trim())`,
    ),
    '经理入口不重复计数',
  )
  await tap('recent:head')
  assert.equal((await recentIds()).length, 0, '收起后不画行')
  await tap('recent:head')
  assert.equal((await recentIds()).length, 3)

  // 默认 5 条，“显示更多”每次多十条，“收起”回到 5 条；默认条数改成 10 立即生效
  await call('Page.navigate', {
    url: `${base}?app=1&scene=home-recent-more&lang=zh-CN&skin=standard&appearance=light`,
  })
  await wait('recent:more')
  // 场景的七步每步隔 120 毫秒，等最后一步落定再数
  await sleep(1500)
  assert.equal((await recentIds()).length, 5, '默认五条')
  const hidden = Number(
    (await read(`document.querySelector('[data-testid="recent"]').innerText`)).match(
      /还有 (\d+) 个/,
    )?.[1],
  )
  assert.ok(hidden > 0, '写着还有几个')
  assert.ok(
    await read(
      `document.querySelector('[data-testid="recent:more"]').getBoundingClientRect().height >= 44`,
    ),
    '显示更多的点击区不低于 44px',
  )
  await shot('recent-more')
  await tap('recent:more')
  assert.equal((await recentIds()).length, 5 + hidden)
  await tap('recent:less')
  assert.equal((await recentIds()).length, 5)
  await tap('recent:menu')
  assert.equal(
    await read(
      `[document.querySelector('[data-testid="recent:menu:first:5"]').getAttribute('role'),document.querySelector('[data-testid="recent:menu:first:5"]').getAttribute('aria-checked'),document.querySelector('[data-testid="recent:menu:project"]').getAttribute('role')].join()`,
    ),
    'radio,true,checkbox',
    '条数单选、聚合复选',
  )
  await sleep(500)
  await shot('recent-menu')
  await tap('recent:menu:first:10')
  await until(async () => (await recentIds()).length === 5 + hidden, '默认十条')
  await tap('recent:menu')
  await tap('recent:menu:first:5')

  // 短暂查看不进最近；在详情页停满 5 秒进最近（react-native-web 的 AppState 按页面可见性）
  await tap('device:local')
  await tap('session:s1')
  await wait('detail')
  await sleep(2000)
  await tap('header:back')
  await tap('header:back')
  await wait('recent')
  assert.ok(!(await recentIds()).includes('recent:local:s1'), '停 2 秒不进最近')
  await tap('device:local')
  await tap('session:s1')
  await wait('detail')
  await sleep(5600)
  await tap('header:back')
  await tap('header:back')
  await until(async () => (await recentIds())[0] === 'recent:local:s1', '满 5 秒进最近且在最前')
  await shot('recent-after-view')
  await call('Page.navigate', { url: `${base}?app=1&scene=home-recent-managers&lang=zh-CN` })
  await until(async () => (await recentIds()).length === 2, '经理最近主项')
  assert.deepEqual(
    await recentIds(),
    ['recent:build:m2', 'recent:local:m1'],
    '工作线归经理，不单列',
  )
  await tap('recent:local:m1')
  await wait('manager-console')
  const managerTabs = () =>
    read(
      `[...document.querySelectorAll('[data-testid^="manager-tab:"]')].map(e=>[e.dataset.testid,e.getAttribute('aria-selected')])`,
    )
  const recentTabs = await managerTabs()
  assert.ok(
    recentTabs.some(([id]) => id === 'manager-tab:console'),
    '工作台有看板页签',
  )
  assert.equal(
    await read(`!!document.querySelector('[data-testid="detail"]')`),
    false,
    '经理进入经理页而不是普通详情',
  )
  await sleep(5600)
  await tap('header:back')
  await until(
    async () => (await recentIds())[0] === 'recent:local:m1',
    '经理页停满五秒刷新最近排序',
  )
  await call('Page.navigate', { url: `${base}?app=1&scene=manager-overview&lang=zh-CN` })
  await wait('manager-console')
  await sleep(1500)
  await tap('header:back')
  await wait('recent')
  assert.deepEqual(await recentIds(), [], '短暂查看经理不进最近')
  await tap('devices:managers')
  await tap('manager:m1')
  await wait('manager-console')
  assert.deepEqual(await managerTabs(), recentTabs, '最近与经理目录的工作台及默认页签一致')
  await sleep(5600)
  await tap('header:back')
  await tap('header:back')
  await until(
    async () => (await recentIds())[0] === 'recent:local:m1',
    '从目录打开经理满五秒进入最近',
  )
  await call('Page.navigate', { url: `${base}?app=1&scene=manager-session-link&lang=zh-CN` })
  await wait('manager-console')
  assert.deepEqual(await managerTabs(), recentTabs, '深链进入同一工作台')
  assert.equal(await read(`!!document.querySelector('[data-testid="detail"]')`), false)
  await tap('header:back')
  await wait('devices')
  assert.equal(
    await read(`!!document.querySelector('[data-testid="detail"]')`),
    false,
    '返回不经过详情中间页',
  )
  console.log(`手机「最近」检查通过${output ? `，截图在 ${output}` : '（未保存截图）'}`)
} catch (error) {
  if (diagnose) console.error(await diagnose().catch(String))
  throw error
} finally {
  cdp?.ws.close()
  child.kill()
}
