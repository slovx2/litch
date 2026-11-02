// 手机输入区收纳的正式页面预览；隔离无头浏览器，先在 apps/mobile 里运行 npm run preview。
// 查：对话参数收在“+”单里（每行带当前值、读屏名称带值）、计划模式开着时“+”上有点、上下文小圆环、
// 定时任务跑出的会话在顶栏放时钟而不是占一行；三种皮肤的明暗各截一张。
// 第二个参数是 measure 时只量不查：会话页对话区、输入区的高度（新旧代码都能跑，用来对比省了多少）。
// 截图在 .artifacts/mobile-composer/（LITCH_COMPOSER_SHOTS 可改）。
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
const measureOnly = process.argv[3] === 'measure'
const work = mkdtempSync(join(tmpdir(), 'litch-composer-'))
const output = process.env.LITCH_COMPOSER_SHOTS ?? join(process.cwd(), '.artifacts/mobile-composer')
mkdirSync(output, { recursive: true })
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
  const sel = (id) => `[data-testid=${JSON.stringify(id)}]`
  const wait = (id, timeout = 60000) =>
    until(() => read(`!!document.querySelector(${JSON.stringify(sel(id))})`), id, timeout)
  const tap = async (id) => {
    await wait(id)
    await read(`document.querySelector(${JSON.stringify(sel(id))}).click()`)
    await sleep(200)
  }
  const shot = async (name) => {
    await read(
      'document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))',
    )
    const picture = await call('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(output, `${name}.png`), Buffer.from(picture.data, 'base64'))
  }
  // CI 模拟器的小屏（320×640）：省出来的高度在小屏上最要紧
  await call('Emulation.setDeviceMetricsOverride', {
    width: 320,
    height: 640,
    deviceScaleFactor: 2,
    mobile: false,
  })
  const url = (scene, look = { skin: 'standard', theme: 'light' }) =>
    `${base}?app=1&scene=${scene}&lang=zh-CN&skin=${look.skin}&appearance=${look.theme}`
  const rect = (id) =>
    read(
      `(()=>{const e=document.querySelector(${JSON.stringify(sel(id))});if(!e)return null;const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}})()`,
    )
  const label = (id) =>
    read(`document.querySelector(${JSON.stringify(sel(id))})?.getAttribute('aria-label') ?? null`)
  /** 会话 s3（定时任务跑出来的）：顶栏下沿到输入区上沿是对话区；输入区自身多高 */
  const openTaskSession = async (look) => {
    await call('Page.navigate', { url: url('sessions', look) })
    await tap('session:s3')
    await wait('composer-input')
    await sleep(800)
  }
  const measure = async () => {
    const menu = await rect('detail:menu')
    const strip = await rect('detail:task')
    const box = await rect('composer')
    // 顶栏 52 高；任务那一条以前在顶栏下面另占一行
    const headerBottom = Math.max(
      menu.bottom + 4,
      strip && strip.top > menu.bottom ? strip.bottom : 0,
    )
    return { transcript: Math.round(box.top - headerBottom), composer: Math.round(box.height) }
  }

  if (measureOnly) {
    await openTaskSession()
    const detail = await measure()
    await shot('measure-detail')
    await call('Page.navigate', { url: url('new-session') })
    await wait('new-input')
    await sleep(800)
    const fresh = Math.round((await rect('new')).height)
    await shot('measure-new')
    console.log(JSON.stringify({ detail, newComposer: fresh }))
  } else {
    for (const skin of ['standard', 'human', 'retro'])
      for (const theme of ['light', 'dark']) {
        const look = { skin, theme }
        await openTaskSession(look)
        // 输入框下面不再有参数那一排
        assert.equal(await rect('settings:model'), null, `${skin}/${theme} 参数不再常驻输入框下`)
        // 定时任务：顶栏上的时钟，读屏名称写着哪个任务
        const clock = await rect('detail:task')
        assert.ok(clock && clock.bottom <= 56, `${skin}/${theme} 时钟在顶栏里`)
        assert.match((await label('detail:task')) ?? '', /定时任务|任务/, '时钟的读屏名称')
        assert.ok(clock.height >= 44, '时钟可点的高度')
        // “+”：读屏名称、尺寸（另有 hitSlop 6，真机上可点 52）
        assert.equal(await label('composer-more'), '添加与对话设置')
        const more = await rect('composer-more')
        assert.ok(more.width >= 40 && more.height >= 40, '“+”的尺寸')
        // 上下文圆环
        const ring = await rect('settings:usage')
        assert.ok(ring && ring.width >= 40 && ring.height >= 40, `${skin}/${theme} 上下文圆环`)
        assert.match(
          (await label('settings:usage')) ?? '',
          /^上下文已用 \d+%$/,
          '圆环的读屏名称带百分比',
        )
        await shot(`composer-${skin}-${theme}`)
        // 点开“+”：每行带当前值，读屏名称也带
        await tap('composer-more')
        await wait('settings:model')
        assert.match((await label('settings:model')) ?? '', /^模型：.+/, '模型那一行带当前值')
        assert.match((await label('settings:effort')) ?? '', /^思考强度：.+/, '强度那一行带当前值')
        assert.ok((await rect('settings:model')).height >= 44, '单里一行的高度')
        assert.ok(await rect('composer-image'), '单里有添加图片')
        await shot(`composer-more-${skin}-${theme}`)
        // 计划模式：点了单收起，“+”上出点、读屏名称说明
        if (await rect('settings:plan')) {
          await tap('settings:plan')
          await wait('composer-more-plan')
          assert.equal(await label('composer-more'), '添加与对话设置，计划模式已开')
          await shot(`composer-plan-${skin}-${theme}`)
          await tap('composer-more')
          await tap('settings:plan')
          await until(async () => !(await rect('composer-more-plan')), '计划模式关掉后点消失')
        } else {
          await tap('sheet:scrim')
        }
      }
    // 改模型：选完单收起，再点开“+”那一行是新的值
    await openTaskSession()
    await tap('composer-more')
    await tap('settings:model')
    await until(
      () => read(`document.querySelectorAll('[data-testid^="picker:option:"]').length > 1`),
      '模型选择单',
    )
    const first = await read(
      `[...document.querySelectorAll('[data-testid^="picker:option:"]')].map(e=>e.dataset.testid).find(id=>!/:selected$/.test(id))`,
    )
    const before = await label('settings:model')
    await read(
      `[...document.querySelectorAll('[data-testid^="picker:option:"]')].reverse()[0].click()`,
    )
    await sleep(400)
    await tap('composer-more')
    await wait('settings:model')
    const after = await label('settings:model')
    assert.ok(first && after && after !== before, `换了模型那一行跟着变（${before} → ${after}）`)
    await tap('sheet:scrim')
    console.log(`手机输入区收纳检查通过，截图在 ${output}`)
  }
} finally {
  cdp?.ws.close()
  child.kill()
}
