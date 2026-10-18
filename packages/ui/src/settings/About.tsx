import { useEffect, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { Fold } from '../app/Fold.tsx'
import { Icon } from '../app/icons.tsx'
import { useServices } from '../app/services.tsx'
import { showToast } from '../app/toasts.tsx'
import type { LicenseEntry, ShellAbout } from '../boot/channel.ts'
import iconUrl from './litch-icon.png'
import { UpdateBlock } from './UpdateBlock.tsx'

/** 项目主页。显示成文字，可以选、可以复制；不做成点了就跳走的链接 */
export const PROJECT_HOME = 'https://github.com/slovx2/litch'

function copy(text: string): void {
  navigator.clipboard.writeText(text).then(
    () => showToast({ id: 'about-copied', lifeMs: 2500, text: (t) => t('files.copied', { text }) }),
    () =>
      showToast({
        id: 'about-copied',
        tone: 'err',
        lifeMs: 5000,
        text: (t) => t('files.copyFailed'),
      }),
  )
}

/** 一份许可文本：一行标题，点开在下面看全文。全文点开的时候才向外壳要 */
function LicenseRow({ entry, title }: { entry: LicenseEntry; title: string }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  /** undefined：还没取；null：没取到 */
  const [body, setBody] = useState<string | null | undefined>(undefined)
  const id = `lic-${entry.id.replace(/[^\w-]/g, '_')}`

  useEffect(() => {
    if (!open || body !== undefined) return
    let dropped = false
    const shell = window.litchShell
    if (!shell) return setBody(null)
    shell.licenseText(entry.id).then(
      (text) => {
        if (!dropped) setBody(text)
      },
      () => {
        if (!dropped) setBody(null)
      },
    )
    return () => {
      dropped = true
    }
  }, [open, body, entry.id])

  return (
    <div className="lic" data-license={entry.id} data-open={open}>
      <div className="set-row lic-row">
        <Fold open={open} onToggle={() => setOpen(!open)} controls={id} className="lic-fold">
          <span className="lic-name">{title}</span>
          {entry.version ? <span className="lic-version">{entry.version}</span> : null}
        </Fold>
        {entry.license ? <span className="lic-kind">{entry.license}</span> : null}
      </div>
      {open ? (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: 全文很长，在这一块里自己滚；能拿焦点，键盘才滚得动
        <pre id={id} className="lic-text" tabIndex={0}>
          {body === undefined
            ? t('settings.about.loading')
            : body === null
              ? t('settings.about.missing')
              : body}
        </pre>
      ) : null}
    </div>
  )
}

/**
 * 关于：应用的名字和版本、项目主页、许可。
 * 版本和许可文本是桌面外壳给的（装好的应用从资源目录里读）；没有外壳（浏览器里）或者没打包时拿不到的，照实说
 */
export function AboutSection() {
  const { channel, shell } = useServices()
  const t = useT()
  const [about, setAbout] = useState<ShellAbout | null>(null)
  const [core, setCore] = useState<{ version: string; mock: boolean } | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    channel
      .command('core.info', {}, { signal: controller.signal })
      .then(setCore)
      .catch(() => {})
    let dropped = false
    window.litchShell?.about().then(
      (info) => {
        if (!dropped) setAbout(info)
      },
      () => {},
    )
    return () => {
      dropped = true
      controller.abort()
    }
  }, [channel])

  // 没有外壳的时候，版本就是核心报的那一个（两边本来就是同一个数）
  const version = about?.version ?? core?.version ?? ''
  return (
    <>
      <section className="set-block about-hero">
        <img className="about-icon" src={iconUrl} alt="" width={64} height={64} />
        <div className="about-who">
          <b className="about-name">{about?.name ?? 'Litch'}</b>
          <span>{t('settings.about.tagline')}</span>
          <span className="about-version" data-version={version}>
            {version ? t('settings.about.version', { version }) : '…'}
            {core?.mock ? <span className="pill mute">{t('sidebar.mockCore')}</span> : null}
          </span>
          {about ? (
            <span className="about-runtime">
              Electron {about.electron} · Chromium {about.chrome}
            </span>
          ) : null}
        </div>
      </section>
      <UpdateBlock />
      <section className="set-block">
        <div className="set-rows">
          <div className="set-row">
            <span className="set-label">{t('settings.about.home')}</span>
            <span className="about-home">{PROJECT_HOME}</span>
            <button
              type="button"
              className="mini"
              data-act="copy-home"
              onClick={() => copy(PROJECT_HOME)}
            >
              <Icon name="copy" small />
              {t('settings.about.copy')}
            </button>
          </div>
        </div>
      </section>
      <section className="set-block" data-licenses={shell === 'electron' ? 'shell' : 'none'}>
        <h3>
          {t('settings.about.licenses')}
          <span>{t('settings.about.licenses.note')}</span>
        </h3>
        {shell !== 'electron' ? (
          <p className="set-para">{t('settings.about.browser')}</p>
        ) : about ? (
          <>
            <div className="set-rows">
              {about.project ? (
                <LicenseRow entry={about.project} title={t('settings.about.project')} />
              ) : null}
              {about.notices ? (
                <LicenseRow entry={about.notices} title={t('settings.about.notices')} />
              ) : null}
            </div>
            <h4 className="set-sub">
              {t('settings.about.packages')}
              {about.packages ? (
                <span>{t('settings.about.packages.count', { count: about.packages.length })}</span>
              ) : null}
            </h4>
            {about.packages ? (
              <div className="set-rows" data-packages={about.packages.length}>
                {about.packages.map((entry) => (
                  <LicenseRow key={entry.id} entry={entry} title={entry.name} />
                ))}
              </div>
            ) : (
              <p className="set-para" data-packages="none">
                {t('settings.about.unbundled')}
              </p>
            )}
          </>
        ) : (
          <p className="set-para">{t('settings.about.loading')}</p>
        )}
      </section>
    </>
  )
}
