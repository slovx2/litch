// 模型等级排序页里的一条阶梯、未分级区和每一行。规则在 ranking-view.ts（手机同一份）。
// 一行只有拖动手柄、模型名和 harness 徽标；手柄能拖，点开是调级菜单，Alt+↑/↓ 直接升降一级。
import type { DeviceView, ModelRankingConfig } from '@litch/core'
import { type DragEvent, type KeyboardEvent, type ReactNode, useState } from 'react'
import { useT } from '../../app/appearance.ts'
import { badgeOf, nameOf } from '../../app/device.ts'
import { Icon } from '../../app/icons.tsx'
import { usePopover } from '../../app/popover.ts'
import {
  canDrop,
  canRank,
  type DropTarget,
  gapsOf,
  type Ladder,
  ladderFor,
  type RankAction,
  type RankedModel,
} from './ranking-view.ts'

export interface RankEditor {
  device: DeviceView | undefined
  draft: ModelRankingConfig
  busy: boolean
  /** 正拖着的模型 */
  dragging: string | null
  setDragging(key: string | null): void
  rank(key: string, action: RankAction): void
  drop(key: string, target: DropTarget): void
}

const sameTarget = (a: DropTarget | null, b: DropTarget) => JSON.stringify(a) === JSON.stringify(b)

/** 一块能接住拖放的地方：拖着能落的模型经过时亮起来 */
function useDropZone(editor: RankEditor, target: DropTarget, accepts: (key: string) => boolean) {
  const [over, setOver] = useState<DropTarget | null>(null)
  const ok = editor.dragging !== null && accepts(editor.dragging)
  return {
    active: ok && sameTarget(over, target),
    props: {
      onDragOver: (event: DragEvent) => {
        if (!ok) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        setOver(target)
      },
      onDragLeave: () => setOver(null),
      onDrop: (event: DragEvent) => {
        event.preventDefault()
        setOver(null)
        if (ok && editor.dragging) editor.drop(editor.dragging, target)
        editor.setDragging(null)
      },
    },
  }
}

/** 一条阶梯：开关关着时上面有 harness 的名字和级数 */
export function RankLadder({ editor, ladder }: { editor: RankEditor; ladder: Ladder }) {
  const t = useT()
  const accepts = (key: string) => canDrop(editor.draft, key, ladder)
  const gaps = gapsOf(ladder, editor.draft.tiers.length)
  return (
    <div className="rk-ladder" data-harness={ladder.harness ?? 'all'}>
      {ladder.harness ? (
        <div className="rk-ladder-head">
          <span className="chip">{badgeOf(editor.device, ladder.harness)}</span>
          <b>{nameOf(editor.device, ladder.harness, t)}</b>
          <span className="mng-sum">{t('ranking.levels', { count: ladder.levels.length })}</span>
        </div>
      ) : null}
      <Gap editor={editor} at={gaps[0] ?? 0} accepts={accepts} />
      {ladder.levels.map((level, index) => (
        <div key={level.tier} className="rk-step">
          <Level editor={editor} tier={level.tier} accepts={accepts}>
            <span className="rk-level-num">{t('ranking.level', { level: level.number })}</span>
            <div className="rk-level-rows">
              {level.members.map((model) => (
                <RankRow
                  key={model.key}
                  editor={editor}
                  model={model}
                  badge={ladder.harness === null}
                />
              ))}
            </div>
          </Level>
          <Gap editor={editor} at={gaps[index + 1] ?? 0} accepts={accepts} />
        </div>
      ))}
    </div>
  )
}

function Level({
  editor,
  tier,
  accepts,
  children,
}: {
  editor: RankEditor
  tier: number
  accepts(key: string): boolean
  children: ReactNode
}) {
  const zone = useDropZone(editor, { kind: 'join', tier }, accepts)
  return (
    <div className="rk-level" data-tier={tier} data-over={zone.active} {...zone.props}>
      {children}
    </div>
  )
}

/** 两级之间的缝：拖着的时候才露出来，落在这里是插成新的一级 */
function Gap({
  editor,
  at,
  accepts,
}: {
  editor: RankEditor
  at: number
  accepts(key: string): boolean
}) {
  const t = useT()
  const zone = useDropZone(editor, { kind: 'gap', at }, accepts)
  const shown = editor.dragging !== null && accepts(editor.dragging)
  return (
    <div className="rk-gap" data-shown={shown} data-over={zone.active} data-at={at} {...zone.props}>
      {zone.active ? <span>{t('ranking.drop.new')}</span> : null}
    </div>
  )
}

/** 未分级的那一区：也能接住拖放 */
export function UnrankedZone({ editor, models }: { editor: RankEditor; models: RankedModel[] }) {
  const t = useT()
  const zone = useDropZone(
    editor,
    { kind: 'unranked' },
    (key) => !editor.draft.unranked.includes(key),
  )
  if (models.length === 0 && editor.dragging === null) return null
  return (
    <div className="rk-unranked" data-over={zone.active} {...zone.props}>
      <div className="rk-ladder-head">
        <b>{t('ranking.unranked')}</b>
        <span className="mng-sum">{models.length}</span>
      </div>
      {models.length ? (
        <p className="mng-sec-note">{t('ranking.unknownNote')}</p>
      ) : (
        <p className="mng-sec-note">{t('ranking.drop.unrank')}</p>
      )}
      <div className="rk-level-rows">
        {models.map((model) => (
          <RankRow key={model.key} editor={editor} model={model} badge />
        ))}
      </div>
    </div>
  )
}

/** 一个模型一行。badge：各 harness 混在一起时（共用阶梯、未分级）才在行尾标 harness，分组时组头已经写了 */
function RankRow({
  editor,
  model,
  badge,
}: {
  editor: RankEditor
  model: RankedModel
  badge: boolean
}) {
  const t = useT()
  const { open, setOpen, root, trigger, pop, onKeyDown } = usePopover()
  const { draft, busy } = editor
  const ranked = !draft.unranked.includes(model.key)
  const able = (action: RankAction) => !busy && canRank(draft, model.key, action)
  const run = (action: RankAction) => {
    setOpen(false)
    editor.rank(model.key, action)
    trigger.current?.focus()
  }
  const onHandleKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = { ArrowUp: -1, ArrowDown: 1 }[event.key]
    if (!step) return
    event.preventDefault()
    if (event.altKey) {
      const action: RankAction = { kind: step < 0 ? 'up' : 'down' }
      if (able(action)) editor.rank(model.key, action)
      return
    }
    // 不按 Alt：在这一节的手柄之间走
    const handles = [
      ...(event.currentTarget
        .closest('[data-model-ranking]')
        ?.querySelectorAll<HTMLButtonElement>('[data-rank-handle]') ?? []),
    ]
    handles[handles.indexOf(event.currentTarget) + step]?.focus()
  }
  // 并入：同一条阶梯上别的等级，从高到低，带上那一级里的模型名方便认
  const others = ladderFor(draft, model).levels.filter(
    (level) => !level.members.some((member) => member.key === model.key),
  )
  const item = (label: string, action: RankAction, extra?: string) => (
    <button
      key={label + JSON.stringify(action)}
      type="button"
      role="menuitem"
      className="pick-opt"
      aria-disabled={!able(action)}
      onClick={() => able(action) && run(action)}
    >
      <b>{label}</b>
      {extra ? <span className="ell">{extra}</span> : null}
    </button>
  )
  return (
    <div
      className="rk-row"
      data-model={model.key}
      data-available={model.available}
      data-dragging={editor.dragging === model.key}
    >
      <span className="rk-menu" ref={root}>
        <button
          ref={trigger}
          type="button"
          className="ibtn rk-grip"
          data-rank-handle={model.key}
          draggable={!busy}
          disabled={busy}
          aria-label={t('ranking.handle', { model: model.name })}
          title={t('ranking.handle.hint')}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          onKeyDown={onHandleKey}
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData('application/litch-model', model.key)
            editor.setDragging(model.key)
          }}
          onDragEnd={() => editor.setDragging(null)}
        >
          <Icon name="grip" small />
        </button>
        {open ? (
          // biome-ignore lint/a11y/noStaticElementInteractions: 键盘事件是从里面的按钮冒上来的
          <div className="pick-pop down rk-pop" ref={pop} onKeyDown={onKeyDown}>
            <div
              role="menu"
              aria-label={t('ranking.handle', { model: model.name })}
              className="pick-list"
            >
              {ranked ? item(t('ranking.menu.up'), { kind: 'up' }) : null}
              {ranked ? item(t('ranking.menu.down'), { kind: 'down' }) : null}
              {ranked ? item(t('ranking.menu.split'), { kind: 'split' }) : null}
              {ranked ? null : item(t('ranking.menu.top'), { kind: 'top' })}
              {ranked ? null : item(t('ranking.menu.bottom'), { kind: 'bottom' })}
              {others.map((level) =>
                item(
                  t('ranking.menu.join', { level: level.number }),
                  { kind: 'join', tier: level.tier },
                  level.members.map((member) => member.name).join(' · '),
                ),
              )}
              {ranked ? item(t('ranking.menu.unrank'), { kind: 'unrank' }) : null}
            </div>
          </div>
        ) : null}
      </span>
      <span className="rk-name ell" title={model.model}>
        {model.name}
      </span>
      {model.provider ? <span className="mng-tag">{model.provider}</span> : null}
      {model.available ? null : <span className="mng-tag">{t('ranking.unavailable')}</span>}
      {badge ? (
        <span className="chip rk-badge" title={nameOf(editor.device, model.harness, t)}>
          {badgeOf(editor.device, model.harness)}
        </span>
      ) : null}
    </div>
  )
}
