// 记号：会话和设备的状态、单选多选、待办的一步。全部是画的，不用文字符号：字体一换，大小和基线就飘，
// ☑ ⏱ 一类在 iOS 上还会变成彩色表情。三种皮肤的区别照桌面端（packages/ui 的 .st 记号，base.css 加各皮肤覆盖），
// 风格靠形状的角、线的粗细和颜色体现：
// - 标准：实心方块（运行中）、菱形（等人）、圆点（未读）、叉（出错）、空心方块（后台）、空心圈（离线）
// - 人文：圆环、圆角菱形、朱砂圆点、细叉、双圈、一道短横；线细、角圆
// - 复古：直角、线粗；运行中是终端里的光标块，后台是两层叠着的方框（桌面复古写 ? * ! & 字符，手机不用字符）
// 空闲不画（同桌面），只占位置。
import type { ReactNode } from 'react'
import { Animated, View } from 'react-native'
import Svg, { Circle, Path, Rect } from 'react-native-svg'
import { type Palette, type Skin, type StatusKind, useTheme } from '../theme'
import { useBreath } from './breath'

const DIAMOND = 'M7 2.6L11.4 7 7 11.4 2.6 7z'

/** 状态记号的颜色：所有皮肤一样，靠皮肤自己的调色板区分 */
export function statusColor(status: StatusKind, c: Palette): string {
  return {
    idle: c.ink3,
    running: c.accent,
    waiting: c.wait,
    error: c.err,
    unread: c.seal,
    offline: c.ink3,
    background: c.accent,
  }[status]
}

/** 14 格里画一个状态；空闲返回 null */
function statusShape(status: StatusKind, skin: Skin, color: string): ReactNode {
  const cross = (width: number, round: boolean) => (
    <Path
      d="M3.8 3.8l6.4 6.4M10.2 3.8l-6.4 6.4"
      stroke={color}
      strokeWidth={width}
      strokeLinecap={round ? 'round' : 'square'}
    />
  )
  if (status === 'idle') return null
  if (skin === 'retro') {
    switch (status) {
      case 'running':
        return <Rect x={4.5} y={1.5} width={5} height={11} fill={color} />
      case 'waiting':
        return <Path d={DIAMOND} fill={color} />
      case 'unread':
        return <Rect x={4} y={4} width={6} height={6} fill={color} />
      case 'error':
        return cross(2.2, false)
      case 'offline':
        return <Rect x={3.75} y={3.75} width={6.5} height={6.5} stroke={color} strokeWidth={1.5} />
      case 'background':
        return (
          <Path d="M2.75 5.25h6v6h-6zM5.25 5.25V2.75h6v6h-2.5" stroke={color} strokeWidth={1.5} />
        )
    }
  }
  if (skin === 'human') {
    switch (status) {
      case 'running':
        return <Circle cx={7} cy={7} r={4} stroke={color} strokeWidth={1.5} />
      case 'waiting':
        return (
          <Path d={DIAMOND} fill={color} stroke={color} strokeWidth={1.2} strokeLinejoin="round" />
        )
      case 'unread':
        return <Circle cx={7} cy={7} r={3.4} fill={color} />
      case 'error':
        return cross(1.4, true)
      case 'offline':
        return <Path d="M3.5 7h7" stroke={color} strokeWidth={1.6} strokeLinecap="round" />
      case 'background':
        return (
          <>
            <Circle cx={7} cy={7} r={5} stroke={color} strokeWidth={1.2} />
            <Circle cx={7} cy={7} r={2} stroke={color} strokeWidth={1.2} />
          </>
        )
    }
  }
  switch (status) {
    case 'running':
      return <Rect x={3.5} y={3.5} width={7} height={7} rx={1} fill={color} />
    case 'waiting':
      return <Path d={DIAMOND} fill={color} />
    case 'unread':
      return <Circle cx={7} cy={7} r={3.2} fill={color} />
    case 'error':
      return cross(1.7, false)
    case 'offline':
      return <Circle cx={7} cy={7} r={3.6} stroke={color} strokeWidth={1.3} />
    case 'background':
      return <Rect x={3.75} y={3.75} width={6.5} height={6.5} stroke={color} strokeWidth={1.5} />
  }
}

/** 只画形状，不呼吸（待办“在做”、页签之类不跟运行节奏走的地方） */
export function StatusShape({
  status,
  size = 14,
  color,
}: {
  status: StatusKind
  size?: number
  color?: string
}) {
  const { c, skin } = useTheme()
  const shape = statusShape(status, skin, color ?? statusColor(status, c))
  return (
    <View aria-hidden pointerEvents="none" style={{ width: size, height: size }}>
      {shape ? (
        <Svg width={size} height={size} viewBox="0 0 14 14" fill="none">
          {shape}
        </Svg>
      ) : null}
    </View>
  )
}

/**
 * 状态记号：形状区分状态（不只靠颜色），形状跟皮肤走。运行中、后台慢呼吸（只改透明度），
 * 读屏不念记号，状态由行的名称或旁边的文字说
 */
export function StatusMark({ status, size = 16 }: { status: StatusKind; size?: number }) {
  const opacity = useBreath(status !== 'running' && status !== 'background')
  return (
    <Animated.View
      testID={`mark:${status}`}
      aria-hidden
      pointerEvents="none"
      style={{ width: 16, alignItems: 'center', justifyContent: 'center', opacity }}
    >
      <StatusShape status={status} size={size} />
    </Animated.View>
  )
}

/**
 * 单选、多选的记号：单选是圈，多选是框（各皮肤都守这个约定）；复古直角、线粗，单选的心是方块；
 * 人文线细、框角圆。选中的多选框填满，里面一道勾
 */
export function ChoiceMark({
  kind,
  state,
  color,
  size = 16,
}: {
  kind: 'radio' | 'check'
  state: 'on' | 'off' | 'mixed'
  /** 不给：选中用强调色，没选用三级墨色 */
  color?: string
  size?: number
}) {
  const { c, skin } = useTheme()
  const ink = color ?? (state === 'off' ? c.ink3 : c.accent)
  const width = skin === 'retro' ? 1.6 : skin === 'human' ? 1.2 : 1.4
  const bar = <Path d="M5 8h6" stroke={kind === 'check' ? c.panel : ink} strokeWidth={1.6} />
  let body: ReactNode
  if (kind === 'radio') {
    const dot =
      skin === 'retro' ? (
        <Rect x={5.5} y={5.5} width={5} height={5} fill={ink} />
      ) : (
        <Circle cx={8} cy={8} r={3} fill={ink} />
      )
    body = (
      <>
        <Circle cx={8} cy={8} r={6} stroke={ink} strokeWidth={width} />
        {state === 'on' ? dot : state === 'mixed' ? bar : null}
      </>
    )
  } else {
    const rx = skin === 'retro' ? 0 : skin === 'human' ? 3.5 : 2
    const filled = state !== 'off'
    body = (
      <>
        <Rect
          x={2.5}
          y={2.5}
          width={11}
          height={11}
          rx={rx}
          stroke={ink}
          strokeWidth={width}
          fill={filled ? ink : 'none'}
        />
        {state === 'on' ? (
          <Path
            d="M5 8.2l2.1 2.1L11 6"
            stroke={c.panel}
            strokeWidth={1.6}
            strokeLinecap={skin === 'human' ? 'round' : 'square'}
          />
        ) : state === 'mixed' ? (
          bar
        ) : null}
      </>
    )
  }
  return (
    <View aria-hidden pointerEvents="none" style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox="0 0 16 16" fill="none">
        {body}
      </Svg>
    </View>
  )
}

/** 待办一步：没做是空心（复古方、另两种圆），在做用运行中的形状（不呼吸），做完是一道勾 */
export function TodoMark({
  state,
  size = 14,
}: {
  state: 'pending' | 'inProgress' | 'completed'
  size?: number
}) {
  const { c, skin } = useTheme()
  if (state === 'inProgress') return <StatusShape status="running" size={size} />
  const shape =
    state === 'completed' ? (
      <Path
        d="M3 7.4l2.6 2.6L11 4.4"
        stroke={c.ok}
        strokeWidth={skin === 'retro' ? 2 : skin === 'human' ? 1.4 : 1.6}
        strokeLinecap={skin === 'human' ? 'round' : 'square'}
      />
    ) : skin === 'retro' ? (
      <Rect x={3.25} y={3.25} width={7.5} height={7.5} stroke={c.ink3} strokeWidth={1.5} />
    ) : (
      <Circle cx={7} cy={7} r={4} stroke={c.ink3} strokeWidth={skin === 'human' ? 1.2 : 1.4} />
    )
  return (
    <View aria-hidden pointerEvents="none" style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox="0 0 14 14" fill="none">
        {shape}
      </Svg>
    </View>
  )
}

/** 让里面的图标随运行节奏慢呼吸（和状态记号同一个钟）；active 为假时完整不透明 */
export function Breathe({ active, children }: { active: boolean; children: ReactNode }) {
  const opacity = useBreath(!active)
  return <Animated.View style={{ opacity }}>{children}</Animated.View>
}
