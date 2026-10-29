import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { until } from './cdp.mjs'

export async function probes({ rpc, cdp, site, results, work }) {
  async function check(name, fn) {
    try {
      const detail = await fn()
      results.checks.push({ name, status: 'pass', detail })
      console.log(`PASS ${name}`)
    } catch (error) {
      results.checks.push({ name, status: 'fail', error: String(error.stack ?? error) })
      console.log(`FAIL ${name}: ${error.message}`)
    }
    writeFileSync(join(work, 'results.json'), JSON.stringify(results, null, 2))
  }
  const ping = await rpc('ping')
  await check('最小权限和 Native Messaging 双向大帧', async () => {
    assert.deepEqual(ping.permissions.origins, [])
    assert(!ping.permissions.permissions.includes('scripting'))
    const echo = await rpc('echo', { text: 'x'.repeat(500000) })
    assert.equal(echo.length, 500000)
    assert.equal(echo.text, 'x'.repeat(500000))
    return ping.permissions
  })
  const tab = await rpc('new', { url: `${site.origin}/login` })
  await rpc('attach', { tabId: tab.id })
  const command = (method, params = {}, sessionId) =>
    rpc('cdp', { tabId: tab.id, method, params, sessionId })
  const evaluate = (expression, contextId, sessionId) =>
    rpc('evaluate', { tabId: tab.id, expression, contextId, sessionId })
  const ready = () =>
    until(
      () => evaluate('document.readyState === "complete" && !!document.querySelector("#button")'),
      '夹具页面加载',
    )
  await ready()
  await check('已有配置登录态自然复用', async () => {
    await rpc('navigate', { tabId: tab.id, url: `${site.origin}/` })
    await until(
      () => evaluate('document.querySelector("#login")?.textContent === "SESSION OK"'),
      '登录态页面',
    )
    return '仅服务器夹具设置 Cookie，代理通过 DOM 看 SESSION OK；没有读取 Cookie API'
  })
  await check('AX、坐标点击、输入及事件 trusted 属性', async () => {
    const ax = await command('Accessibility.getFullAXTree')
    assert(ax.nodes.some((node) => node.name?.value === 'CLICK ME'))
    const point = await evaluate(
      '(()=>{const r=document.querySelector("#button").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()',
    )
    for (const type of ['mousePressed', 'mouseReleased'])
      await command('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
    assert.equal(await evaluate('document.querySelector("#count").textContent'), '1')
    await evaluate('document.querySelector("#input").focus()')
    await command('Input.insertText', { text: 'M0 text' })
    assert.equal(await evaluate('document.querySelector("#input").value'), 'M0 text')
    await evaluate('document.querySelector("#input").blur()')
    const events = await evaluate('events')
    assert(events.some((event) => event.type === 'click' && event.trusted))
    return {
      point,
      axNodes: ax.nodes.length,
      events,
      inference: 'CDP 点击也 trusted；不能用 isTrusted 单独辨别人类',
    }
  })
  await check('隔离世界光标、公共版本检查、AX/截图排除', async () => {
    const baseline = await command('Page.captureScreenshot', { format: 'png' })
    const contextId = await rpc('marker', { tabId: tab.id })
    const surface = {
      surfaceId: String(tab.id),
      executorId: 'm0-mac',
      generation: 1,
      geometryRevision: 1,
      kind: 'browserViewport',
      width: 1000,
      height: 800,
    }
    const sample = {
      ...surface,
      actionId: 'm0-click',
      seq: 1,
      timeUs: 1,
      phase: 'planned',
      kind: 'click',
      position: { x: 300, y: 200 },
    }
    await rpc('pointer', { tabId: tab.id, contextId, surface, sample })
    assert.equal(await evaluate('typeof m0Marker'), 'undefined')
    assert.equal(await evaluate('document.querySelector("#litch-m0-marker").shadowRoot'), null)
    await assert.rejects(
      rpc('pointer', { tabId: tab.id, contextId, surface, sample: { ...sample, generation: 0 } }),
      /过期/,
    )
    const shown = await command('Page.captureScreenshot', { format: 'png' })
    assert.notEqual(shown.data, baseline.data)
    const ax = await command('Accessibility.getFullAXTree')
    assert(!ax.nodes.some((node) => node.name?.value === 'M0'))
    await evaluate('m0Marker.visible(false)', contextId)
    const hidden = await command('Page.captureScreenshot', { format: 'png' })
    assert.equal(hidden.data, baseline.data)
    for (const [name, value] of [
      ['baseline', baseline],
      ['marker', shown],
      ['hidden', hidden],
    ])
      writeFileSync(join(work, `${name}.png`), Buffer.from(value.data, 'base64'))
    await evaluate('m0Marker.dispose()', contextId)
    return {
      screenshotBytes: Buffer.from(baseline.data, 'base64').length,
      contextId,
      excludedPixelExact: true,
    }
  })
  await check('后台标签截图不切走当前标签', async () => {
    const other = await rpc('new', { url: 'about:blank' })
    const before = (await rpc('tabs')).find((item) => item.active)?.id
    const shot = await command('Page.captureScreenshot', { format: 'png' })
    const after = (await rpc('tabs')).find((item) => item.active)?.id
    assert.equal(before, other.id)
    assert.equal(after, other.id)
    assert(shot.data.length > 1000)
    return { before, after, bytes: shot.data.length }
  })
  await rpc('activate', { tabId: tab.id })
  await check('OOPIF 发现、子帧 AX 与顶层坐标点击', async () => {
    await rpc('autoFrames', { tabId: tab.id })
    const frames = await until(async () => {
      const frames = await rpc('frames', { tabId: tab.id })
      return frames.sessions.length ? frames : null
    }, '跨站 iframe')
    const sessionId = frames.sessions[0]
    const ax = await command('Accessibility.getFullAXTree', {}, sessionId)
    assert(ax.nodes.some((node) => node.name?.value === 'FRAME BUTTON'))
    const child = await evaluate(
      '(()=>{const r=document.querySelector("#frameButton").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()',
      undefined,
      sessionId,
    )
    const parent = await evaluate(
      '(()=>{const f=document.querySelector("#frame"),r=f.getBoundingClientRect();return {x:r.x+f.clientLeft,y:r.y+f.clientTop}})()',
    )
    const point = { x: child.x + parent.x, y: child.y + parent.y }
    for (const type of ['mousePressed', 'mouseReleased'])
      await command('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
    assert.equal(
      await evaluate('document.querySelector("#frameButton").textContent', undefined, sessionId),
      'FRAME OK',
    )
    return { sessions: frames.sessions.length, point }
  })
  await check('页面缩放和滚动后的 CSS 坐标', async () => {
    const beforeDpr = await evaluate('devicePixelRatio')
    await rpc('zoom', { tabId: tab.id, factor: 1.5 })
    await until(
      () => evaluate(`Math.abs(devicePixelRatio - ${beforeDpr * 1.5}) < 0.01`),
      '缩放生效',
    )
    await evaluate('document.querySelector("#bottom").scrollIntoView()')
    const geometry = await evaluate(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{const r=document.querySelector("#bottom").getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;resolve({x,y,dpr:devicePixelRatio,scrollY,hit:document.elementFromPoint(x,y)?.id})})))',
    )
    assert.equal(geometry.hit, 'bottom')
    for (const type of ['mousePressed', 'mouseReleased'])
      await command('Input.dispatchMouseEvent', {
        type,
        x: geometry.x,
        y: geometry.y,
        button: 'left',
        clickCount: 1,
      })
    const events = await evaluate('events')
    assert(
      events.some((event) => event.type === 'click' && event.target === 'bottom'),
      JSON.stringify({ geometry, events }),
    )
    await rpc('zoom', { tabId: tab.id, factor: 1 })
    await evaluate('scrollTo(0,0)')
    return geometry
  })
  await check('同源 POST 通过；跨源重定向在请求前阻断', async () => {
    await rpc('guard', { tabId: tab.id, origins: [site.origin] })
    await evaluate('document.querySelector("form").requestSubmit()')
    await until(
      () => site.requests.some((item) => item.path === '/posted' && item.method === 'POST'),
      'POST',
    )
    await ready()
    const navigation = await command('Page.navigate', { url: `${site.origin}/redirect` })
    await until(
      async () =>
        (await rpc('events')).some((event) => event.blocked && event.url?.endsWith('/blocked')),
      '阻断通知',
    )
    assert(!site.requests.some((item) => item.path === '/blocked'))
    await rpc('unguard', { tabId: tab.id })
    return { navigation, blockedBeforeServer: true }
  })
  await check('弹窗与现有标签 Fetch 守卫的边界', async () => {
    await command('Page.navigate', { url: site.origin })
    await ready()
    await rpc('guard', { tabId: tab.id, origins: [site.origin] })
    const point = await evaluate(
      '(()=>{const r=document.querySelector("#popup").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()',
    )
    for (const type of ['mousePressed', 'mouseReleased'])
      await command('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
    const arrived = await until(
      () => site.requests.some((item) => item.path === '/popup'),
      '弹窗请求',
      3000,
    ).catch(() => false)
    await rpc('unguard', { tabId: tab.id })
    const popup = (await rpc('tabs')).find((item) => item.url?.endsWith('/popup'))
    assert(popup, '必须实际创建弹窗，不能把浏览器拦窗当来源守卫通过')
    return {
      popupReachedServer: !!arrived,
      conclusion: arrived
        ? '父标签 Fetch 无法保护新弹窗，生产版须增加预先拦截策略'
        : '未见请求；尚需确认弹窗是否实际创建',
    }
  })
  await check('释放调试器保留已有标签，后续输入拒绝', async () => {
    await rpc('release', { tabId: tab.id })
    assert((await rpc('tabs')).some((item) => item.id === tab.id))
    await assert.rejects(
      command('Input.insertText', { text: 'should-not-type' }),
      /没有 M0 调试租约/,
    )
    return '标签仍在；无租约命令未派发'
  })
  results.targets = (await cdp.call('Target.getTargets')).targetInfos.map(({ type, url }) => ({
    type,
    url,
  }))
}
