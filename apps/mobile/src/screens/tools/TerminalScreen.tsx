// 终端页：一个终端占满屏幕，下面是补键的输入条。标题是终端的名字，副标题是它开在哪个目录。
// 标题栏右边“终端（N）”列出这台设备上的终端（切换、接回留在设备上的、新开），“更多”里是改名、清屏、关闭。
// 终端归核心管（device/terminals.mts）：这一页只发命令、订阅列表（replica 的 keys.terminal*）和一个终端的输出（TerminalView）。
// 页面可以转成横屏（别的页面锁竖屏，见 Navigator 的默认选项）；转屏、键盘弹起收起时页面里的 xterm 重新量行列数，变了告诉对面。
import {
  type DeviceView,
  keys,
  type TerminalGroups,
  type TerminalInfo,
  type WorkspaceView,
} from '@litch/core'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { KeyboardAvoidingView, useKeyboardState } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { RootStackParamList } from '../../nav/routes'
import { useKey, useReplica, useServices } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Button, Empty } from '../../ui/kit/controls'
import { Prompt, Sheet, type SheetAction } from '../../ui/kit/overlays'
import { useTheme } from '../../ui/theme'
import { Frame } from './terminal/Frame'
import { KeyBar } from './terminal/KeyBar'
import { termTheme } from './terminal/look'
import {
  groupIds,
  nextAfterClose,
  pickExisting,
  stateWord,
  terminalName,
  workspaceOf,
} from './terminal/pick'
import { type TerminalHandle, TerminalView } from './terminal/TerminalView'
import { reasonOf } from './tool-errors'
import { termStats } from './tool-flags'

type Props = NativeStackScreenProps<RootStackParamList, 'Terminal'>

const RESIZE_DELAY_MS = 60

export function TerminalScreen({ route, navigation }: Props) {
  const { deviceId, root } = route.params
  const { channel } = useServices()
  const replica = useReplica()
  const theme = useTheme()
  const t = useT()
  const insets = useSafeAreaInsets()
  const keyboardShown = useKeyboardState((state) => state.isVisible)

  // 这一页可以横过来
  useLayoutEffect(() => navigation.setOptions({ orientation: 'all' }), [navigation])

  const device = useKey<DeviceView>(keys.device(deviceId))
  const online = device?.connection === 'online'
  const workspaces = useKey<WorkspaceView[]>(keys.workspaces(deviceId))
  const workspaceId = workspaceOf(workspaces, root)
  const groups = useKey<TerminalGroups>(keys.terminalGroups(deviceId))
  const stowed = useKey<TerminalGroups>(keys.terminalStowed(deviceId))

  const [current, setCurrent] = useState<string | null>(route.params.terminalId ?? null)
  const info = useKey<TerminalInfo>(current ? keys.terminal(deviceId, current) : 'terminals:none')
  const [size, setSize] = useState<{ rows: number; cols: number } | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [ctrl, setCtrl] = useState(false)
  const [focused, setFocused] = useState(false)
  // 输入条上的键盘键只在“焦点在终端上、系统键盘也真的弹着”时算开：对话框关掉之后焦点会回到终端，键盘却不弹
  const keyboardOn = focused && keyboardShown
  const [sheet, setSheet] = useState<'list' | 'more' | 'close' | null>(null)
  const [renaming, setRenaming] = useState(false)
  const view = useRef<TerminalHandle>(null)
  const opening = useRef(false)
  const infoOf = useCallback(
    (id: string) => replica.store.get<TerminalInfo>(keys.terminal(deviceId, id)),
    [replica, deviceId],
  )

  const open = useCallback(async () => {
    if (!size || opening.current) return
    opening.current = true
    setFailure(null)
    try {
      const { terminalId } = await channel.command('terminal.open', {
        deviceId,
        workspaceId,
        cwd: root,
        rows: size.rows,
        cols: size.cols,
      })
      setCurrent(terminalId)
    } catch (error) {
      setFailure(t('terminal.failed.open', { reason: reasonOf(error, t) }))
    } finally {
      opening.current = false
    }
  }, [channel, deviceId, workspaceId, root, size, t])

  // 没指定看哪个：同一个目录里还活着的接着用，没有就新开一个。等页面量出行列数、列表到了、设备连上再决定
  const decided = useRef(current !== null)
  useEffect(() => {
    if (decided.current || !size || !groups || !online) return
    decided.current = true
    const existing = pickExisting(groupIds(groups, workspaceId), infoOf, root)
    if (existing) setCurrent(existing)
    else void open()
  }, [size, groups, online, workspaceId, root, infoOf, open])

  // 页面的行列数和对面的不一样就告诉对面（转屏、键盘弹起收起、别处改过）。连着变只发最后一次
  const told = useRef<string | null>(null)
  useEffect(() => {
    if (!current || !size || info?.state !== 'running') return
    if (info.rows === size.rows && info.cols === size.cols) {
      told.current = `${current}:${size.rows}x${size.cols}`
      return
    }
    const want = `${current}:${size.rows}x${size.cols}`
    if (told.current === want) return
    const timer = setTimeout(() => {
      told.current = want
      channel.command('terminal.resize', { deviceId, terminalId: current, ...size }).catch(() => {})
    }, RESIZE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [channel, deviceId, current, size, info?.state, info?.rows, info?.cols])

  const running = info?.state === 'running'
  const look = useMemo(() => termTheme(theme), [theme])
  const onSize = useCallback((rows: number, cols: number) => setSize({ rows, cols }), [])
  const onCtrlUsed = useCallback(() => setCtrl(false), [])
  const send = (input: Parameters<TerminalHandle['send']>[0]) => view.current?.send(input)

  const restart = () => {
    if (!current || !size) return
    setFailure(null)
    channel
      .command('terminal.restart', { deviceId, terminalId: current, ...size })
      .catch((error: unknown) =>
        setFailure(t('terminal.failed.restart', { reason: reasonOf(error, t) })),
      )
  }

  const close = (mode: 'end' | 'leave') => {
    if (!current) return
    const closing = current
    const next = nextAfterClose(groupIds(groups, workspaceId), closing)
    channel
      .command('terminal.close', { deviceId, terminalId: closing, mode })
      .then(() => {
        if (next) setCurrent(next)
        else navigation.goBack()
      })
      .catch((error: unknown) =>
        setFailure(t('terminal.failed.close', { reason: reasonOf(error, t) })),
      )
  }

  const attach = (terminalId: string) => {
    channel
      .command('terminal.show', { deviceId, terminalId })
      .then(() => setCurrent(terminalId))
      .catch((error: unknown) =>
        setFailure(t('terminal.failed.show', { reason: reasonOf(error, t) })),
      )
  }

  // 列表：这台设备上开成标签的终端（这一组在前），留在设备上的可以接回，最后是新开
  const listActions = (): SheetAction[] => {
    const mine = groupIds(groups, workspaceId)
    const others = Object.entries(groups ?? {})
      .filter(([group]) => group !== (workspaceId ?? ''))
      .flatMap(([, ids]) => ids)
    const actions: SheetAction[] = [...mine, ...others].map((id) => {
      const one = infoOf(id)
      const name = terminalName(one, t)
      const state = one ? stateWord(one, t) : ''
      return {
        label: t(id === current ? 'tools.term.itemHere' : 'tools.term.item', { name, state }),
        testID: `terminal:pick:${id}`,
        onPress: () => setCurrent(id),
      }
    })
    for (const id of Object.values(stowed ?? {}).flat()) {
      actions.push({
        label: t('tools.term.attach', { name: terminalName(infoOf(id), t) }),
        testID: `terminal:attach:${id}`,
        onPress: () => attach(id),
      })
    }
    actions.push({ label: t('terminal.new'), testID: 'terminal:new', onPress: () => void open() })
    return actions
  }

  const moreActions: SheetAction[] = [
    { label: t('terminal.new'), testID: 'terminal:more:new', onPress: () => void open() },
    ...(info
      ? [
          {
            label: t('terminal.rename'),
            testID: 'terminal:rename',
            onPress: () => setRenaming(true),
          },
          {
            label: t('terminal.clear'),
            testID: 'terminal:clear',
            onPress: () => send({ t: 'clear' }),
          },
          {
            label: t('terminal.close', { name: terminalName(info, t) }),
            testID: 'terminal:close',
            danger: true,
            onPress: () => setSheet('close'),
          },
        ]
      : []),
  ]

  const closeActions: SheetAction[] = [
    ...(info?.durable && running
      ? [
          {
            label: t('terminal.close.leave'),
            testID: 'terminal:close:leave',
            onPress: () => close('leave'),
          },
        ]
      : []),
    {
      label: t('terminal.close.end'),
      testID: 'terminal:close:end',
      danger: true,
      onPress: () => close('end'),
    },
  ]

  const count = Object.values(groups ?? {}).reduce((sum, ids) => sum + ids.length, 0)

  return (
    <Frame
      title={info ? terminalName(info, t) : t('terminal.panel')}
      subtitle={info?.cwd ?? root ?? undefined}
      wire={device ? theme.c.wire[device.wire] : undefined}
      actions={[
        {
          label: t('tools.term.list', { n: count }),
          testID: 'terminal:list',
          onPress: () => setSheet('list'),
        },
        { label: '⋯', testID: 'terminal:more', onPress: () => setSheet('more') },
      ]}
    >
      <KeyboardAvoidingView behavior="padding" automaticOffset style={styles.body}>
        <View style={styles.term}>
          <TerminalView
            ref={view}
            deviceId={deviceId}
            terminalId={current}
            running={running}
            theme={look}
            gapText={t('terminal.gap', { size: '{size}' })}
            rejoinedText={t('terminal.gap.rejoined', { size: '{size}' })}
            onSize={onSize}
            onCtrlUsed={onCtrlUsed}
            onKeyboard={setFocused}
            stats={termStats.on}
          />
          <StatusStrip
            info={info}
            hasTerminal={current !== null}
            online={online}
            failure={failure}
            onRestart={restart}
            onRetry={() => void open()}
          />
        </View>
        <KeyBar
          ctrl={ctrl}
          keyboard={keyboardOn}
          disabled={!running}
          bottom={keyboardShown ? 0 : insets.bottom}
          onKey={(k) => send({ t: 'key', k })}
          onText={(d) => send({ t: 'text', d })}
          onCtrl={() => {
            const on = !ctrl
            setCtrl(on)
            send({ t: 'ctrl', on })
          }}
          onKeyboard={() => send(keyboardOn ? { t: 'blur' } : { t: 'focus' })}
        />
      </KeyboardAvoidingView>
      <Sheet
        visible={sheet === 'list'}
        title={t('tools.term.pick')}
        actions={sheet === 'list' ? listActions() : []}
        onClose={() => setSheet(null)}
      />
      <Sheet visible={sheet === 'more'} actions={moreActions} onClose={() => setSheet(null)} />
      <Sheet
        visible={sheet === 'close'}
        title={running ? t('terminal.close.running', { name: terminalName(info, t) }) : undefined}
        actions={closeActions}
        onClose={() => setSheet(null)}
      />
      <Prompt
        visible={renaming}
        title={t('terminal.renameLabel')}
        initial={info?.title ?? ''}
        placeholder={terminalName(info, t)}
        submitLabel={t('terminal.rename')}
        onSubmit={(title) => {
          if (current)
            channel
              .command('terminal.rename', { deviceId, terminalId: current, title })
              .catch(() => {})
        }}
        onClose={() => setRenaming(false)}
      />
    </Frame>
  )
}

/** 终端没在跑、还没开起来、开不成的时候盖在终端底部的一条：是怎么回事，能不能重开 */
function StatusStrip({
  info,
  hasTerminal,
  online,
  failure,
  onRestart,
  onRetry,
}: {
  info: TerminalInfo | undefined
  hasTerminal: boolean
  online: boolean
  failure: string | null
  onRestart(): void
  onRetry(): void
}) {
  const theme = useTheme()
  const t = useT()
  const { c } = theme
  let text: string | null = null
  let action: { label: string; onPress(): void } | null = null
  if (failure) {
    text = failure
    if (!hasTerminal && online) action = { label: t('tools.term.retry'), onPress: onRetry }
  } else if (!hasTerminal) {
    if (!online) {
      return (
        <View style={[styles.cover, { backgroundColor: c.win }]} testID="terminal:offline">
          <Empty title={t('terminal.offline')} />
        </View>
      )
    }
    text = t('tools.term.opening')
  } else if (info && info.state !== 'running') {
    text =
      info.state === 'starting'
        ? t('terminal.state.starting')
        : info.state === 'away'
          ? t('terminal.state.away')
          : info.state === 'exited'
            ? info.exitCode === null
              ? t('terminal.state.exitedNoCode')
              : t('terminal.state.exited', { code: info.exitCode })
            : t(info.durable ? 'terminal.state.lostDurable' : 'terminal.state.lostEphemeral')
    if ((info.state === 'exited' || info.state === 'lost') && online) {
      action = { label: t('terminal.restart'), onPress: onRestart }
    }
  }
  if (!text) return null
  return (
    <View
      style={[styles.strip, { backgroundColor: c.panel, borderTopColor: c.line2 }]}
      testID="terminal:status"
    >
      <Text style={[styles.stripText, { color: c.ink2, fontSize: theme.font.size.meta }]}>
        {text}
      </Text>
      {action ? <Button kind="plain" label={action.label} onPress={action.onPress} /> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  body: { flex: 1 },
  term: { flex: 1 },
  strip: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  stripText: { flex: 1 },
  cover: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'center' },
})
