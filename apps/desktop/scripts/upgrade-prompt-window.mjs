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
  const wait = async (expression) => {
    const until = Date.now() + 25000
    while (!(await read(expression))) {
      if (Date.now() > until) throw new Error(expression)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
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
      2,
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
    await read(
      `for (const select of document.querySelectorAll('[data-upgrade-device] select')) { const id = select.closest('[data-upgrade-device]').dataset.upgradeDevice; select.value = id === 'local' ? 'none' : id === 'remote-busy' ? 'force' : 'idle'; select.dispatchEvent(new Event('change', { bubbles: true })) }`,
    )
    await wait(
      'document.querySelector("[data-upgrade-device=remote-busy]").textContent.includes("终止已检测到的 1 个后台任务")',
    )
    await read('document.querySelector(".confirm-yes").click()')
    await wait(
      'window.upgradeFixture.calls.some(c => c.name === "device.upgradeService" && c.params.deviceId === "remote-busy" && c.params.mode === "force")',
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
    console.log(
      'PASS: 隐藏 Electron，三皮肤、选项、后台摘要、失败隔离、取消、同版本不重复提示、连接超时后汇总',
    )
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
})
