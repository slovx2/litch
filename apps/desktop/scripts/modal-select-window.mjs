import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'

const cases = [
  ['spawn', '#spawn-harness'],
  ['spawn', '#spawn-model'],
  ['spawn', '#spawn-effort'],
  ['spawn', '#spawn-workspace'],
  ['spawn', '#spawn-sandbox'],
  ['import', '#bimp-profile'],
  ['pair', 'select[data-act="pick-host"]'],
  ['repo', '.ext-detail select', '.ext-pick-row'],
  ['feishu', '[data-feishu-manager]'],
  ['search', '.search-dialog select', '[data-open-search]'],
  ['template', '#hc-template', '[data-act="hc-provider-add"]'],
  ['provider-field', '#hc-def-wire_api', '[data-act="hc-provider-add"]'],
  ['instructions', '#hc-unify-source', '[data-act="hc-unify"]'],
  ['auth', '#fixture-auth-region'],
]

app.setPath('userData', process.env.LITCH_SELECT_PROFILE)
app.dock?.hide()
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1100,
    height: 900,
    webPreferences: { backgroundThrottling: false },
  })
  const cdp = window.webContents.debugger
  cdp.attach('1.3')
  const read = (expression) => window.webContents.executeJavaScript(expression)
  const wait = async (expression, ms = 6_000) => {
    const end = Date.now() + ms
    do {
      const value = await read(expression)
      if (value) return value
      await delay(40)
    } while (Date.now() < end)
    return null
  }
  const query = (selector) => `document.querySelector(${JSON.stringify(selector)})`
  const click = async (node, scroll = true) => {
    const point = await read(`(async () => {
    const element = ${node};
    if (!element) return null;
    if (${scroll}) element.scrollIntoView({block: 'nearest', inline: 'nearest'});
    let rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    for (let i = 0; i < 30; i++) {
      await new Promise(requestAnimationFrame);
      const next = element.getBoundingClientRect();
      if (Math.abs(next.x - rect.x) + Math.abs(next.y - rect.y) < 0.5
        && document.elementFromPoint(next.x + next.width / 2, next.y + next.height / 2)
          ?.closest('select,button') === element.closest('select,button')) {
        rect = next;
        break;
      }
      rect = next;
    }
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`)
    if (!point) return false
    for (const type of ['mousePressed', 'mouseReleased'])
      await cdp.sendCommand('Input.dispatchMouseEvent', {
        type,
        ...point,
        button: 'left',
        clickCount: 1,
      })
    return true
  }
  const key = async (key, windowsVirtualKeyCode) => {
    for (const type of ['keyDown', 'keyUp'])
      await cdp.sendCommand('Input.dispatchKeyEvent', {
        type,
        key,
        code: key,
        windowsVirtualKeyCode,
      })
  }

  async function check(scene, selector, open, input) {
    await window.loadURL('about:blank')
    await window.loadURL(`${process.env.LITCH_SELECT_URL}?scene=${scene}`)
    if (open) {
      const trigger = query(open)
      assert.ok(await wait(`${trigger} && !${trigger}.disabled`), `找不到入口 ${open}`)
      assert.ok(await click(trigger))
    }
    const node = query(selector)
    const options = await wait(`(() => {
    const select = ${node};
    if (!select || select.matches(':disabled')) return null;
    if (select.closest('dialog') && !select.closest('dialog:modal')) return null;
    const selected = select.selectedIndex;
    const enabled = [...select.options].map((o, index) => ({
      index, value: o.value, disabled: o.matches(':disabled'),
    })).filter(o => !o.disabled);
    if (enabled.length < 2) return null;
    const next = ${input === 'keyboard'}
      ? (enabled.at(-1).index === selected ? enabled[0] : enabled.at(-1))
      : (enabled.find(o => o.index > selected) ?? enabled.at(-2));
    return { selected, initial: select.value, next, modal: !!select.closest('dialog:modal') };
  })()`)
    assert.ok(options && options.next.value !== options.initial, `缺少可选项 ${scene} ${selector}`)
    await read(`window.selectChanges = [];
    window.selectClicked = false;
    ${node}.addEventListener('click', e => { if (e.isTrusted) window.selectClicked = true; });
    ${node}.addEventListener('change', e => window.selectChanges.push({ trusted: e.isTrusted, value: e.target.value }));`)
    assert.ok(await click(node), `找不到下拉按钮 ${selector}`)
    if (!(await wait(`${node}.matches(':open')`, 600))) {
      assert.ok(await read('window.selectClicked'), `点击没到下拉框 ${selector}`)
      return { modal: options.modal, ok: false, reason: '真实点击后没有弹出菜单' }
    }
    if (input === 'mouse') {
      const evidence = process.env.LITCH_SELECT_EVIDENCE
      if (evidence && scene === 'pair')
        writeFileSync(
          join(evidence, 'pair-picker.png'),
          (await window.webContents.capturePage()).toPNG(),
        )
      const clicked = await click(`${node}.options[${options.next.index}]`, false)
      if (!clicked) return { modal: options.modal, ok: false, reason: '选项没有渲染区域' }
    } else {
      if (process.env.LITCH_SELECT_DIAGNOSE !== '1') {
        await key('Escape', 27)
        assert.ok(
          await wait(`${node}?.closest('dialog:modal') && !${node}.matches(':open')`, 600),
          `Esc 应只关下拉菜单 ${selector}`,
        )
        assert.equal(await read(`${node}.value`), options.initial)
        assert.ok(await click(node))
        assert.ok(await wait(`${node}.matches(':open')`, 600))
      }
      const down = options.next.index > options.selected
      await key(down ? 'End' : 'Home', down ? 35 : 36)
      await key('Enter', 13)
    }
    const expected = JSON.stringify(options.next.value)
    await read('new Promise(resolve => requestAnimationFrame(() => resolve()))')
    const ok = await wait(
      `${node}?.value === ${expected} && window.selectChanges.some(
    entry => entry.trusted && entry.value === ${expected})`,
      600,
    )
    if (ok && scene === 'feishu' && input === 'keyboard') {
      await key('Escape', 27)
      assert.ok(
        await wait('!document.querySelector("dialog:modal")', 600),
        '菜单收起后 Esc 应关设置',
      )
    }
    return {
      modal: options.modal,
      ok: !!ok,
      ...(ok ? {} : { reason: '没有收到预期的受信 change' }),
    }
  }

  const failed = []
  try {
    for (const [scene, selector, open] of cases) {
      for (const input of ['mouse', 'keyboard']) {
        const label = `${scene} ${selector} ${input}`
        try {
          const result = await check(scene, selector, open, input)
          console.log(`${label} ${JSON.stringify(result)}`)
          if (!result.ok && process.env.LITCH_SELECT_DIAGNOSE !== '1') failed.push(label)
        } catch (error) {
          console.error(label, error.message)
          failed.push(label)
        }
      }
    }
    assert.deepEqual(failed, [])
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
})
