// 设置页验收的第二段：回合正在跑的时候换皮肤、换明暗、换密度（设计文档 02 第 2.10 节的验收要点）。
// 换皮肤会换字体和行高，对话的内容高度跟着变：贴在底部的要仍然贴底，没贴底的要停在原来那条消息上，回合照常往下走。
// 量法和对话区“不飘”的验收（probe-scroll.mts）是一套：逐帧取样，只取会被画到屏幕上的状态。
import type { SettingsKit } from './probe-settings-kit.mjs'

export interface TurnSeen {
  /** 贴在底部时换了一圈外观：内容底边到视口底边的距离最多差了多少像素（应为 0）、这期间内容高度变过几种 */
  followSpread: number
  followHeights: number
  /** 这期间回答一直在长（回合没被打断）：字数长了多少、结束时是不是还在出字 */
  followGrew: number
  followStillLive: boolean
  /** 没贴底时换了一圈外观：视口里最靠上的那条消息在屏幕上最多挪了多少像素（应为 0） */
  freeSpread: number
  freeHeights: number
  freeGrew: number
  /** 换完之后盯着的还是原来那一条，而且它还在视口里 */
  freeKept: boolean
  /** 没盯住的时候是哪一种：元素没了、标识变了、还是出了视口 */
  freeWhy: string
  /** 没贴底时“回到底部”一直在 */
  toBottomStayed: boolean
  /** 回合最后正常收尾了（不再出字，回答的字数比换外观之前多） */
  finished: boolean
}

export async function turnSeen(title: string, other: string): Promise<TurnSeen> {
  const kit = (window as unknown as { __setKit: SettingsKit }).__setKit
  const { until, one, frame, sleep } = kit
  const scroller = () => one('.tr-scroll') as HTMLElement
  const content = () => one('.tr') as HTMLElement
  const live = () => one('.md.live')
  const gap = () =>
    content().getBoundingClientRect().bottom - scroller().getBoundingClientRect().bottom
  const spread = (values: number[]) =>
    values.length > 0 ? Math.max(...values) - Math.min(...values) : -1
  /**
   * 逐帧取样。内容的高度刚变、应用自己的补偿还没执行的那一瞬间，脚本读得到但不会上屏，不能算数：
   * 高度变化之后的样本改在尺寸回调里取（这个观察器建得比应用的晚，回调排在它后面）
   */
  const track = (read: () => number) => {
    const values: number[] = []
    const heights = new Set<number>()
    const tall = () => content().getBoundingClientRect().height
    let height = tall()
    const observer = new ResizeObserver(() => {
      height = tall()
      heights.add(Math.round(height))
      values.push(read())
    })
    observer.observe(content())
    return {
      values,
      heights,
      sample() {
        if (tall() === height) values.push(read())
      },
      stop: () => observer.disconnect(),
    }
  }
  /** 换一圈外观：三种皮肤、深浅、三档密度，每换一样连着取一会儿样。最后换回原来的 */
  const before = kit.look.get()
  const tour = async (sample: () => void) => {
    const stops: Parameters<SettingsKit['look']['set']>[0][] = [
      { skin: 'human' },
      { theme: 'dark' },
      { skin: 'standard' },
      { density: 'roomy' },
      { theme: 'light' },
      { skin: 'retro', density: 'compact' },
      { skin: before.skin, theme: before.theme, density: before.density },
    ]
    for (const patch of stops) {
      kit.look.set(patch)
      // 新皮肤的字体是这时候才去取的，到了之后还要再排一次版：取样要把这一下也盖进去
      const end = performance.now() + 450
      while (performance.now() < end) {
        await frame()
        sample()
      }
    }
  }
  /** 打开那个一打开就在流的会话，等它开始出字。先点开别的再点回来，它会重新流一遍 */
  const openStreaming = async () => {
    await kit.openSession(other)
    await until('另一个会话不在出字', () => !live())
    await kit.openSession(title)
    await until('回答开始输出', live)
  }
  const answer = () => [...document.querySelectorAll('.md')].at(-1)?.textContent?.length ?? 0

  // ---- 一、贴在底部 ----
  await openStreaming()
  one<HTMLButtonElement>('.to-bottom')?.click()
  await frame()
  const followStart = answer()
  const follow = track(gap)
  await tour(follow.sample)
  follow.stop()
  const followStillLive = Boolean(live())
  const followGrew = answer() - followStart

  // ---- 二、没贴底：往上滚一截，盯住视口里最靠上的那条 ----
  await openStreaming()
  one<HTMLButtonElement>('.to-bottom')?.click()
  await frame()
  scroller().scrollTop = -260
  await frame()
  await frame()
  const top = scroller().getBoundingClientRect().top
  // 视口里最靠上的那一条：还没完全滚出上边缘的头一条（应用盯的也是它）
  const held = [...content().querySelectorAll<HTMLElement>('[data-anchor]')].find(
    (element) => element.getBoundingClientRect().bottom > top,
  )
  if (!held) throw new Error('没贴底的时候视口里找不到一条消息')
  const anchor = held.dataset.anchor
  const freeStart = answer()
  let box = held.getBoundingClientRect()
  const free = track(() => {
    box = held.getBoundingClientRect()
    return box.top
  })
  let toBottomStayed = Boolean(one('.to-bottom'))
  await tour(() => {
    free.sample()
    if (!one('.to-bottom')) toBottomStayed = false
  })
  free.stop()
  const freeGrew = answer() - freeStart
  // 位置用最后一次有效取样时的：换完一圈的这一刻可能正赶上内容刚长、应用的补偿还没执行（不会上屏），
  // 这时读到的消息被顶上去了一截，和取样时排除的是同一种时刻
  const view = scroller().getBoundingClientRect()
  const freeKept =
    held.isConnected &&
    held.dataset.anchor === anchor &&
    box.bottom > view.top &&
    box.top < view.bottom
  const freeWhy = freeKept
    ? ''
    : !held.isConnected
      ? `那条消息的元素不在页面上了（同标识的还在：${Boolean(content().querySelector(`[data-anchor="${CSS.escape(anchor ?? '')}"]`))}）`
      : held.dataset.anchor !== anchor
        ? `元素的标识从 ${anchor} 变成了 ${held.dataset.anchor}`
        : `出了视口：消息 ${Math.round(box.top)}–${Math.round(box.bottom)}，视口 ${Math.round(view.top)}–${Math.round(view.bottom)}`

  // ---- 回合照常收尾 ----
  const finished = await kit.seen(() => !live(), 60_000)
  await sleep(100)
  return {
    followSpread: spread(follow.values),
    followHeights: follow.heights.size,
    followGrew,
    followStillLive,
    freeSpread: spread(free.values),
    freeHeights: free.heights.size,
    freeGrew,
    freeKept,
    freeWhy,
    toBottomStayed,
    finished: finished && answer() > freeStart,
  }
}

export interface PersistSeen {
  /** 重新加载之后根元素上的样子、语言、页面的像素比是原来的几倍、设置页里各排标着的是哪一档 */
  root: string
  ratio: number
  marked: string
  saved: string
}

/** 重新加载之后看一眼外观还在不在。base：缩放是 100% 时页面的像素比 */
export async function persistSeen(base: number): Promise<PersistSeen> {
  const kit = (window as unknown as { __setKit: SettingsKit }).__setKit
  const { one } = kit
  const root = document.documentElement
  await kit.openSettings('look')
  const pressed = (name: string) =>
    one(`[data-choice="${name}"] [aria-pressed="true"]`)?.dataset.value ?? ''
  const look = [
    one('[data-skin-card][aria-checked="true"]')?.dataset.skinCard ?? '',
    pressed('theme'),
    pressed('density'),
    pressed('zoom'),
  ]
  await kit.openSettings('lang')
  look.push(pressed('lang'))
  return {
    root: [
      root.dataset.skin ?? '',
      root.dataset.theme ?? 'system',
      root.dataset.density ?? '',
      root.lang,
    ].join('/'),
    ratio: Math.round((window.devicePixelRatio / base) * 1000) / 1000,
    marked: look.join('/'),
    saved: localStorage.getItem('litch.appearance') ?? '',
  }
}

/** 把外观换成这一份，等缩放落定（缩放要经外壳走一趟）。返回现在页面的像素比 */
export async function lookSet(
  patch: Record<string, string | number>,
  base: number,
): Promise<number> {
  const kit = (window as unknown as { __setKit: SettingsKit }).__setKit
  kit.look.set(patch)
  const zoom = kit.look.get().zoom
  await kit.until(
    `缩放变成 ${zoom}（换之前像素比 ${window.devicePixelRatio}，100% 时是 ${base}）`,
    () => Math.abs(window.devicePixelRatio / base - zoom) < 0.01,
  )
  await kit.settled()
  return window.devicePixelRatio
}

/** 页面里面现在多大（样式的像素）、像素比多少 */
export function innerSize(): { width: number; height: number; ratio: number } {
  return { width: window.innerWidth, height: window.innerHeight, ratio: window.devicePixelRatio }
}

/** 等页面收到新的窗口大小（主进程刚改的）。等不到不报错，后面量的时候自己会说 */
export async function sizedTo(width: number, height: number): Promise<boolean> {
  const kit = (window as unknown as { __setKit: SettingsKit }).__setKit
  return kit.seen(
    () => Math.abs(window.innerWidth - width) <= 1 && Math.abs(window.innerHeight - height) <= 1,
    8000,
  )
}

/** 应用菜单里点了缩放的一项之后：等页面缩放到界面记着的那一档，返回现在是几倍 */
export async function zoomNow(base: number): Promise<number> {
  const kit = (window as unknown as { __setKit: SettingsKit }).__setKit
  // 菜单那一下要经外壳转给界面、界面再报回外壳：先等界面记着的档位变过来
  await kit.sleep(120)
  const zoom = kit.look.get().zoom
  await kit.seen(() => Math.abs(window.devicePixelRatio / base - zoom) < 0.01, 5000)
  return Math.round((window.devicePixelRatio / base) * 1000) / 1000
}

/** 点开这个会话。量终端之前用：有请求等着的会话会把终端面板压矮，两档缩放要在同一个会话上量 */
export async function sessionOpen(title: string): Promise<boolean> {
  const kit = (window as unknown as { __setKit: SettingsKit }).__setKit
  await kit.openSession(title)
  await kit.settled()
  return true
}

/** 把设置页开到这一组（给截图用） */
export async function showSection(section: string): Promise<boolean> {
  const kit = (window as unknown as { __setKit: SettingsKit }).__setKit
  await kit.openSettings(section)
  await kit.settled()
  return true
}
