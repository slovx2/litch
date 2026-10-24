// 侧栏验收里“框”那一半量到的东西，哪些算不合格。在主进程里跑。
import type { FrameSeen, KeysSeen } from './probe-sidebar-frame.mjs'
import type { HideSeen, ReloadSeen } from './probe-sidebar-hide.mjs'

export interface FrameChecks {
  /** 一开始，什么都没动过 */
  start: FrameSeen
  /** 依次想拖到 360、2000、0、360：各拖成了多宽 */
  dragged: number[]
  afterDrag: FrameSeen
  keys: KeysSeen
  hide: HideSeen
  /** 应用菜单里有“侧栏”那一项；点一下收起，再点展开 */
  menuFound: boolean
  menuClosed: boolean
  menuOpened: boolean
  /** 窗口缩到允许的最窄；再放回原来的大小 */
  narrow: FrameSeen
  restored: FrameSeen
  /**
   * 窗口 1100 宽、右边的侧面板开着：侧栏 300 宽时、拖到最宽时、收起来时，右边那一块各是怎么分的。
   * 侧栏一变，侧面板要跟着重新算自己画多宽
   */
  beside: { slim: FrameSeen; wide: FrameSeen; hidden: FrameSeen }
  reload: ReloadSeen
  /** 窗口允许的最小宽度 */
  minWidth: number
}

// 和 packages/ui/src/sidebar/state.ts 里的数是一回事：这里照着规矩另算一遍，两头对得上才算对
const LEAST = 240
const MOST = 480
const REST = 600
const limitOf = (inner: number) => Math.max(LEAST, Math.min(MOST, inner - REST))
const drawnOf = (wanted: number, inner: number) => Math.min(Math.max(wanted, LEAST), limitOf(inner))

export function judgeFrame(seen: FrameChecks): string[] {
  const failed: string[] = []
  const must = (ok: boolean, what: string) => {
    if (!ok) failed.push(what)
  }
  /** 侧栏开着的时候：画出来的宽度对、和右边那一块正好占满窗口、拖动条报的数对、没有东西伸出窗口 */
  const laid = (frame: FrameSeen, wanted: number, what: string) => {
    const width = drawnOf(wanted, frame.inner)
    must(
      frame.open && frame.sidebar === width && frame.sidebar + frame.body === frame.inner,
      `${what}：侧栏该是 ${width} 宽、和右边那一块占满 ${frame.inner}，量到侧栏 ${frame.sidebar}、右边 ${frame.body}`,
    )
    must(
      frame.grip === `${width}/${LEAST}/${limitOf(frame.inner)}`,
      `${what}：拖动条报给读屏的宽度不对（现在/最窄/最宽）：${frame.grip}`,
    )
    must(frame.overflow === 0, `${what}：有东西伸到窗口外面去了 ${frame.overflow} 像素`)
  }

  laid(seen.start, 300, '一开始')
  must(
    seen.start.pressed === 'true' && !seen.start.newShown,
    `侧栏开着的时候标题栏不对（开关按着没有 ${seen.start.pressed}，“新对话”在不在 ${seen.start.newShown}）`,
  )
  const wide = limitOf(seen.start.inner)
  must(
    seen.dragged.join() === [360, wide, LEAST, 360].join(),
    `拖右边沿调宽度不对（想拖到 360、拖过头、拖到底、再拖到 360）：${seen.dragged.join()}`,
  )
  laid(seen.afterDrag, 360, '拖到 360 之后')
  must(
    seen.afterDrag.saved ===
      JSON.stringify({
        open: true,
        width: 360,
        harnesses: [],
        nativeChildren: false,
        showActive: true,
        bands: {},
        folds: {},
      }),
    `拖出来的宽度没有记下来：${seen.afterDrag.saved}`,
  )
  must(
    seen.keys.widths.join() === '360,384,408,384',
    `用方向键调宽度不对（右、右、左）：${seen.keys.widths.join()}`,
  )
  must(seen.keys.role === 'separator/vertical/0', `拖动条不是键盘走得到的分隔条：${seen.keys.role}`)
  must(seen.keys.rowsKept, '调宽度的时候侧栏里的会话行被整个重画了')

  const hide = seen.hide
  must(hide.closedByKey, '按 Cmd/Ctrl+Shift+B 没有收起侧栏')
  must(hide.filled && hide.gripGone, '侧栏收起之后右边那一块没有占满窗口，或者拖动条还在')
  must(
    hide.pressed === 'false' && hide.newShown,
    `侧栏收着的时候标题栏不对（开关按着没有 ${hide.pressed}，“新对话”在不在 ${hide.newShown}）`,
  )
  must(
    hide.leftClosed === hide.leftOpen &&
      (hide.shell !== 'electron' || hide.platform !== 'mac' || hide.leftClosed >= 78) &&
      // 别的系统上窗口按钮不在页面里：不该白白空出那一块
      (hide.platform === 'mac' || hide.leftClosed < 40),
    `标题栏最左边的东西压到了系统的窗口按钮上，或者跟着侧栏挪了（开着 ${hide.leftOpen}，收着 ${hide.leftClosed}）`,
  )
  must(hide.newByKey, '侧栏收着的时候按 Cmd/Ctrl+N 没有到新建对话页')
  must(hide.openedFromComposer, '焦点在输入框里按 Cmd/Ctrl+Shift+B 没有展开侧栏')
  must(
    hide.widthBack === hide.widthBefore && hide.widthBefore === 360,
    `侧栏展开回来宽度变了：${hide.widthBefore} → ${hide.widthBack}`,
  )
  must(hide.foldKept, '侧栏收起再展开，里面原来收着的项目被展开了')
  must(hide.closedByButton, '点标题栏的开关没有收起侧栏')
  must(hide.newByButton, '侧栏收着的时候点标题栏的“新对话”没有到新建对话页')
  must(hide.openedByButton, '再点标题栏的开关没有展开侧栏，或者“新对话”没收掉')
  must(
    hide.savedClosed ===
      JSON.stringify({
        open: false,
        width: 360,
        harnesses: [],
        nativeChildren: false,
        showActive: true,
        bands: {},
        // 前面收起过的那一项也记着（重启后照旧）
        folds: { nas: { closed: ['bk'], folded: [] } },
      }),
    `侧栏收起没有记下来：${hide.savedClosed}`,
  )
  must(seen.menuFound, '应用菜单里没有“侧栏”那一项')
  must(seen.menuClosed && seen.menuOpened, '点应用菜单里的“侧栏”没有收起、展开侧栏')

  must(
    seen.narrow.inner <= seen.minWidth,
    `窗口没有缩到最窄（${seen.minWidth}）：${seen.narrow.inner}`,
  )
  laid(seen.narrow, 360, '最窄的窗口里')
  must(seen.narrow.body >= REST, `最窄的窗口里右边那一块被侧栏挤得太窄：${seen.narrow.body}`)
  laid(seen.restored, 360, '窗口放回原来的大小')

  const { slim, wide: widest, hidden } = seen.beside
  const whole = (frame: FrameSeen) => frame.sidebar + frame.main + frame.side === frame.inner
  laid(slim, 300, '窗口 1100、侧面板开着、侧栏 300')
  must(
    whole(slim) && slim.sideMode === 'docked' && slim.main >= 380,
    `窗口 1100、侧栏 300 的时候右边分得不对（对话 ${slim.main}、侧面板 ${slim.side} ${slim.sideMode}）`,
  )
  laid(widest, 2000, '窗口 1100、侧面板开着、侧栏拖到最宽')
  must(
    whole(widest) && widest.sideMode === 'tight' && widest.main >= 320 && widest.side >= 280,
    `侧栏拖宽之后侧面板没有跟着让（对话 ${widest.main}、侧面板 ${widest.side} ${widest.sideMode}）`,
  )
  must(
    !hidden.open &&
      hidden.body === hidden.inner &&
      whole(hidden) &&
      hidden.sideMode === 'docked' &&
      hidden.side > widest.side,
    `侧栏收起之后侧面板没有跟着放宽（对话 ${hidden.main}、侧面板 ${hidden.side} ${hidden.sideMode}）`,
  )

  must(seen.reload.closedAtStart && seen.reload.newShown, '应用重开之后侧栏没有照上次的样子收着')
  must(seen.reload.width === 360, `应用重开之后侧栏不是上次拖出来的宽度：${seen.reload.width}`)
  return failed
}
