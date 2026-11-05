// 一个会话的页面内容：标题栏要用的字和按钮、对话区、请求卡片、输入区，以及菜单弹出的各张面板。
// 会话详情页（DetailScreen）和经理页的“对话”页签都用它，同一套组件（35-manager 17.9）。标题栏在首帧就是最终的样子（F1，标题从路由参数来，会话的名字到了再换）；
// 会话的数据只来自订阅（F2）。键盘：对话区和下面那一块（卡片加输入区）各包一层 KeyboardStickyView、用同一个偏移，
// 在 UI 线程上同一帧跟着键盘平移，两者之间的距离一直不变（原型的 sticky 方案，T3）。下面那一块变高（卡片来了、
// 输入框多了一行）时对话区跟着变矮，倒置列表的底就是偏移 0，内容贴着它走，不用 JS 追底。
import { type DeviceView, keys, type SessionSummary, type WorkspaceView } from '@litch/core'
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { type ReactNode, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { StyleSheet, Text, type TextInput, useWindowDimensions, View } from 'react-native'
import { KeyboardStickyView, useKeyboardState } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { whyNot } from '../../../../packages/ui/src/app/errors.ts'
import { readWhileOpen } from '../../../../packages/ui/src/app/read.ts'
import { acquireStore, releaseStore } from '../core/store-cache'
import { experiment } from '../experiment'
import type { RootStackParamList } from '../nav/routes'
import { useManagerOrigin } from '../screens/managers/use-origin'
import { ProposalsStrip } from '../screens/proposals/ProposalsStrip'
import { useSessionTask } from '../screens/tasks/session-task'
import { useChannel, useKey, useServices } from '../shell/services'
import { useT } from '../ui/i18n'
import { useKeyboardAccessoryHeight } from '../ui/kit/KeyboardForm'
import { Confirm, Prompt, Sheet, type SheetAction } from '../ui/kit/overlays'
import type { HeaderAction, HeaderLink } from '../ui/kit/Screen'
import { useTheme } from '../ui/theme'
import { Composer } from './Composer'
import { CommentOverlays } from './comments/CommentOverlays'
import { CommentsContext } from './comments/context'
import { CommentsHub } from './comments/hub'
import { SelectBar } from './comments/SelectBar'
import { draftKey } from './composer/drafts'
import type { IssueLinks } from './issue-links'
import { IssueLinksContext } from './issue-links-context'
import { ChildRequests, DelegatedHistory } from './requests/ChildRequests'
import { PendingQuestions } from './requests/PendingQuestions'
import { RequestSlot } from './requests/RequestSlot'
import { Transcript } from './Transcript'
import { compaction } from './usage/logic'
import { UsageSheet } from './usage/UsageSheet'
import { WorktreeSheet } from './worktree/WorktreeSheet'

/** 标题栏的高度（src/ui/kit/Screen.tsx） */
const HEADER = 52
/**
 * 至少容纳一行用户正文、气泡内外间距和底部留白。复制收进了长按菜单，气泡下面不再有那一排（36），
 * 时刻和交付状态在气泡左边
 */
const KEEP_TRANSCRIPT = 84

export interface SessionPage {
  title: string
  subtitle: string | undefined
  /** 工作线：副标题前半段“↰ 经理名”，点了回到经理 */
  subtitleLink: HeaderLink | undefined
  wire: string | undefined
  /** 标题栏右边：定时任务的时钟（有时）和“⋯” */
  actions: HeaderAction[]
  /** 对话区、请求卡片、输入区 */
  body: ReactNode
  /** 菜单、用量、工作树、改名、归档等弹出的面板，放在页面最外层 */
  overlays: ReactNode
}

export interface SessionPageOptions {
  deviceId: string
  sessionId: string
  /** 列表里那一行的标题，首帧就画出来（F1） */
  title?: string | undefined
  /** 经理会话：菜单不给终端、差异、文件、工作树、改名、归档、定时任务（经理不在自己的目录里干活，结束经理在桌面） */
  manager?: boolean
  /** 在看：对话区确实显示着。经理页切到别的页签时为 false，此时不标已读 */
  active?: boolean
  /** 标题栏以下、对话区以上另外占的高度（经理页的页签），算卡片最高多少时减掉 */
  above?: number
  /** 加在菜单最前面的几项 */
  menu?: SheetAction[]
  /** 正文里的看板编号链接（经理页给；工作线由 useManagerOrigin 自己找到它的经理） */
  issues?: IssueLinks | null
}

export function useSessionPage({
  deviceId,
  sessionId,
  title,
  manager = false,
  active = true,
  above = 0,
  menu: own = [],
  issues = null,
}: SessionPageOptions): SessionPage {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  const channel = useChannel()
  const t = useT()
  const insets = useSafeAreaInsets()
  const accessory = useKeyboardAccessoryHeight()
  const { height } = useWindowDimensions()
  const { c } = useTheme()
  const store = useMemo(
    () => acquireStore(channel, deviceId, sessionId),
    [channel, deviceId, sessionId],
  )
  useEffect(() => () => releaseStore(store), [store])
  const { replica } = useServices()
  useEffect(() => {
    if (active) return readWhileOpen(channel, replica.store, deviceId, sessionId)
  }, [active, channel, replica, deviceId, sessionId])
  // 选中回答加评论：对话区、菜单、输入框上的评论片共用一个（comments/hub.ts）
  const comments = useMemo(
    () => new CommentsHub(store, draftKey(deviceId, sessionId)),
    [store, deviceId, sessionId],
  )
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
  const [usageOpen, setUsageOpen] = useState(false)
  const [treeOpen, setTreeOpen] = useState(false)
  const input = useRef<TextInput>(null)

  // 卡片最高多少：屏幕减去状态栏、标题栏、键盘、输入区，再给对话区留一截
  const [composerHeight, setComposerHeight] = useState(0)
  const keyboard = useKeyboardState((state) => (state.isVisible ? state.height : 0))
  const lifted = keyboard > 0 ? keyboard - insets.bottom + accessory : 0
  const cardMax = Math.max(
    140,
    Math.min(
      height * 0.5,
      height - insets.top - HEADER - above - lifted - composerHeight - KEEP_TRANSCRIPT,
    ),
  )

  const cwd = meta?.cwd ?? summary?.cwd ?? null
  // 改名只经侧栏的摘要通知（会话订阅里没有改名的增量），所以摘要优先
  const shownTitle = summary
    ? t.text(summary.title)
    : meta
      ? t.text(meta.title)
      : (title ?? sessionId)
  // 在设备层工作树里的会话，副标题写分支（路径在“工作树”那一页里）
  const tree = summary?.worktree ?? null
  const place = tree
    ? t(tree.state === 'removed' ? 'session.worktree.removed' : 'session.worktree', {
        branch: tree.branch,
      })
    : cwd
  // 工作线：副标题前半段是回经理的链接，后半段只留 harness（目录在菜单、工作树里都有）
  const origin = useManagerOrigin(deviceId, sessionId, manager ? undefined : summary)
  const subtitle =
    [harness?.name ?? meta?.harness, origin ? null : place].filter(Boolean).join(' · ') || undefined
  const extra = [...(origin?.menu ?? []), ...own]
  const links = issues ?? origin?.issues ?? null
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
  // 手动压缩上下文（照桌面端）：harness 不会的不出；回合在跑时点了说一句为什么压不了
  const compact = compaction(meta?.live ? meta.can : undefined, meta?.running ?? false)
  const compactNow = () => {
    setFailure(null)
    if (compact.blocked) return setFailure(t(compact.blocked))
    channel
      .command('session.compact', { deviceId, sessionId })
      .catch((reason: unknown) =>
        setFailure(t('context.compactFailed', { reason: whyNot(reason, t) })),
      )
  }
  const actions = [
    ...extra,
    ...(cwd && !manager
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
    ...(filesRoot && !manager
      ? [
          {
            label: t('compose.menu.files'),
            testID: 'detail:menu:files',
            onPress: () => navigation.navigate('Files', { deviceId, root: filesRoot }),
          },
        ]
      : []),
    ...(tree && !manager
      ? [
          {
            label: t('worktree.title'),
            testID: 'detail:menu:worktree',
            onPress: () => setTreeOpen(true),
          },
        ]
      : []),
    ...(device?.sessionTree
      ? [
          {
            label: t('proposals.menu'),
            testID: 'detail:menu:proposals',
            onPress: () =>
              navigation.navigate('Proposals', { deviceId, sessionId, title: shownTitle }),
          },
        ]
      : []),
    {
      label: t('side.tab.background'),
      testID: 'detail:menu:background',
      onPress: () => navigation.navigate('Background', { deviceId, sessionId, title: shownTitle }),
    },
    {
      label: t('usage.menu'),
      testID: 'detail:menu:usage',
      onPress: () => setUsageOpen(true),
    },
    ...(compact.shown
      ? [{ label: t('context.compact'), testID: 'detail:menu:compact', onPress: compactNow }]
      : []),
    ...(manager || abilities?.rename === false
      ? []
      : [
          {
            label: t('session.rename'),
            testID: 'detail:menu:rename',
            onPress: () => setRenaming(true),
          },
        ]),
    ...(tasksAvailable && !manager
      ? [
          {
            label: t('tasks.forSession'),
            testID: 'detail:menu:task',
            onPress: () => navigation.navigate('TaskEdit', { deviceId, sessionId }),
          },
        ]
      : []),
    ...(manager || abilities?.archive === false
      ? []
      : [
          {
            label: t('session.archive'),
            testID: 'detail:menu:archive',
            onPress: () => setArchiving(true),
          },
        ]),
  ]

  const task = useSessionTask(deviceId, summary?.task)
  const markers = experiment.markers
  const error = snapshot.error ?? failure
  return {
    title: shownTitle,
    subtitle,
    subtitleLink: origin?.link,
    wire: device ? c.wire[device.wire] : undefined,
    actions: [
      // 定时任务跑出来的会话：顶栏上一个时钟，不另占一行
      ...(task
        ? [
            {
              label: '⏱',
              accessibilityLabel: task.label,
              testID: 'detail:task',
              onPress: task.open,
            },
          ]
        : []),
      {
        label: '⋯',
        testID: 'detail:menu',
        onPress: () => setMenu(true),
      },
    ],
    // 键盘升起时整块往上平移，移出去的那一截裁在标题栏下沿，不压到状态栏上
    body: (
      <IssueLinksContext.Provider value={links}>
        <View style={styles.clip}>
          <DelegatedHistory deviceId={deviceId} sessionId={sessionId} />
          {device?.sessionTree ? (
            <ProposalsStrip deviceId={deviceId} sessionId={sessionId} title={shownTitle} />
          ) : null}
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
            <KeyboardStickyView
              offset={{ closed: 0, opened: insets.bottom - accessory }}
              style={styles.list}
            >
              <CommentsContext.Provider value={comments}>
                <Transcript store={store} bottomOffset={insets.bottom} markers={markers} />
              </CommentsContext.Provider>
            </KeyboardStickyView>
          ) : (
            <View style={styles.list}>
              <CommentsContext.Provider value={comments}>
                <Transcript store={store} bottomOffset={insets.bottom} markers={markers} />
              </CommentsContext.Provider>
            </View>
          )}
          <KeyboardStickyView offset={{ closed: 0, opened: insets.bottom - accessory }}>
            <SelectBar hub={comments} />
            <RequestSlot
              store={store}
              maxHeight={(meta?.pendingQuestions.length ?? 0) > 0 ? cardMax / 2 : cardMax}
              onRevise={revise}
            />
            <ChildRequests
              deviceId={deviceId}
              sessionId={sessionId}
              onOpen={(id) => navigation.push('Detail', { deviceId, sessionId: id })}
            />
            <PendingQuestions
              store={store}
              maxHeight={
                (meta?.requests.length ?? 0) > 0 ||
                (meta?.settings.mode === 'plan' && meta.planTurn)
                  ? cardMax / 2
                  : cardMax
              }
            />
            <View
              style={{ paddingBottom: insets.bottom, backgroundColor: c.panel }}
              onLayout={(event) => setComposerHeight(event.nativeEvent.layout.height)}
            >
              <CommentsContext.Provider value={comments}>
                <Composer
                  store={store}
                  markers={markers}
                  inputRef={input}
                  onUsage={() => setUsageOpen(true)}
                />
              </CommentsContext.Provider>
            </View>
          </KeyboardStickyView>
        </View>
      </IssueLinksContext.Provider>
    ),
    overlays: (
      <>
        <CommentOverlays hub={comments} />
        <Sheet visible={menu} title={shownTitle} actions={actions} onClose={() => setMenu(false)} />
        <UsageSheet
          visible={usageOpen}
          deviceId={deviceId}
          harness={meta?.harness}
          usage={meta?.usage}
          compact={
            compact.shown
              ? { blocked: compact.blocked ? t(compact.blocked) : null, run: compactNow }
              : null
          }
          onClose={() => setUsageOpen(false)}
        />
        {tree ? (
          <WorktreeSheet
            visible={treeOpen}
            deviceId={deviceId}
            worktree={tree}
            onTerminal={() => navigation.navigate('Terminal', { deviceId, root: cwd ?? tree.path })}
            onClose={() => setTreeOpen(false)}
          />
        ) : null}
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
      </>
    ),
  }
}

const styles = StyleSheet.create({
  clip: { flex: 1, overflow: 'hidden' },
  list: { flex: 1 },
  error: { paddingHorizontal: 16, paddingVertical: 8, fontSize: 13 },
})
