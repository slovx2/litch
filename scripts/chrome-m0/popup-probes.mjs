import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { until } from './cdp.mjs'

const settle = () => new Promise((resolve) => setTimeout(resolve, 800))

export async function popupProbes({ rpc, site, results, work }) {
  results.permissions = (await rpc('ping')).permissions
  const targetOrigin = site.origin.replace('a.test', 'b.test')
  const modes = [
    'none',
    'dnr-initiator',
    'dnr-tab',
    'onCreated-close',
    'onCreated-attach',
    'isolated-open',
    'autoAttach-wait',
    'main-open',
  ]
  let sequence = 0
  async function page() {
    const tab = await rpc('new', { url: site.origin })
    await rpc('attach', { tabId: tab.id })
    await until(
      () =>
        rpc('evaluate', {
          tabId: tab.id,
          expression: '!!document.querySelector("#popup") && document.readyState === "complete"',
        }),
      '弹窗源页面',
    )
    return tab.id
  }
  async function trigger(tabId, url, variant = 'open') {
    const expression =
      variant === 'saved'
        ? `document.querySelector('#popup').onclick=()=>window.savedOpen(${JSON.stringify(url)})`
        : variant === 'blank'
          ? `document.querySelector('#popup').onclick=()=>{const w=window.open('about:blank');if(w)w.location=${JSON.stringify(url)}}`
          : variant === 'anchor'
            ? `document.querySelector('#popup').onclick=()=>{const a=document.createElement('a');a.href=${JSON.stringify(url)};a.target='_blank';document.body.append(a);a.click()}`
            : `document.querySelector('#popup').onclick=()=>window.open(${JSON.stringify(url)})`
    await rpc('evaluate', { tabId, expression })
    const point = await rpc('evaluate', {
      tabId,
      expression:
        '(()=>{const r=document.querySelector("#popup").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()',
    })
    for (const type of ['mousePressed', 'mouseReleased']) {
      await rpc('cdp', {
        tabId,
        method: 'Input.dispatchMouseEvent',
        params: { type, ...point, button: 'left', clickCount: 1 },
      })
    }
    await settle()
  }
  async function cleanup() {
    await rpc('popupMode', { mode: 'none', tabId: -1 })
    for (const tab of await rpc('tabs')) {
      if (tab.url?.startsWith('http://a.test:') || tab.url?.startsWith('http://b.test:')) {
        await rpc('close', { tabId: tab.id }).catch(() => {})
      }
    }
  }
  for (const mode of modes) {
    const entry = { name: mode, status: 'pass', trials: [] }
    try {
      for (const variant of ['open', 'saved', 'blank', 'anchor']) {
        const tabId = await page()
        const path = `/popup-${mode}-${++sequence}`
        await rpc('popupMode', { mode, tabId })
        await rpc('events')
        await trigger(tabId, `${targetOrigin}${path}`, variant)
        const requests = site.requests.filter((request) => request.path === path)
        const events = await rpc('events')
        entry.trials.push({
          variant,
          firstRequestSent: requests.length > 0,
          requestCount: requests.length,
          events,
        })
        await cleanup()
      }
      if (mode === 'dnr-initiator') {
        const agent = await page()
        const user = await page()
        await rpc('popupMode', { mode, tabId: agent })
        const path = `/popup-collateral-${++sequence}`
        await trigger(user, `${targetOrigin}${path}`)
        entry.unleasedSameOriginBlocked = !site.requests.some((request) => request.path === path)
        await cleanup()
      }
      if (mode === 'none')
        assert(
          entry.trials.every((trial) => trial.firstRequestSent),
          '基线必须真实发送全部目标请求',
        )
    } catch (error) {
      entry.status = 'fail'
      entry.error = String(error.stack ?? error)
      await cleanup().catch(() => {})
    }
    results.checks.push(entry)
    console.log(
      `${entry.status.toUpperCase()} ${mode}: ${entry.trials.map((trial) => `${trial.variant}=${trial.firstRequestSent ? 'sent' : 'blocked'}`).join(', ')}${entry.unleasedSameOriginBlocked ? '; 误拦未租约用户标签' : ''}${entry.error ? `; ${entry.error}` : ''}`,
    )
    writeFileSync(join(work, 'results.json'), JSON.stringify(results, null, 2))
  }
}
