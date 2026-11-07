// 经理页“工作线”页签（35-manager 17.5）：每条线一行（记号、标题、最近动静；状态 · 分支或回报第一句；行尾“没验 N”），
// 等人、出错在前；已合并的收在最下面“已结束 N”。点一行进这条线的会话页，那里副标题“↰ 经理名”回到这里。
import {
  keys,
  type ManagerBoardView,
  type ManagerLineRow,
  managerLineRows,
  type SessionSummary,
} from '@litch/core'
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { ago } from '../../../../../packages/ui/src/app/format.ts'
import { useReplica } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Empty, Row } from '../../ui/kit/controls'
import { Fold } from '../../ui/kit/Icon'
import { StatusMark } from '../../ui/kit/marks'
import { useTheme } from '../../ui/theme'
import { lineRowParts } from './presentation'

/** 各条线的会话摘要（排序要全部一起看）：任何一条变了整组重算 */
function useLineSummaries(deviceId: string, ids: readonly string[]) {
  const { store } = useReplica()
  const key = ids.join('\n')
  const subscribe = useCallback(
    (changed: () => void) => {
      const stops = key
        ? key.split('\n').map((id) => store.subscribe(keys.summary(deviceId, id), changed))
        : []
      return () => {
        for (const stop of stops) stop()
      }
    },
    [store, deviceId, key],
  )
  const snapshot = useCallback(
    () =>
      key
        .split('\n')
        .map((id) => store.get<SessionSummary>(keys.summary(deviceId, id))?.updatedAt ?? 0)
        .join(','),
    [store, deviceId, key],
  )
  // 快照只用来知道“变了”，真正的摘要按需从仓库取
  const version = useSyncExternalStore(subscribe, snapshot)
  return useMemo(() => {
    void version
    return (id: string) => store.get<SessionSummary>(keys.summary(deviceId, id))
  }, [store, deviceId, version])
}

function LineRow({
  row,
  onOpen,
  head,
}: {
  row: ManagerLineRow
  onOpen(): void
  head?:
    | import('../../../../../packages/protocol/src/manager-paging.mts').ManagerLineHead
    | undefined
}) {
  const t = useT()
  const { c, font, radius } = useTheme()
  const parts = lineRowParts(row)
  const detail = [
    head?.checkedAt === null ? t('manager.paging.unchecked') : t(parts.state),
    parts.branch,
    parts.merged ? t('manager.merged') : null,
    head?.reportPreview ?? parts.report,
    head?.checkedAt ? `${t('manager.paging.checked')} ${ago(head.checkedAt, Date.now(), t)}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
  const meta = row.at ? ago(row.at, Date.now(), t) : undefined
  const unverifiedCount = head?.unverifiedCount ?? parts.unverified
  const unverified = unverifiedCount ? t('mgr.lines.unverified', { count: unverifiedCount }) : ''
  return (
    <Row
      testID={`manager-line:${row.line.threadId}`}
      title={row.line.title}
      detail={detail}
      {...(meta ? { meta } : {})}
      label={[row.line.title, detail, unverified, meta].filter(Boolean).join(' · ')}
      left={<StatusMark status={parts.mark} />}
      trail="forward"
      right={
        unverified ? (
          <Text
            testID={`manager-line:${row.line.threadId}:unverified`}
            style={[
              styles.unverified,
              {
                color: c.wait,
                borderColor: c.wait,
                borderRadius: radius.s,
                fontSize: font.size.meta,
              },
            ]}
          >
            {unverified}
          </Text>
        ) : undefined
      }
      onPress={onOpen}
    />
  )
}

export function ManagerLines({
  deviceId,
  board,
  onOpen,
  lineHeads,
}: {
  deviceId: string
  board: ManagerBoardView
  onOpen(threadId: string, title: string): void
  lineHeads?: import('../../../../../packages/protocol/src/manager-paging.mts').ManagerLineHead[]
}) {
  const t = useT()
  const { c } = useTheme()
  const [showEnded, setShowEnded] = useState(false)
  const summaryOf = useLineSummaries(
    deviceId,
    board.lines.map((line) => line.threadId),
  )
  const { active, ended } = useMemo(
    () => managerLineRows(board.lines, summaryOf),
    [board.lines, summaryOf],
  )
  if (!board.lines.length) return <Empty title={t('mgr.lines.none')} />
  const row = (each: ManagerLineRow) => (
    <LineRow
      key={each.line.threadId}
      row={each}
      head={lineHeads?.find((head) => head.threadId === each.line.threadId)}
      onOpen={() => onOpen(each.line.threadId, each.line.title)}
    />
  )
  return (
    <View testID="manager-lines">
      {active.map(row)}
      {ended.length ? (
        <Fold
          open={showEnded}
          testID="manager-lines:ended"
          onToggle={() => setShowEnded(!showEnded)}
          style={[styles.group, { backgroundColor: c.win }]}
        >
          <Text style={{ color: c.ink2 }}>{t('mgr.lines.ended', { count: ended.length })}</Text>
        </Fold>
      ) : null}
      {showEnded ? ended.map(row) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  unverified: { borderWidth: 1, paddingHorizontal: 4, marginLeft: 8, alignSelf: 'center' },
  group: { justifyContent: 'center', paddingHorizontal: 16 },
})
