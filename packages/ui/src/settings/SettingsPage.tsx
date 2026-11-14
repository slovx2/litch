import type { ReactNode } from 'react'
import { useState } from 'react'
import { useT } from '../app/appearance.ts'
import { Archive, Close, Forward } from '../app/icons.tsx'
import { useServices } from '../app/services.tsx'
import { AddDevice } from '../devices/AddDevice.tsx'
import type { MessageKey } from '../i18n/index.ts'
import { AboutSection } from './About.tsx'
import { AssistSection } from './AssistSection.tsx'
import { BrowserSection } from './BrowserSection.tsx'
import { ChatSection } from './ChatSection.tsx'
import { ChromeSection } from './ChromeSection.tsx'
import { ComputerSection } from './ComputerSection.tsx'
import { computerBridge, computerIntro } from './computer-bridge.ts'
import { DeviceNav } from './DeviceNav.tsx'
import { HarnessSwitches } from './HarnessSwitches.tsx'
import { LangSection, LookSection } from './Look.tsx'
import { NotifySection } from './NotifySection.tsx'
import { ShortcutsSection } from './Shortcuts.tsx'

/**
 * 设置页左边的几组，按这个顺序排。
 * 所有设备在导航中平铺，点入设备及 harness 的独立详情；“已归档对话”打开主页面。computer（Computer Use）只在 macOS 上的桌面外壳里有
 * （外壳给了 window.litchComputerUse 才显示），别的系统和普通浏览器里不出这一组；
 * chrome（代理操作这台电脑上的 Chrome）不是内置浏览器，单独一组，只在桌面外壳里有
 */
export const SETTINGS_SECTIONS = [
  'look',
  'lang',
  'chat',
  'browser',
  'chrome',
  'computer',
  'notify',
  'assist',
  'keys',
  'about',
  'switches',
] as const
type SettingsGroup = (typeof SETTINGS_SECTIONS)[number]
export type SettingsSection = SettingsGroup | 'devices'

export const isSettingsSection = (value: string): value is SettingsSection =>
  value === 'devices' || (SETTINGS_SECTIONS as readonly string[]).includes(value)

/** 这个窗口里看得到的几组 */
const shownSections = (shell: string): SettingsGroup[] =>
  SETTINGS_SECTIONS.filter(
    (id) =>
      (id !== 'computer' || computerBridge() !== undefined) &&
      (id !== 'chrome' || shell === 'electron'),
  )

const TITLES: Record<SettingsSection, MessageKey> = {
  devices: 'devices.title',
  look: 'settings.group.look',
  lang: 'settings.group.lang',
  chat: 'settings.group.chat',
  switches: 'settings.group.switches',
  browser: 'settings.group.browser',
  chrome: 'chrome.title',
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
  chrome: 'chrome.note',
  computer: 'settings.computer.intro',
  notify: 'settings.notify.intro',
  assist: 'settings.assist.intro',
}

interface SettingsPageProps {
  /** 正看着哪一组。记在外面：应用菜单的“关于”要能直接开到那一组 */
  section: SettingsSection
  onSection(section: SettingsSection): void
  onClose(): void
  /** 进入设置窗口内的设备列表 */
  onDevices(): void
  activeDevice: string | null
  onDevice(deviceId: string): void
  /** 设备列表、设备详情及 harness 详情共用设置窗口。 */
  devices: ReactNode
  /** 去“已归档对话”那一页 */
  onArchived(): void
}

/**
 * 设置模态窗口：左边是分组，右边显示当前设置或设备与 harness 详情。
 * 侧栏底部只留了定时任务和进这里的齿轮，那两页的入口放在左边分组的上面。
 * 本机偏好改了当场生效；设备与 harness 的配置沿用原有保存/离开确认。
 */
export function SettingsPage({
  section: asked,
  onSection,
  onClose,
  onDevices,
  activeDevice,
  onDevice,
  devices,
  onArchived,
}: SettingsPageProps) {
  const t = useT()
  const { shell } = useServices()
  const [adding, setAdding] = useState(false)
  const sections = shownSections(shell)
  // 要的那一组这里没有（不是 macOS 却要开 Computer Use）：落到第一组
  const section = asked === 'devices' || sections.includes(asked) ? asked : 'look'
  const intro = section === 'computer' ? computerIntro() : INTROS[section]

  return (
    <div className="set-page">
      <nav className="set-nav" aria-label={t('settings.nav')}>
        <h1>{t('settings.title')}</h1>
        <DeviceNav
          active={section === 'devices' ? activeDevice : null}
          onDevice={onDevice}
          onDevices={onDevices}
          onAdd={() => setAdding(true)}
        />
        <hr className="set-nav-rule" />
        <h2 className="set-nav-label">{t('settings.general')}</h2>
        {sections
          .filter((id) => id !== 'switches')
          .map((id) => (
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
        <hr className="set-nav-rule" />
        <h2 className="set-nav-label">{t('settings.shared')}</h2>
        <button
          type="button"
          data-section="switches"
          aria-current={section === 'switches' ? 'page' : undefined}
          onClick={() => onSection('switches')}
        >
          {t(TITLES.switches)}
        </button>
        <button type="button" className="set-go" data-page="archived" onClick={onArchived}>
          <Archive />
          <span className="grow">{t('archived.title')}</span>
          <Forward />
        </button>
      </nav>
      {section === 'devices' ? (
        <div className="set-devices">{devices}</div>
      ) : (
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
            ) : section === 'chrome' ? (
              <ChromeSection />
            ) : section === 'computer' ? (
              <ComputerSection onDevices={onDevices} />
            ) : section === 'notify' ? (
              <NotifySection />
            ) : section === 'assist' ? (
              <AssistSection onClose={onClose} />
            ) : section === 'keys' ? (
              <ShortcutsSection />
            ) : (
              <AboutSection />
            )}
          </div>
        </div>
      )}
      {adding ? <AddDevice edit={null} onClose={() => setAdding(false)} /> : null}
    </div>
  )
}
