// 手机 issue 控制台的筛选：和桌面同一套逻辑（packages/ui 的 filter-groups.ts）。
// 胶囊行下面一行是状态分组的分段（单选，最常用，直接点）；其余条件在底部抽屉里：
// 类型（带勾的方框，多选，带已选数和全选）、状态（分段，单一类型时可展开细分）、只看（带勾的方框）、排序（分段）。
// 抽屉底部“清除筛选”回到页签默认条件，保留排序。
import { type ReactNode, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import {
  MANAGER_ISSUE_KINDS,
  MANAGER_ISSUE_LIST_ORDERS,
  type ManagerIssueFilter,
} from '../../../../../../packages/core/src/projection/manager-issue-list.mts'
import type {
  ManagerIssueAuthorKind,
  ManagerIssueKind,
} from '../../../../../../packages/protocol/src/manager-issues.mts'
import {
  clearIssueFilter,
  DEFAULT_ISSUE_STATUS_GROUP,
  issueActiveFilterCount,
  issueKindChecked,
  issueStatusDetails,
  issueStatusGroups,
  readIssueStatus,
  toggleIssueKind,
  withIssueKinds,
  withIssueStatusDetail,
  withIssueStatusGroup,
} from '../../../../../../packages/ui/src/manager/issues/filter-groups.ts'
import { useT } from '../../../ui/i18n'
import { Button } from '../../../ui/kit/controls'
import { Caret, Icon } from '../../../ui/kit/Icon'
import { useTheme } from '../../../ui/theme'
import { DiscussionDrawer } from '../DiscussionDrawer'

interface FilterProps {
  discussions: boolean
  /** 当前页签 */
  kind: ManagerIssueKind
  filter: ManagerIssueFilter
  onChange(filter: ManagerIssueFilter): void
}

const currentChoice = (filter: ManagerIssueFilter) =>
  readIssueStatus(filter.statuses, filter.kinds) ?? {
    group: DEFAULT_ISSUE_STATUS_GROUP,
    detail: null,
  }

/** 单选分段：一条凹槽，选中的一段浮起来；读屏角色是 radio */
function Segmented<T extends string>({
  options,
  value,
  label,
  testID,
  small,
  onPick,
}: {
  options: readonly { value: T; label: string }[]
  value: T | null
  label: string
  testID(value: T): string
  small?: boolean
  onPick(value: T): void
}) {
  const { c, font, radius } = useTheme()
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={[
        styles.seg,
        { borderColor: c.line2, backgroundColor: c.sunken, borderRadius: radius.m },
      ]}
    >
      {options.map((option) => {
        const on = option.value === value
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            testID={testID(option.value)}
            hitSlop={4}
            onPress={() => onPick(option.value)}
            style={({ pressed }) => [
              styles.segItem,
              small ? styles.segItemSmall : null,
              {
                borderRadius: Math.max(radius.s, radius.m - 2),
                backgroundColor: on ? c.raised : pressed ? c.press : 'transparent',
                borderColor: on ? c.line2 : 'transparent',
              },
            ]}
          >
            <Text
              numberOfLines={1}
              style={{
                color: on ? c.ink : c.ink2,
                fontSize: small ? font.size.meta - 1 : font.size.meta,
                fontWeight: on ? '600' : '400',
              }}
            >
              {option.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

/** 多选项：方框加勾；读屏角色是 checkbox */
function CheckChip({
  label,
  checked,
  testID,
  onToggle,
}: {
  label: string
  checked: boolean
  testID: string
  onToggle(): void
}) {
  const { c, font, radius } = useTheme()
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      testID={testID}
      hitSlop={4}
      onPress={onToggle}
      style={({ pressed }) => [
        styles.check,
        {
          borderRadius: radius.s,
          borderColor: checked ? c.accent : c.line2,
          backgroundColor: checked ? c.sel : pressed ? c.press : 'transparent',
        },
      ]}
    >
      <View
        style={[
          styles.box,
          {
            borderRadius: Math.min(radius.s, 3),
            borderColor: checked ? c.accentSolid : c.line3,
            backgroundColor: checked ? c.accentSolid : c.raised,
          },
        ]}
      >
        {checked ? <Icon name="check" size={12} weight={2} color={c.onAccent} /> : null}
      </View>
      <Text numberOfLines={1} style={{ color: checked ? c.ink : c.ink2, fontSize: font.size.meta }}>
        {label}
      </Text>
    </Pressable>
  )
}

/** 胶囊行下面的状态分段：单选，换组即查询 */
export function IssueStatusRow({ filter, onChange }: Omit<FilterProps, 'discussions' | 'kind'>) {
  const t = useT()
  const choice = currentChoice(filter)
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      testID="issue-status-row"
      contentContainerStyle={styles.statusRow}
    >
      <Segmented
        label={t('issue.filter.status')}
        value={choice.group}
        options={issueStatusGroups(filter.kinds).map((group) => ({
          value: group,
          label: t(`issue.group.${group}`),
        }))}
        testID={(group) => `issue-status:${group}`}
        onPick={(group) => onChange(withIssueStatusGroup(filter, group))}
      />
    </ScrollView>
  )
}

/** 底部筛选抽屉 */
export function IssueFilterDrawer({ onClose, ...props }: FilterProps & { onClose(): void }) {
  const t = useT()
  const { c, font } = useTheme()
  const { discussions, kind, filter, onChange } = props
  const ordinary = kind === 'ordinary'
  const kinds = ordinary && discussions ? MANAGER_ISSUE_KINDS : []
  const checked = kinds.filter((one) => issueKindChecked(filter, one)).length
  const choice = currentChoice(filter)
  const details = issueStatusDetails(choice.group, filter.kinds)
  const [detailOpen, setDetailOpen] = useState(false)
  // 细分默认收起；正选着某个细分状态时必须看得见
  const showDetail = details.length > 0 && (detailOpen || choice.detail !== null)
  const count = issueActiveFilterCount(filter, kind)
  const section = (label: string, children: ReactNode, right?: ReactNode) => (
    <View style={{ gap: 8 }}>
      <View style={styles.sectionHead}>
        <Text style={{ flex: 1, color: c.ink2, fontSize: font.size.meta }}>{label}</Text>
        {right}
      </View>
      <View style={styles.wrap}>{children}</View>
    </View>
  )
  const author = (who: ManagerIssueAuthorKind) => ({
    checked: filter.authors.includes(who),
    onToggle: () =>
      onChange({
        ...filter,
        authors: filter.authors.includes(who)
          ? filter.authors.filter((one) => one !== who)
          : [...filter.authors, who],
      }),
  })
  const only = [
    { key: 'user', label: t('issue.filter.byUser'), ...author('user') },
    { key: 'manager', label: t('issue.filter.byManager'), ...author('manager') },
    {
      key: 'unread',
      label: t('issue.filter.unread'),
      checked: filter.unread,
      onToggle: () => onChange({ ...filter, unread: !filter.unread }),
    },
    {
      key: 'paused',
      label: t('issue.follow.off'),
      checked: filter.followUp === 'off',
      onToggle: () => onChange({ ...filter, followUp: filter.followUp === 'off' ? 'all' : 'off' }),
    },
  ]
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
            disabled={!count}
            testID="issue-filter-reset"
            onPress={() => onChange(clearIssueFilter(filter, kind))}
          />
          <Button label={t('issue.filter.done')} testID="issue-filter-done" onPress={onClose} />
        </View>
      }
    >
      <View style={{ gap: 18 }}>
        {kinds.length
          ? section(
              t('issue.filter.kind'),
              kinds.map((one) => (
                <CheckChip
                  key={one}
                  label={t(`issue.kind.${one}`)}
                  checked={issueKindChecked(filter, one)}
                  testID={`issue-filter-kind:${one}`}
                  onToggle={() => onChange(toggleIssueKind(filter, one))}
                />
              )),
              <View style={styles.sectionHead}>
                <Text style={{ color: c.ink3, fontSize: font.size.meta }}>
                  {t('issue.filter.kindCount', { n: checked, total: kinds.length })}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: checked === kinds.length }}
                  disabled={checked === kinds.length}
                  testID="issue-filter-kind:all"
                  hitSlop={8}
                  onPress={() => onChange(withIssueKinds(filter, []))}
                >
                  <Text
                    style={{
                      color: checked === kinds.length ? c.ink3 : c.accent,
                      fontSize: font.size.meta,
                    }}
                  >
                    {t('issue.filter.selectAll')}
                  </Text>
                </Pressable>
              </View>,
            )
          : null}
        {section(
          t('issue.filter.status'),
          <View style={styles.full}>
            <Segmented
              label={t('issue.filter.status')}
              value={choice.group}
              options={issueStatusGroups(filter.kinds).map((group) => ({
                value: group,
                label: t(`issue.group.${group}`),
              }))}
              testID={(group) => `issue-filter-status:${group}`}
              onPick={(group) => onChange(withIssueStatusGroup(filter, group))}
            />
            {showDetail ? (
              <Segmented
                small
                label={t('issue.filter.detail')}
                value={choice.detail ?? 'any'}
                options={[
                  { value: 'any', label: t('issue.filter.detailAny') },
                  ...details.map((status) => ({
                    value: status,
                    label: t(`issue.status.${status}`),
                  })),
                ]}
                testID={(value) => `issue-filter-detail:${value}`}
                onPick={(value) =>
                  onChange(
                    withIssueStatusDetail(filter, choice.group, value === 'any' ? null : value),
                  )
                }
              />
            ) : null}
          </View>,
          details.length ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: showDetail, disabled: choice.detail !== null }}
              disabled={choice.detail !== null}
              testID="issue-filter-detail-toggle"
              hitSlop={8}
              onPress={() => setDetailOpen(!showDetail)}
              style={styles.sectionHead}
            >
              <Text style={{ color: c.accent, fontSize: font.size.meta }}>
                {t('issue.filter.detail')}
              </Text>
              <Caret open={showDetail} color={c.accent} />
            </Pressable>
          ) : null,
        )}
        {ordinary
          ? section(
              t('issue.filter.only'),
              only.map((one) => (
                <CheckChip
                  key={one.key}
                  label={one.label}
                  checked={one.checked}
                  testID={`issue-filter-only:${one.key}`}
                  onToggle={one.onToggle}
                />
              )),
            )
          : null}
        {section(
          t('issue.filter.order'),
          <View style={styles.full}>
            <Segmented
              label={t('issue.filter.order')}
              value={filter.order}
              options={MANAGER_ISSUE_LIST_ORDERS.map((order) => ({
                value: order,
                label: t(`issue.order.${order}`),
              }))}
              testID={(order) => `issue-filter-order:${order}`}
              onPick={(order) => onChange({ ...filter, order })}
            />
          </View>,
        )}
      </View>
    </DiscussionDrawer>
  )
}

const styles = StyleSheet.create({
  seg: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignSelf: 'flex-start',
    maxWidth: '100%',
    gap: 2,
    padding: 2,
    borderWidth: 1,
  },
  segItem: {
    minHeight: 30,
    justifyContent: 'center',
    paddingHorizontal: 8,
    borderWidth: 1,
  },
  segItemSmall: { minHeight: 26, paddingHorizontal: 8 },
  check: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 34,
    paddingLeft: 8,
    paddingRight: 12,
    borderWidth: 1,
  },
  box: {
    width: 16,
    height: 16,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusRow: { paddingHorizontal: 12, paddingBottom: 6, paddingTop: 2 },
  full: { width: '100%', gap: 8 },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  acts: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
})
