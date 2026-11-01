// 可选截图仍使用隐藏窗口；页面停在两轮问答，截图完成后继续其余验收。
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { judgeManager, managerProbe } from './probe-manager.mjs'
import { runInPage } from './smoke.mjs'

export async function runManagerChecks(
  window: BrowserWindow,
): Promise<readonly [object, string[]]> {
  const shots = process.env.LITCH_MANAGER_QUESTION_SHOTS
  const running = runInPage(window, managerProbe, Boolean(shots))
  if (shots) {
    const capture = async () => {
      const deadline = Date.now() + 30000
      while (Date.now() < deadline) {
        const ready = await window.webContents.executeJavaScript(
          'document.documentElement.dataset.managerQuestionsReady === "true"',
        )
        if (ready) {
          await mkdir(shots, { recursive: true })
          await writeFile(
            join(shots, 'decision-questions.png'),
            (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG(),
          )
          await window.webContents.executeJavaScript(
            'window.dispatchEvent(new Event("litch-manager-questions-captured"))',
          )
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      throw new Error('等待经理问答截图超时')
    }
    await Promise.race([capture(), running])
  }
  const result = await running
  return [result, judgeManager(result)]
}
