import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import {
  judgeServiceRestart,
  serviceRestart,
} from '../../apps/desktop/src/probe-remote-service-restart.mts'

// 原探针仍原样序列化进页面；重启完成时自动回合已结束，手动继续提示从未被探针观察到。
function fixture(mode = 'completed') {
  let page = 'chat'
  let restarts = 0
  let pendingToast = false
  let replying = false
  const sends = []
  const waits = []
  const svc = '远程设备'
  const opening = '首句'
  const text = (textContent) => ({ textContent })
  const button = (click) => ({ click })
  const group = { classList: { contains: () => false } }
  const row = { ...text(opening), click() {} }
  const resumed = text(mode === 'incomplete' ? '回答尚未结束' : '恢复回答一点一点出来的。')
  const original = text('旧回合一点一点出来的。')
  const after = text('收到：重启之后接着说的一句')
  class Textarea {
    set value(value) {
      this.words = value
    }
    dispatchEvent(event) {
      if (event.type === 'keydown') {
        sends.push(this.words)
        replying = sends.length === 1
      }
    }
  }
  const input = new Textarea()
  const finishRestart = () => {
    restarts++
    pendingToast = true
    replying = false
  }
  const one = (selector, root) => {
    if (selector === '.dev-row:not(.projection-group *) .name') return text(svc)
    if (selector === '.dev-row:not(.projection-group *) .pill') return text('重启中')
    if (selector === ':scope > .row-line > .row-more > .ibtn') return button(() => {})
    if (selector.includes('data-action="settings"')) return button(() => (page = 'detail'))
    if (selector.includes('data-action="restart"'))
      return button(() => {
        if (!restarts) finishRestart()
      })
    if (selector === '[data-detail]') return page === 'detail' ? {} : null
    if (selector === '[data-sec="service"]') return {}
    if (selector === '[data-fact="pid"]') return text(String(1000 + restarts))
    if (selector === '[data-act="back"]') return button(() => (page = 'devices'))
    if (selector === '.devp-list' || selector === '.devp') return page === 'devices' ? {} : null
    if (selector === '.devp .arch-head .ibtn') return button(() => (page = 'chat'))
    if (selector === '.ss-row:not(.projection-group *).sel') return row
    if (selector === 'textarea.cmp-text') return input
    if (selector === '.running-line:not([data-hidden])')
      return replying || (restarts === 2 && mode === 'running') ? {} : null
    if (selector === '.md.live') return replying ? text('正在回复') : null
    if (selector === '.toast[data-toast^="restart:"]') return pendingToast ? {} : null
    if (selector === '.toast-text')
      return text(`已重启 ${svc} 的设备服务${restarts === 2 ? '，1 个会话被打断' : ''}`)
    if (selector === '.toast-x') return button(() => (pendingToast = false))
    if (selector === 'dialog.confirm [data-restart="sessions"]') return { closest: () => ({}) }
    if (selector === 'b') return text(`重启 ${svc} 的设备服务？`)
    if (selector === '.confirm-yes') return button(finishRestart)
    if (selector === '[data-sys="restart"]')
      return root === resumed && mode !== 'wrong-origin' ? {} : null
    // 自动继续已经清掉提示；旧探针会在这里超时。
    return null
  }
  const all = (selector) => {
    if (selector === '.dev-group') return [group]
    if (selector === '.ss-row:not(.projection-group *)') return [row]
    if (selector === '[data-restart="sessions"] li') return [text(`${opening} · 回合进行中`)]
    if (selector === '.turn')
      return [
        original,
        ...(restarts === 2 && mode !== 'missing' ? [resumed] : []),
        ...(restarts === 2 && mode === 'duplicate' ? [resumed] : []),
        ...(sends.length === 2 ? [after] : []),
      ]
    return []
  }
  const kit = {
    one,
    all,
    text: (node) => node?.textContent ?? '',
    frame: async () => {},
    async until(name, check, budget) {
      waits.push({ name, budget })
      const value = check()
      if (!value) throw new Error(`等不到：${name}`)
      return value
    },
  }
  const context = {
    window: { __termKit: kit },
    HTMLTextAreaElement: Textarea,
    Event: class {},
    KeyboardEvent: class {
      constructor(type) {
        this.type = type
      }
    },
  }
  return {
    sends,
    waits,
    run: () => runInNewContext(`(${serviceRestart.toString()})('远程设备', '首句')`, context),
  }
}

test('自动继续先于 toast 采样完成：不等短暂提示，核对恢复回答后只发一次后续消息', async () => {
  const page = fixture()
  const seen = await page.run()
  assert.equal(seen.autoContinued, true)
  assert.equal(seen.continued, true)
  assert.equal(seen.noteGone, true)
  assert.deepEqual(judgeServiceRestart(seen, '远程设备', '首句'), [])
  assert.deepEqual(page.sends, ['重启设备服务时在说的这一句', '重启之后接着说的一句'])
  assert.ok(
    page.waits.some(({ name, budget }) => name === '原会话自动继续且回答完成' && budget === 60000),
  )
})

for (const mode of ['missing', 'wrong-origin', 'incomplete', 'running', 'duplicate']) {
  test(`重启回合 ${mode} 不能判恢复完成或提前发送下一句`, async () => {
    const page = fixture(mode)
    await assert.rejects(page.run(), /原会话自动继续且回答完成|重启后自动继续了不止一次/)
    assert.deepEqual(page.sends, ['重启设备服务时在说的这一句'])
  })
}
