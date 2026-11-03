import type {
  ManagerBoardTopicView,
  ManagerObjectId,
  ManagerView,
  SuggestionView,
} from '@litch/core'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import {
  managerHistorySnapshot,
  managerPageKey,
  managerPageLabel,
  managerPageStates,
} from '../../../../../packages/core/src/projection/manager-paging.mts'
import type { ManagerPageKind } from '../../../../../packages/protocol/src/manager-paging.mts'
import { useChannel } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Button } from '../../ui/kit/controls'
import { useTheme } from '../../ui/theme'
import { Issue } from './Issue'
import { Markdown } from './IssueMarkdown'
import { setIssueOrder, useIssueOrder } from './issue-order'
import { ManagerLines } from './ManagerLines'
import { ItemRow } from './ManagerOverview'

export function PagedBoard({
  manager,
  view,
  tab,
  kind: category,
  target,
  suggestions,
  onLine,
  onQuery,
  onDetail,
}: {
  manager: ManagerView
  view: ManagerBoardTopicView & {
    board: NonNullable<ManagerBoardTopicView['board']>
    paging: NonNullable<ManagerBoardTopicView['paging']>
  }
  tab: string
  kind: Exclude<ManagerPageKind, 'item'>
  target: string | null
  suggestions: readonly SuggestionView[]
  onLine(id: string, title?: string): void
  onQuery(key: string): void
  onDetail(y: number, relative?: boolean): void
}) {
  const channel = useChannel()
  const t = useT()
  const { c, hit, font } = useTheme()
  const board = view.board
  const paging = view.paging
  const order = useIssueOrder()
  const [items, setItems] = useState(false)
  const kind: ManagerPageKind = tab === 'overview' ? 'item' : category
  const [filters, setFilters] = useState<Record<string, string>>({})
  const status = filters[kind] ?? managerPageStates[kind][0]
  const query = useMemo(() => ({ kind, status, order }), [kind, status, order])
  const key = managerPageKey(query)
  const page = paging.pages[key]
  const [selected, setSelected] = useState<ManagerObjectId | null>(null)
  const [linked, setLinked] = useState(false)
  const [talking, setTalking] = useState(false)
  const [error, setError] = useState('')
  const positions = useRef(new Map<string, number>())
  const focused = useRef<string | null>(null)
  const address = useMemo(
    () => ({ deviceId: manager.deviceId, managerId: manager.id }),
    [manager.deviceId, manager.id],
  )
  const invoke = useCallback((request: Promise<unknown>) => {
    void request.then(
      () => setError(''),
      (error) => setError(String(error)),
    )
  }, [])
  const open = useCallback(
    (id: ManagerObjectId) => {
      setSelected(id)
      invoke(channel.command('managers.board.detail', { ...address, id }))
    },
    [invoke, channel, address],
  )
  const list = tab === 'console' || (tab === 'overview' && items)
  useLayoutEffect(() => {
    if (tab === 'chat') return
    focused.current = null
    positions.current.clear()
    setLinked(false)
    onQuery(`${tab}/${key}`)
    if (list) invoke(channel.command('managers.board.page', { ...address, ...query }))
  }, [key, list, tab, onQuery, invoke, channel, address, query])
  useEffect(() => {
    if (target) {
      setLinked(true)
      if (target.startsWith('I-')) setItems(true)
      open(target as ManagerObjectId)
    }
  }, [target, open])
  const active =
    selected && (linked || page?.entries.some((head) => head.id === selected)) ? selected : null
  const post = board.posts?.find((post) => post.id === active)
  const item = board.items.find((item) => item.id === active)
  const history = active ? paging.histories[active] : undefined
  const lines = paging.summary.lines
  const style = { color: c.ink, fontSize: font.size.body }
  const detail = active ? (
    <View
      testID={`paging-detail:${active}`}
      onLayout={(event) => {
        // 编号跳转可能不在当前分页里；只有这种导航才主动定位详情。
        if (linked && !page?.entries.some((head) => head.id === active))
          onDetail(event.nativeEvent.layout.y + 12)
      }}
    >
      {!post && !item && !paging.loading.includes(active) ? (
        <>
          <Text accessibilityRole="alert" style={{ color: c.err }}>
            {error || paging.error}
          </Text>
          <Button kind="plain" label={t('manager.paging.retry')} onPress={() => open(active)} />
        </>
      ) : null}
      {post ? (
        <Issue
          inline
          key={post.id}
          manager={manager}
          post={post}
          board={board}
          suggestions={suggestions}
          talking={talking}
          onTalk={setTalking}
          onBack={() => setTalking(false)}
          onPosition={() => {}}
        />
      ) : null}
      {item ? <ItemRow item={item} focused /> : null}
      {!history || history.nextCursor ? (
        <Button
          testID="paging-history"
          kind="plain"
          label={t(history ? 'manager.paging.more' : 'manager.postHistory')}
          busy={paging.loading.includes(`history:${active}`)}
          onPress={() =>
            invoke(
              channel.command('managers.board.history', {
                ...address,
                id: active,
                more: Boolean(history),
              }),
            )
          }
        />
      ) : null}
      {history?.changes.map((change) => {
        const snapshot = managerHistorySnapshot(change)
        return (
          <View key={change.id}>
            <Text style={style}>
              {snapshot?.revision ? `v${snapshot.revision} · ` : ''}
              {snapshot?.title} · {new Date(change.at).toLocaleString()}
            </Text>
            <Markdown text={change.why} />
            {snapshot ? <Markdown text={snapshot.body} /> : null}
          </View>
        )
      })}
    </View>
  ) : null
  return (
    <View testID="manager-paging" style={{ gap: 12, padding: 12 }}>
      {error || paging.error ? (
        <Text accessibilityRole="alert" style={{ color: c.err }}>
          {error || paging.error}
        </Text>
      ) : null}
      <Button
        kind="plain"
        label={t('manager.paging.refresh')}
        busy={paging.loading.includes('summary')}
        onPress={() => invoke(channel.command('managers.board.refresh', address))}
      />
      {tab === 'overview' ? (
        <>
          {paging.summary.situation ? <Markdown text={paging.summary.situation.text} /> : null}
          {Object.entries(paging.summary.counts).map(([kind, counts]) => (
            <Text key={kind} style={style}>
              {t(
                `manager.${kind === 'decision' ? 'decisions' : kind === 'item' ? 'items' : `${kind}s`}` as Parameters<
                  typeof t
                >[0],
              )}{' '}
              · {counts.pending ?? 0} / {counts.all ?? 0}
            </Text>
          ))}
          {board.activities.map((activity) => (
            <View key={activity.id}>
              <Text style={style}>{new Date(activity.at).toLocaleString()}</Text>
              <Markdown text={activity.text} />
            </View>
          ))}
          <Button
            testID="paging-items"
            kind="plain"
            label={t('manager.items')}
            onPress={() => setItems(!items)}
          />
        </>
      ) : null}
      {tab === 'lines' || tab === 'overview' ? (
        <>
          <Text style={style}>
            {lines.checkedAt === null
              ? t('manager.paging.unchecked')
              : `${t('manager.paging.checked')} · ${new Date(lines.checkedAt).toLocaleString()}`}
          </Text>
          {lines.failed ? (
            <Text accessibilityRole="alert" style={{ color: c.err }}>
              {t('manager.paging.failed', { n: lines.failed })}
            </Text>
          ) : null}
          <Button
            kind="plain"
            label={t('manager.paging.refresh')}
            busy={paging.loading.includes('lines')}
            onPress={() =>
              invoke(channel.command('managers.board.refresh', { ...address, lines: true }))
            }
          />
          {tab === 'lines' ? (
            <ManagerLines
              deviceId={manager.deviceId}
              board={board}
              lineHeads={lines.lines}
              onOpen={onLine}
            />
          ) : null}
        </>
      ) : null}
      {list ? (
        <>
          {tab === 'overview' ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {(['newest', 'oldest', 'pending'] as const).map((sort) => (
                <Button
                  key={sort}
                  testID={`paging-order:${sort}`}
                  kind="plain"
                  label={t(`manager.order.${sort}`)}
                  onPress={() => setIssueOrder(sort)}
                />
              ))}
            </View>
          ) : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {managerPageStates[kind].map((filter) => (
              <Pressable
                key={filter}
                accessibilityRole="button"
                accessibilityState={{ selected: status === filter }}
                testID={`paging-filter:${filter}`}
                onPress={() => {
                  setLinked(false)
                  setFilters({ ...filters, [kind]: filter })
                }}
                style={{
                  minHeight: hit,
                  justifyContent: 'center',
                  borderBottomWidth: status === filter ? 2 : 0,
                  borderBottomColor: c.accent,
                }}
              >
                <Text style={style}>
                  {t(managerPageLabel(kind, filter) as Parameters<typeof t>[0])} ·{' '}
                  {paging.summary.counts[kind][filter] ?? 0}
                </Text>
              </Pressable>
            ))}
          </View>
          {linked && active && !page?.entries.some((head) => head.id === active) ? detail : null}
          {!page ? (
            <Button
              label={t('manager.paging.retry')}
              onPress={() =>
                invoke(channel.command('managers.board.page', { ...address, ...query }))
              }
            />
          ) : (
            <>
              {page.entries.map((head) => (
                <View
                  key={head.id}
                  onLayout={(event) => {
                    const y = event.nativeEvent.layout.y
                    const previous = positions.current.get(head.id)
                    positions.current.set(head.id, y)
                    if (focused.current === head.id && previous !== undefined)
                      onDetail(y - previous, true)
                    if (linked && active === head.id) onDetail(y + 12)
                  }}
                >
                  <Pressable
                    testID={`paging-object:${head.id}`}
                    accessibilityRole="button"
                    accessibilityState={{ expanded: active === head.id }}
                    aria-expanded={active === head.id}
                    onPress={() => {
                      focused.current = head.id
                      setLinked(false)
                      if (active === head.id) setSelected(null)
                      else open(head.id)
                    }}
                    style={({ pressed }) => ({
                      minHeight: hit,
                      padding: 12,
                      backgroundColor: pressed ? c.press : c.panel,
                      gap: 8,
                    })}
                  >
                    <Text style={style}>
                      {active === head.id ? '▾' : '▸'} {head.id} · {head.title} ·{' '}
                      {t(managerPageLabel(kind, head.status) as Parameters<typeof t>[0])}
                    </Text>
                    <Text numberOfLines={2} style={{ color: c.ink2 }}>
                      {head.preview}
                    </Text>
                  </Pressable>
                  {active === head.id ? detail : null}
                </View>
              ))}
              <Text style={style}>
                {t('manager.paging.loaded', { n: page.entries.length, total: page.total })}
              </Text>
              {page.nextCursor ? (
                <Button
                  testID="paging-more"
                  label={t('manager.paging.more')}
                  busy={paging.loading.includes(key)}
                  onPress={() =>
                    invoke(
                      channel.command('managers.board.page', { ...address, ...query, more: true }),
                    )
                  }
                />
              ) : null}
            </>
          )}
        </>
      ) : null}
    </View>
  )
}
