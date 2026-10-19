// 一个 harness 的安装那一行：版本（已装、验证版、最新）、按钮（安装验证版，下拉可选最新版；装了且有更新给“更新到”；
// 不是验证过的标“未验证”）、进行中的日志末尾、没装成时的回退（原因、可展开的日志、可复制的官方命令、官方说明、
// “装好后重新检测”）。设备页的 harness 块、新建页“没有可用的 harness”、首启引导第一步共用这一个。
// 设备不能装（没有这个能力）时什么都不画，用的地方照原来的说明显示。
import type { DeviceView, HarnessVersionView, InstallJobView, InstallTopicView } from '@litch/core'
import { type MouseEvent, useId, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { whyNot } from '../app/errors.ts'
import { useServices } from '../app/services.tsx'
import { showToast } from '../app/toasts.tsx'
import { type InstallOffer, installChoice, logTail, phaseOf, runningJob } from './logic.ts'

/** 进行中只露出最后这么几行 */
const TAIL_LINES = 4

interface InstallRowProps {
  device: DeviceView
  harnessId: string
  /** 这台设备的安装情况（useInstall）。没有就是不能装 */
  view: InstallTopicView | undefined
  /** 名字。设备上没列这个 harness 时用标识 */
  name: string
  /** 紧凑：新建页和引导里只要按钮和要紧的话，版本那一行收进提示 */
  compact?: boolean
}

/** 官方说明的链接：桌面外壳里交给系统浏览器，普通浏览器里开新标签 */
export function DocsLink({ href, children }: { href: string; children: string }) {
  if (!/^https?:\/\//i.test(href)) return null
  const open = (event: MouseEvent) => {
    const shell = window.litchShell
    if (!shell) return
    event.preventDefault()
    shell.openExternal(href)
  }
  return (
    <a className="inst-docs" href={href} target="_blank" rel="noreferrer" onClick={open}>
      {children}
    </a>
  )
}

/** 可以复制的一条命令 */
function CopyCommand({ command }: { command: string }) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard?.writeText(command).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <div className="cfail-cmd inst-cmd">
      <code className="mono">{command}</code>
      <button type="button" className="mini" data-act="copy-install" onClick={copy}>
        {t(copied ? 'devices.guide.copied' : 'devices.guide.copy')}
      </button>
    </div>
  )
}

/** 版本那一行：已装 2.1.286 · 验证版 2.1.282 · 最新 2.1.303 */
function Versions({ info, loading }: { info: HarnessVersionView; loading: boolean }) {
  const t = useT()
  const parts = [
    info.installed
      ? t('install.installed', { version: info.installed })
      : t('install.notInstalled'),
    info.verified ? t('install.verified', { version: info.verified }) : null,
    info.latest ? t('install.latest', { version: info.latest }) : null,
  ].filter((part): part is string => part !== null)
  return (
    <span className="inst-vers" data-install-versions>
      <span className="mono">{parts.join(' · ')}</span>
      {loading ? <span className="dim"> {t('install.checkingLatest')}</span> : null}
      {info.latestError ? (
        <span className="dim inst-noLatest" data-latest-error>
          {' '}
          {t('install.noLatest', { reason: t.said(info.latestError) })}
        </span>
      ) : null}
    </span>
  )
}

/** 没装成：原因一句、可展开的日志、官方命令、官方说明、装好后重新检测 */
function Fallback(props: {
  info: HarnessVersionView
  job: InstallJobView | null
  onRecheck(): void
  rechecking: boolean
}) {
  const { info, job, onRecheck, rechecking } = props
  const t = useT()
  const [showLog, setShowLog] = useState(false)
  const logId = useId()
  const reason = job?.failure
    ? t.said(job.failure)
    : job?.state === 'lost'
      ? t('install.lost')
      : null
  return (
    <div className="inst-fallback" data-install-fallback>
      {reason ? (
        <div className="inst-fail" data-install-failure>
          {t('install.failed', { reason })}
        </div>
      ) : null}
      {job && job.log.length > 0 ? (
        <div className="inst-logfold">
          <button
            type="button"
            className="mini"
            data-act="install-log"
            aria-expanded={showLog}
            aria-controls={showLog ? logId : undefined}
            onClick={() => setShowLog((open) => !open)}
          >
            {t(showLog ? 'install.log.hide' : 'install.log.show', { lines: job.log.length })}
          </button>
          {showLog ? (
            <pre id={logId} className="inst-log mono" data-install-log="full">
              {job.log.join('\n')}
            </pre>
          ) : null}
        </div>
      ) : null}
      <div className="inst-manual">
        <span>{t('install.manual')}</span>
        {info.manual ? <CopyCommand command={info.manual} /> : null}
      </div>
      <div className="inst-acts">
        <DocsLink href={info.docsUrl}>{t('install.docs')}</DocsLink>
        <button
          type="button"
          className="btn"
          data-act="install-recheck"
          disabled={rechecking}
          onClick={onRecheck}
        >
          {t(rechecking ? 'install.rechecking' : 'install.recheck')}
        </button>
      </div>
    </div>
  )
}

function offerLabel(offer: InstallOffer, t: ReturnType<typeof useT>): string {
  if (offer.update) return t('install.update', { version: offer.version })
  return t(offer.target === 'verified' ? 'install.verifiedBtn' : 'install.latestBtn', {
    version: offer.version,
  })
}

export function InstallRow({ device, harnessId, view, name, compact = false }: InstallRowProps) {
  const { channel } = useServices()
  const t = useT()
  const [starting, setStarting] = useState(false)
  const [more, setMore] = useState(false)
  const [rechecking, setRechecking] = useState(false)
  /** 点过“装好后重新检测”的那次任务：它的失败不再挡着 */
  const [cleared, setCleared] = useState<string | null>(null)
  const info = view?.versions?.find((entry) => entry.harness === harnessId)
  if (view?.available !== true) return null
  if (!info) {
    return view.loading ? (
      <div className="inst-row" data-install={harnessId} data-phase="loading">
        <span className="dim">{t('install.loading')}</span>
      </div>
    ) : null
  }
  const phase = phaseOf(view, harnessId, cleared)
  const job = view.jobs.find((entry) => entry.harness === harnessId) ?? null
  const busy = runningJob(view)
  const choice = installChoice(info)

  const start = async (offer: InstallOffer) => {
    setMore(false)
    setStarting(true)
    setCleared(null)
    try {
      await channel.command('install.start', {
        deviceId: device.id,
        harness: harnessId,
        version: offer.target,
      })
    } catch (error) {
      showToast({
        id: `install:${device.id}:${harnessId}`,
        tone: 'err',
        text: (say) => say('install.startFailed', { name, reason: whyNot(error, say) }),
        lifeMs: 9000,
      })
    } finally {
      setStarting(false)
    }
  }

  /** 装好后重新检测：让设备重启这个 harness（会重新探测），再问一次版本 */
  const recheck = async () => {
    setRechecking(true)
    setCleared(job?.job ?? null)
    try {
      await channel.command('device.harness.restart', { deviceId: device.id, harness: harnessId })
    } catch {
      // 设备上没有这个 harness、它还是起不来：版本那里照实说
    }
    try {
      await channel.command('install.versions', { deviceId: device.id })
    } catch {
      // 问不到就留着上次的
    } finally {
      setRechecking(false)
    }
  }

  const button = (offer: InstallOffer, primary: boolean) => (
    <span className="inst-offer" key={`${offer.target}:${offer.version}`}>
      <button
        type="button"
        className={primary ? 'btn primary' : 'btn'}
        data-act={primary ? 'install' : 'install-more'}
        data-target={offer.target}
        disabled={starting || busy !== null}
        title={busy && busy.harness !== harnessId ? t('install.waitOther') : undefined}
        onClick={() => void start(offer)}
      >
        {offerLabel(offer, t)}
      </button>
      {offer.unverified ? (
        <span className="pill wait" data-unverified title={t('install.unverifiedNote')}>
          {t('install.unverified')}
        </span>
      ) : null}
    </span>
  )

  return (
    <div
      className={compact ? 'inst-row compact' : 'inst-row'}
      data-install={harnessId}
      data-phase={phase}
    >
      {compact && phase !== 'failed' && phase !== 'manual' ? null : (
        <Versions info={info} loading={view.loading === 'latest'} />
      )}
      {phase === 'running' && job ? (
        <div className="inst-running" data-install-running>
          <span className="inst-now">
            <i className="st run" />
            {t('install.running', { version: job.resolved ?? '' })}
          </span>
          <pre className="inst-log mono" data-install-log="tail">
            {logTail(job.log, TAIL_LINES).join('\n') || t('install.started')}
          </pre>
        </div>
      ) : null}
      {phase === 'done' ? (
        <span className="inst-done" data-install-done>
          {t('install.done', { version: info.installed ?? '' })}
        </span>
      ) : null}
      {(phase === 'offer' || phase === 'waiting' || phase === 'failed' || phase === 'done') &&
      choice.primary ? (
        <div className="inst-buttons">
          {button(choice.primary, true)}
          {choice.more ? (
            <button
              type="button"
              className="mini"
              data-act="install-menu"
              aria-expanded={more}
              title={t('install.more')}
              onClick={() => setMore((open) => !open)}
            >
              ▾
            </button>
          ) : null}
          {more && choice.more ? button(choice.more, false) : null}
          {phase === 'waiting' && busy ? (
            <span className="dim">{t('install.waitOther')}</span>
          ) : null}
        </div>
      ) : null}
      {phase === 'failed' || phase === 'manual' ? (
        <Fallback
          info={info}
          job={phase === 'failed' ? job : null}
          onRecheck={() => void recheck()}
          rechecking={rechecking}
        />
      ) : null}
    </div>
  )
}
