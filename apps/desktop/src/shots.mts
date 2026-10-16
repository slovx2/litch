// 给 README 截图：不显示窗口，对着模拟核心，把几种皮肤和场景各截一张存成 PNG。
// 示例数据的语言在核心进程启动时就定了，所以一次运行只截一种语言，两种语言由 scripts/shots.mjs 分两次起。
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'

type Scene = 'chat' | 'activity' | 'stream'

interface Shot {
  name: string
  skin: 'retro' | 'human'
  theme: 'light' | 'dark'
  scene: Scene
}

/** 每种皮肤三张：对话全貌、活动区展开看差异、另一种明暗下正在输出 */
const SHOTS: Shot[] = [
  { name: 'retro-dark-chat', skin: 'retro', theme: 'dark', scene: 'chat' },
  { name: 'retro-dark-activity', skin: 'retro', theme: 'dark', scene: 'activity' },
  { name: 'retro-light-stream', skin: 'retro', theme: 'light', scene: 'stream' },
  { name: 'human-light-chat', skin: 'human', theme: 'light', scene: 'chat' },
  { name: 'human-light-activity', skin: 'human', theme: 'light', scene: 'activity' },
  { name: 'human-dark-stream', skin: 'human', theme: 'dark', scene: 'stream' },
]

/**
 * 在页面里把场景摆好。和验收脚本一样，这个函数会被原样送进页面执行，不能引用外面的东西。
 * 返回时页面已经是要截的样子。
 */
async function arrange(scene: string): Promise<void> {
  const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
  const until = async (what: string, check: () => unknown, ms = 60_000) => {
    const end = performance.now() + ms
    while (performance.now() < end) {
      if (check()) return
      await sleep(50)
    }
    throw new Error(`等不到：${what}`)
  }
  const one = (selector: string) => document.querySelector<HTMLElement>(selector)
  const live = () => one('.md.live')
  await document.fonts.ready
  // 启动落在新建对话页：截的是对话，先点开第一个工作区里排最前面的那个会话（示例里一打开就在流的那个）。
  // 两种语言下标题不一样，所以按位置找，不按标题找
  const first = () => one('.ws-row')?.closest('[data-group]')?.querySelector<HTMLElement>('.ss-row')
  await until('侧栏里的会话', first)
  first()?.click()
  await until('会话内容', () => one('.turn'))

  if (scene === 'stream') {
    // 回答出到代码块的时候截：这时活动区还开着，光标在动
    await until('回答输出到代码块', () => one('.md.live .code'))
    await sleep(600)
    return
  }
  await until('回答开始输出', live)
  await until('回答输出完', () => !live())
  await sleep(300)
  if (scene === 'chat') return

  // 活动区展开，再点开改文件的那一条看差异
  const turn = one('.turn:last-child') as HTMLElement
  turn.querySelector<HTMLElement>('.act-head')?.click()
  await until('活动区展开', () => turn.querySelector('.act-body'))
  const rows = [...turn.querySelectorAll<HTMLElement>('.item-head:not(:disabled)')]
  rows[1]?.click()
  await until('差异画出来', () => turn.querySelector('.dl'))
  // 把这一回合的开头滚到视口上沿
  turn.scrollIntoView({ block: 'start' })
  await sleep(300)
}

export async function runShots(
  window: BrowserWindow,
  outDir: string,
  load: (params: Record<string, string>) => Promise<void>,
): Promise<boolean> {
  mkdirSync(outDir, { recursive: true })
  try {
    for (const shot of SHOTS) {
      await load({ skin: shot.skin, theme: shot.theme })
      await window.webContents.executeJavaScript(
        `(${arrange.toString()})(${JSON.stringify(shot.scene)})`,
        true,
      )
      const image = await window.webContents.capturePage()
      if (image.isEmpty()) throw new Error(`${shot.name}：截到的是空图`)
      // 按一倍大小存（1280×800）：文件小，而且不随截图那台机器的屏幕是不是高分屏而变
      writeFileSync(join(outDir, `${shot.name}.png`), image.toPNG())
      console.log(`LITCH_SHOT ${shot.name}`)
    }
    return true
  } catch (error) {
    console.error(`截图失败：${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}
