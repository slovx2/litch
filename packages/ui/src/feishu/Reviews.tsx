// 经理 Console 的“审批”页签（设备有审批扩展 litchReviews 时才有）：这位经理在审批发言的群里要发的话。
// 列表待批的在前（快过期的在前），每条一行：发到哪、格式、剩余时间或状态、创建时间，下面一行内容开头；
// 以用户身份发的在行上标“以 某某 身份发”，经 lark-cli 发的标一个小记号（悬停看方法和路径）；
// 点开就地看详情（回复的哪条、@ 了谁、以谁的身份、经 lark-cli 的方法与路径、每段内容、发起的回合、各个时间、谁在哪批的与理由）。
// 待批的可批准或拒绝（理由选填），带 expectedRevision；冲突、已有结果、已过期时提示并重读快照。
// 写操作只给设备管理员连接：判断沿用飞书设置的 admin。
import { useCallback, useState } from 'react'
import type { ManagerView } from '../../../core/src/model-manager.mts'
import { useT } from '../app/appearance.ts'
import { useNow } from '../app/clock.ts'
import { stampFull } from '../app/format.ts'
import { Caret, Check, Close, Icon } from '../app/icons.tsx'
import { useServices } from '../app/services.tsx'
import { byteSize } from '../files/lines.ts'
import { Stamp } from '../transcript/Stamp.tsx'
import { useFeishuDevice, useReviews } from './data.ts'
import { reviewFailure } from './failure.ts'
import {
  decideParams,
  pendingReviewCount,
  REVIEW_REASON_MAX,
  type Review,
  type ReviewSpeechPreview,
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
} from './model.ts'
import {
  actingLabel,
  actingUserText,
  cliText,
  mentionNames,
  targetLabel,
  timeLeftText,
} from './speech-text.ts'

const STATE_TONE: Record<ReviewState, string> = {
  pending: 'pill wait',
  approved: 'pill ok',
  rejected: 'pill err',
  canceled: 'pill mute',
  expired: 'pill mute',
}

/** 页签要不要出、上面的计数：设备支持审批（available）时才出；计数是这位经理的待批数 */
export function useReviewsSummary(
  manager: Pick<ManagerView, 'deviceId' | 'id'>,
  enabled: boolean,
): { available: boolean; pending: number } {
  const view = useReviews(manager.deviceId, manager.id, enabled)
  const now = useNow()
  return { available: view?.available === true, pending: pendingReviewCount(view?.value, now) }
}

function Parts({ preview }: { preview: ReviewSpeechPreview }) {
  const t = useT()
  return (
    <div className="fs-review-parts">
      {preview.parts.map((part, index) =>
        part.text !== undefined ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: 各段没有自己的 ID，顺序固定
          <p key={index} className="fs-inbox-full fs-review-part" data-format={part.format}>
            {part.text}
          </p>
        ) : (
          <p
            // biome-ignore lint/suspicious/noArrayIndexKey: 同上
            key={index}
            className="fs-review-part fs-review-file"
            data-format={part.format}
          >
            <Icon name="file" small />
            <span className="pill mute">{t(`feishu.format.${part.format}`)}</span>
            <span className="ell">{part.name}</span>
            {part.size !== undefined ? <span className="dim">{byteSize(part.size)}</span> : null}
          </p>
        ),
      )}
    </div>
  )
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
  const { channel } = useServices()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const problem = reasonProblem(reason)
  const denied =
    block === 'readOnly' ? t('feishu.readOnly') : block ? t('feishu.offline') : undefined
  const decide = async (decision: 'approve' | 'reject') => {
    setBusy(true)
    setError('')
    try {
      const result = await channel.command('reviews.decide', {
        deviceId,
        ...decideParams(review, decision, reason),
      })
      onReview(result.review)
    } catch (cause) {
      if (reviewStale(reviewReason(cause))) onStale()
      setError(reviewFailure(cause, t))
    } finally {
      setBusy(false)
    }
  }
  const off = block !== null || busy || problem !== null
  return (
    <div className="fs-decide" data-feishu-decide={review.reviewId}>
      <div className="fs-decide-row">
        <input
          className={problem ? 'req-input wrong grow' : 'req-input grow'}
          data-feishu-review-reason
          placeholder={t('feishu.review.reason')}
          aria-label={t('feishu.review.reason')}
          value={reason}
          disabled={block !== null || busy}
          title={denied}
          onChange={(event) => setReason(event.target.value)}
        />
        <button
          type="button"
          className="ibtn fs-approve"
          data-act="feishu-review-approve"
          title={denied ?? t('feishu.review.approve')}
          aria-label={t('feishu.review.approve')}
          disabled={off}
          onClick={() => void decide('approve')}
        >
          <Check />
        </button>
        <button
          type="button"
          className="ibtn fs-reject"
          data-act="feishu-review-reject"
          title={denied ?? t('feishu.review.reject')}
          aria-label={t('feishu.review.reject')}
          disabled={off}
          onClick={() => void decide('reject')}
        >
          <Close />
        </button>
      </div>
      {problem ? (
        <p className="fs-hint err">{t('feishu.review.reasonLong', { max: REVIEW_REASON_MAX })}</p>
      ) : (
        <p className="fs-hint">{denied ?? t('feishu.review.approveNote')}</p>
      )}
      {error ? (
        <p className="fs-hint err" role="alert" data-feishu-review-error>
          {error}
        </p>
      ) : null}
    </div>
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
  manager: Pick<ManagerView, 'deviceId' | 'name'>
  block: WriteBlock
  onReview(review: Review): void
  onStale(): void
}) {
  const t = useT()
  const preview = review.preview
  const turn = review.requestedBy.turnId
  return (
    <div className="ext-detail fs-inbox-detail" data-feishu-review-detail={review.reviewId}>
      {preview.replyTo ? (
        <blockquote className="fs-quote">
          <span className="dim">{t('feishu.review.detail.replyTo')} </span>
          {preview.replyTo.text?.trim() || t('feishu.review.detail.replyMissing')}
        </blockquote>
      ) : null}
      <Parts preview={preview} />
      <div className="ext-row-meta fs-inbox-meta">
        <span>
          {t('feishu.review.detail.target')} {targetLabel(t, preview.target)}
        </span>
        {preview.mentions.length ? (
          <span>
            {t('feishu.review.detail.mentions')} {mentionNames(preview)}
          </span>
        ) : null}
        <span>
          {t('feishu.review.detail.actingAs')} {actingLabel(t, preview)}
        </span>
        {preview.cli ? (
          <span className="mono" data-feishu-cli>
            {cliText(t, preview.cli)}
          </span>
        ) : null}
        {preview.parts.length > 1 ? (
          <span>{t('feishu.review.detail.parts', { n: preview.parts.length })}</span>
        ) : null}
        <span>
          {t('feishu.review.detail.manager')} {manager.name}
          {turn ? ` · ${t('feishu.review.detail.turn', { id: turn })}` : ''}
        </span>
        <span>
          {t('feishu.review.detail.created')} <Stamp at={review.createdAt * 1000} />
        </span>
        {state === 'pending' || state === 'expired' ? (
          <span>
            {/* 过期时间多在将来，相对写法会当成今天：写完整的年月日时刻 */}
            {t('feishu.review.detail.expires')} {stampFull(review.expiresAt * 1000, t.lang)}
          </span>
        ) : null}
        {review.decidedAt && state !== 'pending' ? (
          <span data-feishu-review-decided>
            {t('feishu.review.detail.decided')} {t(`feishu.review.state.${state}`)}
            {review.decidedBy ? ` · ${t(`feishu.review.decidedBy.${review.decidedBy.via}`)}` : ''}
            {review.decidedBy?.via === 'feishu' && review.decidedBy.who ? (
              <span className="mono"> {review.decidedBy.who}</span>
            ) : null}{' '}
            · <Stamp at={review.decidedAt * 1000} />
          </span>
        ) : null}
        <span>
          {t('feishu.inbox.detail.id')} <span className="mono">{review.reviewId}</span>
        </span>
      </div>
      {review.reason ? (
        <p className="fs-review-reason">
          <span className="dim">{t('feishu.review.detail.reason')} </span>
          {review.reason}
        </p>
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
    </div>
  )
}

export function Reviews({ manager, online }: { manager: ManagerView; online: boolean }) {
  const t = useT()
  const { channel } = useServices()
  const now = useNow()
  const view = useReviews(manager.deviceId, manager.id)
  const feishu = useFeishuDevice(manager.deviceId)
  const block = writeBlock(online, feishu?.admin)
  const [open, setOpen] = useState<string | null>(null)
  /** 命令结果或冲突后重读到的审批：比快照新才用（快照随设备的变更通知随后跟上） */
  const [fresh, setFresh] = useState<Record<string, Review>>({})
  const remember = useCallback(
    (review: Review) => setFresh((all) => ({ ...all, [review.reviewId]: review })),
    [],
  )
  const rows = view?.value
    ? sortReviews(
        view.value.reviews.map((review) => {
          const newer = fresh[review.reviewId]
          return newer && newer.revision > review.revision ? newer : review
        }),
        now,
      )
    : null
  // 冲突、已有结果、已过期：重读这一条
  const refetch = (reviewId: string) => {
    channel.command('reviews.get', { deviceId: manager.deviceId, reviewId }).then(
      (result) => remember(result.review),
      () => {},
    )
  }
  return (
    <div className="ext-inbox fs-inbox fs-reviews" data-feishu-reviews>
      {view?.error ? (
        <p className="err" role="alert">
          {view.error.text ? t.text(view.error.text) : view.error.message}
        </p>
      ) : null}
      {view && !view.online && view.fetchedAt ? (
        <p className="ext-empty">{t('feishu.offlineCached')}</p>
      ) : null}
      {rows === null ? (
        view?.error ? null : (
          <p className="ext-empty">{t('feishu.loading')}</p>
        )
      ) : rows.length === 0 ? (
        <p className="ext-empty" data-feishu-reviews-empty>
          {t('feishu.review.empty')}
        </p>
      ) : (
        <ul className="ext-list">
          {rows.map((review) => {
            const expanded = open === review.reviewId
            const state = reviewShownState(review, now)
            const left = state === 'pending' ? timeLeft(review.expiresAt, now) : null
            const acting = actingUserText(t, review.preview.actingAs)
            return (
              <li
                key={review.reviewId}
                className="ext-inbox-item fs-inbox-item"
                data-feishu-review={review.reviewId}
                data-state={state}
              >
                <div className="ext-row">
                  <button
                    type="button"
                    className="ext-inbox-main"
                    aria-expanded={expanded}
                    onClick={() => setOpen(expanded ? null : review.reviewId)}
                  >
                    <Caret />
                    <b className="ell">{targetLabel(t, review.preview.target)}</b>
                  </button>
                  {speechFormats(review.preview.parts).map((format) => (
                    <span key={format} className="pill mute">
                      {t(`feishu.format.${format}`)}
                    </span>
                  ))}
                  {acting ? (
                    <span className="pill mute fs-acting ell" data-feishu-acting>
                      {acting}
                    </span>
                  ) : null}
                  {review.preview.cli ? (
                    <span
                      className="pill mute mono fs-nowrap"
                      data-feishu-cli-mark
                      title={cliText(t, review.preview.cli)}
                    >
                      lark-cli
                    </span>
                  ) : null}
                  <span className="grow" />
                  {left ? (
                    <span
                      className={left.soon ? 'pill err' : 'pill wait'}
                      data-feishu-review-left
                      title={t('feishu.review.state.pending')}
                    >
                      {timeLeftText(t, left)}
                    </span>
                  ) : (
                    <span className={STATE_TONE[state]} data-feishu-review-state={state}>
                      {t(`feishu.review.state.${state}`)}
                    </span>
                  )}
                  <Stamp className="dim fs-inbox-time" at={review.createdAt * 1000} />
                </div>
                {expanded ? (
                  <Detail
                    review={review}
                    state={state}
                    manager={manager}
                    block={block}
                    onReview={remember}
                    onStale={() => refetch(review.reviewId)}
                  />
                ) : (
                  <p className="fs-inbox-line ell" data-kind="text">
                    {speechHead(review.preview.parts)}
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
