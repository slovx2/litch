// 在五轮问答处用真实窗口事件检查分隔条和窄布局；可选截图仍使用隐藏窗口。
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { judgeManager, managerProbe } from './probe-manager.mjs'
import { runInPage } from './smoke.mjs'

export async function runManagerChecks(
  window: BrowserWindow,
): Promise<readonly [object, string[]]> {
  const shots = process.env.LITCH_MANAGER_QUESTION_SHOTS
  const pathShot = process.env.LITCH_FIXTURE_PATH_PICKER_SHOT
  if (pathShot)
    await window.webContents.executeJavaScript(
      'document.documentElement.dataset.pathPickerShot = "true"',
    )
  const running = runInPage(window, managerProbe, true)
  {
    const capture = async () => {
      const deadline = Date.now() + 30000
      while (Date.now() < deadline) {
        const ready = await window.webContents.executeJavaScript(
          'document.documentElement.dataset.managerQuestionsReady === "true"',
        )
        if (ready) {
          const waitLayout = () => new Promise((resolve) => setTimeout(resolve, 150))
          const measure = () =>
            window.webContents.executeJavaScript(`(()=>{
            const pane=document.querySelector('.mg-talk-pane').getBoundingClientRect();
            const body=document.querySelector('.mg-board > .mg-body').getBoundingClientRect();
            const board=document.querySelector('.mg-board').getBoundingClientRect();
            return {height:pane.height,top:pane.top,bottom:pane.bottom,right:pane.right,list:body.height,boardBottom:board.bottom,width:innerWidth};
          })()`)
          const point = await window.webContents.executeJavaScript(`(()=>{
            const r=document.querySelector('.mg-talk-grip').getBoundingClientRect();
            return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};
          })()`)
          const before = await measure()
          window.webContents.sendInputEvent({
            type: 'mouseDown',
            ...point,
            button: 'left',
            clickCount: 1,
          })
          window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y - 30 })
          window.webContents.sendInputEvent({
            type: 'mouseUp',
            x: point.x,
            y: point.y - 30,
            button: 'left',
            clickCount: 1,
          })
          await waitLayout()
          const dragged = await measure()
          if (dragged.height < before.height + 20)
            throw new Error(`讨论分隔条拖动无效：${JSON.stringify({ before, dragged })}`)
          if (shots) {
            await mkdir(shots, { recursive: true })
            await writeFile(
              join(shots, 'decision-questions.png'),
              (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG(),
            )
          }
          const bounds = window.getBounds()
          window.setSize(720, 640)
          await waitLayout()
          await window.webContents.executeJavaScript(
            "document.querySelectorAll('.mg-narrow button')[1].click()",
          )
          await waitLayout()
          const narrow = await measure()
          if (
            narrow.list < 140 ||
            narrow.height < 96 ||
            narrow.bottom > narrow.boardBottom + 1 ||
            narrow.right > narrow.width
          )
            throw new Error(`窄窗口讨论挤出卡片列表：${JSON.stringify(narrow)}`)
          if (shots)
            await writeFile(
              join(shots, 'decision-questions-narrow.png'),
              (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG(),
            )
          window.setBounds(bounds)
          await waitLayout()
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
  if (pathShot) {
    const capturePath = async () => {
      const deadline = Date.now() + 30000
      while (Date.now() < deadline) {
        if (
          await window.webContents.executeJavaScript(
            'document.documentElement.dataset.pathPickerReady === "true"',
          )
        ) {
          await window.webContents.executeJavaScript(
            'window.__litchLook.set({skin:"human",theme:"light"})',
          )
          await new Promise((resolve) => setTimeout(resolve, 150))
          await writeFile(
            pathShot,
            (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG(),
          )
          await window.webContents.executeJavaScript(
            'window.dispatchEvent(new Event("litch-path-picker-captured"))',
          )
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      throw new Error('等待路径选择器截图超时')
    }
    await Promise.race([capturePath(), running])
  }
  const result = await running
  return [result, judgeManager(result)]
}
