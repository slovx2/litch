// 隐藏 Electron 窗口验正式组件；只加载模拟设备夹具。

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { app, BrowserWindow } from 'electron'

app.setPath('userData', process.env.LITCH_UPGRADE_PROFILE)
app.dock?.hide()
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1100,
    height: 900,
    webPreferences: { backgroundThrottling: false },
  })
  const read = (expression) => window.webContents.executeJavaScript(expression)
  const cdp = window.webContents.debugger
  cdp.attach('1.3')
  const wait = async (expression) => {
    const until = Date.now() + 25000
    while (!(await read(expression))) {
      if (Date.now() > until) throw new Error(expression)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  const click = async (selector) => {
    const point = await read(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`)
    assert.ok(point, `可点击的 ${selector}`)
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.sendCommand('Input.dispatchMouseEvent', {
        type,
        ...point,
        button: 'left',
        clickCount: 1,
      })
    }
  }
  const key = async (key, windowsVirtualKeyCode) => {
    for (const type of ['keyDown', 'keyUp']) {
      await cdp.sendCommand('Input.dispatchKeyEvent', {
        type,
        key,
        code: key,
        windowsVirtualKeyCode,
      })
    }
  }
  const select = (id) => `[data-upgrade-device="${id}"] select`
  const openSelect = async (id) => {
    const selector = select(id)
    await click(selector)
    await wait(`document.querySelector('${selector}').matches(':open')`)
  }
  const choose = async (id, value) => {
    await openSelect(id)
    await click(`${select(id)} option[value="${value}"]`)
    await wait(`document.querySelector('${select(id)}').value === '${value}'`)
  }
  try {
    await window.loadURL(process.env.LITCH_UPGRADE_URL)
    assert.equal(await read('document.querySelectorAll("[data-upgrade-device]").length'), 0)
    await wait('document.querySelectorAll("[data-upgrade-device]").length === 4')
    assert.equal(
      await read('document.querySelector("[data-upgrade-device=local] select").options.length'),
      3,
    )
    assert.equal(
      await read(
        'document.querySelector("[data-upgrade-device=remote-idle] select").options.length',
      ),
      3,
    )
    assert.equal(
      await read(
        '[...document.querySelectorAll("[data-upgrade-device] select")].every(s => s.value === "idle")',
      ),
      true,
    )
    assert.equal(
      await read(
        'document.querySelector("[data-upgrade-device=remote-busy] select").options.length',
      ),
      3,
    )
    await wait(
      'document.querySelector("[data-upgrade-device=remote-idle]").textContent.includes("空闲")',
    )
    assert.equal(
      await read(
        'document.querySelectorAll("[data-upgrade-device=offline], [data-upgrade-device=latest]").length',
      ),
      0,
    )
    await wait(
      'document.querySelector("[data-upgrade-device=remote-busy]").textContent.includes("npm run dev")',
    )
    for (const skin of ['standard', 'retro', 'human'])
      for (const theme of ['light', 'dark']) {
        await read(`window.__litchLook.set({ skin: '${skin}', theme: '${theme}' })`)
        await new Promise((resolve) => setTimeout(resolve, 100))
        writeFileSync(
          `${process.env.LITCH_UPGRADE_PROFILE}/${skin}-${theme}.png`,
          (await window.webContents.capturePage()).toPNG(),
        )
        assert.equal(
          await read(
            'document.querySelector("dialog").scrollWidth <= document.querySelector("dialog").clientWidth',
          ),
          true,
        )
      }
    await choose('local', 'none')
    await openSelect('remote-idle')
    await key('ArrowDown', 40)
    await key('Enter', 13)
    await wait(
      'document.querySelector("[data-upgrade-device=remote-idle]").textContent.includes("终止已检测到的 0 个后台任务")',
    )
    await read('document.querySelector(".confirm-yes").click()')
    await wait(
      'window.upgradeFixture.calls.some(c => c.name === "device.upgradeService" && c.params.deviceId === "remote-idle" && c.params.mode === "force")',
    )
    assert.equal(
      await read(
        'window.upgradeFixture.calls.some(c => c.name === "device.upgradeService" && c.params.deviceId === "remote-busy" && c.params.mode === "start")',
      ),
      true,
      '未改选项时也必须执行默认空闲升级',
    )
    await wait('document.querySelector("[data-toast=upgrade-remote-fail]")')
    assert.equal(
      await read(
        'document.querySelector("[data-toast=upgrade-remote-fail]").textContent.includes("fixture: download failed")',
      ),
      true,
    )
    await wait('document.querySelector("[data-act=remote-cancel]")')
    for (const skin of ['standard', 'retro', 'human'])
      for (const theme of ['light', 'dark']) {
        await read(`window.__litchLook.set({ skin: '${skin}', theme: '${theme}' })`)
        await new Promise((resolve) => setTimeout(resolve, 100))
        const metrics = await read(`(() => {
        const cancel = document.querySelector('[data-act=remote-cancel]'), retry = document.querySelector('[data-act=remote-retry]');
        const a = cancel.getBoundingClientRect(), b = retry.getBoundingClientRect(), icon = cancel.querySelector('svg').getBoundingClientRect();
        const range = document.createRange(); range.selectNodeContents(cancel.lastChild); const text = range.getBoundingClientRect();
        return { top: a.top-b.top, height: a.height-b.height, icon: icon.height, font: parseFloat(getComputedStyle(cancel).fontSize), center: (icon.top+icon.bottom-text.top-text.bottom)/2 };
      })()`)
        assert.equal(metrics.top, 0)
        assert.equal(metrics.height, 0)
        assert.ok(metrics.icon <= metrics.font + 1, JSON.stringify(metrics))
        assert.ok(Math.abs(metrics.center) <= 2, JSON.stringify(metrics))
        writeFileSync(
          `${process.env.LITCH_UPGRADE_PROFILE}/buttons-${skin}-${theme}.png`,
          (await window.webContents.capturePage()).toPNG(),
        )
      }
    await read('document.querySelector("[data-act=remote-force]").click()')
    await wait('document.querySelector("[data-confirm=force]")')
    assert.equal(
      await read(
        'document.querySelector("[data-confirm=force]").textContent.includes("终止已检测到的 1 个后台任务")',
      ),
      true,
    )
    await read('document.querySelector("dialog.confirm .confirm-yes").click()')
    await read('document.querySelector("[data-act=remote-cancel]").click()')
    await wait('window.upgradeFixture.calls.some(c => c.params.mode === "cancel")')
    await window.reload()
    await new Promise((resolve) => setTimeout(resolve, 2500))
    assert.equal(await read('document.querySelectorAll("[data-upgrade-device]").length'), 0)
    await read('localStorage.removeItem("litch.device-upgrade.prompt-version")')
    await window.loadURL(`${process.env.LITCH_UPGRADE_URL}&pending=1`)
    await new Promise((resolve) => setTimeout(resolve, 2500))
    assert.equal(await read('document.querySelectorAll("[data-upgrade-device]").length'), 0)
    await wait('document.querySelectorAll("[data-upgrade-device]").length === 4')
    await read('window.upgradeFixture.setOnline(false)')
    await wait('document.querySelectorAll("[data-upgrade-device]").length === 0')
    await read('window.upgradeFixture.setOnline(true)')
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(await read('document.querySelectorAll("[data-upgrade-device]").length'), 0)

    await read('localStorage.removeItem("litch.device-upgrade.prompt-version")')
    await window.loadURL(`${process.env.LITCH_UPGRADE_URL}&applyOne=1`)
    await wait('document.querySelectorAll("[data-upgrade-device]").length === 4')
    // 已入弹窗的本机变空闲时，仍等用户应用选择。
    await wait(
      'document.querySelector("[data-upgrade-device=local] .upgrade-state").textContent === "空闲"',
    )
    const calls = () =>
      read(
        'window.upgradeFixture.calls.filter(c => ["device.upgradeService", "device.restartService"].includes(c.name))',
      )
    assert.deepEqual(await calls(), [])
    for (const id of ['local', 'remote-busy', 'remote-fail']) await choose(id, 'none')
    await choose('remote-idle', 'force')
    await choose('remote-idle', 'idle')
    await click('.confirm-yes')
    await wait('window.upgradeFixture.calls.some(c => c.name === "device.upgradeService")')
    assert.deepEqual(await calls(), [
      { name: 'device.upgradeService', params: { deviceId: 'remote-idle', mode: 'start' } },
    ])
    console.log(
      'PASS: 隐藏 Electron，三皮肤、选项、后台摘要、失败隔离、取消、同版本不重复提示、连接超时后汇总',
    )
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
})
