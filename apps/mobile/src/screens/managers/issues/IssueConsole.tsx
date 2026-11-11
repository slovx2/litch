// 手机经理控制台的 issue 模式：类别胶囊一行（默认决策）、行尾过滤和普通 issue 的新建图标；
// 列表是一张张卡（编号加标题、一行小字、两行预览），点开拉起 IssueSheet 半屏抽屉；过滤和新建也是底部抽屉。
// 屏幕只管摆放：useIssueConsole 给出 header（胶囊行）、body（列表）、overlays（抽屉）。
import type {
  ManagerBoardView,
  ManagerFeaturesView,
  ManagerView,
  SuggestionView,
} from '@litch/core'
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import {
  type BoardPageMemory,
  boardPageMemory,
  managerBoardMemory,
} from '../../../../../../packages/core/src/manager-board-memory.mts'
import {
  MANAGER_ISSUE_ATTENTION_FILTERS,
  MANAGER_ISSUE_KINDS,
  MANAGER_ISSUE_LIST_ORDERS,
  type ManagerIssueFilter,
  managerIssueFilterKey,
  managerIssueHead,
  managerIssueKindFilter,
  managerIssueLinkFilter,
  managerIssuePageKey,
  managerIssueStatusFilters,
  supportedManagerIssueFilter,
  withManagerIssueKinds,
} from '../../../../../../packages/core/src/projection/manager-issue-list.mts'
import type {
  ManagerIssueHead,
  ManagerIssueKind,
  ManagerIssueStatus,
} from '../../../../../../packages/protocol/src/manager-issues.mts'
import { useT } from '../../../ui/i18n'
import { Button, Chip } from '../../../ui/kit/controls'
import { IconButton } from '../../../ui/kit/Icon'
import { useTheme } from '../../../ui/theme'
import { DiscussionDrawer } from '../DiscussionDrawer'
import { Issue } from '../Issue'
import { IssueContext } from '../IssueRelations'
import {
  type IssueCommands,
  type ManagerIssuesState,
  useIssueCommands,
  useIssueCounts,
} from './data'
import { IssueComposer, IssueMetaLine, IssueThread } from './IssueThread'

/** 页签次序：四类特殊 issue 在前（日常处理的都在这里），普通 issue 在末尾 */
const TABS: readonly ManagerIssueKind[] = [
  'decision',
  'suggestion',
  'request',
  'report',
  'ordinary',
]
const kindFilter = managerIssueKindFilter
/** 每个经理记住当前页签和每一类的过滤条件 */
const memory = new Map<
  string,
  { kind: ManagerIssueKind; filters: Partial<Record<ManagerIssueKind, ManagerIssueFilter>> }
>()

/** 概览摘要点进来时带的过滤；version 变了才套用 */
export interface IssuePreset {
  patch: Partial<ManagerIssueFilter>
  version: number
}

export function useIssueConsole({
  manager,
  board,
  features,
  suggestions,
  issues,
  disabled,
  reason,
  narrow,
  preset,
  onFull,
  onOpenItem,
  onLocate,
  active = true,
  onQuery,
}: {
  manager: ManagerView
  board: ManagerBoardView | null
  features: ManagerFeaturesView
  suggestions: readonly SuggestionView[]
  issues: ManagerIssuesState
  disabled: boolean
  reason: string
  narrow: boolean
  preset: IssuePreset | null
  onFull(id: string): void
  onOpenItem(id: string): void
  onLocate?(): void
  active?: boolean
  onQuery?(memory: BoardPageMemory, ready: boolean): void
}): { header: ReactNode; body: ReactNode; overlays: ReactNode; open(id: string): void } {
  const t = useT()
  const theme = useTheme()
  const { c, font, radius } = theme
  const commands = useIssueCommands(manager, issues.discussions === true)
  const key = JSON.stringify([manager.deviceId, manager.id])
  const [saved, setSaved] = useState(
    () => memory.get(key) ?? { kind: 'decision' as ManagerIssueKind, filters: {} },
  )
  const kind = saved.kind
  const [linked, setLinked] = useState<string | null>(null)
  const located = useRef(false)
  // 保持默认条件引用，分页结果不能触发 list effect 再读首屏。
  const filter = useMemo(
    () =>
      supportedManagerIssueFilter(
        saved.filters[kind] ?? kindFilter(kind),
        issues.discussions === true,
      ),
    [saved.filters, kind, issues.discussions],
  )
  const save = useCallback(
    (next: typeof saved) => {
      memory.set(key, next)
      setSaved(next)
    },
    [key],
  )
  /** 换条件；条件里的类型就是页签 */
  const setFilter = useCallback(
    (next: ManagerIssueFilter, one = kind) => {
      setLinked(null)
      const now = memory.get(key) ?? saved
      save({ kind: one, filters: { ...now.filters, [one]: next } })
    },
    [key, save, saved, kind],
  )
  const pickKind = (one: ManagerIssueKind) => {
    setLinked(null)
    save({ ...saved, kind: one })
  }
  const [filtering, setFiltering] = useState(false)
  const [creating, setCreating] = useState(false)
  const [sheet, setSheet] = useState<string | null>(null)
  const [error, setError] = useState('')
  const page = issues.pages[managerIssuePageKey(manager.id, filter)]
  const reading = boardPageMemory(
    managerBoardMemory(manager.deviceId, manager.id),
    `mobile-issues:${kind}`,
    managerIssueFilterKey(filter),
  )
  useLayoutEffect(() => {
    // issue 控制台替代了旧 PagedBoard，同样必须交还滚动恢复；加载/错误本身也是可显示的内容。
    if (active) onQuery?.(reading, true)
  }, [active, reading, onQuery])
  const linkedIssue = linked ? issues.details[linked as keyof typeof issues.details] : undefined
  useEffect(() => {
    if (!linkedIssue) return
    const next = managerIssueLinkFilter(linkedIssue, saved.filters[linkedIssue.kind])
    if (kind === linkedIssue.kind && managerIssueFilterKey(next) === managerIssueFilterKey(filter))
      return
    save({ kind: linkedIssue.kind, filters: { ...saved.filters, [linkedIssue.kind]: next } })
  }, [linkedIssue, kind, filter, saved.filters, save])
  const open = useCallback(
    (id: string) => {
      located.current = false
      setLinked(id)
      setSheet(id)
      void commands
        .read(id, { manual: true })
        .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
    },
    [commands],
  )
  const attention = useIssueCounts(manager, issues, MANAGER_ISSUE_ATTENTION_FILTERS)
  const list = useCallback(
    (cursor?: string, manual = false) =>
      void commands
        .list(filter, { ...(cursor ? { cursor } : {}), ...(manual ? { manual: true } : {}) })
        .then(
          () => setError(''),
          (cause) => setError(cause instanceof Error ? cause.message : String(cause)),
        ),
    [commands, filter],
  )
  useEffect(() => {
    if (issues.supported) list()
  }, [issues.supported, list])
  const [applied, setApplied] = useState(0)
  useEffect(() => {
    if (!preset || preset.version === applied) return
    setApplied(preset.version)
    setFilter(
      { ...kindFilter('ordinary'), statuses: [], ...preset.patch, kinds: ['ordinary'] },
      'ordinary',
    )
  }, [preset, applied, setFilter])
  const ordinary = kind === 'ordinary'
  const filtered = managerIssueFilterKey(filter) !== managerIssueFilterKey(kindFilter(kind))
  // 窄屏放不下五个胶囊：选到末尾的普通 issue 时把胶囊行滚到头，选回特殊类型时滚回开头
  const pills = useRef<ScrollView>(null)
  useEffect(() => {
    if (ordinary) pills.current?.scrollToEnd({ animated: true })
    else pills.current?.scrollTo({ x: 0, animated: true })
  }, [ordinary])
  const capsule = (one: ManagerIssueKind) => {
    const on = one === kind
    const count = attention?.[one] ?? 0
    const label = t(one === 'ordinary' ? 'issue.tab' : `issue.kind.${one}`)
    return (
      <Pressable
        key={one}
        role="radio"
        aria-checked={on}
        aria-label={count ? `${label} ${count}` : label}
        testID={`issue-capsule:${one}`}
        hitSlop={{ top: 6, bottom: 6 }}
        onPress={() => pickKind(one)}
        style={[
          styles.pill,
          narrow ? styles.pillNarrow : null,
          {
            borderRadius: radius.l,
            borderColor: on ? c.accent : c.line2,
            backgroundColor: on ? c.sunken : 'transparent',
          },
        ]}
      >
        <Text style={{ color: on ? c.ink : c.ink2, fontSize: font.size.meta + 1 }}>{label}</Text>
        {count ? (
          <Text style={{ color: c.wait, fontSize: font.size.meta + 1, fontWeight: '600' }}>
            {count}
          </Text>
        ) : null}
      </Pressable>
    )
  }
  const header = (
    <View>
      <View style={styles.categories}>
        <ScrollView
          ref={pills}
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.fill}
          contentContainerStyle={[styles.pills, narrow ? styles.pillsNarrow : null]}
        >
          {TABS.map(capsule)}
        </ScrollView>
        <IconButton
          icon="list"
          label={t('issue.filter.title')}
          dot={filtered ? c.accent : undefined}
          testID="issue-filter-open"
          onPress={() => setFiltering(true)}
        />
        {ordinary ? (
          <IconButton
            icon="plus"
            label={disabled ? reason : t('issue.new')}
            disabled={disabled}
            testID="issue-new"
            onPress={() => setCreating(true)}
          />
        ) : null}
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        testID="issue-status-row"
        contentContainerStyle={styles.pills}
      >
        {managerIssueStatusFilters(kind, filter.kinds).map((option) => (
          <Chip
            key={option.key}
            label={t(option.label as never)}
            testID={`issue-status:${option.key}`}
            on={
              option.statuses.length === filter.statuses.length &&
              option.statuses.every((status) => filter.statuses.includes(status))
            }
            onPress={() => setFilter({ ...filter, statuses: option.statuses })}
          />
        ))}
      </ScrollView>
    </View>
  )
  const card = (head: ManagerIssueHead) => {
    const issue = issues.details[head.id]
    return (
      <Pressable
        key={head.id}
        accessibilityRole="button"
        testID={`issue-card:${head.id}`}
        onLayout={() => {
          if (head.id === linked && !located.current) {
            located.current = true
            onLocate?.()
          }
        }}
        onPress={() => {
          if (head.id !== linked) setLinked(null)
          setSheet(head.id)
          void commands.read(head.id, { manual: true }).catch(() => {})
        }}
        style={({ pressed }) => [
          styles.card,
          {
            borderColor: c.line1,
            borderRadius: radius.m,
            backgroundColor: pressed ? c.press : c.panel,
          },
        ]}
      >
        <View style={styles.cardHead}>
          <Text style={{ flex: 1, color: c.ink, fontSize: font.size.title, fontWeight: '600' }}>
            <Text style={{ color: c.ink2, fontFamily: font.mono, fontSize: font.size.meta + 1 }}>
              {head.id}{' '}
            </Text>
            {head.title}
          </Text>
          {head.unread ? (
            <View
              testID={`issue-unread:${head.id}`}
              accessibilityLabel={t('issue.unread')}
              style={[styles.dot, { backgroundColor: c.accent }]}
            />
          ) : null}
        </View>
        <IssueMetaLine head={head} comments={issue?.discussion.comments.length ?? 0} />
        {head.preview ? (
          <Text numberOfLines={2} style={{ color: c.ink2, fontSize: font.size.body - 1 }}>
            {head.preview}
          </Text>
        ) : null}
      </Pressable>
    )
  }
  // 编号可能在后续分页；定位补入同一筛选结果，关抽屉不移除，翻页读到后自然去重。
  const entries = page?.entries ?? []
  const linkedHead = linkedIssue?.kind === kind ? managerIssueHead(linkedIssue) : null
  const visible = linkedHead
    ? [linkedHead, ...entries.filter((head) => head.id !== linked)]
    : entries
  const body =
    error || issues.error ? (
      <View style={styles.note} testID="issue-load-error">
        <Text accessibilityRole="alert" style={{ color: c.err }}>
          {error || issues.error}
        </Text>
        <Button
          kind="plain"
          label={t('manager.paging.retry')}
          onPress={() => list(undefined, true)}
        />
      </View>
    ) : !page && !linkedHead ? (
      <Text testID="issue-loading" style={[styles.note, { color: c.ink3 }]}>
        {t('manager.loading')}
      </Text>
    ) : visible.length ? (
      <View style={styles.list} testID="issue-list">
        {visible.map(card)}
        <Text style={{ color: c.ink3, fontSize: font.size.meta, textAlign: 'center' }}>
          {t('issue.loaded', { n: visible.length, total: page?.total ?? visible.length })}
        </Text>
        {page?.nextCursor ? (
          <Button
            kind="plain"
            label={t('issue.loadMore')}
            testID="issue-more"
            onPress={() => list(page?.nextCursor ?? undefined, true)}
          />
        ) : null}
      </View>
    ) : (
      <View
        testID="issue-empty"
        style={[styles.empty, { borderColor: c.line2, borderRadius: radius.m }]}
      >
        <Text style={{ color: c.ink3, fontSize: font.size.body - 1, textAlign: 'center' }}>
          {t(filtered ? 'issue.empty' : ordinary ? 'issue.emptyAll' : 'issue.emptyKind')}
        </Text>
        {filtered ? (
          <Button
            kind="plain"
            label={t('issue.filter.reset')}
            onPress={() => setFilter(kindFilter(kind))}
          />
        ) : null}
      </View>
    )
  const overlays = (
    <>
      {filtering ? (
        <FilterDrawer
          discussions={issues.discussions === true}
          kind={kind}
          filter={filter}
          onChange={setFilter}
          onClose={() => setFiltering(false)}
        />
      ) : null}
      {creating ? (
        <NewIssueDrawer
          commands={commands}
          onClose={(id) => {
            setCreating(false)
            if (!id) return
            setSheet(id)
          }}
        />
      ) : null}
      {sheet && issues.details[sheet as keyof typeof issues.details] ? (
        <IssueSheetDrawer
          manager={manager}
          board={board}
          features={features}
          suggestions={suggestions}
          issueId={sheet}
          issues={issues}
          commands={commands}
          disabled={disabled}
          reason={reason}
          onClose={() => setSheet(null)}
          onFull={() => {
            setSheet(null)
            onFull(sheet)
          }}
          onOpenItem={(id) => {
            setSheet(null)
            onOpenItem(id)
          }}
        />
      ) : null}
    </>
  )
  return { header, body, overlays, open }
}

/** 打开一条 issue 的半屏抽屉：特殊 issue 先是原来的快速处理卡，点“讨论”再展开讨论；普通 issue 直接是讨论 */
export function IssueSheetDrawer({
  manager,
  board,
  features,
  suggestions,
  issueId,
  issues,
  commands,
  disabled,
  reason,
  onClose,
  onFull,
  onOpenItem,
}: {
  manager: ManagerView
  board: ManagerBoardView | null
  features: ManagerFeaturesView
  suggestions: readonly SuggestionView[]
  issueId: string
  issues: ManagerIssuesState
  commands: IssueCommands
  disabled: boolean
  reason: string
  onClose(): void
  onFull(): void
  onOpenItem(id: string): void
}) {
  const t = useT()
  const issue = issues.details[issueId as keyof typeof issues.details]
  const special = issue ? issue.kind !== 'ordinary' : false
  const [talking, setTalking] = useState(!special)
  const seenAttempt = useRef('')
  useEffect(() => {
    if (!issue?.unread || issue.kind === 'report' || disabled) {
      seenAttempt.current = ''
      return
    }
    const key = JSON.stringify([
      manager.deviceId,
      manager.id,
      issue.id,
      issue.revision,
      issue.updatedAt,
      issue.discussion.comments.at(-1)?.id,
      issue.discussion.comments.at(-1)?.revision,
    ])
    if (seenAttempt.current === key) return
    seenAttempt.current = key
    void commands.seen({ id: issue.id, revision: issue.revision }).catch(() => {})
  }, [issue, commands, disabled, manager.deviceId, manager.id])
  if (!issue) return null
  const post = board?.posts?.find((one) => one.id === (issue.id as string))
  const quick =
    special && board && post ? (
      <IssueContext.Provider value={{ manager, board, features, open: onOpenItem }}>
        <Issue
          manager={manager}
          post={post}
          board={board}
          suggestions={suggestions}
          // 原卡自己的问答抽屉不再打开：讨论统一在这个抽屉里展开
          talking={false}
          onTalk={(open) => setTalking(open ? !talking : false)}
          onBack={() => {}}
          onPosition={() => {}}
          bare
          inline
        />
      </IssueContext.Provider>
    ) : undefined
  return (
    <DiscussionDrawer
      visible
      id={issue.id}
      title={issue.title}
      testID={`issue-sheet:${issue.id}`}
      open={{ label: t('issue.full.open'), onPress: onFull }}
      stickToEnd={false}
      onClose={onClose}
      onBack={onClose}
      footer={
        talking ? (
          <IssueComposer
            manager={manager}
            issue={issue}
            disabled={disabled}
            reason={reason}
            commands={commands}
          />
        ) : undefined
      }
    >
      <View style={{ gap: 10 }}>
        <IssueMetaLine
          withKind
          head={{
            ...issue,
            author: issue.author.kind,
            followUp: issue.followUp.state,
            preview: '',
          }}
          comments={issue.discussion.comments.length}
        />
        {special && !talking ? (
          quick
        ) : (
          <IssueThread
            key={issue.id}
            changes={board?.changes ?? []}
            manager={manager}
            issue={issue}
            disabled={disabled}
            reason={reason}
            commands={commands}
            quick={quick}
            onOpenItem={onOpenItem}
          />
        )}
        <Button kind="plain" label={t('issue.full.open')} testID="issue-full" onPress={onFull} />
      </View>
    </DiscussionDrawer>
  )
}

function FilterDrawer({
  discussions,
  kind,
  filter,
  onChange,
  onClose,
}: {
  discussions: boolean
  kind: ManagerIssueKind
  filter: ManagerIssueFilter
  onChange(filter: ManagerIssueFilter): void
  onClose(): void
}) {
  const t = useT()
  const { c, font } = useTheme()
  const ordinary = kind === 'ordinary'
  const section = (label: string, children: ReactNode) => (
    <View style={{ gap: 6 }}>
      <Text style={{ color: c.ink3, fontSize: font.size.meta }}>{label}</Text>
      <View style={styles.wrap}>{children}</View>
    </View>
  )
  const toggle = <T extends string>(list: T[], value: T) =>
    list.includes(value) ? list.filter((one) => one !== value) : [...list, value]
  return (
    <DiscussionDrawer
      visible
      id=""
      title={t('issue.filter.title')}
      testID="issue-filter"
      stickToEnd={false}
      onClose={onClose}
      onBack={onClose}
      footer={
        <View style={styles.acts}>
          <Button
            kind="plain"
            label={t('issue.filter.reset')}
            testID="issue-filter-reset"
            onPress={() => onChange(kindFilter(kind))}
          />
          <Button label={t('issue.filter.done')} testID="issue-filter-done" onPress={onClose} />
        </View>
      }
    >
      <View style={{ gap: 14 }}>
        {ordinary
          ? section(
              t('issue.filter.kind'),
              <>
                {discussions ? (
                  <Chip
                    label={t('issue.kind.all')}
                    testID="issue-filter-kind:all"
                    on={!filter.kinds.length || filter.kinds.length === MANAGER_ISSUE_KINDS.length}
                    onPress={() => onChange(withManagerIssueKinds(filter, []))}
                  />
                ) : null}
                {(discussions ? MANAGER_ISSUE_KINDS : (['ordinary'] as const)).map((one) => (
                  <Chip
                    key={one}
                    label={t(`issue.kind.${one}`)}
                    testID={`issue-filter-kind:${one}`}
                    on={!filter.kinds.length || filter.kinds.includes(one)}
                    onPress={() => {
                      const selected = filter.kinds.length ? filter.kinds : [...MANAGER_ISSUE_KINDS]
                      const next = selected.includes(one)
                        ? selected.filter((k) => k !== one)
                        : [...selected, one]
                      if (next.length) onChange(withManagerIssueKinds(filter, next))
                    }}
                  />
                ))}
              </>,
            )
          : null}
        {section(
          t('issue.filter.status'),
          managerIssueStatusFilters(kind, filter.kinds).map((option) => {
            const status = option.statuses[0]
            return (
              <Chip
                key={option.key}
                label={t(option.label as Parameters<typeof t>[0])}
                on={
                  option.statuses.length === 1 && status !== undefined
                    ? filter.statuses.includes(status)
                    : option.statuses.length === filter.statuses.length &&
                      option.statuses.every((status) => filter.statuses.includes(status))
                }
                testID={`issue-filter-status:${option.key}`}
                onPress={() =>
                  onChange({
                    ...filter,
                    statuses:
                      option.statuses.length === 1 && status !== undefined
                        ? toggle<ManagerIssueStatus>(filter.statuses, status)
                        : option.statuses,
                  })
                }
              />
            )
          }),
        )}
        {ordinary
          ? section(
              t('issue.filter.author'),
              (['user', 'manager'] as const).map((author) => (
                <Chip
                  key={author}
                  label={t(author === 'user' ? 'issue.filter.byUser' : 'issue.filter.byManager')}
                  on={filter.authors.includes(author)}
                  testID={`issue-filter-author:${author}`}
                  onPress={() => onChange({ ...filter, authors: toggle(filter.authors, author) })}
                />
              )),
            )
          : null}
        {ordinary
          ? section(
              t('issue.filter.follow'),
              (['all', 'on', 'off'] as const).map((value) => (
                <Chip
                  key={value}
                  radio
                  label={t(
                    value === 'all'
                      ? 'issue.filter.all'
                      : value === 'on'
                        ? 'issue.follow.on'
                        : 'issue.follow.off',
                  )}
                  on={filter.followUp === value}
                  testID={`issue-filter-follow:${value}`}
                  onPress={() => onChange({ ...filter, followUp: value })}
                />
              )),
            )
          : null}
        {section(
          t('issue.filter.order'),
          MANAGER_ISSUE_LIST_ORDERS.map((order) => (
            <Chip
              key={order}
              radio
              label={t(`issue.order.${order}`)}
              on={filter.order === order}
              testID={`issue-filter-order:${order}`}
              onPress={() => onChange({ ...filter, order })}
            />
          )),
        )}
        <View style={[styles.wrap, ordinary ? null : styles.hidden]}>
          <Chip
            label={t('issue.filter.unread')}
            on={filter.unread}
            testID="issue-filter-unread"
            onPress={() => onChange({ ...filter, unread: !filter.unread })}
          />
        </View>
      </View>
    </DiscussionDrawer>
  )
}

const newDraft = { title: '', body: '' }
function NewIssueDrawer({
  commands,
  onClose,
}: {
  commands: IssueCommands
  onClose(id: string | null): void
}) {
  const t = useT()
  const { c, font, radius, hit } = useTheme()
  const [title, setTitle] = useState(newDraft.title)
  const [body, setBody] = useState(newDraft.body)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async () => {
    if (!title.trim()) {
      setError(t('issue.new.titleRequired'))
      return
    }
    setBusy(true)
    setError('')
    try {
      const { issue } = await commands.create({ title: title.trim(), body })
      newDraft.title = ''
      newDraft.body = ''
      onClose(issue.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  const input = {
    color: c.ink,
    borderColor: c.line2,
    borderRadius: radius.s,
    backgroundColor: c.sunken,
    fontSize: font.size.body,
  }
  return (
    <DiscussionDrawer
      visible
      id=""
      title={t('issue.new')}
      testID="issue-new-drawer"
      stickToEnd={false}
      onClose={() => onClose(null)}
      onBack={() => onClose(null)}
      footer={
        <View style={styles.acts}>
          <Button kind="plain" label={t('issue.new.cancel')} onPress={() => onClose(null)} />
          <Button
            label={t('issue.new.create')}
            busy={busy}
            testID="issue-create"
            onPress={() => void submit()}
          />
        </View>
      }
    >
      <View style={{ gap: 10 }}>
        <TextInput
          value={title}
          onChangeText={(value) => {
            newDraft.title = value
            setTitle(value)
          }}
          placeholder={t('issue.new.title')}
          placeholderTextColor={c.ink3}
          accessibilityLabel={t('issue.new.title')}
          maxLength={200}
          testID="issue-new-title"
          style={[styles.input, input, { minHeight: hit }]}
        />
        <TextInput
          value={body}
          onChangeText={(value) => {
            newDraft.body = value
            setBody(value)
          }}
          multiline
          placeholder={t('issue.new.body')}
          placeholderTextColor={c.ink3}
          accessibilityLabel={t('issue.new.body')}
          testID="issue-new-body"
          style={[styles.input, input, { minHeight: 120, textAlignVertical: 'top' }]}
        />
        {error ? (
          <Text accessibilityRole="alert" style={{ color: c.err }}>
            {error}
          </Text>
        ) : null}
      </View>
    </DiscussionDrawer>
  )
}

const styles = StyleSheet.create({
  hidden: { display: 'none' },
  empty: {
    alignItems: 'center',
    gap: 8,
    paddingVertical: 24,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderStyle: 'dashed',
  },
  fill: { flex: 1 },
  categories: { flexDirection: 'row', alignItems: 'center', paddingRight: 4 },
  pills: { alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 6 },
  pillsNarrow: { gap: 4, paddingHorizontal: 8 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  pillNarrow: { paddingHorizontal: 7 },
  list: { gap: 8, padding: 12 },
  card: { borderWidth: 1, padding: 12, gap: 4 },
  cardHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 7 },
  note: { padding: 12, gap: 8 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  acts: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  input: { borderWidth: 1, paddingHorizontal: 10, paddingVertical: 8 },
})
