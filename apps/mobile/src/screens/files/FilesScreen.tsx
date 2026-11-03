// 文件：一个根（工作区的根、会话的工作目录）下面逐层往里看，文件只读打开。
// 一层目录、一个文件各是页面栈里的一页（系统返回键就是上一层）；路由参数带着 path，对话区的文件引用直接跳到这里，
// 带着 line 的打开后定位到那一行。path 不知道是目录还是文件时先读一次（对面说是目录就改成列这一层），根就是目录。
// 路径都由核心核对：必须在根之内，对面不提供文件访问时说明白（files.unsupported 这类话由核心给）。
import {
  baseName,
  type DeviceView,
  type DirectoryView,
  type FileContent,
  type FileLinkResolution,
  type FileLinkTarget,
  keys,
  normalizePath,
  pathTwin,
  relativeTo,
  unrecognizedFileLink,
} from '@litch/core'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useCallback, useEffect, useState } from 'react'
import { ScrollView } from 'react-native'
import { reasonOf } from '../../../../../packages/ui/src/app/errors.ts'
import type { RootStackParamList } from '../../nav/routes'
import { useChannel, useKey, useReplica } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Button, Empty } from '../../ui/kit/controls'
import { Screen } from '../../ui/kit/Screen'
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
  const root = target?.root ?? normalizePath(route.params.root)
  const path = target?.path ?? normalizePath(route.params.path ?? root)
  const device = useKey<DeviceView>(keys.device(deviceId))
  const t = useT()
  const channel = useChannel()
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
    let live = true
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
    } else if (path === root) void asDir()
    else
      channel.command('files.read', { deviceId, root, path }).then((content) => {
        if (!live) return
        if (content.kind === 'directory') void asDir()
        else setLoaded({ kind: 'file', content })
      }, failed)
    return () => {
      live = false
    }
  }, [
    channel,
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

  const open = useCallback(
    (to: string) => navigation.push('Files', { deviceId, root, path: to }),
    [navigation, deviceId, root],
  )

  const rel = relativeTo(root, path, pathTwin(device?.os ?? null))
  let body: React.ReactNode
  if (loaded.kind === 'loading') body = <Empty title={t('files.tree.loading')} />
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
        path={path}
        showHidden={showHidden}
        onOpen={open}
      />
    )
  else {
    // 预览与源码共用最终选中的设备、文件树根和定位信息。
    const view = { content: loaded.content, line, deviceId, root, fragment: route.params.fragment }
    body = <FileView {...view} />
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
      subtitle={rel === '' ? root : rel}
      actions={
        loaded.kind === 'dir'
          ? [
              {
                label: showHidden ? '.*✓' : '.*',
                testID: 'files:hidden',
                onPress: () => files.setShowHidden(!showHidden),
              },
            ]
          : []
      }
      testID="files"
    >
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
