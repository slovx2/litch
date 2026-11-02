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
    // 设置页上是一行加选择单
    await tap('settings:sendMode')
    await tap('settings:sendMode:queue')
    await sleep(300)
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
      // 立即插入是拐角回车，和待发的“发送”（↑）分开（桌面同样）
      assert.deepEqual(
        acts.map((act) => act.text),
        ['⏎', '✎', '✕'],
        `${where} 排队行尾的记号`,
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
    // “全部发送”可点 44 高、至少 44 宽，头一行看着仍是 32（网页预览不认 hitSlop，量的是它自己）
    const sendAll = await rect('queue:send')
    const head = await read(
      `Math.round(document.querySelector('${sel('queue:send')}').parentElement.getBoundingClientRect().height)`,
    )
    assert.ok(
      sendAll.height >= 44 && sendAll.width >= 44,
      `${where} “全部发送”可点区（${sendAll.width}×${sendAll.height}）`,
    )
    assert.equal(head, 32, `${where} 待发的头一行仍是 32 高`)
    assert.deepEqual(
      (await buttons('queue:0')).map((act) => act.label),
      ['发送', '编辑', '移除'],
      `${where} 待发的行尾是发送、编辑、移除`,
    )
    assert.deepEqual(
      (await buttons('queue:0')).map((act) => act.text),
      ['↑', '✎', '✕'],
      `${where} 待发行尾的记号`,
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
  /** 回合里的过程摘要：“已处理 · 1 步”一行；用时只写在回合尾“完成 · 41 秒”，不写两遍 */
  const checkProcess = async (look, where) => {
    await call('Page.navigate', { url: url('sessions', look) })
    await tap('session:s1')
    await wait('process-head')
    await sleep(400)
    const head = await read(
      `(()=>{const e=document.querySelector('${sel('process-head')}');return {text:e.innerText,height:e.getBoundingClientRect().height}})()`,
    )
    assert.match(head.text, /^▸\s*已处理 · \d+ 步$/, `${where} 摘要不再写用时（${head.text}）`)
    assert.match(
      await read(
        `[...document.querySelectorAll('${sel('turn-menu')}')].at(-1).parentElement.textContent`,
      ),
      /^完成 · .+ 秒 · /,
      `${where} 用时写在回合尾`,
    )
    assert.ok(head.height <= 48, `${where} 过程摘要一行（${head.height}）`)
  }

  /**
   * 回合在跑、紧挨在下面没有正文时，活动那一行就是“正在做什么”：不再另起一行“{name} 正在工作”。
   * 新会话里说“跑一会儿，想一会儿”：命令运行 → 活动行内等待 → 正文后的独立等待状态。
   */
  const checkWorking = async (look, where) => {
    await call('Page.navigate', { url: url('new-session', look) })
    await wait('new-input')
    await sleep(500)
    await read(
      `(()=>{const i=document.querySelector('${sel('new-input')}');const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;set.call(i,'跑一会儿，想一会儿：看状态行');i.dispatchEvent(new Event('input',{bubbles:true}))})()`,
    )
    await sleep(250)
    await tap('new-send')
    let live = 0
    let afterText = 0
    let runningHeight = null
    let accessible = false
    const seconds = new Set()
    for (let i = 0; i < 80; i++) {
      const state = await read(
        `(()=>{const group=[...document.querySelectorAll('${sel('process-toggle')}')].at(-1);const working=[...document.querySelectorAll('div,span')].filter(e=>e.childElementCount===0&&/正在工作/.test(e.textContent));const text=group?.firstElementChild;return {group:group?.textContent??'',height:group?.getBoundingClientRect().height,whiteSpace:text&&getComputedStyle(text).whiteSpace,textWidth:text?.scrollWidth,textRoom:text?.clientWidth,working:working.map(e=>({text:e.textContent,inside:group?.contains(e)??false}))}})()`,
      )
      if (/正在运行/.test(state.group)) {
        live++
        runningHeight = state.height
        assert.deepEqual(state.working, [], `${where} 活动行在跑时不出“正在工作”`)
      }
      const match = state.group.match(/正在工作 · (\d+) 秒$/)
      if (match) {
        seconds.add(Number(match[1]))
        assert.equal(state.working.length, 1, `${where} 只有一个“正在工作”提示`)
        assert.ok(state.working[0].inside, `${where} “正在工作”在活动行内`)
        assert.equal(state.height, runningHeight, `${where} 等待时活动行不增高`)
        assert.equal(state.whiteSpace, 'nowrap', `${where} 活动文字仍只有一行`)
        assert.ok(state.textWidth <= state.textRoom, `${where} 活动行内的等待提示没有被截断`)
        if (!accessible) {
          const tree = await call('Accessibility.getFullAXTree')
          accessible = tree.nodes.some(
            (node) =>
              node.role?.value === 'button' && /活动.*正在工作/.test(node.name?.value ?? ''),
          )
          assert.ok(accessible, `${where} 活动按钮的读屏名称包含“正在工作”`)
        }
      }
      if (seconds.size && state.working.some((entry) => !entry.inside)) {
        afterText++
        assert.doesNotMatch(state.group, /正在工作/, `${where} 正文出现后活动行不再显示等待`)
        assert.match(
          state.working.find((entry) => !entry.inside).text,
          /正在工作/,
          `${where} 正文后的空档恢复原来的状态行`,
        )
      }
      await sleep(100)
    }
    assert.ok(live > 0, `${where} 量到了活动行在跑的时候`)
    assert.ok(seconds.size >= 2, `${where} 活动行内秒数持续递增：${[...seconds]}`)
    assert.ok(afterText > 0, `${where} 量到了正文之后的独立状态行`)
    console.log(
      `${where} 活动行 ${runningHeight}px，等待秒数 ${[...seconds].join(' → ')}，读屏和正文后的状态行通过`,
    )
  }
  /** 建议卡：写明开不成的那张，“开始”是不能点的边框样式，读屏名称带原因；点了不报错 */
  const checkProposal = async (look, where) => {
    await call('Page.navigate', { url: url('proposals', look) })
    await until(
      () => read(`document.querySelectorAll('[data-testid$=":start"]').length >= 3`),
      `${where} 三张提案卡`,
    )
    await sleep(400)
    const starts = await read(
      `[...document.querySelectorAll('[data-testid^="proposal:"][data-testid$=":start"]')].map(e=>({id:e.dataset.testid,text:e.textContent,label:e.getAttribute('aria-label'),disabled:e.getAttribute('aria-disabled'),bg:getComputedStyle(e).backgroundColor}))`,
    )
    const blocked = starts.filter((entry) => entry.disabled === 'true')
    assert.equal(blocked.length, 1, `${where} 只有 Pi 那张开不成`)
    assert.equal(blocked[0].text, '开始')
    assert.match(
      blocked[0].label ?? '',
      /^开始，不可用：此 harness 要求「完全访问」/,
      `${where} 读屏名称写明原因`,
    )
    assert.equal(blocked[0].bg, 'rgba(0, 0, 0, 0)', `${where} 不再是实心主色`)
    for (const entry of starts.filter((entry) => entry.disabled !== 'true'))
      assert.equal(entry.label, null, `${where} 能开的“开始”照常读字`)
    await read(`document.querySelector('${sel(blocked[0].id)}').click()`)
    await sleep(600)
    assert.equal(
      await read(
        `[...document.querySelectorAll('div')].some(e=>e.childElementCount===0&&/操作失败|不支持父会话权限/.test(e.textContent))`,
      ),
      false,
      `${where} 点了不再报一遍同样的错`,
    )
    await shot(`proposal-blocked-${look.skin}-${look.theme}`)
  }
  /** 设置“任务卡”：每台设备一行“名字　N/M 已开 ›”，点开是选择单，逐个勾、单不收起 */
  const checkTaskCards = async (look, where) => {
    await call('Page.navigate', { url: url('settings', look) })
    await wait('settings:task-cards')
    await read(`document.querySelector('${sel('settings:task-cards')}').scrollIntoView()`)
    await sleep(500)
    const rows = await read(
      `[...document.querySelectorAll('[data-testid^="task-cards:"][data-testid$=":open"]')].map(e=>({id:e.dataset.testid,label:e.getAttribute('aria-label'),height:Math.round(e.getBoundingClientRect().height)}))`,
    )
    assert.deepEqual(
      rows.map((row) => row.id),
      [
        'task-cards:local:open',
        'task-cards:build:open',
        'task-cards:nas:open',
        'task-cards:gpu:open',
      ],
      `${where} 每台设备一行`,
    )
    for (const row of rows)
      assert.ok(row.height <= 48, `${where} 设备那一行一行高（${row.height}）`)
    const section = await rect('settings:task-cards')
    assert.ok(
      section.height <= rows.length * 48 + 4,
      `${where} 一节不再列出每个 harness（${section.height}）`,
    )
    const local = rows[0].label ?? ''
    const [, on, all] = local.match(/^本机：(\d+)\/(\d+) 已开$/) ?? []
    assert.ok(on && all, `${where} 读屏名称带开了几个（${local}）`)
    assert.equal(rows[3].label, 'gpu-box：离线', `${where} 离线设备写着离线`)
    await tap('task-cards:local:open')
    await until(
      () =>
        read(
          `document.querySelectorAll('[data-testid^="task-cards:local:"][role="checkbox"]').length > 1`,
        ),
      `${where} 本机的选择单`,
    )
    const items = await read(
      `[...document.querySelectorAll('[data-testid^="task-cards:local:"][role="checkbox"]')].map(e=>({id:e.dataset.testid,checked:e.getAttribute('aria-checked')}))`,
    )
    assert.equal(items.length, Number(all), `${where} 单里每个 harness 一项`)
    assert.equal(
      items.filter((item) => item.checked === 'true').length,
      Number(on),
      `${where} 勾着的和行上写的一样`,
    )
    assert.ok(await rect('task-cards:local:device'), `${where} 单里有整台设备一起设`)
    await shot(`task-cards-${look.skin}-${look.theme}`)
    // 勾一项：单不收起，那一项换勾，行上的数跟着变
    const first = items[0]
    await read(`document.querySelector('${sel(first.id)}').click()`)
    const flipped = first.checked === 'true' ? 'false' : 'true'
    await until(
      () =>
        read(
          `document.querySelector('${sel(first.id)}')?.getAttribute('aria-checked') === '${flipped}'`,
        ),
      `${where} 勾了换勾、单还开着`,
    )
    await tap('sheet:scrim')
    const after = Number(on) + (flipped === 'true' ? 1 : -1)
    await until(
      async () => (await label('task-cards:local:open')) === `本机：${after}/${all} 已开`,
      `${where} 行上的数跟着变`,
    )
    // 离线设备：单里每项不能改，写着原因
    await tap('task-cards:gpu:open')
    await wait('task-cards:gpu:device')
    assert.equal(
      await read(
        `(()=>{const items=[...document.querySelectorAll('[data-testid^="task-cards:gpu:"]:not([data-testid$=":open"])')];return items.length>1&&items.every(e=>e.getAttribute('aria-disabled')==='true')})()`,
      ),
      true,
      `${where} 离线设备的项不能改`,
    )
    await tap('sheet:scrim')
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
        await checkWorking(look, `${skin}/${theme}`)
        await checkProposal(look, `${skin}/${theme}`)
        await checkTaskCards(look, `${skin}/${theme}`)
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
