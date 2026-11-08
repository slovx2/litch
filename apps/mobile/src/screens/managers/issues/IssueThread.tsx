// 手机上一条 issue 的讨论界面：半屏抽屉（IssueSheet）和完整讨论页共用，与桌面 IssueThread 对应。
// 依次是一行小字（类型、状态、创建者、跟进）、原帖、状态与跟进、关联、评论时间线；输入框是单独的 IssueComposer，
// 抽屉里放在底部固定，完整页放在页尾。触控区不小于主题的 hit。
import type { ManagerView } from '@litch/core'
import { type ReactNode, useEffect, useState } from 'react'
import { StyleSheet, Switch, Text, TextInput, View } from 'react-native'
import { MANAGER_ISSUE_STATUSES } from '../../../../../../packages/core/src/projection/manager-issue-list.mts'
import type {
  ManagerIssue,
  ManagerIssueHead,
  ManagerOrdinaryStatus,
} from '../../../../../../packages/protocol/src/manager-issues.mts'
import { stamp } from '../../../../../../packages/ui/src/app/format.ts'
import { useT } from '../../../ui/i18n'
import { Chip } from '../../../ui/kit/controls'
import { IconButton } from '../../../ui/kit/Icon'
import { useTheme } from '../../../ui/theme'
import { Byline } from '../Byline'
import { Markdown } from '../IssueMarkdown'
import type { IssueCommands } from './data'

const drafts = new Map<string, string>()

/** 类型记号：小号描边字，颜色随类型 */
export function IssueKindTag({ kind }: { kind: ManagerIssueHead['kind'] }) {
  const t = useT()
  const { c, radius, font } = useTheme()
  const color = {
    ordinary: c.ink2,
    decision: c.accent,
    request: c.wait,
    suggestion: c.ok,
    report: c.ink3,
  }[kind]
  return (
    <Text
      testID={`issue-kind:${kind}`}
      style={[
        styles.kind,
        { color, borderColor: color, borderRadius: radius.s, fontSize: font.size.meta - 1 },
      ]}
    >
      {t(`issue.kind.${kind}`)}
    </Text>
  )
}

/** 状态圆点的颜色：开放=强调色，进行中=等待色，受阻=错误色，完成一类=成功色，其余灰（与桌面一致） */
export function issueStateColor(c: ReturnType<typeof useTheme>['c'], status: string): string {
  if (['open', 'pending', 'endorsed', 'unread'].includes(status)) return c.accent
  if (status === 'in_progress') return c.wait
  if (status === 'blocked') return c.err
  if (['resolved', 'answered', 'started', 'delivered', 'replied'].includes(status)) return c.ok
  return c.ink3
}

/** 一行小字，状态不另占一行；放不下时折行。列表按类型分页签，卡上不写类型；抽屉和完整页带上 */
export function IssueMetaLine({
  head,
  comments,
  withKind = false,
}: {
  head: ManagerIssueHead
  comments?: number
  withKind?: boolean
}) {
  const t = useT()
  const { c, font } = useTheme()
  const parts = [
    t(head.author === 'manager' ? 'issue.author.manager' : 'issue.author.user'),
    stamp(head.updatedAt, Date.now(), t.lang),
    comments ? t('issue.commentCount', { n: comments }) : '',
  ].filter(Boolean)
  return (
    <View style={styles.meta} testID={`issue-meta:${head.id}`}>
      {withKind ? <IssueKindTag kind={head.kind} /> : null}
      <View style={[styles.dot, { backgroundColor: issueStateColor(c, head.status) }]} />
      <Text style={{ color: c.ink3, fontSize: font.size.meta, flexShrink: 1 }}>
        <Text style={{ color: c.ink2 }}>
          {t(`issue.status.${head.status}` as Parameters<typeof t>[0])}
        </Text>
        {` · ${parts.join(' · ')}`}
        {head.kind === 'ordinary' && head.followUp === 'off' ? (
          <Text style={{ color: c.wait }}>{` · ${t('issue.follow.off')}`}</Text>
        ) : null}
      </Text>
    </View>
  )
}

export function IssueThread({
  manager: _manager,
  issue,
  disabled,
  reason,
  commands,
  quick,
  onOpenItem,
}: {
  manager: ManagerView
  issue: ManagerIssue
  disabled: boolean
  reason: string
  commands: IssueCommands
  /** 特殊 issue 的快速处理区（原来那张卡）；给了就画在原帖位置 */
  quick?: ReactNode
  onOpenItem(id: string): void
}) {
  const t = useT()
  const [openingError, setOpeningError] = useState('')
  const opened =
    issue.discussion.opened ||
    issue.discussion.comments.length > 0 ||
    issue.discussion.questions.length > 0
  useEffect(() => {
    if (disabled || !commands.canOpenDiscussion || issue.kind === 'ordinary' || opened) return
    void commands
      .update({
        id: issue.id,
        revision: issue.revision,
        patch: { discussionOpened: true },
        why: t('issue.discuss.open'),
      })
      .then(
        () => setOpeningError(''),
        (error) => setOpeningError(error instanceof Error ? error.message : String(error)),
      )
  }, [disabled, issue.id, issue.kind, issue.revision, opened, commands, t])

  const { c, font, radius } = useTheme()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const run = async (request: Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await request
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  const targets = issue.relations.flatMap((edge) =>
    edge.from.kind === 'issue' && edge.from.target === issue.id
      ? [edge.to]
      : edge.to.kind === 'issue' && edge.to.target === issue.id
        ? [edge.from]
        : [],
  )
  type Row =
    | { kind: 'comment'; id: string; at: number; who: 'user' | 'manager'; body: string }
    | { kind: 'question'; id: string; at: number; body: string; answer: string | null }
    | { kind: 'event'; id: string; at: number; text: string }
  const rows: Row[] = [
    ...issue.discussion.comments.map(
      (one): Row => ({
        kind: 'comment',
        id: one.id,
        at: one.createdAt,
        who: one.author.kind,
        body: one.body,
      }),
    ),
    ...issue.discussion.questions.map(
      (one): Row => ({
        kind: 'question',
        id: one.id,
        at: one.at,
        body: one.question,
        answer: one.answer,
      }),
    ),
    ...issue.timeline.flatMap((entry): Row[] => {
      if (['comment', 'question', 'answer', 'created'].includes(entry.kind)) return []
      // 设备把操作原因写在 summary 里；没有就用通用说法（与桌面一致）
      const who =
        entry.actor === 'manager' || entry.actor === 'user'
          ? `${t(entry.actor === 'manager' ? 'issue.author.manager' : 'issue.author.user')} · `
          : ''
      const what =
        entry.summary.trim() || t(`issue.timeline.${entry.kind}` as Parameters<typeof t>[0])
      return [{ kind: 'event', id: entry.id, at: entry.at, text: `${who}${what}` }]
    }),
  ].sort((a, b) => a.at - b.at)
  const ordinary = issue.kind === 'ordinary'
  return (
    <View style={styles.thread} testID={`issue-thread:${issue.id}`}>
      {openingError ? (
        <Text accessibilityRole="alert" style={{ color: c.err }}>
          {openingError}
        </Text>
      ) : null}
      {quick ??
        (issue.body ? (
          <Markdown text={issue.body} />
        ) : (
          <Text style={{ color: c.ink3 }}>{t('issue.noBody')}</Text>
        ))}
      {ordinary ? (
        <View style={styles.controls}>
          <View style={styles.wrap} role="radiogroup" aria-label={t('issue.filter.status')}>
            {MANAGER_ISSUE_STATUSES.ordinary.map((status) => (
              <Chip
                key={status}
                radio
                label={t(`issue.status.${status}` as Parameters<typeof t>[0])}
                on={issue.status === status}
                disabled={disabled || busy}
                testID={`issue-status:${status}`}
                onPress={() =>
                  issue.status === status
                    ? undefined
                    : void run(
                        commands.update({
                          id: issue.id,
                          revision: issue.revision,
                          patch: { status: status as ManagerOrdinaryStatus },
                          why: t('issue.why.status', {
                            status: t(`issue.status.${status}` as Parameters<typeof t>[0]),
                          }),
                        }),
                      )
                }
              />
            ))}
          </View>
          <View style={styles.followRow}>
            <Text style={{ color: c.ink2, fontSize: font.size.meta + 1, flex: 1 }}>
              {t('issue.follow.label')}
              <Text style={{ color: c.ink3, fontSize: font.size.meta }}>
                {`  ${t('issue.follow.hint')}`}
              </Text>
            </Text>
            <Switch
              testID="issue-follow"
              value={issue.followUp.state === 'on'}
              disabled={disabled || busy}
              trackColor={{ true: c.accent, false: c.line2 }}
              onValueChange={(on) =>
                void run(
                  commands.follow({
                    id: issue.id,
                    revision: issue.revision,
                    state: on ? 'on' : 'off',
                    why: t(on ? 'issue.why.followUp.on' : 'issue.why.followUp.off'),
                  }),
                )
              }
            />
          </View>
        </View>
      ) : null}
      {error ? <Text style={{ color: c.err }}>{error}</Text> : null}
      {disabled ? <Text style={{ color: c.ink3, fontSize: font.size.meta }}>{reason}</Text> : null}
      {targets.length ? (
        <View style={styles.wrap} testID="issue-relations">
          <Text style={{ color: c.ink3, fontSize: font.size.meta }}>{t('manager.relations')}</Text>
          {targets.map((target) =>
            target.kind === 'item' ? (
              <Chip
                key={`${target.kind}:${target.target}`}
                label={`${target.target} · ${t('issue.itemTag')}`}
                testID={`issue-item:${target.target}`}
                onPress={() => onOpenItem(target.target)}
              />
            ) : (
              <Text
                key={`${target.kind}:${target.target}`}
                style={[
                  styles.relation,
                  {
                    color: c.ink2,
                    fontSize: font.size.meta,
                    borderColor: c.line2,
                    backgroundColor: c.sunken,
                  },
                ]}
              >
                {t(`manager.relationKind.${target.kind}` as Parameters<typeof t>[0])} ·{' '}
                {target.label ?? target.target}
              </Text>
            ),
          )}
        </View>
      ) : null}
      {rows.length ? (
        <View style={[styles.timeline, { borderTopColor: c.line1 }]}>
          <Text style={{ color: c.ink2, fontSize: font.size.meta + 1, fontWeight: '600' }}>
            {t('issue.comments')}
            <Text style={{ color: c.ink3, fontWeight: '400' }}>
              {`  ${issue.discussion.comments.length}`}
            </Text>
          </Text>
          {rows.map((row) =>
            row.kind === 'event' ? (
              <View key={row.id} style={styles.event}>
                <View style={[styles.dot, { backgroundColor: c.line3 }]} />
                <Text style={{ color: c.ink3, fontSize: font.size.meta, flexShrink: 1 }}>
                  {row.text} · {stamp(row.at, Date.now(), t.lang)}
                </Text>
              </View>
            ) : (
              <View
                key={row.id}
                testID={`issue-${row.kind}:${row.id}`}
                style={[
                  styles.entry,
                  {
                    borderLeftColor:
                      row.kind === 'comment' && row.who === 'manager' ? c.accent : c.line3,
                    backgroundColor: c.sunken,
                    borderRadius: radius.s,
                  },
                ]}
              >
                <Byline
                  who={
                    row.kind === 'question'
                      ? t('issue.timeline.question')
                      : t(row.who === 'manager' ? 'issue.author.manager' : 'issue.author.user')
                  }
                  at={row.at}
                />
                <Markdown text={row.body} />
                {row.kind === 'question' && row.answer ? (
                  <View
                    style={[styles.answer, { borderLeftColor: c.accent, backgroundColor: c.panel }]}
                  >
                    <Markdown text={row.answer} />
                  </View>
                ) : null}
              </View>
            ),
          )}
        </View>
      ) : null}
      {!ordinary ? (
        <Text style={{ color: c.ink3, fontSize: font.size.meta }}>{t('issue.comment.note')}</Text>
      ) : null}
      {issue.followUp.state === 'off' ? (
        <Text style={{ color: c.wait, fontSize: font.size.meta }} testID="issue-follow-note">
          {t('issue.follow.pausedNote')}
        </Text>
      ) : null}
    </View>
  )
}

/** 评论输入：草稿按 [设备, 经理, 编号] 存在内存里，关抽屉不丢 */
export function IssueComposer({
  manager,
  issue,
  disabled,
  reason,
  commands,
}: {
  manager: ManagerView
  issue: ManagerIssue
  disabled: boolean
  reason: string
  commands: IssueCommands
}) {
  const t = useT()
  const { c, font, radius, hit } = useTheme()
  const key = JSON.stringify([manager.deviceId, manager.id, issue.id])
  const [text, setText] = useState(() => drafts.get(key) ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const edit = (value: string) => {
    setText(value)
    if (value) drafts.set(key, value)
    else drafts.delete(key)
  }
  const send = async () => {
    const body = text.trim()
    if (!body || busy) return
    setBusy(true)
    setError('')
    try {
      await commands.comment({ id: issue.id, revision: issue.revision, body })
      edit('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <View style={styles.composer}>
      <View style={styles.composeRow}>
        <TextInput
          value={text}
          onChangeText={edit}
          editable={!disabled}
          multiline
          placeholder={disabled ? reason : t('issue.comment.placeholder')}
          placeholderTextColor={c.ink3}
          accessibilityLabel={t('issue.comment.placeholder')}
          testID="issue-comment-input"
          style={[
            styles.input,
            {
              minHeight: hit,
              color: c.ink,
              borderColor: c.line2,
              borderRadius: radius.s,
              backgroundColor: c.sunken,
              fontSize: font.size.body,
            },
          ]}
        />
        <IconButton
          icon="send"
          label={t('issue.comment.send')}
          disabled={disabled || busy || !text.trim()}
          busy={busy}
          tone="solid"
          testID="issue-comment-send"
          onPress={() => void send()}
        />
      </View>
      {error ? <Text style={{ color: c.err }}>{error}</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  kind: { borderWidth: 1, paddingHorizontal: 4, lineHeight: 16 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  thread: { gap: 12 },
  controls: { gap: 8 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
  follow: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 40,
    paddingHorizontal: 12,
    borderWidth: 1,
  },
  timeline: { gap: 10, borderTopWidth: 1, paddingTop: 10 },
  entry: { borderLeftWidth: 3, paddingHorizontal: 10, paddingVertical: 8, gap: 4 },
  event: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  relation: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  followRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 40 },
  answer: { borderLeftWidth: 2, paddingLeft: 8, paddingVertical: 4, marginTop: 4 },
  composer: { gap: 4 },
  composeRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 6 },
  input: { flex: 1, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 8, maxHeight: 140 },
})
