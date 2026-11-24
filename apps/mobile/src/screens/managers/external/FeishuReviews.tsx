// 经理控制台的“审批”页签（设备有审批扩展时才有）：这位经理在审批发言的群里要发的话，待批的在前（快过期的在前）。
// 每条两行——第一行发到哪、格式、剩余时间或状态与时间，第二行内容开头；点一条就地展开回复的哪条、每段内容、
// @ 到的人、身份、经 lark-cli 的方法与路径、发起的回合、各个时间、谁在哪批的与理由。待批的下面一行理由输入框加“批准”“拒绝”两个小图标按钮。
// 以用户身份发的、经 lark-cli 发的在第一行格式后面标出。
// 写操作只给设备管理员连接：判断沿用飞书设置的 admin；冲突、已有结果、已过期时提示并重读这一条。
import type { ManagerView } from '@litch/core'
import { useCallback, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { stamp, stampFull } from '../../../../../../packages/ui/src/app/format.ts'
import { reviewFailure } from '../../../../../../packages/ui/src/feishu/failure.ts'
import {
  decideParams,
  pendingReviewCount,
  REVIEW_REASON_MAX,
  type Review,
  type ReviewState,
  reasonProblem,
  reviewReason,
  reviewShownState,
  reviewStale,
  sortReviews,
  speechFormats,
  speechHead,
  timeLeft,
  type WriteBlock,
  writeBlock,
} from '../../../../../../packages/ui/src/feishu/model.ts'
import {
  actingLabel,
  actingUserText,
  cliText,
  mentionNames,
  targetLabel,
  timeLeftText,
} from '../../../../../../packages/ui/src/feishu/speech-text.ts'
import { byteSize } from '../../../../../../packages/ui/src/files/lines.ts'
import { useChannel } from '../../../shell/services'
import { useT } from '../../../ui/i18n'
import { Empty } from '../../../ui/kit/controls'
import { IconButton } from '../../../ui/kit/Icon'
import { type Theme, useTheme } from '../../../ui/theme'
import { useFeishuDevice, useReviews } from '../../devices/feishu/use-feishu'
import { useNow } from '../../sessions/clock'

/** 页签要不要出、上面的计数：设备支持审批（available）时才出；计数是这位经理的待批数 */
export function useReviewsSummary(
  manager: Pick<ManagerView, 'deviceId' | 'id'>,
  enabled: boolean,
): { available: boolean; pending: number } {
  const view = useReviews(manager.deviceId, manager.id, enabled)
  const now = useNow()
  return { available: view?.available === true, pending: pendingReviewCount(view?.value, now) }
}

function stateColor(c: Theme['c'], state: ReviewState): string {
  return state === 'approved' ? c.ok : state === 'rejected' ? c.err : c.ink3
}

function Decide({
  deviceId,
  review,
  block,
  onReview,
  onStale,
}: {
  deviceId: string
  review: Review
  block: WriteBlock
  onReview(review: Review): void
  onStale(): void
}) {
  const t = useT()
  const { c, font, radius, hit } = useTheme()
  const channel = useChannel()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null)
  const [error, setError] = useState('')
  const problem = reasonProblem(reason)
  const denied = block === 'readOnly' ? t('feishu.readOnly') : block ? t('feishu.offline') : null
  const decide = async (decision: 'approve' | 'reject') => {
    setBusy(decision)
    setError('')
    try {
      const result = await channel.command('reviews.decide', {
        deviceId,
        ...decideParams(review, decision, reason),
      })
      onReview(result.review)
    } catch (failed) {
      if (reviewStale(reviewReason(failed))) onStale()
      setError(reviewFailure(failed, t))
    } finally {
      setBusy(null)
    }
  }
  const off = block !== null || busy !== null || problem !== null
  const meta = { color: c.ink3, fontSize: font.size.meta }
  return (
    <View style={styles.decide} testID={`feishu-review-decide:${review.reviewId}`}>
      <View style={styles.decideRow}>
        <TextInput
          value={reason}
          onChangeText={setReason}
          placeholder={t('feishu.review.reason')}
          accessibilityLabel={t('feishu.review.reason')}
          placeholderTextColor={c.ink3}
          editable={block === null && busy === null}
          testID={`feishu-review-reason:${review.reviewId}`}
          style={[
            styles.input,
            {
              color: c.ink,
              backgroundColor: c.raised,
              borderColor: problem ? c.err : c.line2,
              borderRadius: radius.m,
              minHeight: hit - 8,
              fontSize: font.size.body,
            },
          ]}
        />
        <IconButton
          icon="check"
          label={t('feishu.review.approve')}
          color={off ? undefined : c.ok}
          busy={busy === 'approve'}
          disabled={off}
          testID={`feishu-review-approve:${review.reviewId}`}
          onPress={() => void decide('approve')}
        />
        <IconButton
          icon="close"
          label={t('feishu.review.reject')}
          color={off ? undefined : c.err}
          busy={busy === 'reject'}
          disabled={off}
          testID={`feishu-review-reject:${review.reviewId}`}
          onPress={() => void decide('reject')}
        />
      </View>
      <Text style={[meta, problem ? { color: c.err } : null]}>
        {problem
          ? t('feishu.review.reasonLong', { max: REVIEW_REASON_MAX })
          : (denied ?? t('feishu.review.approveNote'))}
      </Text>
      {error ? (
        <Text accessibilityRole="alert" style={[meta, { color: c.err }]}>
          {error}
        </Text>
      ) : null}
    </View>
  )
}

function Detail({
  review,
  state,
  manager,
  block,
  onReview,
  onStale,
}: {
  review: Review
  state: ReviewState
  manager: ManagerView
  block: WriteBlock
  onReview(review: Review): void
  onStale(): void
}) {
  const t = useT()
  const { c, font } = useTheme()
  const preview = review.preview
  const meta = { color: c.ink3, fontSize: font.size.meta }
  const when = (at: number) => stamp(at * 1000, Date.now(), t.lang)
  const turn = review.requestedBy.turnId
  const decided =
    review.decidedAt && state !== 'pending'
      ? [
          `${t('feishu.review.detail.decided')} ${t(`feishu.review.state.${state}`)}`,
          review.decidedBy ? t(`feishu.review.decidedBy.${review.decidedBy.via}`) : '',
          review.decidedBy?.via === 'feishu' ? (review.decidedBy.who ?? '') : '',
          when(review.decidedAt),
        ]
          .filter(Boolean)
          .join(' · ')
      : ''
  const lines = [
    `${t('feishu.review.detail.target')} ${targetLabel(t, preview.target)}`,
    preview.mentions.length ? `${t('feishu.review.detail.mentions')} ${mentionNames(preview)}` : '',
    `${t('feishu.review.detail.actingAs')} ${actingLabel(t, preview)}`,
    preview.cli ? cliText(t, preview.cli) : '',
    preview.parts.length > 1 ? t('feishu.review.detail.parts', { n: preview.parts.length }) : '',
    `${t('feishu.review.detail.manager')} ${manager.name}${turn ? ` · ${t('feishu.review.detail.turn', { id: turn })}` : ''}`,
    `${t('feishu.review.detail.created')} ${when(review.createdAt)}`,
    state === 'pending' || state === 'expired'
      ? // 过期时间多在将来，相对写法会当成今天：写完整的年月日时刻
        `${t('feishu.review.detail.expires')} ${stampFull(review.expiresAt * 1000, t.lang)}`
      : '',
    decided,
    `${t('feishu.inbox.detail.id')} ${review.reviewId}`,
  ]
  return (
    <View style={styles.detail} testID={`feishu-review-detail:${review.reviewId}`}>
      {preview.replyTo ? (
        <Text style={[meta, styles.quote, { borderColor: c.line2, color: c.ink2 }]}>
          {`${t('feishu.review.detail.replyTo')} `}
          {preview.replyTo.text?.trim() || t('feishu.review.detail.replyMissing')}
        </Text>
      ) : null}
      {preview.parts.map((part, index) => (
        <Text
          // biome-ignore lint/suspicious/noArrayIndexKey: 各段没有自己的 ID，顺序固定
          key={index}
          selectable
          style={[
            { color: c.ink, fontSize: font.size.body },
            index > 0 ? [styles.partGap, { borderColor: c.line2 }] : null,
          ]}
        >
          {part.text ??
            [
              t(`feishu.format.${part.format}`),
              part.name ?? '',
              part.size !== undefined ? byteSize(part.size) : '',
            ]
              .filter(Boolean)
              .join(' · ')}
        </Text>
      ))}
      <Text style={meta}>{lines.filter(Boolean).join('\n')}</Text>
      {review.reason ? (
        <Text selectable style={{ color: c.ink, fontSize: font.size.meta }}>
          <Text style={{ color: c.ink3 }}>{`${t('feishu.review.detail.reason')} `}</Text>
          {review.reason}
        </Text>
      ) : null}
      {state === 'pending' ? (
        <Decide
          deviceId={manager.deviceId}
          review={review}
          block={block}
          onReview={onReview}
          onStale={onStale}
        />
      ) : null}
    </View>
  )
}

export function FeishuReviews({ manager, online }: { manager: ManagerView; online: boolean }) {
  const t = useT()
  const { c, font, radius } = useTheme()
  const channel = useChannel()
  const now = useNow()
  const view = useReviews(manager.deviceId, manager.id, true)
  const feishu = useFeishuDevice(manager.deviceId, true)
  const block = writeBlock(online, feishu?.admin)
  const [open, setOpen] = useState<string | null>(null)
  /** 命令结果或冲突后重读到的审批：比快照新才用（快照随设备的变更通知随后跟上） */
  const [fresh, setFresh] = useState<Record<string, Review>>({})
  const remember = useCallback(
    (review: Review) => setFresh((all) => ({ ...all, [review.reviewId]: review })),
    [],
  )
  const refetch = (reviewId: string) => {
    channel.command('reviews.get', { deviceId: manager.deviceId, reviewId }).then(
      (result) => remember(result.review),
      () => {},
    )
  }
  const rows = view?.value
    ? sortReviews(
        view.value.reviews.map((review) => {
          const newer = fresh[review.reviewId]
          return newer && newer.revision > review.revision ? newer : review
        }),
        now,
      )
    : null
  const meta = { color: c.ink3, fontSize: font.size.meta }
  return (
    <View style={styles.fill} testID="feishu-reviews">
      {view && !view.online && view.fetchedAt ? (
        <Text style={[styles.note, meta]}>{t('feishu.offlineCached')}</Text>
      ) : null}
      <ScrollView
        style={styles.fill}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
      >
        {!view || (!view.value && !view.error) ? (
          <Empty busy title={t('feishu.loading')} />
        ) : view.error && !rows ? (
          <Text accessibilityRole="alert" style={[styles.note, { color: c.err }]}>
            {view.error.text ? t.text(view.error.text) : view.error.message}
          </Text>
        ) : !rows || rows.length === 0 ? (
          <Empty title={t('feishu.review.empty')} />
        ) : (
          rows.map((review) => {
            const expanded = open === review.reviewId
            const state = reviewShownState(review, now)
            const left = state === 'pending' ? timeLeft(review.expiresAt, now) : null
            const formats = [
              ...speechFormats(review.preview.parts).map((format) => t(`feishu.format.${format}`)),
              actingUserText(t, review.preview.actingAs) ?? '',
              review.preview.cli ? 'lark-cli' : '',
            ]
              .filter(Boolean)
              .join(' · ')
            return (
              <View
                key={review.reviewId}
                style={[styles.row, { borderColor: c.line1, borderRadius: radius.s }]}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded }}
                  testID={`feishu-review-row:${review.reviewId}`}
                  onPress={() => setOpen(expanded ? null : review.reviewId)}
                  style={({ pressed }) => [
                    styles.head,
                    { backgroundColor: pressed ? c.press : 'transparent' },
                  ]}
                >
                  <View style={styles.line}>
                    <Text
                      numberOfLines={1}
                      style={[
                        styles.shrink,
                        { color: c.ink, fontWeight: '600', fontSize: font.size.meta + 1 },
                      ]}
                    >
                      {targetLabel(t, review.preview.target)}
                    </Text>
                    <Text numberOfLines={1} style={[styles.shrink, meta]}>
                      {formats}
                    </Text>
                    <View style={styles.grow} />
                    <Text
                      testID={`feishu-review-state:${review.reviewId}`}
                      style={[
                        meta,
                        {
                          color: left ? (left.soon ? c.err : c.wait) : stateColor(c, state),
                        },
                      ]}
                    >
                      {left ? timeLeftText(t, left) : t(`feishu.review.state.${state}`)}
                    </Text>
                    <Text style={meta}>{stamp(review.createdAt * 1000, now, t.lang)}</Text>
                  </View>
                  {expanded ? null : (
                    <Text numberOfLines={1} style={{ color: c.ink, fontSize: font.size.meta }}>
                      {speechHead(review.preview.parts)}
                    </Text>
                  )}
                </Pressable>
                {expanded ? (
                  <Detail
                    review={review}
                    state={state}
                    manager={manager}
                    block={block}
                    onReview={remember}
                    onStale={() => refetch(review.reviewId)}
                  />
                ) : null}
              </View>
            )
          })
        )}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  grow: { flex: 1 },
  shrink: { flexShrink: 1 },
  note: { paddingHorizontal: 12, paddingVertical: 4 },
  list: { padding: 12, gap: 8 },
  row: { borderWidth: 1, overflow: 'hidden' },
  head: { paddingHorizontal: 10, paddingVertical: 8, gap: 2 },
  line: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  detail: { gap: 6, paddingHorizontal: 10, paddingBottom: 10 },
  quote: { borderLeftWidth: 2, paddingLeft: 8 },
  partGap: { borderTopWidth: 1, borderStyle: 'dashed', paddingTop: 6 },
  decide: { gap: 4, paddingTop: 4 },
  decideRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  input: { flex: 1, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 4 },
})
