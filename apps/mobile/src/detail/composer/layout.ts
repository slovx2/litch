// 输入区那一排（＋、输入框、发送/停止圆键）的尺寸。单拿出来是为了单测守住一条：三者一样高、上下边对齐。
// 高度只有一个来源——输入框（一行时 minHeight，内容或占位文字折行后自己长高，到 maxHeight）；
// 一排按 stretch 排，两边按钮跟着拉到同一高度，只给 minHeight、不给固定 height。
// 安卓多行输入框的高度连占位文字一起量：回合进行中那句占位文字在窄屏上折成两行，输入框就变高，
// 以前按钮钉死 40、整排靠底对齐，就上下错开了
import type { TextStyle, ViewStyle } from 'react-native'

/** 一行的高度：行高 22 + 上下内边距 8 + 描边 1，和两边按钮的最小高度相同 */
export const ROW_MIN = 40
const LINE = 22
const PAD_Y = 8
const BORDER = 1
/** 发送、停止的圆键直径 */
export const SEND = 36

export const rowLayout: {
  row: ViewStyle
  side: ViewStyle
  input: TextStyle
  send: ViewStyle
  sendDot: ViewStyle
} = {
  row: {
    flexDirection: 'row',
    flexWrap: 'nowrap',
    alignItems: 'stretch',
    gap: 8,
    paddingHorizontal: 12,
    paddingBottom: 8,
  },
  side: {
    width: 40,
    minHeight: ROW_MIN,
    borderWidth: BORDER,
    alignItems: 'center',
    justifyContent: 'center',
  },
  input: {
    flex: 1,
    minHeight: ROW_MIN,
    maxHeight: 132,
    borderWidth: BORDER,
    paddingHorizontal: 10,
    paddingVertical: PAD_Y,
    lineHeight: LINE,
    textAlignVertical: 'top',
  },
  // 发送键这一格：随一排拉高，里面 36 的圆键贴底（底边和一行的输入框居中对齐）
  send: {
    width: 36,
    minHeight: ROW_MIN,
    justifyContent: 'flex-end',
    paddingBottom: (ROW_MIN - SEND) / 2,
  },
  sendDot: {
    width: SEND,
    height: SEND,
    borderRadius: SEND / 2,
    borderWidth: BORDER,
    alignItems: 'center',
    justifyContent: 'center',
  },
}

/** 一行文字的输入框正好 ROW_MIN 高（单测对这个数） */
export const ONE_LINE = LINE + PAD_Y * 2 + BORDER * 2
