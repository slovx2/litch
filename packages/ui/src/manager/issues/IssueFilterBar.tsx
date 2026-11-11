// issue 控制台顶上的筛选栏。左边一列标签、右边一列控件，几行对齐：
// 类型（多选，带勾的方框，只在 issue 页签）、状态（单选分段，跨类型统一分组，单一类型时可展开细分）、
// 只看（多选开关，只在 issue 页签），清除筛选和排序在最后一行的右端；action 是放不进类别分段时的新建按钮。
// 外观上分得清：多选都是带方框的勾选项，单选是分段或下拉。
// 控制台窄了（compact）收成一个“筛选”按钮，按钮上写生效几项，点开浮层里是同样的几行，旁边一个“清除筛选”。
import { type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from 'react'
import {
  MANAGER_ISSUE_KINDS,
  MANAGER_ISSUE_LIST_ORDERS,
  type ManagerIssueFilter,
} from '../../../../core/src/projection/manager-issue-list.mts'
import type {
  ManagerIssueAuthorKind,
  ManagerIssueKind,
} from '../../../../protocol/src/manager-issues.mts'
import { useT } from '../../app/appearance.ts'
import { Caret, Check, Icon } from '../../app/icons.tsx'
import { usePopover } from '../../app/popover.ts'
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
} from './filter-groups.ts'

interface FilterProps {
  discussions: boolean
  /** 当前页签 */
  kind: ManagerIssueKind
  filter: ManagerIssueFilter
  onChange(filter: ManagerIssueFilter): void
}

/** 筛选栏比这窄时收成“筛选”按钮加浮层：标签列加五个类型勾选项放不下一行（看板最窄 360） */
const COMPACT_WIDTH = 460

/** 盯着筛选栏自己的宽度，窄了返回 true。没有 ResizeObserver 的环境（单测）按宽屏算。 */
function useCompact(root: RefObject<HTMLElement | null>): boolean {
  const [compact, setCompact] = useState(false)
  useLayoutEffect(() => {
    const element = root.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const measure = () => setCompact(element.getBoundingClientRect().width < COMPACT_WIDTH)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [root])
  return compact
}

export function IssueFilterBar({
  action,
  ...props
}: FilterProps & {
  /** 右上角的主要操作，和筛选分开放 */
  action?: ReactNode
}) {
  const root = useRef<HTMLDivElement>(null)
  const compact = useCompact(root)
  return (
    <div
      ref={root}
      className="mg-issue-toolbar"
      data-issue-filters
      data-compact={compact || undefined}
    >
      {compact ? <CompactFilters {...props} /> : <IssueFilterFields {...props} stacked={false} />}
      {action ? <div className="mg-issue-toolbar-act">{action}</div> : null}
    </div>
  )
}

/** 窄屏：一个“筛选”按钮（带生效数），点开浮层；有生效的筛选时旁边一个“清除筛选” */
function CompactFilters(props: FilterProps) {
  const t = useT()
  const { open, setOpen, root, trigger, pop, onKeyDown } = usePopover()
  const count = issueActiveFilterCount(props.filter, props.kind)
  return (
    <div className="mg-issue-compact" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="btn mg-issue-ftoggle"
        data-act="issue-filter-open"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={count ? t('issue.filter.applied', { n: count }) : t('issue.filter.title')}
        onClick={() => setOpen(!open)}
      >
        <Icon name="filter" small />
        {t('issue.filter.title')}
        {count ? (
          <span className="pill mg-issue-fcount" data-issue-filter-count>
            {count}
          </span>
        ) : null}
        <Caret />
      </button>
      {count ? <ClearFilters {...props} /> : null}
      {open ? (
        <div
          className="pick-pop down mg-issue-pop"
          ref={pop}
          role="dialog"
          aria-label={t('issue.filter.title')}
          onKeyDown={onKeyDown}
        >
          <IssueFilterFields {...props} stacked />
        </div>
      ) : null}
    </div>
  )
}

function ClearFilters({ kind, filter, onChange }: FilterProps) {
  const t = useT()
  return (
    <button
      type="button"
      className="mg-issue-link"
      data-act="issue-filter-clear"
      onClick={() => onChange(clearIssueFilter(filter, kind))}
    >
      {t('issue.filter.reset')}
    </button>
  )
}

/** 带方框的勾选项：多选的类型和“只看”开关共用 */
function CheckOption({
  checked,
  label,
  data,
  onToggle,
}: {
  checked: boolean
  label: string
  data: Record<string, string>
  onToggle(): void
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: 原生的复选框画不成带边框的勾选项
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      className="mg-issue-check"
      {...data}
      onClick={onToggle}
    >
      <span className="mg-issue-box" aria-hidden="true">
        {checked ? <Check /> : null}
      </span>
      {label}
    </button>
  )
}

/**
 * 筛选的几行。宽屏是两列网格（标签、控件），清除和排序在最后一行右端；
 * 浮层里（stacked）标签在控件上面，排序单独一行，清除在浮层外的按钮旁。
 */
function IssueFilterFields({ stacked, ...props }: FilterProps & { stacked: boolean }) {
  const t = useT()
  const { discussions, kind, filter, onChange } = props
  const ordinary = kind === 'ordinary'
  // 设备不支持讨论时 issue 页签只有一种类型，没什么可勾，这一行不出
  const kinds = ordinary && discussions ? MANAGER_ISSUE_KINDS : []
  const checked = kinds.filter((one) => issueKindChecked(filter, one)).length
  const choice = readIssueStatus(filter.statuses, filter.kinds) ?? {
    group: DEFAULT_ISSUE_STATUS_GROUP,
    detail: null,
  }
  const details = issueStatusDetails(choice.group, filter.kinds)
  const [detailOpen, setDetailOpen] = useState(false)
  // 细分默认收起；正选着某个细分状态时（比如编号定位来的）必须看得见
  const showDetail = details.length > 0 && (detailOpen || choice.detail !== null)
  const count = issueActiveFilterCount(filter, kind)
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
  const only: { key: string; label: string; checked: boolean; onToggle(): void }[] = [
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
  const sort = (
    <label className="mg-issue-order">
      {stacked ? null : <span className="mg-issue-order-label">{t('manager.order')}</span>}
      <select
        data-issue-filter="order"
        aria-label={t('manager.order')}
        value={filter.order}
        onChange={(event) =>
          onChange({ ...filter, order: event.target.value as ManagerIssueFilter['order'] })
        }
      >
        {MANAGER_ISSUE_LIST_ORDERS.map((one) => (
          <option key={one} value={one}>
            {t(`issue.order.${one}`)}
          </option>
        ))}
      </select>
    </label>
  )
  // 宽屏最后一行的右端：清除筛选（有生效的才出）和排序
  const end = stacked ? null : (
    <span className="mg-issue-fend">
      {count ? <ClearFilters {...props} /> : null}
      {sort}
    </span>
  )
  return (
    <div className={stacked ? 'mg-issue-fields stacked' : 'mg-issue-fields'}>
      {kinds.length ? (
        <>
          <span className="mg-issue-flabel">{t('issue.filter.kind')}</span>
          {/* biome-ignore lint/a11y/useSemanticElements: 网格里的一格，标签在左边一列，fieldset 的边框和 legend 用不上 */}
          <div className="mg-issue-fctl" role="group" aria-label={t('issue.filter.kind')}>
            {kinds.map((one) => (
              <CheckOption
                key={one}
                checked={issueKindChecked(filter, one)}
                label={t(`issue.kind.${one}`)}
                data={{ 'data-issue-filter-kind': one }}
                onToggle={() => onChange(toggleIssueKind(filter, one))}
              />
            ))}
            <span className="mg-issue-fnote" data-issue-kind-count>
              {t('issue.filter.kindCount', { n: checked, total: kinds.length })}
            </span>
            <button
              type="button"
              className="mg-issue-link"
              data-issue-filter-kind="all"
              aria-pressed={checked === kinds.length}
              disabled={checked === kinds.length}
              onClick={() => onChange(withIssueKinds(filter, []))}
            >
              {t('issue.filter.selectAll')}
            </button>
          </div>
        </>
      ) : null}
      <span className="mg-issue-flabel">{t('issue.filter.status')}</span>
      <div className="mg-issue-fctl">
        <div className="mg-issue-seg" role="radiogroup" aria-label={t('issue.filter.status')}>
          {issueStatusGroups(filter.kinds).map((group) => (
            // biome-ignore lint/a11y/useSemanticElements: 原生的单选框画不成分段
            <button
              type="button"
              role="radio"
              key={group}
              aria-checked={choice.group === group}
              data-issue-filter-status={group}
              onClick={() => onChange(withIssueStatusGroup(filter, group))}
            >
              {t(`issue.group.${group}`)}
            </button>
          ))}
        </div>
        {details.length ? (
          <button
            type="button"
            className="mg-issue-link mg-issue-detail-toggle"
            data-act="issue-filter-detail"
            aria-expanded={showDetail}
            disabled={choice.detail !== null}
            onClick={() => setDetailOpen(!showDetail)}
          >
            {t('issue.filter.detail')}
            <Caret />
          </button>
        ) : null}
        {ordinary ? null : end}
      </div>
      {showDetail ? (
        <>
          <span className="mg-issue-flabel sub" aria-hidden="true" />
          <div className="mg-issue-fctl">
            <div
              className="mg-issue-seg small"
              role="radiogroup"
              aria-label={t('issue.filter.detail')}
              data-issue-filter-details
            >
              {[null, ...details].map((status) => (
                // biome-ignore lint/a11y/useSemanticElements: 原生的单选框画不成分段
                <button
                  type="button"
                  role="radio"
                  key={status ?? 'any'}
                  aria-checked={choice.detail === status}
                  data-issue-filter-detail={status ?? 'any'}
                  onClick={() => onChange(withIssueStatusDetail(filter, choice.group, status))}
                >
                  {t(status ? `issue.status.${status}` : 'issue.filter.detailAny')}
                </button>
              ))}
            </div>
          </div>
        </>
      ) : null}
      {ordinary ? (
        <>
          <span className="mg-issue-flabel">{t('issue.filter.only')}</span>
          {/* biome-ignore lint/a11y/useSemanticElements: 网格里的一格，标签在左边一列，fieldset 的边框和 legend 用不上 */}
          <div className="mg-issue-fctl" role="group" aria-label={t('issue.filter.only')}>
            {only.map((one) => (
              <CheckOption
                key={one.key}
                checked={one.checked}
                label={one.label}
                data={{ 'data-issue-chip': one.key }}
                onToggle={one.onToggle}
              />
            ))}
            {end}
          </div>
        </>
      ) : null}
      {stacked ? (
        <>
          <span className="mg-issue-flabel">{t('manager.order')}</span>
          <div className="mg-issue-fctl">{sort}</div>
        </>
      ) : null}
    </div>
  )
}
