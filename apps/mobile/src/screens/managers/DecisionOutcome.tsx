// 手机上已答、已关闭、重新打开的决策：答复与关闭记录各占一块，没选中的选项默认收起（与桌面同一规则）。
import { decisionAnswerParts } from '@litch/core'
import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { ManagerDecisionView as ManagerDecision } from '../../../../../packages/core/src/model-manager.mts'
import type {
  ManagerActor,
  ManagerClosed,
  ManagerDecisionOption,
} from '../../../../../packages/protocol/src/manager.mjs'
import { stamp } from '../../../../../packages/ui/src/app/format.ts'
import { useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'
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
      <Text style={{ color: c.ink2 }}>
        <Text style={{ color: c.ink, fontWeight: '600' }}>
          {t(
            parts.answerKind === 'previous'
              ? 'manager.answerPrevious'
              : parts.answer.by === 'user-conversation'
                ? 'manager.answerConversation'
                : 'manager.answerYours',
          )}
        </Text>
        {' · '}
        {stamp(parts.answer.at, Date.now(), t.lang)}
      </Text>
      {parts.chosen ? (
        <Option option={parts.chosen} recommend={decision.recommend === parts.chosen.id} />
      ) : null}
      {parts.answer.text ? <Markdown text={parts.answer.text} /> : null}
    </View>
  )
}

/** 已关闭的记录。重新打开的决策只作历史：默认收起，展开看原因 */
function ClosedNote({
  decisionId,
  closed,
  previous,
}: {
  decisionId: string
  closed: ManagerClosed
  previous: boolean
}) {
  const t = useT()
  const { c, radius, hit } = useTheme()
  const [open, setOpen] = useState(!previous)
  const head = (
    <Text style={{ color: c.ink2 }}>
      {previous ? `${open ? '▾' : '▸'} ` : ''}
      <Text style={{ color: c.ink, fontWeight: '600' }}>
        {t(previous ? 'manager.closedPrevious' : 'manager.closedBy', {
          who: t(`manager.closer.${closerKey(closed.by)}`),
        })}
      </Text>
      {' · '}
      {stamp(closed.at, Date.now(), t.lang)}
    </Text>
  )
  return (
    <View
      testID={`decision-${previous ? 'previous-closed' : 'closed'}:${decisionId}`}
      style={[
        styles.block,
        { backgroundColor: c.sunken, borderLeftColor: c.line3, borderRadius: radius.s },
      ]}
    >
      {previous ? (
        <Pressable
          accessibilityRole="button"
          aria-expanded={open}
          onPress={() => setOpen(!open)}
          style={[styles.head, { minHeight: hit }]}
        >
          {head}
        </Pressable>
      ) : (
        head
      )}
      {open ? <Markdown text={closed.reason} /> : null}
    </View>
  )
}

/** 重新打开的决策：作答表单上方，重开前的关闭记录（收起） */
export function DecisionHistory({ decision }: { decision: ManagerDecision }) {
  const parts = decisionAnswerParts(decision)
  return parts.previousClosed ? (
    <ClosedNote decisionId={decision.id} closed={parts.previousClosed} previous />
  ) : null
}

export function DecisionOutcome({ decision }: { decision: ManagerDecision }) {
  const t = useT()
  const { c, hit } = useTheme()
  const [open, setOpen] = useState(false)
  const parts = decisionAnswerParts(decision)
  return (
    <>
      <DecisionAnswer decision={decision} />
      {parts.closed ? (
        <ClosedNote decisionId={decision.id} closed={parts.closed} previous={false} />
      ) : null}
      {parts.others.length ? (
        <>
          <Pressable
            accessibilityRole="button"
            aria-expanded={open}
            testID={`decision-others:${decision.id}`}
            onPress={() => setOpen(!open)}
            style={[styles.toggle, { minHeight: hit }]}
          >
            <Text style={{ color: c.ink2 }}>
              {open ? '▾' : '▸'}{' '}
              {t(parts.chosen ? 'manager.otherOptions' : 'manager.allOptions', {
                n: parts.others.length,
              })}
            </Text>
          </Pressable>
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
  toggle: { alignSelf: 'stretch', justifyContent: 'center' },
  head: { justifyContent: 'center' },
})
