// 会话详情：标题栏、对话区、请求卡片、输入区。标题栏在首帧就是最终的样子（F1，标题从路由参数来，会话的名字到了再换）；
// 会话的数据只来自订阅（F2）。键盘：对话区和下面那一块（卡片加输入区）各包一层 KeyboardStickyView、用同一个偏移，
// 在 UI 线程上同一帧跟着键盘平移，两者之间的距离一直不变（原型的 sticky 方案，T3）。下面那一块变高（卡片来了、
// 输入框多了一行）时对话区跟着变矮，倒置列表的底就是偏移 0，内容贴着它走，不用 JS 追底。
import { type DeviceView, keys, type SessionSummary, type WorkspaceView } from '@litch/core'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { StyleSheet, Text, type TextInput, useWindowDimensions, View } from 'react-native'
import { KeyboardStickyView, useKeyboardState } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { whyNot } from '../../../../packages/ui/src/app/errors.ts'
import { acquireStore, releaseStore } from '../core/store-cache'
import { experiment } from '../experiment'
import type { RootStackParamList } from '../nav/routes'
import { SessionTaskStrip } from '../screens/tasks/SessionTaskStrip'
import { useChannel, useKey } from '../shell/services'
import { useT } from '../ui/i18n'
import { Confirm, Prompt, Sheet } from '../ui/kit/overlays'
import { Screen } from '../ui/kit/Screen'
import { useTheme } from '../ui/theme'
import { Composer } from './Composer'
import { RequestSlot } from './requests/RequestSlot'
import { Transcript } from './Transcript'

type Props = NativeStackScreenProps<RootStackParamList, 'Detail'>

/** 标题栏的高度（src/ui/kit/Screen.tsx） */
const HEADER = 52
/** 卡片再高也给对话区留这么多 */
const KEEP_TRANSCRIPT = 72

export function DetailScreen({ route, navigation }: Props) {
  const { deviceId, sessionId, title } = route.params
  const channel = useChannel()
  const t = useT()
  const insets = useSafeAreaInsets()
  const { height } = useWindowDimensions()
  const { c } = useTheme()
  const store = useMemo(
    () => acquireStore(channel, deviceId, sessionId),
    [channel, deviceId, sessionId],
  )
  useEffect(() => () => releaseStore(store), [store])
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const meta = useSyncExternalStore(store.subscribeMeta, store.getMeta)
  const device = useKey<DeviceView>(keys.device(deviceId))
  const summary = useKey<SessionSummary>(keys.summary(deviceId, sessionId))
  const workspaces = useKey<WorkspaceView[]>(keys.workspaces(deviceId))
  const harness = device?.harnesses.find((entry) => entry.id === meta?.harness)
  const abilities = harness?.abilities
  const tasksAvailable = useKey<boolean | null>(keys.tasksAvailable(deviceId))

  const [menu, setMenu] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const input = useRef<TextInput>(null)

  // 卡片最高多少：屏幕减去状态栏、标题栏、键盘、输入区，再给对话区留一截
  const [composerHeight, setComposerHeight] = useState(0)
  const keyboard = useKeyboardState((state) => (state.isVisible ? state.height : 0))
  const lifted = keyboard > 0 ? keyboard - insets.bottom : 0
  const cardMax = Math.max(
    140,
    Math.min(
      height * 0.5,
      height - insets.top - HEADER - lifted - composerHeight - KEEP_TRANSCRIPT,
    ),
  )

  const cwd = meta?.cwd ?? summary?.cwd ?? null
  // 改名只经侧栏的摘要通知（会话订阅里没有改名的增量），所以摘要优先
  const shownTitle = summary
    ? t.text(summary.title)
    : meta
      ? t.text(meta.title)
      : (title ?? sessionId)
  const subtitle = [harness?.name ?? meta?.harness, cwd].filter(Boolean).join(' · ') || undefined
  // 文件页开在会话所在工作区的根上（会话的工作目录可能是它下面的一层）；不属于工作区的开在工作目录上
  const workspace = workspaces?.find((entry) => entry.id === summary?.workspaceId)
  const filesRoot = workspace?.roots[0] ?? cwd

  // 输入框还拿着焦点、只是键盘被收起时 focus() 什么都不做：先放掉焦点再拿，键盘才会出来
  const revise = () => {
    const field = input.current
    if (field?.isFocused()) field.blur()
    requestAnimationFrame(() => input.current?.focus())
  }
  const run = (work: Promise<unknown>, after?: () => void) => {
    setFailure(null)
    work.then(after, (reason: unknown) => setFailure(whyNot(reason, t)))
  }
  const actions = [
    ...(cwd
      ? [
          {
            label: t('compose.menu.terminal'),
            testID: 'detail:menu:terminal',
            onPress: () => navigation.navigate('Terminal', { deviceId, root: cwd }),
          },
          {
            label: t('compose.menu.diff'),
            testID: 'detail:menu:diff',
            onPress: () =>
              navigation.navigate('Diff', { deviceId, root: cwd, scope: 'all', sessionId }),
          },
        ]
      : []),
    ...(filesRoot
      ? [
          {
            label: t('compose.menu.files'),
            testID: 'detail:menu:files',
            onPress: () => navigation.navigate('Files', { deviceId, root: filesRoot }),
          },
        ]
      : []),
    ...(abilities?.rename === false
      ? []
      : [
          {
            label: t('session.rename'),
            testID: 'detail:menu:rename',
            onPress: () => setRenaming(true),
          },
        ]),
    ...(tasksAvailable
      ? [
          {
            label: t('timed.forSession'),
            testID: 'detail:menu:task',
            onPress: () => navigation.navigate('TaskEdit', { deviceId, sessionId }),
          },
        ]
      : []),
    ...(abilities?.archive === false
      ? []
      : [
          {
            label: t('session.archive'),
            testID: 'detail:menu:archive',
            onPress: () => setArchiving(true),
          },
        ]),
  ]

  const markers = experiment.markers
  const error = snapshot.error ?? failure
  return (
    <Screen
      title={shownTitle}
      subtitle={subtitle}
      wire={device ? c.wire[device.wire] : undefined}
      actions={[{ label: '⋯', testID: 'detail:menu', onPress: () => setMenu(true) }]}
      testID="detail"
    >
      {/* 键盘升起时整块往上平移，移出去的那一截裁在标题栏下沿，不压到状态栏上 */}
      <View style={styles.clip}>
        <SessionTaskStrip deviceId={deviceId} mark={summary?.task} />
        {error ? (
          <Text
            testID="detail:error"
            style={[styles.error, { color: c.err, backgroundColor: c.raised }]}
            numberOfLines={2}
          >
            {error}
          </Text>
        ) : null}
        {experiment.keyboard === 'sticky' ? (
          // 顶上移出去的那一截藏到标题栏后面（标题栏压在上面）
          <KeyboardStickyView offset={{ closed: 0, opened: insets.bottom }} style={styles.list}>
            <Transcript store={store} bottomOffset={insets.bottom} markers={markers} />
          </KeyboardStickyView>
        ) : (
          <View style={styles.list}>
            <Transcript store={store} bottomOffset={insets.bottom} markers={markers} />
          </View>
        )}
        <KeyboardStickyView offset={{ closed: 0, opened: insets.bottom }}>
          <RequestSlot store={store} maxHeight={cardMax} onRevise={revise} />
          <View
            style={{ paddingBottom: insets.bottom, backgroundColor: c.panel }}
            onLayout={(event) => setComposerHeight(event.nativeEvent.layout.height)}
          >
            <Composer store={store} markers={markers} inputRef={input} />
          </View>
        </KeyboardStickyView>
      </View>
      <Sheet visible={menu} title={shownTitle} actions={actions} onClose={() => setMenu(false)} />
      <Prompt
        visible={renaming}
        title={t('session.rename')}
        initial={shownTitle}
        submitLabel={t('session.rename')}
        onSubmit={(name) =>
          run(channel.command('session.rename', { deviceId, sessionId, title: name }))
        }
        onClose={() => setRenaming(false)}
      />
      <Confirm
        visible={archiving}
        title={t('compose.archive.title')}
        detail={t('compose.archive.note')}
        confirmLabel={t('session.archive')}
        onConfirm={() =>
          run(channel.command('session.archive', { deviceId, sessionId }), () =>
            navigation.goBack(),
          )
        }
        onClose={() => setArchiving(false)}
      />
    </Screen>
  )
}

const styles = StyleSheet.create({
  clip: { flex: 1, overflow: 'hidden' },
  list: { flex: 1 },
  error: { paddingHorizontal: 16, paddingVertical: 8, fontSize: 13 },
})
