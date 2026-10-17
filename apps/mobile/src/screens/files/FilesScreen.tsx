// 文件：一个根（工作区的根、会话的工作目录）下面逐层往里看，文件只读打开。
// 一层目录、一个文件各是页面栈里的一页（系统返回键就是上一层）；路由参数带着 path，对话区的文件引用直接跳到这里，
// 带着 line 的打开后定位到那一行。path 不知道是目录还是文件时先读一次（对面说是目录就改成列这一层），根就是目录。
// 路径都由核心核对：必须在根之内，对面不提供文件访问时说明白（files.unsupported 这类话由核心给）。
import {
  baseName,
  type DeviceView,
  type DirectoryView,
  type FileContent,
  keys,
  normalizePath,
  pathTwin,
  relativeTo,
} from '@litch/core'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useCallback, useEffect, useState } from 'react'
import { reasonOf } from '../../../../../packages/ui/src/app/errors.ts'
import type { RootStackParamList } from '../../nav/routes'
import { useChannel, useKey } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Button, Empty } from '../../ui/kit/controls'
import { Screen } from '../../ui/kit/Screen'
import { DirList } from './DirList'
import { FileView } from './FileView'

type Props = NativeStackScreenProps<RootStackParamList, 'Files'>

type Loaded =
  | { kind: 'loading' }
  | { kind: 'dir'; view: DirectoryView }
  | { kind: 'file'; content: FileContent }
  | { kind: 'failed'; reason: string }

export function FilesScreen({ navigation, route }: Props) {
  const { deviceId, line } = route.params
  const root = normalizePath(route.params.root)
  const path = normalizePath(route.params.path ?? root)
  const device = useKey<DeviceView>(keys.device(deviceId))
  const t = useT()
  const channel = useChannel()
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' })
  const [showHidden, setShowHidden] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [refreshing, setRefreshing] = useState(false)

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
    if (path === root) void asDir()
    else
      channel.command('files.read', { deviceId, root, path }).then((content) => {
        if (!live) return
        if (content.kind === 'directory') void asDir()
        else setLoaded({ kind: 'file', content })
      }, failed)
    return () => {
      live = false
    }
  }, [channel, deviceId, root, path, list, attempt])

  const refresh = useCallback(() => {
    setRefreshing(true)
    list(true)
      .then(
        (view) => setLoaded({ kind: 'dir', view }),
        (error: unknown) => setLoaded({ kind: 'failed', reason: reasonOf(error, t) }),
      )
      .finally(() => setRefreshing(false))
  }, [list, t])

  const open = useCallback(
    (to: string) => navigation.push('Files', { deviceId, root, path: to }),
    [navigation, deviceId, root],
  )

  const rel = relativeTo(root, path, pathTwin(device?.os ?? null))
  let body: React.ReactNode
  if (loaded.kind === 'loading') body = <Empty title={t('files.tree.loading')} />
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
      <DirList
        view={loaded.view}
        root={root}
        showHidden={showHidden}
        refreshing={refreshing}
        onRefresh={refresh}
        onOpen={open}
      />
    )
  else body = <FileView content={loaded.content} line={line} />

  return (
    <Screen
      title={path === root ? baseName(root) || root : baseName(path)}
      subtitle={rel === '' ? root : rel}
      actions={
        loaded.kind === 'dir'
          ? [
              {
                label: showHidden ? '.*✓' : '.*',
                testID: 'files:hidden',
                onPress: () => setShowHidden((show) => !show),
              },
            ]
          : []
      }
      testID="files"
    >
      {body}
    </Screen>
  )
}
