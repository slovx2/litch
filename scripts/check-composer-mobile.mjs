// 手机输入区收纳的正式页面预览；隔离无头浏览器，先在 apps/mobile 里运行 npm run preview。
// 查：对话参数收在“+”单里（每行带当前值、读屏名称带值）、计划模式开着时“+”上有点、上下文小圆环、
// 定时任务跑出的会话在顶栏放时钟而不是占一行；消息区没有“复制消息”文字按钮，复制在长按菜单和回合 ⋯ 里，
// 用户消息的时刻在气泡左边、不另起一行；回合在跑时排队的消息一条一行、停止后的待发一行头加图标按钮，
// “连同待发”是发送键旁的小开关，发送、停止是 36 的圆键，提示语不截断；过程摘要一行。三种皮肤的明暗各截一张。
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
  // 复制要真的写进剪贴板（无头浏览器默认不给）
  await cdp.call('Browser.grantPermissions', {
    origin: new URL(base).origin,
    permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
  })
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

  /** 长按：按住 700ms 再松开（react-native-web 的长按是 500ms） */
  const longPress = async (selector) => {
    const box = await read(
      `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`,
    )
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
    await call('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: box.x,
      y: box.y,
      button: 'left',
      clickCount: 1,
    })
    await sleep(700)
    await call('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: box.x,
      y: box.y,
      button: 'left',
      clickCount: 1,
    })
    await sleep(300)
  }
  /** 消息区：没有复制文字按钮，用户消息的时刻在气泡左边、和气泡底边对齐 */
  const checkMessages = async (where) => {
    assert.equal(
      await read(
        `[...document.querySelectorAll('[data-testid="detail"] *')].some(e=>e.childElementCount===0&&/^(复制消息|Copy message)$/.test(e.textContent))`,
      ),
      false,
      `${where} 消息区没有“复制消息”文字按钮`,
    )
    const layout = await read(
      `(()=>{const b=[...document.querySelectorAll('[data-testid="user-message"]')].at(-1);if(!b)return null;const r=b.getBoundingClientRect();const side=b.previousElementSibling?.getBoundingClientRect();const next=b.parentElement.nextElementSibling;return {bubble:{left:r.left,bottom:r.bottom},side:side&&{right:side.right,bottom:side.bottom,height:side.height},wrapBottom:b.parentElement.getBoundingClientRect().bottom}})()`,
    )
    assert.ok(layout?.side, `${where} 用户消息左边有时刻那一列`)
    assert.ok(layout.side.right <= layout.bubble.left, `${where} 时刻在气泡左边`)
    assert.ok(
      Math.abs(layout.side.bottom - layout.bubble.bottom) <= 4,
      `${where} 时刻和气泡底边对齐`,
    )
    // 这一排的下沿就是气泡的下沿（加上下内边距），气泡下面没有另一排
    assert.ok(layout.wrapBottom - layout.bubble.bottom <= 8, `${where} 气泡下面不另起一行`)
  }

  /** 往输入框里写字（react-native-web 的输入框认原生 input 事件） */
  const type = async (text) => {
    await read(
      `(()=>{const i=document.querySelector('[data-testid="composer-input"]');const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;set.call(i,${JSON.stringify(text)});i.dispatchEvent(new Event('input',{bubbles:true}))})()`,
    )
    await sleep(250)
  }
  const pressed = (id) =>
    read(`document.querySelector(${JSON.stringify(sel(id))})?.getAttribute('aria-checked')`)
  /** 某处里所有可点的东西：读屏名称和尺寸 */
  const buttons = (id) =>
    read(
      `[...document.querySelectorAll(${JSON.stringify(`${sel(id)} [role="button"]`)})].map(e=>{const r=e.getBoundingClientRect();return {label:e.getAttribute('aria-label'),text:e.textContent,width:r.width,height:r.height}})`,
    )
  /**
   * 待发与发送键（会话 s2 回合在跑）：排队时没有标题行、每条一行图标按钮；停止后一行头加“全部发送”，
   * 状态不每行重复；“连同待发”只在有字时出现在发送键旁；发送、停止是 36 的圆键；提示语不截断
   */
  const checkPending = async (look, where) => {
    // 设置在页面里，换页就没了：从设置页一路点进会话
    await call('Page.navigate', { url: url('settings', look) })
    await tap('settings:sendMode:queue')
    await tap('header:back')
    await tap('device:local')
    await tap('session:s2')
    await wait('composer-input')
    await sleep(600)
    const send = await rect('composer-send')
    assert.ok(
      Math.round(send.width) === 36 && Math.round(send.height) === 36,
      `${where} 发送键 36 见方`,
    )
    assert.equal(
      await read(
        `getComputedStyle(document.querySelector('${sel('composer-send')}')).borderRadius`,
      ),
      '18px',
      `${where} 发送键是圆的`,
    )
    assert.equal(await label('composer-send'), '停止', `${where} 回合在跑时是停止键，读屏名称写着`)
    const hint = await read(
      `(()=>{const i=document.querySelector('${sel('composer-input')}');const s=getComputedStyle(i);const c=document.createElement('canvas').getContext('2d');c.font=s.font;return {text:i.placeholder,need:c.measureText(i.placeholder).width,room:i.clientWidth-parseFloat(s.paddingLeft)-parseFloat(s.paddingRight)}})()`,
    )
    assert.equal(hint.text, '排队发送…', `${where} 排队时的提示语`)
    assert.ok(hint.need <= hint.room, `${where} 提示语不截断（${hint.need} > ${hint.room}）`)
    await type('第一句排队的话，长一点看会不会折行')
    await tap('composer-send')
    await type('第二句')
    await tap('composer-send')
    await wait('queue:1')
    await sleep(300)
    assert.equal(await rect('queue:send'), null, `${where} 只是排队时没有“全部发送”`)
    const queued = await rect('queue')
    // 两条各一行（36）加内边距：没有标题行
    assert.ok(queued.height <= 84, `${where} 排队的两条不另占标题行（${queued.height}）`)
    assert.match(
      await read(`document.querySelector('${sel('queue:0')}').textContent`),
      /^◷ 2/,
      `${where} 数目写在第一行前面`,
    )
    for (const index of [0, 1]) {
      const row = await rect(`queue:${index}`)
      assert.ok(row.height <= 40, `${where} 第 ${index + 1} 条单行（${row.height}）`)
      const acts = await buttons(`queue:${index}`)
      assert.deepEqual(
        acts.map((act) => act.label),
        ['立即插入', '编辑', '移除'],
        `${where} 排队的行尾是插入、编辑、移除`,
      )
      for (const act of acts)
        assert.ok(
          act.width >= 36 && act.height >= 36,
          `${where} 图标按钮 36 见方（另有 hitSlop 4）`,
        )
    }
    await shot(`pending-queued-${look.skin}-${look.theme}`)
    // 停止：留下两条待发
    await tap('composer-send')
    await wait('queue:send')
    await sleep(400)
    const tray = await read(`document.querySelector('${sel('queue')}').textContent`)
    assert.match(tray, /^‖ 2 条待发 ·\s*全部发送/, `${where} 待发的头一行`)
    assert.equal(
      /已停止|待发送/.test(tray.replace(/^‖ 2 条待发/, '')),
      false,
      `${where} 状态不每行重复`,
    )
    const held = await rect('queue')
    assert.ok(held.height <= 120, `${where} 停止后的待发：一行头加两行（${held.height}）`)
    assert.deepEqual(
      (await buttons('queue:0')).map((act) => act.label),
      ['发送', '编辑', '移除'],
      `${where} 待发的行尾是发送、编辑、移除`,
    )
    assert.equal(await label('composer-send'), '发送', `${where} 停止后是发送键`)
    // 没字时没有“连同待发”，有字时在发送键旁，默认连同
    assert.equal(await rect('composer-pending'), null, `${where} 没字时没有“连同待发”`)
    await type('再写一句')
    await wait('composer-pending')
    const toggle = await rect('composer-pending')
    const sendNow = await rect('composer-send')
    assert.ok(
      toggle.right <= sendNow.left && sendNow.left - toggle.right <= 12,
      `${where} “连同待发”在发送键旁`,
    )
    assert.ok(Math.abs(toggle.top + toggle.height / 2 - (sendNow.top + sendNow.height / 2)) <= 4)
    assert.equal(await pressed('composer-pending'), 'true', `${where} 默认连同待发一起发`)
    assert.equal(await label('composer-pending'), '含 2 条待发')
    await shot(`pending-held-${look.skin}-${look.theme}`)
    await tap('composer-pending')
    assert.equal(await pressed('composer-pending'), 'false', `${where} 点一下改成只发这条`)
    await type('')
    await tap('queue:send')
    await until(async () => !(await rect('queue')), `${where} 全部发送后托盘收起`)
  }
  /** 回合里的过程摘要：“已处理 41 秒 · 1 步”一行 */
  const checkProcess = async (look, where) => {
    await call('Page.navigate', { url: url('sessions', look) })
    await tap('session:s1')
    await wait('process-head')
    await sleep(400)
    const head = await read(
      `(()=>{const e=document.querySelector('${sel('process-head')}');return {text:e.innerText,height:e.getBoundingClientRect().height}})()`,
    )
    assert.match(head.text, /已处理 .+ · \d+ 步/, `${where} 时长和步数在同一行`)
    assert.ok(head.height <= 48, `${where} 过程摘要一行（${head.height}）`)
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
        await checkMessages(`${skin}/${theme}`)
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
        await checkPending(look, `${skin}/${theme}`)
        await checkProcess(look, `${skin}/${theme}`)
      }
    // 复制收进菜单：长按用户消息有“复制消息”，点了闪“已复制”；回合状态行的 ⋯ 里有“复制回答”
    await openTaskSession()
    await longPress('[data-testid="user-message"]')
    await wait('menu:copy-message')
    await tap('menu:copy-message')
    await until(
      () =>
        read(
          `[...document.querySelectorAll('*')].some(e=>e.childElementCount===0&&/^(已复制|Copied)$/.test(e.textContent))`,
        ),
      '复制后的提示',
    )
    await tap('turn-menu')
    await wait('menu:copy-answer')
    await tap('sheet:scrim')
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
