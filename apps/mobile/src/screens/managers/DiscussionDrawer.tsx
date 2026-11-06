// 控制台帖子讨论的底部抽屉：卡片上只留讨论入口，点开先占半屏，拖把手或点按钮到全屏，往下拖收回或关掉。
// 内容和桌面看板底部的讨论分屏一致：标题（点了回到卡片）、按时间排的问答、追问输入。草稿和提交仍在卡片组件里。
// 对话里点 #D-n 拉起的半屏议题卡（IssueSheet）也用它：标题和 ↗ 是“在控制台打开”，内容不自动滚到底。
import { type ReactNode, useRef, useState } from 'react'
import {
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native'
import type { KeyboardAwareScrollViewRef } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ModalConsentHost } from '../../privacy/ConsentPresentation'
import { useT } from '../../ui/i18n'
import { KeyboardFormScrollView } from '../../ui/kit/KeyboardForm'
import { ModalKeyboardArea } from '../../ui/kit/ModalKeyboardArea'
import { useTheme } from '../../ui/theme'

/** 拖过这么远才换档，免得点把手时误触 */
const SNAP = 40

export function DiscussionDrawer({
  visible,
  id,
  title,
  onClose,
  onBack,
  children,
  footer,
  backLabel,
  open,
  stickToEnd = true,
  testID = `discussion-drawer:${id}`,
}: {
  visible: boolean
  id: string
  title: string
  onClose(): void
  onBack(): void
  /** 问答记录：在中间滚 */
  children: ReactNode
  /** 追问输入：固定在底部 */
  footer?: ReactNode
  /** 标题的读屏名称前半句；不给是“回到卡片” */
  backLabel?: string
  /** 标题行多一个 ↗ 图标（半屏议题卡的“在控制台打开”） */
  open?: { label: string; onPress(): void }
  /** 内容变高时滚到底（讨论是最新在下面）；半屏议题卡从头看 */
  stickToEnd?: boolean
  testID?: string
}) {
  const t = useT()
  const theme = useTheme()
  const { c, font, hit, radius } = theme
  const insets = useSafeAreaInsets()
  const { height } = useWindowDimensions()
  const [full, setFull] = useState(false)
  const [drag, setDrag] = useState(0)
  const scroll = useRef<KeyboardAwareScrollViewRef>(null)
  // 手势回调只建一次，读最新的档位和关闭函数用 ref
  const state = useRef({ full, onClose })
  state.current = { full, onClose }
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 4,
      onPanResponderMove: (_, g) => setDrag(g.dy),
      onPanResponderRelease: (_, g) => {
        setDrag(0)
        if (g.dy < -SNAP) setFull(true)
        else if (g.dy > SNAP) {
          if (state.current.full) setFull(false)
          else state.current.onClose()
        }
      },
      onPanResponderTerminate: () => setDrag(0),
    }),
  ).current
  const max = height - insets.top - 8
  const sheet = Math.max(160, Math.min(max, (full ? max : Math.round(height * 0.55)) - drag))
  const close = () => {
    setFull(false)
    onClose()
  }
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <ModalKeyboardArea style={styles.bottom}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('manager.discussionClose')}
          style={StyleSheet.absoluteFill}
          onPress={close}
          testID="discussion-drawer:scrim"
        />
        <View
          testID={testID}
          style={[
            styles.sheet,
            {
              height: sheet,
              backgroundColor: c.panel,
              borderColor: c.line3,
              borderTopLeftRadius: radius.l,
              borderTopRightRadius: radius.l,
              paddingBottom: insets.bottom,
            },
          ]}
        >
          <View {...pan.panHandlers} style={styles.grip} testID="discussion-drawer:grip">
            <View style={[styles.bar, { backgroundColor: c.line3 }]} />
          </View>
          <View style={[styles.head, { borderBottomColor: c.line1 }]}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${backLabel ?? t('manager.discussionBack')} · ${id} ${title}`}
              onPress={() => {
                setFull(false)
                onBack()
              }}
              style={[styles.title, { minHeight: hit }]}
            >
              <Text
                numberOfLines={1}
                style={{ color: c.ink, fontWeight: '600', fontSize: font.size.body }}
              >
                <Text style={{ color: c.ink3 }}>{id}</Text> {title}
              </Text>
            </Pressable>
            {open ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={open.label}
                testID={`${testID}:open`}
                onPress={() => {
                  setFull(false)
                  open.onPress()
                }}
                style={[styles.icon, { minHeight: hit, minWidth: hit }]}
              >
                <Text style={{ color: c.ink2, fontSize: font.size.body }}>↗</Text>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t(full ? 'mgr.discussion.half' : 'mgr.discussion.full')}
              testID="discussion-drawer:size"
              onPress={() => setFull(!full)}
              style={[styles.icon, { minHeight: hit, minWidth: hit }]}
            >
              <Text style={{ color: c.ink2, fontSize: font.size.body }}>{full ? '⌄' : '⌃'}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('manager.discussionClose')}
              testID="discussion-drawer:close"
              onPress={close}
              style={[styles.icon, { minHeight: hit, minWidth: hit }]}
            >
              <Text style={{ color: c.ink2, fontSize: font.size.body }}>✕</Text>
            </Pressable>
          </View>
          <KeyboardFormScrollView
            ref={scroll}
            style={styles.fill}
            contentContainerStyle={styles.body}
            keyboardShouldPersistTaps="handled"
            // 问答按时间排，最新在下面：打开或来了新问答时滚到底
            onContentSizeChange={() => {
              if (stickToEnd) scroll.current?.scrollToEnd({ animated: false })
            }}
          >
            {children}
          </KeyboardFormScrollView>
          {footer ? <View style={[styles.foot, { borderTopColor: c.line1 }]}>{footer}</View> : null}
        </View>
      </ModalKeyboardArea>
      <ModalConsentHost active={visible} />
    </Modal>
  )
}

const styles = StyleSheet.create({
  bottom: { justifyContent: 'flex-end' },
  sheet: { maxHeight: '100%', borderWidth: 1, borderBottomWidth: 0, overflow: 'hidden' },
  grip: { alignItems: 'center', paddingVertical: 8 },
  bar: { width: 36, height: 4, borderRadius: 2 },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { flex: 1, justifyContent: 'center' },
  icon: { justifyContent: 'center', alignItems: 'center' },
  fill: { flex: 1 },
  body: { padding: 12, gap: 12 },
  foot: { padding: 8, borderTopWidth: StyleSheet.hairlineWidth },
})
