// X-n 原帖下方的 GitHub 引用：每个外部线程一个可点的“owner/name#n”，接单依据默认收起。
// 字段来自议题详情（设备只发给声明了扩展的连接）；没有就什么都不画。
import type { ExternalAnswerSource } from '@litch/core'
import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { ManagerIssue } from '../../../../../../packages/protocol/src/manager-issues.mts'
import { stamp } from '../../../../../../packages/ui/src/app/format.ts'
import { subjectLabel } from '../../../../../../packages/ui/src/external/model.ts'
import { type Key, useT } from '../../../ui/i18n'
import { Fold, Icon } from '../../../ui/kit/Icon'
import { useTheme } from '../../../ui/theme'
import { openGithub, roleLabel } from './labels'

export function IssueExternal({
  issue,
}: {
  issue: Pick<ManagerIssue, 'externalRefs' | 'intakeMandates'>
}) {
  const t = useT()
  const { c, font } = useTheme()
  const [open, setOpen] = useState(false)
  const refs = issue.externalRefs ?? []
  const mandates = issue.intakeMandates ?? []
  if (!refs.length && !mandates.length) return null
  return (
    <View style={styles.block} testID="issue-github">
      <View style={styles.refs}>
        <Text style={{ color: c.ink3, fontSize: font.size.meta }}>{t('mgh.ref.title')}</Text>
        {refs.map((ref) => (
          <Pressable
            key={`${ref.repoId}/${ref.number}`}
            accessibilityRole="link"
            testID={`issue-github-ref:${ref.number}`}
            hitSlop={6}
            onPress={() => openGithub(ref.url)}
            style={styles.ref}
          >
            <Text style={{ color: c.accent, fontSize: font.size.meta + 1 }}>
              {subjectLabel(ref)}
            </Text>
            <Icon name="external" size={12} color={c.accent} />
          </Pressable>
        ))}
      </View>
      {mandates.length ? (
        <>
          <Fold open={open} onToggle={() => setOpen(!open)} testID="issue-github-mandates">
            <Text style={{ color: c.ink3, fontSize: font.size.meta }}>
              {t('mgh.mandate.title')} {mandates.length}
            </Text>
          </Fold>
          {open
            ? mandates.map((mandate) => (
                <View key={mandate.mandateId} style={[styles.mandate, { borderColor: c.line2 }]}>
                  {[
                    t('mgh.mandate.requester', {
                      id: mandate.requesterUserId,
                      role: roleLabel(t, mandate.observedRole),
                    }),
                    t('mgh.mandate.rule', {
                      rule: mandate.ruleId,
                      version: mandate.rulesVersion,
                    }),
                    t('mgh.mandate.accepted', {
                      time: stamp(mandate.acceptedAt * 1000, Date.now(), t.lang),
                    }),
                    t('mgh.mandate.scope', {
                      actions: mandate.authorizedScope.actions
                        .map((action) => t(`mgh.action.${action}` as Key))
                        .join(t.lang === 'en' ? ', ' : '、'),
                    }),
                  ].map((line) => (
                    <Text key={line} style={{ color: c.ink2, fontSize: font.size.meta }}>
                      {line}
                    </Text>
                  ))}
                  {mandate.revokedAt ? (
                    <Text style={{ color: c.err, fontSize: font.size.meta }}>
                      {t('mgh.mandate.revoked')} ·{' '}
                      {stamp(mandate.revokedAt * 1000, Date.now(), t.lang)}
                    </Text>
                  ) : null}
                </View>
              ))
            : null}
        </>
      ) : null}
    </View>
  )
}

/** 决策答复头上的“来自 GitHub 评论”外链 */
export function AnswerSourceLink({ source }: { source: ExternalAnswerSource | undefined }) {
  const t = useT()
  const { c, font } = useTheme()
  if (!source) return null
  return (
    <Pressable
      accessibilityRole="link"
      testID="decision-answer-github"
      hitSlop={6}
      onPress={() => openGithub(source.url)}
      style={styles.ref}
    >
      <Text style={{ color: c.accent, fontSize: font.size.meta }}>{t('mgh.answerSource')}</Text>
      <Icon name="external" size={12} color={c.accent} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  block: { gap: 6 },
  refs: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 10, rowGap: 4 },
  ref: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  mandate: { borderLeftWidth: 2, paddingLeft: 8, gap: 2 },
})
