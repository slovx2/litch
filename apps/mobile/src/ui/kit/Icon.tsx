// 手机端的图标：和桌面端（packages/ui/src/app/icons.tsx）同一套 16 像素网格的描边图标，
// 路径照桌面画，线宽、端点也照桌面（1.4、方头）。控件上不要再用 ▾ ▸ ⌃ ✕ ↑ ↗ ⋯ 一类文字符号冒充图标：
// 字体不同、皮肤不同时大小和位置都飘，读起来像乱码。状态、单选多选、待办的记号也是画的，见 marks.tsx。
import type { ReactNode } from 'react'
import {
  ActivityIndicator,
  Pressable,
  type StyleProp,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native'
import Svg, { Path } from 'react-native-svg'
import { useTheme } from '../theme'

/** 发送箭头：发送键和讨论抽屉的发送共用 */
const SEND = 'M8 13V3.5M4 7.5l4-4 4 4'

const PATHS = {
  /** 展开收起的箭头：朝下是开着；收着时转成朝右（Caret 负责转） */
  caret: 'M4 6l4 4 4-4',
  back: 'M9.5 3.5L5 8l4.5 4.5',
  /** 行尾“进去看”：朝右的尖角 */
  forward: 'M6.5 3.5L11 8l-4.5 4.5',
  up: 'M3.5 10l4.5-4.5 4.5 4.5',
  down: 'M3.5 6l4.5 4.5L12.5 6',
  send: SEND,
  /** 立即插入：拐进去的回车箭头，插进正在跑的回合；和发送的直箭头分得开 */
  steer: 'M12.5 3.5V8a1.5 1.5 0 0 1-1.5 1.5H4M6.5 7L4 9.5 6.5 12',
  /** 停止：一个方块 */
  stop: 'M4.5 4.5h7v7h-7z',
  close: 'M4 4l8 8M12 4l-8 8',
  check: 'M3.5 8.5l3 3 6-7',
  /** 筛选：漏斗 */
  filter: 'M2.5 3.5h11L9.5 8.5v4.5l-3-1.5v-3z',
  plus: 'M8 3.5v9M3.5 8h9',
  minus: 'M3.5 8h9',
  /** 更多：横着三个点（方头短线画成点） */
  more: 'M3.5 8h1M7.5 8h1M11.5 8h1',
  /** 讨论、批注：一个对话气泡 */
  note: 'M3 3.5h10v7H8l-3 2.5v-2.5H3z',
  /** 在别处打开：一个框，右上角伸出一支箭头 */
  external: 'M9 2.5h4.5V7M13.5 2.5L8 8M11.5 9.5v4h-9v-9h4',
  /** 重新取：没合上的圈，带一个回头的箭头 */
  reload: 'M12.5 8a4.5 4.5 0 1 1-1.4-3.2M12.5 3v2.5H10',
  /** 排序：一上一下两支箭头 */
  sort: 'M5 2.5v11M2.5 11L5 13.5 7.5 11M11 13.5v-11M8.5 5L11 2.5 13.5 5',
  /** 放大到全屏：两个角往外 */
  maximize: 'M9.5 2.5h4v4M13.5 2.5L9.5 6.5M6.5 13.5h-4v-4M2.5 13.5l4-4',
  /** 缩回半屏：两个角往里 */
  minimize: 'M13.5 2.5l-4 4M9.5 3.5v3h3M2.5 13.5l4-4M3.5 9.5h3v3',
  gear: 'M12.5 6.8L13.9 7.2L13.9 8.8L12.5 9.2L12.1 10.3L12.8 11.6L11.6 12.8L10.4 12.1L9.2 12.5L8.8 13.9L7.2 13.9L6.8 12.5L5.7 12.1L4.4 12.8L3.2 11.6L3.9 10.3L3.5 9.2L2.1 8.8L2.1 7.2L3.5 6.8L3.9 5.6L3.2 4.4L4.4 3.2L5.6 3.9L6.8 3.5L7.2 2.1L8.8 2.1L9.2 3.5L10.4 3.9L11.6 3.2L12.8 4.4L12.1 5.6zM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  pencil: 'M3 13l.6-2.6L10.4 3.6a1.4 1.4 0 0 1 2 2L5.6 12.4zM9.4 4.6l2 2',
  trash: 'M3.5 4.5h9M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5M7 7v4M9 7v4',
  folder: 'M2.5 4.5h4L8 6h5.5v6.5h-11z',
  /** 项目根目录：一座房子（文件页回到项目） */
  home: 'M2.5 7.5L8 3l5.5 4.5M4 6.3V13h8V6.3M6.5 13V9.5h3V13',
  file: 'M4.5 2.5H9l3 3v8H4.5zM9 2.5v3h3',
  copy: 'M5.5 5.5h7v7h-7zM3.5 10.5v-7h7',
  search: 'M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM10.3 10.3L13.5 13.5',
  clip: 'M12 7.5l-4.3 4.3a2.3 2.3 0 0 1-3.2-3.2l5-5a1.5 1.5 0 0 1 2.1 2.1L6.8 10.5',
  clock: 'M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM8 5v3l2 1.5',
  info: 'M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM8 7.5v3.5M8 5v.5',
  notice: 'M8 2.5l5.5 10.5h-11zM8 6.5v3M8 11.2v.3',
  machine: 'M2.5 3.5h11v7h-11zM5.5 13h5M8 10.5V13',
  /** 工作树、分支：一条主干岔出一枝 */
  branch:
    'M5 3.5v6M5 9.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM11 3.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM11 6.5c0 2.5-6 1.5-6 3',
  /** 提交：一根线穿过一个圈 */
  commit: 'M8 10.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM2 8h3.5M10.5 8H14',
  /** 事项清单：三行，每行前一个点 */
  list: 'M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.5M2.5 8h.5M2.5 12h.5',
  /** 建议任务：一盏灯泡 */
  suggest:
    'M6.3 13.5h3.4M8 2.5a3.8 3.8 0 0 0-2.2 6.9c.4.3.7.8.7 1.3v.8h3v-.8c0-.5.3-1 .7-1.3A3.8 3.8 0 0 0 8 2.5z',
  /** 键盘：一块板上几排键 */
  keyboard: 'M2 4.5h12v7H2zM4.5 7h1M7.5 7h1M10.5 7h1M5 9.5h6',
  /** 粘贴：一块写字板，顶上一个夹子 */
  paste: 'M5.5 3.5h-2v10h9v-10h-2M5.5 2.5h5v2h-5z',
  /** 显示隐藏的：一只眼睛 */
  eye: 'M2 8c1.6-2.7 3.6-4 6-4s4.4 1.3 6 4c-1.6 2.7-3.6 4-6 4s-4.4-1.3-6-4zM8 9.6a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2z',
  /** 键盘上的方向键（终端快捷键条） */
  left: 'M13 8H3.5M7 4.5L3.5 8 7 11.5',
  right: 'M3 8h9.5M9 4.5l3.5 3.5L9 11.5',
  arrowUp: 'M8 13V3.5M4.5 7L8 3.5 11.5 7',
  arrowDown: 'M8 3v9.5M4.5 9L8 12.5 11.5 9',
  /** 别的会话发来的话：一个信封 */
  mail: 'M2.5 4h11v8h-11zM2.5 4.5L8 9l5.5-4.5',
  /** 代答、转交：一来一回两支箭头 */
  swap: 'M3 5.5h9.5M10.5 3.5l2 2-2 2M13 10.5H3.5M5.5 8.5l-2 2 2 2',
  /** 停下待发：两道竖线 */
  pause: 'M6 4v8M10 4v8',
  play: 'M5.5 4l6 4-6 4z',
  download: 'M8 2v8M5 7l3 3 3-3M3 11v3h10v-3',
  /** 持续目标：靶心，两个同心圈 */
  target: 'M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  /** 拒绝了：圈里一道斜线 */
  ban: 'M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM4.2 4.2l7.6 7.6',
  /** 在这里做：往下再拐进来的箭头 */
  here: 'M4 3v5.5A1.5 1.5 0 0 0 5.5 10H12M9.5 7.5L12 10l-2.5 2.5',
} as const

export type IconName = keyof typeof PATHS

export function Icon({
  name,
  size = 18,
  color,
  rotate,
  weight = 1.4,
}: {
  name: IconName
  /** 画出来的边长；路径按 16 格缩放 */
  size?: number
  /** 不给是次一级的墨色 */
  color?: string
  rotate?: number
  /** 线宽（16 格里的单位）：控件一律 1.4；记号按皮肤加粗或减细 */
  weight?: number
}) {
  const { c } = useTheme()
  // 图标只是画，读屏读按钮的名称：外面这层 View 对读屏藏起来（Svg 在网页上会把读屏属性原样写进 DOM）
  return (
    <View
      aria-hidden
      pointerEvents="none"
      style={[
        { width: size, height: size },
        rotate ? { transform: [{ rotate: `${rotate}deg` }] } : null,
      ]}
    >
      <Svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        stroke={color ?? c.ink2}
        strokeWidth={weight}
        strokeLinecap="square"
        strokeLinejoin="miter"
      >
        <Path d={PATHS[name]} />
      </Svg>
    </View>
  )
}

/** 展开收起的箭头：开着朝下，收着朝右（同桌面的 Caret） */
export function Caret({
  open,
  size = 14,
  color,
}: {
  open: boolean
  size?: number
  color?: string
}) {
  const { c } = useTheme()
  return <Icon name="caret" size={size} color={color ?? c.ink3} rotate={open ? 0 : -90} />
}

/**
 * 只有图标的按钮：读屏名称必填；触控区至少 theme.hit 见方，图标本身小。
 * count 是图标旁的小数字（回复数之类），dot 是右上角的小点（有新内容、在等、有草稿）。
 */
export function IconButton({
  icon,
  label,
  onPress,
  disabled,
  busy,
  color,
  size,
  count,
  dot,
  expanded,
  selected,
  tone = 'plain',
  testID,
  style,
}: {
  icon: IconName
  label: string
  onPress(): void
  disabled?: boolean
  busy?: boolean
  color?: string
  size?: number
  count?: number | string
  dot?: string
  expanded?: boolean
  selected?: boolean
  /** plain 只有图标；solid 是实心的主要动作（发送） */
  tone?: 'plain' | 'solid'
  testID?: string
  style?: StyleProp<ViewStyle>
}) {
  const { c, hit, radius, font } = useTheme()
  const inactive = disabled || busy
  const solid = tone === 'solid'
  // 选中、展开时底色是 selBg，前景配 selFg（复古暗色的 selBg 是浅色，用 ink 会看不见）
  const ink = solid ? c.onAccent : (color ?? (selected || expanded ? c.selFg : c.ink2))
  return (
    <Pressable
      key={busy ? 'busy' : 'idle'}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{
        disabled: !!inactive,
        busy: !!busy,
        ...(expanded === undefined ? {} : { expanded }),
        ...(selected === undefined ? {} : { selected }),
      }}
      disabled={inactive}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.hit,
        { minHeight: hit, minWidth: hit, opacity: inactive ? 0.4 : pressed && solid ? 0.75 : 1 },
        style,
        pressed && !solid ? { backgroundColor: c.press, borderRadius: radius.s } : null,
      ]}
    >
      <View
        style={[
          styles.face,
          solid
            ? {
                backgroundColor: c.accentSolid,
                borderRadius: radius.m,
                width: hit - 10,
                height: hit - 10,
              }
            : null,
          selected || expanded ? { backgroundColor: c.selBg, borderRadius: radius.s } : null,
        ]}
      >
        {busy ? (
          <ActivityIndicator size="small" color={ink} />
        ) : (
          <Icon name={icon} size={size} color={ink} />
        )}
        {count !== undefined && count !== '' && count !== 0 ? (
          <Text style={[styles.count, { color: ink, fontSize: font.size.small + 1 }]}>{count}</Text>
        ) : null}
        {dot ? <View style={[styles.dot, { backgroundColor: dot }]} /> : null}
      </View>
    </Pressable>
  )
}

/** 收起展开的一行：箭头加标题，整行都能点（同桌面的 Fold）。right 放在行尾，不参与点击之外的事 */
export function Fold({
  open,
  onToggle,
  children,
  right,
  label,
  testID,
  style,
}: {
  open: boolean
  onToggle(): void
  children: ReactNode
  right?: ReactNode
  /** 读屏名称；不给就读里面的文字 */
  label?: string
  testID?: string
  style?: StyleProp<ViewStyle>
}) {
  const { c, hit } = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      aria-expanded={open}
      {...(label ? { accessibilityLabel: label } : {})}
      onPress={onToggle}
      testID={testID}
      style={({ pressed }) => [
        styles.fold,
        { minHeight: hit, backgroundColor: pressed ? c.press : 'transparent' },
        style,
      ]}
    >
      <Caret open={open} />
      <View style={styles.foldBody}>{children}</View>
      {right}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  hit: { alignItems: 'center', justifyContent: 'center' },
  face: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingHorizontal: 4,
    paddingVertical: 4,
  },
  count: { fontVariant: ['tabular-nums'], fontWeight: '600' },
  dot: { position: 'absolute', top: 1, right: 0, width: 7, height: 7, borderRadius: 4 },
  fold: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  foldBody: { flex: 1, minWidth: 0 },
})
