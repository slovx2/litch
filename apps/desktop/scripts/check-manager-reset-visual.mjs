// 独立隐藏窗口，只访问本地模拟界面；截图走 stdout，不写截图和日志文件。

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'

const profile = mkdtempSync(join(tmpdir(), 'litch-reset-visual-'))
app.setPath('userData', profile)
app.on('will-quit', () => rmSync(profile, { recursive: true, force: true }))
async function run() {
  await app.whenReady()
  const deadline = setTimeout(() => {
    console.error('Visual probe timeout')
    app.exit(1)
  }, 45000)
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  })
  try {
    await window.loadURL('http://127.0.0.1:5207')
    await window.webContents.executeJavaScript(`(async () => {
    const wait = async (selector) => {
      for (let i = 0; i < 100; i++) { const node = document.querySelector(selector); if (node) return node; await new Promise(r => setTimeout(r, 50)); }
      throw new Error(selector);
    };
    document.querySelector('[data-act="onboard-later"]')?.click();
    (await wait('[data-sidebar-mode="manager"]')).click();
    (await wait('[data-manager-id="m1"] .mg-pick')).click();
    await wait('[data-act="manager-reset"]');
  })()`)
    for (const skin of process.env.LITCH_VISUAL_SKIN
      ? [process.env.LITCH_VISUAL_SKIN]
      : ['standard', 'human', 'retro']) {
      await window.webContents.executeJavaScript(`(async () => {
      window.__litchLook.set({ skin: '${skin}', theme: 'light' });
      document.querySelector('[data-act="manager-reset"]').click();
      for (let i=0; i<40 && !document.querySelector('dialog[open]'); i++) await new Promise(r=>setTimeout(r,25));
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    })()`)
      const shot = await window.webContents.capturePage()
      process.stdout.write(
        `RESET_IMAGE ${skin} ${shot.resize({ width: 1200 }).toJPEG(50).toString('base64')}\n`,
      )
      await window.webContents.executeJavaScript(
        `document.querySelector('dialog[open] .btn.ghost').click()`,
      )
    }
  } finally {
    clearTimeout(deadline)
    window.destroy()
    app.quit()
  }
}
void run().catch((error) => {
  console.error(error)
  app.exit(1)
})
