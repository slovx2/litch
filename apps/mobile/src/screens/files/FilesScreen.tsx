// 文件：同设备选定的根下面展开目录树，文件只读打开。
// 路由参数带着 path，对话区的文件引用直接跳到这里；根外链接由核心核实并返回临时根，
// 带着 line 的打开后定位到那一行。path 不知道是目录还是文件时先读一次（对面说是目录就改成列这一层），根就是目录。
// 路径都由核心核对：必须在根之内，对面不提供文件访问时说明白（files.unsupported 这类话由核心给）。
import {
  baseName,
  type DeviceView,
  type DirectoryView,
  type FileContent,
  type FileLinkResolution,
  type FileLinkTarget,
  fileBrowserKey,
  fileBrowserLink,
  fileBrowserRoot,
  keys,
  normalizePath,
  observeFileChanges,
  parentPath,
  setFileBrowserRoot,
  unrecognizedFileLink,
} from '@litch/core'
import { useIsFocused } from '@react-navigation/native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { reasonOf } from '../../../../../packages/ui/src/app/errors.ts'
import type { RootStackParamList } from '../../nav/routes'
import { useChannel, useKey, useReplica } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Button, Empty } from '../../ui/kit/controls'
import { IconButton } from '../../ui/kit/Icon'
import { Dialog } from '../../ui/kit/overlays'
import { Screen } from '../../ui/kit/Screen'
import { PathPicker } from '../../ui/PathPicker'
import { useTheme } from '../../ui/theme'
import { FileLinkReport } from './FileLinkReport'
import { FileTreeView } from './FileTreeView'
import { FileView } from './FileView'

type Props = NativeStackScreenProps<RootStackParamList, 'Files'>

type Loaded =
  | { kind: 'loading' }
  | { kind: 'dir'; view: DirectoryView }
  | { kind: 'file'; content: FileContent }
  | { kind: 'failed'; reason: string }
  | { kind: 'link'; result: FileLinkResolution }

export function FilesScreen({ navigation, route }: Props) {
  const { deviceId, line } = route.params
  const requestKey = JSON.stringify(route.params)
  const [selection, setSelection] = useState<{ key: string; target: FileLinkTarget } | null>(null)
  const target = selection?.key === requestKey ? selection.target : null
  const setTarget = useCallback(
    (target: FileLinkTarget) => setSelection({ key: requestKey, target }),
    [requestKey],
  )
  const browserKey = fileBrowserKey(deviceId, route.params.sessionId, route.params.workspaceId)
  const defaultRoot = normalizePath(route.params.defaultRoot ?? route.params.root)
  const root =
    target?.root ??
    normalizePath(
      !route.params.path && !route.params.ref && !route.params.browsing
        ? (fileBrowserRoot(browserKey, defaultRoot) ?? defaultRoot)
        : route.params.root,
    )
  const path = target?.path ?? normalizePath(route.params.path ?? root)
  const device = useKey<DeviceView>(keys.device(deviceId))
  const t = useT()
  const theme = useTheme()
  const [locationOpen, setLocationOpen] = useState(false)
  const [locationError, setLocationError] = useState('')
  const locating = useRef<AbortController | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: 换根或换设备时撤销尚未完成的旧导航。
  useEffect(() => () => locating.current?.abort(), [deviceId, root])
  const linkPath = target?.linkPath ?? route.params.linkPath ?? fileBrowserLink(browserKey)
  const [locationWidth, setLocationWidth] = useState(0)
  const pathChars = Math.max(8, Math.floor(locationWidth / (theme.font.size.small * 0.65)))
  const shownRoot =
    locationWidth && root.length > pathChars ? `…${root.slice(1 - pathChars)}` : root
  useEffect(() => {
    if (root) setFileBrowserRoot(browserKey, root, target?.linkPath ?? route.params.linkPath)
  }, [browserKey, root, target?.linkPath, route.params.linkPath])
  const channel = useChannel()
  const focused = useIsFocused()
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' })
  const { files } = useReplica()
  const showHidden = useKey<boolean>(keys.filesShowHidden) ?? false
  const [attempt, setAttempt] = useState(0)
  const [resolution, setResolution] = useState<FileLinkResolution | null>(null)

  const list = useCallback(
    (fresh: boolean) => channel.command('files.list', { deviceId, root, path, fresh }),
    [channel, deviceId, root, path],
  )

  // attempt 变了就是点了“重试”
  // biome-ignore lint/correctness/useExhaustiveDependencies: 见上
  useEffect(() => {
    if (!focused) return
    let live = true
    let generation = 0
    let close = () => {}
    setLoaded({ kind: 'loading' })
    const failed = (error: unknown) => {
      if (live) setLoaded({ kind: 'failed', reason: reasonOf(error, t) })
    }
    const asDir = () =>
      list(attempt > 0).then((view) => live && setLoaded({ kind: 'dir', view }), failed)
    if (route.params.unrecognized) {
      setLoaded({ kind: 'link', result: unrecognizedFileLink(route.params.href ?? '') })
    } else if (route.params.ref && !target) {
      channel
        .command('files.resolve', {
          deviceId,
          root,
          ref: route.params.ref,
          href: route.params.href ?? path,
        })
        .then((result) => {
          if (!live) return
          setResolution(result)
          const found = result.candidates[0]
          if (result.status === 'ready' && found) setTarget(found)
          else setLoaded({ kind: 'link', result })
        }, failed)
    } else if (route.params.path && !target) {
      void channel.command('files.target', { deviceId, root, path }).then((found) => {
        if (live) setTarget(found)
      }, failed)
    } else if (path === root) void asDir()
    else {
      const read = async () => {
        const mine = ++generation
        try {
          const content = await channel.command('files.read', { deviceId, root, path })
          if (!live || mine !== generation) return
          if (content.kind === 'directory') void asDir()
          else setLoaded({ kind: 'file', content })
        } catch (error) {
          if (mine === generation) failed(error)
        }
      }
      close = observeFileChanges(channel, { deviceId, root, path }, read, true)
    }
    return () => {
      live = false
      close()
    }
  }, [
    channel,
    focused,
    deviceId,
    root,
    path,
    list,
    attempt,
    route.params.ref,
    route.params.href,
    route.params.unrecognized,
    target,
  ])

  const changeRoot = (to: string) => {
    locating.current?.abort()
    const abort = new AbortController()
    locating.current = abort
    setLocationError('')
    const full = normalizePath(to)
    void channel
      .command('files.target', { deviceId, root: full, path: full }, { signal: abort.signal })
      .then(
        (found) => {
          if (abort.signal.aborted) return
          if (found.kind !== 'directory') {
            setLocationError(t('files.tree.rootFailed'))
            return
          }
          navigation.replace('Files', {
            deviceId,
            root: found.root,
            defaultRoot,
            browsing: true,
            ...(found.linkPath ? { linkPath: found.linkPath } : {}),
            ...(route.params.sessionId ? { sessionId: route.params.sessionId } : {}),
            ...(route.params.workspaceId ? { workspaceId: route.params.workspaceId } : {}),
          })
        },
        (error) => {
          if (!abort.signal.aborted) setLocationError(reasonOf(error, t))
        },
      )
  }
  const open = (to: string) =>
    navigation.push('Files', {
      ...route.params,
      root,
      defaultRoot,
      path: to,
      ref: undefined,
      href: undefined,
      unrecognized: undefined,
    })
  const parent = parentPath(root)

  let body: React.ReactNode
  if (loaded.kind === 'loading') body = <Empty busy title={t('files.tree.loading')} />
  else if (loaded.kind === 'link')
    body = (
      <ScrollView>
        <FileLinkReport result={loaded.result} expanded onPick={setTarget} />
        {!route.params.unrecognized ? (
          <Button kind="plain" label={t('files.retry')} onPress={() => setAttempt((n) => n + 1)} />
        ) : null}
      </ScrollView>
    )
  else if (loaded.kind === 'failed')
    body = (
      <Empty
        title={t(loaded.reason ? 'files.tree.failed' : 'files.tree.rootFailed', {
          reason: loaded.reason,
        })}
        action={
          <Button
            kind="plain"
            label={t('files.retry')}
            testID="files:retry"
            onPress={() => setAttempt((n) => n + 1)}
          />
        }
      />
    )
  else if (loaded.kind === 'dir')
    body = (
      <FileTreeView
        deviceId={deviceId}
        root={root}
        scope={route.params.sessionId ?? ''}
        path={path}
        showHidden={showHidden}
        onOpen={open}
      />
    )
  else {
    // 预览与源码共用最终选中的设备、文件树根和定位信息。
    body = (
      <FileView
        content={loaded.content}
        line={line}
        deviceId={deviceId}
        root={root}
        fragment={route.params.fragment}
      />
    )
  }

  return (
    <Screen
      title={
        route.params.unrecognized
          ? t('files.link.failed')
          : path === root
            ? baseName(root) || root
            : baseName(path)
      }
      subtitle={undefined}
      actions={
        loaded.kind === 'dir'
          ? [
              {
                icon: 'eye',
                label: t('files.hidden'),
                selected: showHidden,
                testID: 'files:hidden',
                onPress: () => files.setShowHidden(!showHidden),
              },
            ]
          : []
      }
      testID="files"
    >
      <View
        testID="files:navigation"
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 8,
          borderBottomWidth: 1,
          borderBottomColor: theme.c.line1,
        }}
      >
        <IconButton
          icon="up"
          label={t('files.nav.up')}
          testID="files:up"
          disabled={!parent}
          onPress={() => parent && changeRoot(parent)}
        />
        <PathPicker
          deviceId={deviceId}
          value={root}
          kind="directory"
          bounded
          compact
          onPick={changeRoot}
        />
        <IconButton
          icon="home"
          label={t('files.nav.project')}
          testID="files:project"
          disabled={!defaultRoot}
          onPress={() => changeRoot(defaultRoot)}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${device ? t.text(device.name) : deviceId} · ${root}`}
          testID="files:location"
          onPress={() => setLocationOpen(true)}
          style={{
            flex: 1,
            minWidth: 0,
            flexDirection: 'row',
            alignItems: 'center',
            minHeight: theme.hit,
          }}
        >
          {device?.kind !== 'local' ? (
            <Text
              numberOfLines={1}
              style={{ maxWidth: 76, color: theme.c.ink2, fontSize: theme.font.size.small }}
            >
              {device ? t.text(device.name) : deviceId} ·{' '}
            </Text>
          ) : null}
          <Text
            numberOfLines={1}
            ellipsizeMode="head"
            onLayout={(event) => setLocationWidth(event.nativeEvent.layout.width)}
            style={{
              color: theme.c.ink3,
              flex: 1,
              fontFamily: theme.font.mono,
              fontSize: theme.font.size.small,
            }}
          >
            {shownRoot}
          </Text>
        </Pressable>
      </View>
      <Dialog visible={locationOpen} onClose={() => setLocationOpen(false)}>
        <Text style={{ color: theme.c.ink }}>{device ? t.text(device.name) : deviceId}</Text>
        <Text
          testID="files:full-location"
          selectable
          style={{ color: theme.c.ink, fontFamily: theme.font.mono }}
        >
          {linkPath ? `${linkPath} → ${path}` : root}
        </Text>
        <Button kind="plain" label={t('viewer.close')} onPress={() => setLocationOpen(false)} />
      </Dialog>
      {locationError ? (
        <Text accessibilityRole="alert" style={{ color: theme.c.err }}>
          {locationError}
        </Text>
      ) : null}
      {body}
      {loaded.kind !== 'link' && loaded.kind !== 'loading' && loaded.kind !== 'dir' ? (
        <FileLinkReport
          expanded={loaded.kind === 'failed'}
          result={
            resolution ?? {
              status: 'failed',
              href: route.params.href ?? path,
              path,
              attempted: [path],
              candidates: [],
              failures: [],
            }
          }
        />
      ) : null}
    </Screen>
  )
}
