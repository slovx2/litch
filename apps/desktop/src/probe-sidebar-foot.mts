// 侧栏验收：底部横排的三个小按钮（定时任务、外观、设置）。侧栏拖到最窄，六套皮肤明暗、中英文各量一遍，
// 三个都画得出来、一样宽、名字没被截断、和底色分得开；“外观”的小弹层改得了皮肤，“更多外观设置”通到设置页的“外观”。
// 和别的验收一样，这里的函数会被原样送进页面里执行，不能引用函数外面的东西。
import type { SidebarKit } from './probe-sidebar-kit.mjs'

export interface FootSeen {
  /** 量的时候侧栏多宽 */
  width: number
  /** 每套外观一行：“皮肤/明暗/语言｜名字:宽x高:图标宽:截断没有:对比度｜…” */
  looks: string[]
  /** 点开“外观”：弹层出来了、整块在窗口里，点“文艺”皮肤当场换上 */
  popOpened: boolean
  popInside: boolean
  skinPicked: string
  /** 弹层里“更多外观设置”打开的是设置页的哪一组；弹层收起了没有 */
  moreAt: string
  popClosed: boolean
}

export async function footSeen(): Promise<FootSeen> {
  const kit = (window as unknown as { __sidebarKit: SidebarKit }).__sidebarKit
  const { one, all, until, sleep } = kit
  const appearance = (
    window as unknown as {
      __litchLook: {
        get(): { skin: string; theme: string; lang: string }
        set(patch: { skin?: string; theme?: string; lang?: string }): void
      }
    }
  ).__litchLook
  const was = appearance.get()
  const looks: string[] = []
  for (const lang of ['zh-CN', 'en']) {
    appearance.set({ lang })
    await sleep(200)
    looks.push(
      ...(await kit.eachSkin((where) =>
        [
          `${where}/${lang}`,
          ...all('.sb-foot .sb-btn').map((button) => {
            const name = one('.sb-btn-name', button) as HTMLElement
            const icon = one('svg', button)?.getBoundingClientRect()
            return [
              name.textContent,
              `${button.offsetWidth}x${button.offsetHeight}`,
              Math.round(icon?.width ?? 0),
              name.scrollWidth > name.clientWidth ? '截断' : '全',
              kit.contrast(getComputedStyle(button).color, kit.backdrop(button)).toFixed(1),
            ].join(':')
          }),
        ].join('｜'),
      )),
    )
  }
  appearance.set({ lang: was.lang })
  await sleep(200)

  one<HTMLButtonElement>('.sb-btn.look')?.click()
  const pop = await until('外观的小弹层', () => one('.sb-look-pop'), 5000)
  const box = pop.getBoundingClientRect()
  const popInside =
    box.left >= 0 && box.top >= 0 && box.right <= window.innerWidth && box.bottom <= innerHeight
  one<HTMLButtonElement>('[data-choice="skin"] [data-value="human"]', pop)?.click()
  await sleep(200)
  const skinPicked = document.documentElement.dataset.skin ?? ''
  appearance.set({ skin: was.skin })
  await sleep(200)
  one<HTMLButtonElement>('.sb-look-more')?.click()
  await until('设置页', () => one('.set-page'), 5000)
  const moreAt = one('.set-content')?.dataset.section ?? ''
  const popClosed = !one('.sb-look-pop')
  one<HTMLButtonElement>('.set-head .ibtn')?.click()
  await until('关掉设置页', () => !one('.set-page'), 5000)

  return {
    width: (one('.sb') as HTMLElement).offsetWidth,
    looks,
    popOpened: Boolean(pop),
    popInside,
    skinPicked,
    moreAt,
    popClosed,
  }
}

export function judgeFoot(seen: FootSeen): string[] {
  const failed: string[] = []
  const must = (ok: boolean, what: string) => {
    if (!ok) failed.push(what)
  }
  must(seen.width === 240, `侧栏没有拖到最窄再量底部按钮：${seen.width}`)
  must(seen.looks.length === 12, `底部按钮没有在六套皮肤明暗、两种语言下量全：${seen.looks.length}`)
  for (const line of seen.looks) {
    const [where, ...buttons] = line.split('｜')
    must(buttons.length === 3, `${where} 下底部不是三个按钮：${buttons.length}`)
    const widths = new Set<string>()
    for (const button of buttons) {
      const [name, size = '', icon, cut, contrast] = button.split(':')
      const [width = 0, height = 0] = size.split('x').map(Number)
      widths.add(String(width))
      must(width >= 60 && height >= 28, `${where} 下“${name}”太小：${size}`)
      must(Number(icon) >= 14, `${where} 下“${name}”的图标没画出来：${icon}`)
      must(cut === '全', `${where} 下“${name}”的名字被截断了`)
      must(Number(contrast) >= 4.5, `${where} 下“${name}”和底色分不开（对比度 ${contrast}）`)
    }
    must(widths.size === 1, `${where} 下三个按钮不一样宽：${[...widths].join('、')}`)
  }
  must(seen.popOpened && seen.popInside, '“外观”的小弹层没出来，或者伸到了窗口外面')
  must(seen.skinPicked === 'human', `在“外观”弹层里选“文艺”，皮肤没换上：${seen.skinPicked}`)
  must(seen.moreAt === 'look', `“更多外观设置”没有打开设置页的“外观”：${seen.moreAt}`)
  must(seen.popClosed, '点了“更多外观设置”之后弹层还开着')
  return failed
}
