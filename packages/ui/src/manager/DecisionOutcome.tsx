// 已答、已关闭、重新打开的决策：答复与关闭记录各占一块，与问题分开；没选中的选项默认收起。
import { decisionAnswerParts } from '@litch/core'
import type { ManagerDecisionView } from '../../../core/src/model-manager.mts'
import type { ManagerActor, ManagerDecisionOption } from '../../../protocol/src/manager.mjs'
import { useT } from '../app/appearance.ts'
import { Stamp } from '../transcript/Stamp.tsx'
import { BoardMarkdown } from './BoardMarkdown.tsx'

export const closerKey = (by: ManagerActor) =>
  by === 'user' || by === 'user-conversation'
    ? 'user'
    : by === 'device'
      ? 'device'
      : ('manager' as const)

function Option({ option, recommend }: { option: ManagerDecisionOption; recommend: boolean }) {
  const t = useT()
  return (
    <div className="mg-option-static" data-option={option.id}>
      <div className="mg-option-label">
        <b>{option.label}</b>
        {recommend ? <span className="mg-recommend">{t('manager.recommend')}</span> : null}
      </div>
      {option.description ? <BoardMarkdown text={option.description} /> : null}
    </div>
  )
}

/** 答复块：已答为“你的答复”，重新打开后为“上次的答复”。 */
export function DecisionAnswer({ decision }: { decision: ManagerDecisionView }) {
  const t = useT()
  const parts = decisionAnswerParts(decision)
  if (!parts.answer) return null
  return (
    <section
      className="mg-answer"
      data-answer={parts.answerKind}
      aria-label={t('manager.answerYours')}
    >
      <header>
        <b>
          {t(
            parts.answerKind === 'previous'
              ? 'manager.answerPrevious'
              : parts.answer.by === 'user-conversation'
                ? 'manager.answerConversation'
                : 'manager.answerYours',
          )}
        </b>
        <Stamp className="dim" at={parts.answer.at} />
      </header>
      {parts.chosen ? (
        <Option option={parts.chosen} recommend={decision.recommend === parts.chosen.id} />
      ) : null}
      {parts.answer.text ? (
        <div className="mg-answer-text">
          <BoardMarkdown text={parts.answer.text} />
        </div>
      ) : null}
    </section>
  )
}

/** 已答或已关闭时，答复块之后是关闭记录和收起的其他选项。 */
export function DecisionOutcome({ decision }: { decision: ManagerDecisionView }) {
  const t = useT()
  const parts = decisionAnswerParts(decision)
  return (
    <>
      <DecisionAnswer decision={decision} />
      {parts.closed ? (
        <section className="mg-closed-note">
          <header>
            <b>
              {t('manager.closedBy', { who: t(`manager.closer.${closerKey(parts.closed.by)}`) })}
            </b>
            <Stamp className="dim" at={parts.closed.at} />
          </header>
          <BoardMarkdown text={parts.closed.reason} />
        </section>
      ) : null}
      {parts.others.length ? (
        <details className="mg-other-options" data-other-options>
          <summary>
            {t(parts.chosen ? 'manager.otherOptions' : 'manager.allOptions', {
              n: parts.others.length,
            })}
          </summary>
          {parts.others.map((option) => (
            <Option key={option.id} option={option} recommend={decision.recommend === option.id} />
          ))}
        </details>
      ) : null}
    </>
  )
}
