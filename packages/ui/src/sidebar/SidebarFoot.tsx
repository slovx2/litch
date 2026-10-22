import { keys } from '@litch/core'
import { useEffect, useState } from 'react'
import type { Page } from '../app/App.tsx'
import { requestSettings } from '../app/actions.ts'
import { LANGS, SKINS, setAppearance, THEMES, useAppearance, useT } from '../app/appearance.ts'
import { Clock, Gear, Palette } from '../app/icons.tsx'
import { usePopover } from '../app/popover.ts'
import { useKey, useServices } from '../app/services.tsx'
import { Choice, LANG_NAMES } from '../settings/Look.tsx'

/** 定时任务：图标右上角是各台设备上没看过的运行一共几条 */
function TasksButton({ on, onOpen }: { on: boolean; onOpen(): void }) {
  const unread = useKey<number>(keys.tasksUnread) ?? 0
  const t = useT()
  return (
    <button
      type="button"
      className={on ? 'sb-btn tasks on' : 'sb-btn tasks'}
      aria-current={on ? 'page' : undefined}
      title={t('tasks.title')}
      onClick={onOpen}
    >
      <span className="sb-btn-ic">
        <Clock />
        {unread > 0 ? (
          <span
            className="sb-count"
            data-unread={unread}
            title={t('tasks.unread', { count: unread })}
          >
            {unread}
          </span>
        ) : null}
      </span>
      <span className="sb-btn-name">{t('sidebar.tasks')}</span>
    </button>
  )
}

/** 外观：往上弹一小块，皮肤、明暗、语言三排，点了当场生效；其余几项到设置页的“外观”里改 */
function LookButton() {
  const look = useAppearance()
  const t = useT()
  const { open, setOpen, root, trigger, pop, onKeyDown } = usePopover()
  return (
    <div className="sb-look" ref={root}>
      <button
        ref={trigger}
        type="button"
        className={open ? 'sb-btn look on' : 'sb-btn look'}
        title={t('sidebar.look')}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="sb-btn-ic">
          <Palette />
        </span>
        <span className="sb-btn-name">{t('sidebar.look')}</span>
      </button>
      {open ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: 键盘事件是从里面的按钮冒上来的
        <div
          className="pick-pop sb-look-pop"
          role="dialog"
          aria-label={t('sidebar.look')}
          ref={pop}
          onKeyDown={onKeyDown}
        >
          <span className="sb-look-row">
            <span>{t('look.skin')}</span>
            <Choice
              name="skin"
              value={look.skin}
              options={SKINS}
              label={(skin) => t(`skin.${skin}`)}
              onPick={(skin) => setAppearance({ skin })}
            />
          </span>
          <span className="sb-look-row">
            <span>{t('look.theme')}</span>
            <Choice
              name="theme"
              value={look.theme}
              options={THEMES}
              label={(theme) => t(`theme.${theme}`)}
              onPick={(theme) => setAppearance({ theme })}
            />
          </span>
          <span className="sb-look-row">
            <span>{t('look.lang')}</span>
            <Choice
              name="lang"
              value={look.lang}
              options={LANGS}
              label={(lang) => LANG_NAMES[lang]}
              onPick={(lang) => setAppearance({ lang })}
            />
          </span>
          <button
            type="button"
            className="sb-look-more"
            onClick={() => {
              setOpen(false)
              requestSettings('look')
            }}
          >
            {t('sidebar.look.more')}
          </button>
        </div>
      ) : null}
    </div>
  )
}

/**
 * 进设置。设备、已归档对话、版本都收在设置页里，开着这三页中的哪一页它都亮着。
 * 提示里带着核心的版本，顺带确认命令这条路是通的
 */
function SettingsButton({ page, onOpen }: { page: Page | null; onOpen(): void }) {
  const { channel } = useServices()
  const [info, setInfo] = useState<{ version: string; mock: boolean } | null>(null)
  const t = useT()
  useEffect(() => {
    const controller = new AbortController()
    channel
      .command('core.info', {}, { signal: controller.signal })
      .then(setInfo)
      .catch(() => {})
    return () => controller.abort()
  }, [channel])
  const tip = [
    t('sidebar.settings'),
    ...(info ? [t('sidebar.core', { version: info.version })] : []),
    ...(info?.mock ? [t('sidebar.mockCore')] : []),
  ].join(' · ')
  const lit = page === 'settings' || page === 'devices' || page === 'archived'
  return (
    <button
      type="button"
      className={lit ? 'sb-btn sb-settings on' : 'sb-btn sb-settings'}
      aria-current={page === 'settings' ? 'page' : undefined}
      aria-label={t('sidebar.settings')}
      title={tip}
      data-core={info?.version}
      data-mock={info?.mock ? '' : undefined}
      onClick={onOpen}
    >
      <span className="sb-btn-ic">
        <Gear />
      </span>
      <span className="sb-btn-name">{t('sidebar.settings')}</span>
    </button>
  )
}

/** 侧栏底部横排三个小按钮：定时任务、外观、设置。图标在上、名字在下，最窄的侧栏里英文也放得下 */
export function SidebarFoot({ page, onPage }: { page: Page | null; onPage(page: Page): void }) {
  return (
    <div className="sb-foot">
      <TasksButton on={page === 'tasks'} onOpen={() => onPage('tasks')} />
      <LookButton />
      <SettingsButton page={page} onOpen={() => onPage('settings')} />
    </div>
  )
}
