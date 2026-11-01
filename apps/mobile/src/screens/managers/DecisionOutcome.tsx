// 手机上已答、已关闭、重新打开的决策：答复与关闭记录各占一块，没选中的选项默认收起（与桌面同一规则）。
import { decisionAnswerParts } from '@litch/core'
import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type {
  ManagerActor,
  ManagerDecision,
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

export function DecisionOutcome({ decision }: { decision: ManagerDecision }) {
  const t = useT()
  const { c, radius } = useTheme()
  const [open, setOpen] = useState(false)
  const parts = decisionAnswerParts(decision)
  return (
    <>
      <DecisionAnswer decision={decision} />
      {parts.closed ? (
        <View
          testID={`decision-closed:${decision.id}`}
          style={[
            styles.block,
            { backgroundColor: c.sunken, borderLeftColor: c.line3, borderRadius: radius.s },
          ]}
        >
          <Text style={{ color: c.ink2 }}>
            <Text style={{ color: c.ink, fontWeight: '600' }}>
              {t('manager.closedBy', {
                who: t(`manager.closer.${closerKey(parts.closed.by)}`),
              })}
            </Text>
            {' · '}
            {stamp(parts.closed.at, Date.now(), t.lang)}
          </Text>
          <Markdown text={parts.closed.reason} />
        </View>
      ) : null}
      {parts.others.length ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            testID={`decision-others:${decision.id}`}
            onPress={() => setOpen(!open)}
            style={styles.toggle}
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
  toggle: { alignSelf: 'flex-start', paddingVertical: 8 },
})
