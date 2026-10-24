// 设备详情里的“设备服务”一节：这台设备上在跑的常驻服务是哪一版、从哪份适配器起的、什么时候起的、怎么起的。
// 本机另外说这一次连接换没换版本——换上了新版说一句；比应用自带的旧而没换成的，说清为什么、该怎么办。
// 远程设备在跑的比应用旧时，这里有一键升级（RemoteUpgrade.tsx）。
// 平时收着，标题后面一个版本号就够看；有“没换成”要说的时候默认开着，可以合上。
// 只在连着的时候有这一节：没连上时在跑的是哪一份说不准，上次知道的不拿出来当现在的。
// 例外是远程设备的一键升级：正在升级（停了服务、正在重连），或者旧到连不上（也给同一个按钮），没连着也摆出来。
// 判断都在 service.ts 里，这里只管摆。
import type { DeviceView, ServiceUpgradeView } from '@litch/core'
import { useEffect, useId, useRef, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { nameOf } from '../app/device.ts'
import { Fold } from '../app/Fold.tsx'
import { useServices } from '../app/services.tsx'
import { showToast } from '../app/toasts.tsx'
import { RemoteUpgradeNote } from './RemoteUpgrade.tsx'
import {
  busyLine,
  endSteps,
  FOREGROUND_STEPS,
  noticeOf,
  olderLine,
  originOf,
  pillOf,
  remotePillOf,
  replacedLine,
  type ServiceNotice,
  staleRemote,
  staleService,
} from './service.ts'
import { GuideSteps } from './status.tsx'

/** “再试一次”有了结果之后的那条提示留多久 */
const TOLD_MS = 6000

/** 命令行的原话，照原样摆出来 */
function Said({ detail }: { detail: string | null }) {
  const t = useT()
  if (!detail) return null
  return (
    <div className="svc-said">
      <span className="devp-note">{t('service.said')}</span>
      <pre className="cfail-detail mono">{detail}</pre>
    </div>
  )
}

interface NoteProps {
  device: DeviceView
  upgrade: ServiceUpgradeView
  notice: ServiceNotice
  /** 点了“再试一次”，正在重新连接 */
  retrying: boolean
  onRetry(): void
}

/** 这一次连接换版本的结果：换上了新版，或者没换成的原因和该怎么办 */
function UpgradeNote({ device, upgrade, notice, retrying, onRetry }: NoteProps) {
  const t = useT()
  if (notice === 'replaced') {
    const line = replacedLine(upgrade)
    return (
      <div className="cfail svc-note" data-service-note="replaced">
        <div className="cfail-text">{t(line.key, line.args)}</div>
      </div>
    )
  }
  const older = olderLine(upgrade)
  const steps = notice === 'unsupported' ? endSteps(upgrade.pid) : []
  return (
    <div className="cfail svc-note" data-service-note={notice}>
      <div className="cfail-text">{t(older.key, older.args)}</div>
      <div className="cfail-text">{t(`service.${notice}`)}</div>
      {notice === 'busy' ? (
        <>
          <ul className="svc-busy">
            {upgrade.busy.map((entry) => {
              const line = busyLine(entry, (id) => nameOf(device, id), t('list.comma'))
              return (
                <li key={`${entry.reason}:${entry.harnesses.join(',')}`} data-busy={entry.reason}>
                  {t(line.key, line.args)}
                </li>
              )
            })}
          </ul>
          <div className="cfail-guide">
            <span>{t('service.busy.next')}</span>
          </div>
          <div className="cfail-acts">
            <button
              type="button"
              className="mini retry"
              data-act="service-retry"
              disabled={retrying}
              onClick={onRetry}
            >
              {t(retrying ? 'service.retrying' : 'service.retry')}
            </button>
          </div>
        </>
      ) : null}
      {notice === 'foreground' ? <GuideSteps steps={FOREGROUND_STEPS} /> : null}
      {notice === 'unsupported' ? (
        steps.length > 0 ? (
          <GuideSteps steps={steps} args={{ pid: upgrade.pid ?? '' }} />
        ) : (
          <div className="cfail-guide">
            <span>{t('service.unsupported.noPid')}</span>
          </div>
        )
      ) : null}
      {notice === 'unsupported' || notice === 'failed' ? <Said detail={upgrade.detail} /> : null}
    </div>
  )
}

export function ServiceSection({
  device,
  reveal = false,
}: {
  device: DeviceView
  /** 一出来就打开、滚到眼前，焦点放到升级按钮上（侧栏设备行上的升级记号点进来的） */
  reveal?: boolean
}) {
  const { channel } = useServices()
  const t = useT()
  const id = useId()
  const { upgrade } = device
  const online = device.connection === 'online'
  // 没连着时在跑的是哪一份说不准：上次知道的不摆出来
  const service = online ? device.service : null
  const remote = device.remoteUpgrade
  const notice = noticeOf(upgrade)
  /** 远程设备的一键升级在进行中，或者有没做成、换上了要说的 */
  const remoteBusy = remote !== null && remote.phase.step !== 'idle'
  const stale = staleService(device) || staleRemote(device) || remoteBusy
  /** 开没开。有“没换成”要说的时候默认开着；之后听用户的，那件事了结了也不自己合上 */
  const [open, setOpen] = useState(stale || reveal)
  useEffect(() => {
    if (stale) setOpen(true)
  }, [stale])
  const box = useRef<HTMLElement>(null)
  // 点升级记号进来的：滚到这一节，焦点放到该按的那个按钮上（远程的“升级”、本机的“立即重试”），都没有就落在标题上
  useEffect(() => {
    if (!reveal) return
    const sec = box.current
    if (!sec) return
    sec.scrollIntoView({ block: 'start' })
    const target = ['[data-act^="remote-"]', '[data-act="service-retry"]', '.mng-sec-head button']
      .map((selector) => sec.querySelector<HTMLElement>(selector))
      .find((found) => found !== null)
    target?.focus({ preventScroll: true })
  }, [reveal])

  /** 点了“再试一次”，还没有结果 */
  const [retrying, setRetrying] = useState(false)
  /** 点了之后看到过它在重新连接：再回到一个定下来的状态，就是这一次有了结果 */
  const left = useRef(false)
  const linking =
    (device.connection === 'connecting' || device.connection === 'reconnecting') && !device.failure
  const to = upgrade?.bundled.version ?? ''
  useEffect(() => {
    if (!retrying) return
    if (linking) {
      left.current = true
      return
    }
    if (!left.current) return
    left.current = false
    setRetrying(false)
    // 没连上的话原因在上面“这台设备”一节里；别的没换成的情形这一节自己会说。这里只报两种：还是忙，换成了
    if (!online) return
    if (notice === 'busy') {
      showToast({ id: 'service-retry', lifeMs: TOLD_MS, text: (say) => say('service.retry.still') })
    } else if (notice === 'replaced') {
      showToast({
        id: 'service-retry',
        lifeMs: TOLD_MS,
        text: (say) => say('service.retry.done', { to }),
      })
    }
  }, [retrying, linking, online, notice, to])

  /**
   * 现在再试一次：就是重新连一次。外壳每次连本机都会比一遍版本，在跑的旧而且闲着才换；
   * 不闲就照旧连上它，不打断谁
   */
  const retry = () => {
    left.current = false
    setRetrying(true)
    channel.command('device.reconnect', { deviceId: device.id }).catch(() => setRetrying(false))
  }

  if (!online && !retrying && remote === null) return null
  if (service === null && notice === null && remote === null) return null
  const origin = service === null ? null : originOf(service, upgrade)
  const pill = remote ? remotePillOf(remote) : pillOf(upgrade)
  return (
    <section
      ref={box}
      className="mng-sec"
      data-sec="service"
      data-open={open}
      data-notice={notice ?? undefined}
      data-stale={stale || undefined}
    >
      <div className="mng-sec-head">
        <h2>
          <Fold open={open} onToggle={() => setOpen(!open)} controls={id}>
            {t('service.title')}
          </Fold>
        </h2>
        <span className="mng-sum mono" data-service-version>
          {service ? service.version : t('service.version.unknown')}
        </span>
        {pill ? (
          <span className={`pill ${pill.tone}`} data-service-pill={pill.tone}>
            {t(pill.key, pill.args)}
          </span>
        ) : null}
      </div>
      {open ? (
        <div id={id} className="mng-sec-body">
          <dl className="devp-facts">
            <div>
              <dt>{t('service.version')}</dt>
              <dd className={service ? 'mono' : undefined} data-fact="version">
                {service ? service.version : t('service.version.unknown')}
              </dd>
            </div>
            {upgrade ? (
              <div>
                <dt>{t('service.bundled')}</dt>
                <dd className="mono" data-fact="bundled">
                  {upgrade.bundled.version}
                </dd>
              </div>
            ) : null}
            {remote ? (
              <div>
                <dt>{t('service.app')}</dt>
                <dd className="mono" data-fact="app">
                  {remote.target}
                </dd>
              </div>
            ) : null}
            {remote?.installed && remote.installed !== service?.version ? (
              <div>
                <dt>{t('service.installed')}</dt>
                <dd className="mono" data-fact="installed">
                  {remote.installed}
                </dd>
              </div>
            ) : null}
            {service ? (
              <>
                <div>
                  <dt>{t('service.origin')}</dt>
                  {/* 应用自带的那一份说成一句话，路径放在提示里；别的照实给路径 */}
                  <dd
                    className={origin === 'path' ? 'mono' : undefined}
                    data-fact="origin"
                    data-origin={origin}
                    title={origin === 'path' ? undefined : service.root}
                  >
                    {origin === 'path' ? service.root : t(`service.origin.${origin ?? 'bundled'}`)}
                  </dd>
                </div>
                {service.startedAt === null ? null : (
                  <div>
                    <dt>{t('service.started')}</dt>
                    <dd data-fact="started">
                      {new Date(service.startedAt).toLocaleString(t.lang, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                    </dd>
                  </div>
                )}
                <div>
                  <dt>{t('service.launch')}</dt>
                  <dd data-fact="launch" data-detached={service.detached}>
                    {t(service.detached ? 'service.launch.detached' : 'service.launch.managed')}
                  </dd>
                </div>
                <div>
                  <dt>{t('service.pid')}</dt>
                  <dd className="mono" data-fact="pid">
                    {service.pid}
                  </dd>
                </div>
              </>
            ) : null}
          </dl>
          {remote ? <RemoteUpgradeNote device={device} view={remote} /> : null}
          {upgrade && notice ? (
            <UpgradeNote
              device={device}
              upgrade={upgrade}
              notice={notice}
              retrying={retrying}
              onRetry={retry}
            />
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
