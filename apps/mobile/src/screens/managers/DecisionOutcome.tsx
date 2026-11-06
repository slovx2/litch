// 手机上已答、已关闭、重新打开的决策：答复与关闭记录各占一块，没选中的选项默认收起（与桌面同一规则）。
import { decisionAnswerParts } from '@litch/core'
import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import type { ManagerDecisionView as ManagerDecision } from '../../../../../packages/core/src/model-manager.mts'
import type {
  ManagerActor,
  ManagerClosed,
  ManagerDecisionOption,
} from '../../../../../packages/protocol/src/manager.mjs'
import { useT } from '../../ui/i18n'
import { Fold } from '../../ui/kit/Icon'
import { useTheme } from '../../ui/theme'
import { Byline } from './Byline'
import { Markdown } from './IssueMarkdown'

const closerKey = (by: ManagerActor) =>
  by === 'user' || by === 'user-conversation'
    ? 'user'
    : by === 'device'
      ? 'device'
      : ('manager' as const)

function Option({ option, recommend }: { option: ManagerDecisionOption; recommend: boolean }) {
  const t = useT()
  const { c, radius } = useTheme()
  return (
    <View
      testID={`decision-option:${option.id}`}
      style={[styles.option, { borderColor: c.line1, borderRadius: radius.s }]}
    >
      <Text style={{ color: c.ink, fontWeight: '600' }}>
        {option.label}
        {recommend ? <Text style={{ color: c.accent }}> · {t('manager.recommend')}</Text> : null}
      </Text>
      {option.description ? <Markdown text={option.description} /> : null}
    </View>
  )
}

export function DecisionAnswer({ decision }: { decision: ManagerDecision }) {
  const t = useT()
  const { c, radius } = useTheme()
  const parts = decisionAnswerParts(decision)
  if (!parts.answer) return null
  return (
    <View
      testID={`decision-answer:${decision.id}`}
      style={[
        styles.block,
        {
          backgroundColor: c.sunken,
          borderLeftColor: parts.answerKind === 'previous' ? c.line3 : c.accent,
          borderRadius: radius.s,
        },
      ]}
    >
      <Byline
        who={t(
          parts.answerKind === 'previous'
            ? 'manager.answerPrevious'
            : parts.answer.by === 'user-conversation'
              ? 'manager.answerConversation'
              : 'manager.answerYours',
        )}
        at={parts.answer.at}
      />
      {parts.chosen ? (
        <Option option={parts.chosen} recommend={decision.recommend === parts.chosen.id} />
      ) : null}
      {parts.answer.text ? <Markdown text={parts.answer.text} /> : null}
    </View>
  )
}

/**
 * 关闭记录。closed：已关闭；ignored：你忽略的（理由可空）。重新打开的决策可收起：
 * previous 是重开前那次关闭（默认收起），reopened 是经理把你忽略的重新打开时写的理由（默认展开）。
 */
function ClosedNote({
  decisionId,
  closed,
  kind,
}: {
  decisionId: string
  closed: ManagerClosed
  kind: 'closed' | 'ignored' | 'previous' | 'reopened'
}) {
  const t = useT()
  const { c, radius } = useTheme()
  const previous = kind === 'previous' || kind === 'reopened'
  // 经理重开的理由是请你重看的原因，默认展开；上次关闭只作历史，默认收起
  const [open, setOpen] = useState(kind !== 'previous')
  const closer = { who: t(`manager.closer.${closerKey(closed.by)}`) }
  const who = t(
    kind === 'previous'
      ? 'manager.closedPrevious'
      : kind === 'reopened'
        ? 'manager.reopenedBy'
        : kind === 'ignored'
          ? 'manager.ignoredBy'
          : 'manager.closedBy',
    closer,
  )
  return (
    <View
      testID={`decision-${kind === 'previous' ? 'previous-closed' : kind}:${decisionId}`}
      style={[
        styles.block,
        { backgroundColor: c.sunken, borderLeftColor: c.line3, borderRadius: radius.s },
      ]}
    >
      {previous ? (
        <Fold open={open} onToggle={() => setOpen(!open)}>
          <Byline who={who} at={closed.at} />
        </Fold>
      ) : (
        <Byline who={who} at={closed.at} />
      )}
      {open && closed.reason ? <Markdown text={closed.reason} /> : null}
    </View>
  )
}

/** 重新打开的决策：作答表单上方，经理重开的理由和重开前的关闭记录（收起） */
export function DecisionHistory({ decision }: { decision: ManagerDecision }) {
  const parts = decisionAnswerParts(decision)
  return (
    <>
      {parts.reopened ? (
        <ClosedNote decisionId={decision.id} closed={parts.reopened} kind="reopened" />
      ) : null}
      {parts.previousClosed ? (
        <ClosedNote decisionId={decision.id} closed={parts.previousClosed} kind="previous" />
      ) : null}
    </>
  )
}

export function DecisionOutcome({ decision }: { decision: ManagerDecision }) {
  const t = useT()
  const { c } = useTheme()
  const [open, setOpen] = useState(false)
  const parts = decisionAnswerParts(decision)
  return (
    <>
      <DecisionAnswer decision={decision} />
      {parts.closed ? (
        <ClosedNote
          decisionId={decision.id}
          closed={parts.closed}
          kind={decision.status === 'ignored' ? 'ignored' : 'closed'}
        />
      ) : null}
      {parts.others.length ? (
        <>
          <Fold
            open={open}
            testID={`decision-others:${decision.id}`}
            onToggle={() => setOpen(!open)}
          >
            <Text style={{ color: c.ink2 }}>
              {t(parts.chosen ? 'manager.otherOptions' : 'manager.allOptions', {
                n: parts.others.length,
              })}
            </Text>
          </Fold>
          {open
            ? parts.others.map((option) => (
                <Option
                  key={option.id}
                  option={option}
                  recommend={decision.recommend === option.id}
                />
              ))
            : null}
        </>
      ) : null}
    </>
  )
}

const styles = StyleSheet.create({
  block: { borderLeftWidth: 3, padding: 12, gap: 8 },
  option: { borderWidth: 1, padding: 10, gap: 6 },
})
