import { useEffect } from 'react'
import { useT } from '../app/appearance.ts'
import { Archive, Close, Forward, Machine } from '../app/icons.tsx'
import type { MessageKey } from '../i18n/index.ts'
import { AboutSection } from './About.tsx'
import { AssistSection } from './AssistSection.tsx'
import { BrowserSection } from './BrowserSection.tsx'
import { ChatSection } from './ChatSection.tsx'
import { ComputerSection } from './ComputerSection.tsx'
import { computerBridge, computerIntro } from './computer-bridge.ts'
import { HarnessSwitches } from './HarnessSwitches.tsx'
import { LangSection, LookSection } from './Look.tsx'
import { NotifySection } from './NotifySection.tsx'
import { ShortcutsSection } from './Shortcuts.tsx'

/**
 * 设置页左边的几组，按这个顺序排。
 * “设备”“已归档对话”不是这里的组，是左上角直接进那两页的入口。computer（Computer Use）只在 macOS 上的桌面外壳里有
 * （外壳给了 window.litchComputerUse 才显示），别的系统和普通浏览器里不出这一组
 */
export const SETTINGS_SECTIONS = [
  'look',
  'lang',
  'chat',
  'switches',
  'browser',
  'computer',
  'notify',
  'assist',
  'keys',
  'about',
] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

export const isSettingsSection = (value: string): value is SettingsSection =>
  (SETTINGS_SECTIONS as readonly string[]).includes(value)

/** 这个窗口里看得到的几组 */
const shownSections = (): SettingsSection[] =>
  SETTINGS_SECTIONS.filter((id) => id !== 'computer' || computerBridge() !== undefined)

const TITLES: Record<SettingsSection, MessageKey> = {
  look: 'settings.group.look',
  lang: 'settings.group.lang',
  chat: 'settings.group.chat',
  switches: 'settings.group.switches',
  browser: 'settings.group.browser',
  computer: 'settings.group.computer',
  notify: 'settings.group.notify',
  assist: 'settings.group.assist',
  keys: 'settings.group.keys',
  about: 'settings.group.about',
}
/** 组标题下的一句说明：只有这一组有不明显的范围或后果时才写，其余组不写 */
const INTROS: Partial<Record<SettingsSection, MessageKey>> = {
  switches: 'settings.switches.intro',
  browser: 'settings.browser.intro',
  computer: 'settings.computer.intro',
  notify: 'settings.notify.intro',
  assist: 'settings.assist.intro',
}

interface SettingsPageProps {
  /** 正看着哪一组。记在外面：应用菜单的“关于”要能直接开到那一组 */
  section: SettingsSection
  onSection(section: SettingsSection): void
  onClose(): void
  /** 去“设备”那一页：设备和 harness 的管理都在那边，这里只留一个入口 */
  onDevices(): void
  /** 去“已归档对话”那一页 */
  onArchived(): void
}

/**
 * 设置：和“设备”“已归档对话”一样占着对话区的一整页。左边是分组，右边一次只放一组的内容。
 * 侧栏底部只留了定时任务和进这里的齿轮，那两页的入口放在左边分组的上面。
 * 这里的每一项都是这台电脑上的偏好，改了当场生效，没有“保存”
 */
export function SettingsPage({
  section: asked,
  onSection,
  onClose,
  onDevices,
  onArchived,
}: SettingsPageProps) {
  const t = useT()
  const sections = shownSections()
  // 要的那一组这里没有（不是 macOS 却要开 Computer Use）：落到第一组
  const section = sections.includes(asked) ? asked : 'look'
  const intro = section === 'computer' ? computerIntro() : INTROS[section]

  // Esc 回到对话
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="set-page">
      <nav className="set-nav" aria-label={t('settings.nav')}>
        <h1>{t('settings.title')}</h1>
        <button type="button" className="set-go" data-page="devices" onClick={onDevices}>
          <Machine />
          <span className="grow">{t('sidebar.devices')}</span>
          <Forward />
        </button>
        <button type="button" className="set-go" data-page="archived" onClick={onArchived}>
          <Archive />
          <span className="grow">{t('archived.title')}</span>
          <Forward />
        </button>
        <hr className="set-nav-rule" />
        {sections.map((id) => (
          <button
            key={id}
            type="button"
            data-section={id}
            aria-current={id === section ? 'page' : undefined}
            onClick={() => onSection(id)}
          >
            {t(TITLES[id])}
          </button>
        ))}
      </nav>
      <div className="set-body">
        <header className="set-head">
          <div>
            <h2>{t(TITLES[section])}</h2>
            {intro ? <p>{t(intro)}</p> : null}
          </div>
          <button
            type="button"
            className="ibtn"
            title={t('settings.close')}
            aria-label={t('settings.close')}
            onClick={onClose}
          >
            <Close />
          </button>
        </header>
        <div className="set-content" data-section={section}>
          {section === 'look' ? (
            <LookSection />
          ) : section === 'lang' ? (
            <LangSection />
          ) : section === 'chat' ? (
            <ChatSection />
          ) : section === 'switches' ? (
            // 任务卡、内置浏览器、Computer Use 按“设备 → harness”的开关表
            <HarnessSwitches />
          ) : section === 'browser' ? (
            <BrowserSection />
          ) : section === 'computer' ? (
            <ComputerSection onDevices={onDevices} />
          ) : section === 'notify' ? (
            <NotifySection />
          ) : section === 'assist' ? (
            <AssistSection />
          ) : section === 'keys' ? (
            <ShortcutsSection />
          ) : (
            <AboutSection />
          )}
        </div>
      </div>
    </div>
  )
}
