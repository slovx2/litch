// tree 探针结束时当前会话仍有未答的异步题。用真实 BrowserWindow 改大小，确认待答区不会挤掉输入框。
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'

export async function pendingLooks(
  window: BrowserWindow,
): Promise<{ rows: object[]; failed: string[] }> {
  const before = window.getBounds()
  const rows: object[] = []
  const failed: string[] = []
  const shots = process.env.LITCH_PENDING_SHOTS
  if (shots) mkdirSync(shots, { recursive: true })
  const look = async (skin: string) =>
    window.webContents.executeJavaScript(
      `window.__litchLook.set({skin:${JSON.stringify(skin)},theme:'light'})`,
      true,
    )
  try {
    for (const [width, height] of [
      [1200, 900],
      [900, 640],
    ] as const) {
      window.setSize(width, height)
      for (const skin of ['standard', 'retro', 'human']) {
        await look(skin)
        await new Promise((resolve) => setTimeout(resolve, 180))
        const row = (await window.webContents.executeJavaScript(
          `(() => {
          const rect = (selector) => {
            const e = document.querySelector(selector); if (!e) return null;
            const r = e.getBoundingClientRect();
            return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,scroll:e.scrollWidth,client:e.clientWidth};
          };
          return {width:innerWidth,height:innerHeight,
            pending:rect('.main .pending-asks'),composer:rect('.main .dock'),
            count:document.querySelectorAll('.main [data-pending-question]').length};
        })()`,
          true,
        )) as {
          width: number
          height: number
          count: number
          pending: { bottom: number; scroll: number; client: number; height: number } | null
          composer: { y: number; bottom: number; height: number } | null
        }
        rows.push({ skin, ...row })
        const prefix = `${skin}/${width}×${height}`
        if (row.count !== 2 || !row.pending || !row.composer) failed.push(`${prefix} 待答区缺失`)
        else {
          if (row.composer.bottom > row.height + 1 || row.composer.height < 70)
            failed.push(`${prefix} 输入框被挤出`)
          if (row.pending.bottom > row.composer.y + 1 || row.pending.height < 32)
            failed.push(`${prefix} 待答区与输入框重叠`)
          if (row.pending.scroll > row.pending.client + 1) failed.push(`${prefix} 待答区横向溢出`)
        }
        if (shots)
          writeFileSync(
            join(shots, `pending-${skin}-${width}.png`),
            (await window.webContents.capturePage()).toPNG(),
          )
      }
    }
  } finally {
    window.setBounds(before)
  }
  return { rows, failed }
}
