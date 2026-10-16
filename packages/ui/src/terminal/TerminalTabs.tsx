// 终端面板顶上那一条：一排标签、新开，右边是对当前这个终端做的事（改名、清屏）和收起面板。
import { keys, type TerminalInfo } from '@litch/core'
import { useEffect, useRef, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { Close, Down, Icon, Plus } from '../app/icons.tsx'
import { usePopover } from '../app/popover.ts'
import { useKey } from '../app/services.tsx'
import type { Translator } from '../i18n/index.ts'

export const terminalName = (info: TerminalInfo | undefined, t: Translator): string =>
  info?.title ?? t('terminal.defaultName', { n: info?.seq ?? 1 })

export interface TabActions {
  pick(terminalId: string): void
  rename(terminalId: string, title: string): void
  /** leave：收起，留在设备上继续运行；end：结束 */
  close(terminalId: string, mode: 'leave' | 'end'): void
  show(terminalId: string): void
  create(): void
  clear(): void
  hide(): void
}

/** 关标签的那个叉。还在运行的终端点了先问：留在设备上，还是结束 */
function CloseButton({
  info,
  name,
  actions,
}: {
  info: TerminalInfo
  name: string
  actions: TabActions
}) {
  const t = useT()
  const { open, setOpen, close, root, trigger, pop, onKeyDown } = usePopover()
  const live = info.state === 'running' || info.state === 'starting' || info.state === 'away'
  const choose = (mode: 'leave' | 'end') => {
    close(false)
    actions.close(info.id, mode)
  }
  const cancel = (
    <button
      type="button"
      role="menuitem"
      className="pick-opt"
      data-choice="cancel"
      onClick={() => close(true)}
    >
      <b>{t('terminal.close.cancel')}</b>
    </button>
  )
  return (
    <div className="pick term-x" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="ibtn"
        title={t('terminal.close', { name })}
        aria-label={t('terminal.close', { name })}
        aria-haspopup={live ? 'menu' : undefined}
        aria-expanded={live ? open : undefined}
        // 已经结束的没什么可问的，直接关
        onClick={() => (live ? setOpen(!open) : actions.close(info.id, 'end'))}
      >
        <Close />
      </button>
      {open ? (
        <div
          className="pick-pop term-close"
          ref={pop}
          role="menu"
          aria-label={t('terminal.close.running', { name })}
          onKeyDown={onKeyDown}
        >
          <div className="term-close-head">{t('terminal.close.running', { name })}</div>
          {/* 焦点落在第一项上：属于设备的是“留着”，随连接结束的是“不关了”。顺手按回车不会把程序结束掉 */}
          {info.durable ? (
            <button
              type="button"
              role="menuitem"
              className="pick-opt"
              data-choice="leave"
              onClick={() => choose('leave')}
            >
              <b>{t('terminal.close.leave')}</b>
              <span>{t('terminal.close.leaveNote')}</span>
            </button>
          ) : (
            cancel
          )}
          <button
            type="button"
            role="menuitem"
            className="pick-opt term-end"
            data-choice="end"
            onClick={() => choose('end')}
          >
            <b>{t('terminal.close.end')}</b>
            <span>{t('terminal.close.endNote')}</span>
          </button>
          {info.durable ? cancel : null}
        </div>
      ) : null}
    </div>
  )
}

function Tab({
  deviceId,
  terminalId,
  active,
  renaming,
  onRename,
  onRenamed,
  actions,
}: {
  deviceId: string
  terminalId: string
  active: boolean
  renaming: boolean
  onRename(): void
  /** 改名结束了（改了或者没改） */
  onRenamed(): void
  actions: TabActions
}) {
  const t = useT()
  const info = useKey<TerminalInfo>(keys.terminal(deviceId, terminalId))
  const input = useRef<HTMLInputElement>(null)
  /** 这一次改名已经有结果了：输入框收起时还会再丢一次焦点，那一次不算 */
  const settled = useRef(false)
  useEffect(() => {
    if (!renaming) return
    settled.current = false
    input.current?.select()
  }, [renaming])
  if (!info) return null
  const name = terminalName(info, t)
  const finish = (apply: boolean) => {
    if (settled.current) return
    settled.current = true
    const next = input.current?.value.trim() ?? ''
    if (apply && next !== (info.title ?? '')) actions.rename(terminalId, next)
    onRenamed()
  }
  return (
    <div
      className="term-tab"
      role="presentation"
      data-terminal={terminalId}
      data-state={info.state}
      data-active={active}
    >
      {renaming ? (
        <input
          ref={input}
          className="term-rename"
          aria-label={t('terminal.renameLabel')}
          defaultValue={info.title ?? ''}
          placeholder={t('terminal.defaultName', { n: info.seq })}
          maxLength={120}
          onBlur={() => finish(true)}
          onKeyDown={(event) => {
            // 输入法正在选字的回车不算
            if (event.nativeEvent.isComposing) return
            if (event.key === 'Enter') finish(true)
            else if (event.key === 'Escape') {
              event.stopPropagation()
              finish(false)
            }
          }}
        />
      ) : (
        <button
          type="button"
          role="tab"
          className="term-tab-btn"
          aria-selected={active}
          title={info.cwd ?? name}
          onClick={() => actions.pick(terminalId)}
          // 双击改名：右边有同样作用的按钮，这只是快一点的入口
          onDoubleClick={onRename}
        >
          <i className="term-dot" />
          <span className="ell">{name}</span>
        </button>
      )}
      <CloseButton info={info} name={name} actions={actions} />
    </div>
  )
}

function StowedRow({
  deviceId,
  terminalId,
  actions,
}: {
  deviceId: string
  terminalId: string
  actions: TabActions
}) {
  const t = useT()
  const info = useKey<TerminalInfo>(keys.terminal(deviceId, terminalId))
  if (!info) return null
  return (
    <div className="term-stowed-row" data-terminal={terminalId}>
      <span className="ell" title={info.cwd ?? undefined}>
        {terminalName(info, t)}
      </span>
      <button
        type="button"
        className="mini"
        data-choice="attach"
        onClick={() => actions.show(terminalId)}
      >
        {t('terminal.stowed.attach')}
      </button>
      <button
        type="button"
        className="mini term-end"
        data-choice="end"
        onClick={() => actions.close(terminalId, 'end')}
      >
        {t('terminal.stowed.end')}
      </button>
    </div>
  )
}

/** 留在设备上、没开成标签的那些：列出来，能接回、能结束 */
function Stowed({
  deviceId,
  ids,
  actions,
}: {
  deviceId: string
  ids: string[]
  actions: TabActions
}) {
  const t = useT()
  const { open, setOpen, root, trigger, pop, onKeyDown } = usePopover()
  // 最后一个也接回去了：浮层跟着收起
  useEffect(() => {
    if (ids.length === 0) setOpen(false)
  }, [ids.length, setOpen])
  if (ids.length === 0) return null
  return (
    <div className="pick term-stowed" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="mini"
        title={t('terminal.stowed.note')}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {t('terminal.stowed')} · {ids.length}
      </button>
      {open ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: 键盘事件是从里面的按钮冒上来的
        <div className="pick-pop term-stowed-pop" ref={pop} onKeyDown={onKeyDown}>
          <div className="term-close-head">{t('terminal.stowed.note')}</div>
          {ids.map((id) => (
            <StowedRow key={id} deviceId={deviceId} terminalId={id} actions={actions} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function TerminalTabs({
  deviceId,
  ids,
  activeId,
  stowed,
  durable,
  canCreate,
  actions,
}: {
  deviceId: string
  ids: string[]
  activeId: string | null
  /** 这一组里留在设备上没开成标签的 */
  stowed: string[]
  /** 这台设备上的终端是不是属于设备的。null：还不知道 */
  durable: boolean | null
  canCreate: boolean
  actions: TabActions
}) {
  const t = useT()
  /** 正在改名的那个标签 */
  const [renaming, setRenaming] = useState<string | null>(null)
  const active = useKey<TerminalInfo>(keys.terminal(deviceId, activeId ?? ''))
  return (
    <div className="term-bar">
      <div className="term-tabs" role="tablist" aria-label={t('terminal.tabs')}>
        {ids.map((id) => (
          <Tab
            key={id}
            deviceId={deviceId}
            terminalId={id}
            active={id === activeId}
            renaming={renaming === id}
            onRename={() => setRenaming(id)}
            onRenamed={() => setRenaming(null)}
            actions={actions}
          />
        ))}
        <button
          type="button"
          className="ibtn term-new"
          title={t('terminal.new')}
          aria-label={t('terminal.new')}
          disabled={!canCreate}
          onClick={actions.create}
        >
          <Plus />
        </button>
      </div>
      <div className="term-tools">
        {durable === false ? (
          <span className="pill mute term-eph" title={t('terminal.ephemeral.note')}>
            {t('terminal.ephemeral')}
          </span>
        ) : null}
        {active?.cwd ? (
          <span className="term-cwd ell" title={active.cwd}>
            {active.cwd}
          </span>
        ) : null}
        <Stowed deviceId={deviceId} ids={stowed} actions={actions} />
        {activeId ? (
          <>
            <button
              type="button"
              className="ibtn"
              data-tool="rename"
              title={t('terminal.rename')}
              aria-label={t('terminal.rename')}
              onClick={() => setRenaming(activeId)}
            >
              <Icon name="edit" small />
            </button>
            <button type="button" className="mini" data-tool="clear" onClick={actions.clear}>
              {t('terminal.clear')}
            </button>
          </>
        ) : null}
        <button
          type="button"
          className="ibtn"
          data-tool="hide"
          title={t('terminal.hide')}
          aria-label={t('terminal.hide')}
          onClick={actions.hide}
        >
          <Down />
        </button>
      </div>
    </div>
  )
}
