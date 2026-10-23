// 差异页：一个根里没提交的改动。上面一排切范围（全部、已暂存、未暂存），下面是变了的文件（状态、路径、增删行数），
// 点一个进去看这个文件的差异（FileDiffPane），返回键回到列表，“上一个”“下一个”在文件之间跳。
// 数据归核心管（device/diffs.mts）：页面开着时订阅概况（replica.openDiff，keys.diff），核心在设备上起 git 去取，
// 回合结束、对面报文件变了会自己更新；下拉、标题栏的“重新取”是 diff.refresh。
// 这个目录不是 git 仓库而 harness 给本回合差异时（sessionId 给了才有），核心改用它，页面上说明一句。
import {
  type ChannelErrorShape,
  type DeviceView,
  DIFF_SCOPES,
  type DiffEntry,
  type DiffScope,
  type DiffView,
  keys,
} from '@litch/core'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { FlashList } from '@shopify/flash-list'
import { useEffect, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { reasonOf } from '../../../../../packages/ui/src/app/errors.ts'
import { totalsOf } from '../../../../../packages/ui/src/diff/model.ts'
import type { RootStackParamList } from '../../nav/routes'
import { useKey, useReplica, useServices } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Button, Empty } from '../../ui/kit/controls'
import { Screen } from '../../ui/kit/Screen'
import { useTheme } from '../../ui/theme'
import { FileDiffPane } from './diff/FileDiffPane'
import { STATUS_LETTER, splitPath } from './diff/rows'

type Props = NativeStackScreenProps<RootStackParamList, 'Diff'>

export function DiffScreen({ route, navigation }: Props) {
  const { deviceId, root, sessionId } = route.params
  const { channel } = useServices()
  const replica = useReplica()
  const theme = useTheme()
  const t = useT()
  const insets = useSafeAreaInsets()
  const { c } = theme
  const [scope, setScope] = useState<DiffScope>(route.params.scope)
  const [picked, setPicked] = useState<string | null>(null)
  const [pulling, setPulling] = useState(false)
  const device = useKey<DeviceView>(keys.device(deviceId))
  const online = device?.connection === 'online'

  // 页面开着才订阅：有人订阅，核心才去设备上取。订阅被拒（根目录不认得之类）就结束了，“重试”重新订阅一次
  const [attempt, setAttempt] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt 变了就是要重新订阅
  useEffect(
    () => replica.openDiff(deviceId, root, scope, sessionId),
    [replica, deviceId, root, scope, sessionId, attempt],
  )
  const view = useKey<DiffView>(keys.diff(deviceId, root, scope, sessionId))
  const refused = useKey<ChannelErrorShape>(keys.diffError(deviceId, root, scope, sessionId))
  const entries = view?.phase === 'ready' ? view.entries : []
  const entry = picked ? entries.find((one) => one.path === picked) : undefined
  const at = entry ? entries.indexOf(entry) : -1

  // 看着一个文件时，返回（标题栏的、系统的）先回到列表
  useEffect(
    () =>
      navigation.addListener('beforeRemove', (event) => {
        if (picked === null) return
        event.preventDefault()
        setPicked(null)
      }),
    [navigation, picked],
  )

  const refresh = () => {
    setPulling(true)
    channel
      .command('diff.refresh', { deviceId, root })
      .catch(() => {})
      .finally(() => setPulling(false))
  }

  const totals = totalsOf(entries)
  const subtitle = entry
    ? entry.path
    : [root, view?.branch ? t('diffs.branch', { name: view.branch }) : null]
        .filter(Boolean)
        .join('  ')

  return (
    <Screen
      title={t('tools.diff.title')}
      subtitle={subtitle}
      wire={device ? c.wire[device.wire] : undefined}
      testID="diff"
      actions={[
        {
          label: t('diffs.refresh'),
          testID: 'diff:refresh',
          disabled: !online || pulling,
          onPress: refresh,
        },
      ]}
    >
      {entry ? (
        <View style={styles.fill}>
          <FileDiffPane
            where={{ deviceId, root, scope, sessionId }}
            entry={entry}
            version={view?.version ?? 0}
          />
          <View
            style={[
              styles.pager,
              { borderTopColor: c.line2, backgroundColor: c.panel, paddingBottom: insets.bottom },
            ]}
          >
            <Button
              kind="plain"
              label={t('diffs.prev')}
              disabled={at <= 0}
              testID="diff:prev"
              onPress={() => setPicked(entries[at - 1]?.path ?? null)}
            />
            <Text style={[styles.position, { color: c.ink2, fontFamily: theme.font.mono }]}>
              {t('diffs.position', { at: at + 1, total: entries.length })}
            </Text>
            <Button
              kind="plain"
              label={t('diffs.next')}
              disabled={at >= entries.length - 1}
              testID="diff:next"
              onPress={() => setPicked(entries[at + 1]?.path ?? null)}
            />
          </View>
        </View>
      ) : (
        <View style={styles.fill}>
          <Scopes scope={scope} onPick={setScope} />
          <Body
            view={view}
            refused={refused}
            onRetry={() => setAttempt((n) => n + 1)}
            online={online}
            scope={scope}
            pulling={pulling}
            onRefresh={refresh}
            onPick={setPicked}
            totals={view?.phase === 'ready' && entries.length > 0 ? totals : null}
            bottom={insets.bottom}
          />
        </View>
      )}
    </Screen>
  )
}

/** 切范围：三个并排的键，选中的反白 */
function Scopes({ scope, onPick }: { scope: DiffScope; onPick(scope: DiffScope): void }) {
  const theme = useTheme()
  const t = useT()
  const { c } = theme
  return (
    <View
      style={[styles.scopes, { borderBottomColor: c.line2, backgroundColor: c.panel }]}
      accessibilityRole="tablist"
      accessibilityLabel={t('diffs.scope')}
    >
      {DIFF_SCOPES.map((one) => {
        const on = one === scope
        return (
          <Pressable
            key={one}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            testID={`diff:scope:${one}`}
            onPress={() => onPick(one)}
            style={[
              styles.scope,
              {
                minHeight: theme.hit - 8,
                borderColor: c.line3,
                borderRadius: theme.radius.m,
                backgroundColor: on ? c.selBg : 'transparent',
              },
            ]}
          >
            <Text style={{ color: on ? c.selFg : c.ink, fontSize: theme.font.size.meta }}>
              {t(`diffs.scope.${one}`)}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

function Body({
  view,
  refused,
  onRetry,
  online,
  scope,
  pulling,
  totals,
  bottom,
  onRefresh,
  onPick,
}: {
  view: DiffView | undefined
  /** 订阅被拒了 */
  refused: ChannelErrorShape | undefined
  onRetry(): void
  online: boolean
  scope: DiffScope
  pulling: boolean
  totals: { files: number; added: number; removed: number } | null
  bottom: number
  onRefresh(): void
  onPick(path: string): void
}) {
  const theme = useTheme()
  const t = useT()
  const { c } = theme
  if (refused) {
    return (
      <Empty
        title={t('diffs.failed', { reason: reasonOf(refused, t) })}
        action={<Button kind="plain" label={t('diffs.retry')} onPress={onRetry} />}
      />
    )
  }
  if (!view || view.phase === 'loading') {
    return <Empty title={t(online ? 'diffs.loading' : 'diffs.offline')} />
  }
  if (view.phase === 'absent') {
    const why =
      view.why === 'noGit'
        ? t('diffs.noGit')
        : view.why === 'unsupported'
          ? t('diffs.unsupported')
          : t('diffs.notRepo')
    return <Empty title={why} />
  }
  if (view.phase === 'failed') {
    return (
      <Empty
        title={t('diffs.failed', { reason: reasonOf(view.error, t) })}
        action={<Button kind="plain" label={t('diffs.retry')} onPress={onRefresh} />}
      />
    )
  }
  const notes = [
    view.source === 'turn' ? t('diffs.turnSource') : null,
    totals ? t('tools.diff.files', totals) : null,
  ].filter((note): note is string => note !== null)
  return (
    <FlashList
      data={view.entries}
      keyExtractor={(entry) => entry.path}
      renderItem={({ item }) => <FileRow entry={item} onPress={() => onPick(item.path)} />}
      refreshing={pulling}
      onRefresh={online ? onRefresh : undefined}
      ListHeaderComponent={
        notes.length > 0 ? (
          <Text
            style={[
              styles.summary,
              { color: c.ink2, fontFamily: theme.font.mono, fontSize: theme.font.size.small },
            ]}
            testID="diff:summary"
          >
            {notes.join('\n')}
          </Text>
        ) : null
      }
      ListEmptyComponent={<Empty title={t(`diffs.clean.${scope}`)} />}
      ListFooterComponent={
        <View style={{ height: bottom + 16 }}>
          {view.omitted > 0 ? (
            <Text style={[styles.summary, { color: c.ink3 }]}>
              {t('diffs.omitted', { n: view.omitted })}
            </Text>
          ) : null}
        </View>
      }
      testID="diff:files"
    />
  )
}

/** 列表里的一个文件：状态字母、路径（目录淡、文件名重）、增删行数 */
function FileRow({ entry, onPress }: { entry: DiffEntry; onPress(): void }) {
  const theme = useTheme()
  const t = useT()
  const { c } = theme
  const { dir, name } = splitPath(entry.path)
  const tone =
    entry.status === 'added' || entry.status === 'untracked'
      ? c.ok
      : entry.status === 'deleted' || entry.status === 'conflicted'
        ? c.err
        : c.wait
  const counted = entry.added !== null || entry.removed !== null
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${t(`diffs.status.${entry.status}`)} ${entry.path}`}
      testID={`diff:file:${entry.path}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.file,
        {
          minHeight: theme.hit + 4,
          borderBottomColor: c.line1,
          backgroundColor: pressed ? c.press : c.panel,
        },
      ]}
    >
      <Text style={[styles.letter, { color: tone, fontFamily: theme.font.mono }]}>
        {STATUS_LETTER[entry.status]}
      </Text>
      <View style={styles.fileText}>
        <Text numberOfLines={1} style={{ color: c.ink, fontSize: theme.font.size.body }}>
          {name}
          {entry.dir ? '/' : ''}
        </Text>
        {dir || entry.from ? (
          <Text
            numberOfLines={1}
            ellipsizeMode="head"
            style={{ color: c.ink3, fontSize: theme.font.size.small, fontFamily: theme.font.mono }}
          >
            {entry.from ? t('diffs.from', { path: entry.from }) : dir}
          </Text>
        ) : null}
      </View>
      {counted ? (
        <Text style={[styles.count, { fontFamily: theme.font.mono }]}>
          <Text style={{ color: c.ok }}>+{entry.added ?? 0}</Text>
          <Text style={{ color: c.ink3 }}> </Text>
          <Text style={{ color: c.err }}>−{entry.removed ?? 0}</Text>
        </Text>
      ) : entry.binary ? (
        <Text style={[styles.count, { color: c.ink3, fontFamily: theme.font.mono }]}>bin</Text>
      ) : null}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  scopes: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  scope: { flex: 1, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  summary: { paddingHorizontal: 16, paddingVertical: 8 },
  file: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  letter: { width: 14, fontSize: 14, fontWeight: '700', textAlign: 'center' },
  fileText: { flex: 1, minWidth: 0 },
  count: { fontSize: 12 },
  pager: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  position: { fontSize: 12 },
})
