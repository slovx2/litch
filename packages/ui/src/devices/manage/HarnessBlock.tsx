// 设备页每个 harness 只有一行入口与状态；独立详情页显示安装、重启、运行信息和设置。
import type { DeviceView, HarnessView, InstallTopicView } from '@litch/core'
import { type ReactNode, useState } from 'react'
import { useT } from '../../app/appearance.ts'
import { Confirm } from '../../app/Confirm.tsx'
import { whyNot } from '../../app/errors.ts'
import { Forward, Icon } from '../../app/icons.tsx'
import { useServices } from '../../app/services.tsx'
import { showToast } from '../../app/toasts.tsx'
import { InstallRow } from '../../install/InstallRow.tsx'
import { cliPresentation } from '../cli-presentation.ts'
import { HarnessWhy } from '../HarnessList.tsx'

const STATE_CLASS: Record<HarnessView['state'], string> = {
  ready: 'pill ok',
  // 设备服务会自己接着试，所以按“在等”的样子画，不按出错画
  unavailable: 'pill wait',
  disabled: 'pill mute',
}

interface HarnessBlockProps {
  device: DeviceView
  /** 设置里提到了、设备却没有声明的 harness，只知道它的标识 */
  harnessId: string
  harness: HarnessView | undefined
  /** 设备能装 harness 时的版本和安装任务：标题行下多一行版本和按钮。不能装是 undefined */
  install: InstallTopicView | undefined
  /** 改过的设置还没用上，等着重启 */
  pending: boolean
  /** 详情页显示运行信息与设置；设备列表只显示标题行。 */
  detail?: boolean
  /** 列表行进入独立详情页；详情页自身不再显示入口。 */
  settings: (() => void) | null
  children: ReactNode
}

export function HarnessBlock(props: HarnessBlockProps) {
  const { device, harnessId, harness, install, pending, detail = false, settings, children } = props
  const { channel } = useServices()
  const t = useT()
  const [restarting, setRestarting] = useState(false)
  const [copiesOpen, setCopiesOpen] = useState(false)
  const { selected, candidates } = cliPresentation(
    harness?.cli,
    install?.versions?.find((entry) => entry.harness === harnessId)?.candidates,
  )
  /** 它有回合在跑，设备服务没有照做：问用户要不要仍然重启 */
  const [asking, setAsking] = useState(false)
  const deviceId = device.id
  const name = t.harness(harnessId, harness?.name)
  const ready = harness?.state === 'ready'

  const restart = async (force: boolean) => {
    setAsking(false)
    setRestarting(true)
    const id = `manage-restart:${deviceId}:${harnessId}`
    try {
      const result = await channel.command('device.harness.restart', {
        deviceId,
        harness: harnessId,
        ...(force ? { force: true } : {}),
      })
      const { running, text } = result
      showToast({
        id,
        tone: running ? 'plain' : 'err',
        text: (say) =>
          running
            ? say('manage.restart.done', { name })
            : say('manage.restart.down', {
                name,
                reason: text ? say.said(text) : say('harness.unavailable'),
              }),
        lifeMs: running ? 4000 : 9000,
      })
    } catch (error) {
      // 有回合在跑：什么都没做。说明情况，让用户决定要不要照做
      if (!force && (error as { code?: string } | null)?.code === 'busy') {
        setAsking(true)
        return
      }
      showToast({
        id,
        tone: 'err',
        text: (say) => say('manage.restart.failed', { name, reason: whyNot(error, say) }),
        lifeMs: 9000,
      })
    } finally {
      setRestarting(false)
    }
  }

  // 设备页只保留可进入的整行；安装、启停和运行信息都在独立详情页。
  if (!detail) {
    const version = install?.versions?.find((entry) => entry.harness === harnessId)
    return (
      <section
        className="mng-h"
        data-harness-block={harnessId}
        data-state={harness?.state ?? 'unknown'}
        data-pending={pending}
        data-open={false}
      >
        <button
          type="button"
          className="mng-h-link"
          data-act="harness-settings"
          disabled={typeof settings !== 'function'}
          onClick={typeof settings === 'function' ? settings : undefined}
        >
          <span className={ready ? 'chip' : 'chip off'}>
            {harness?.badge ?? harnessId.slice(0, 2).toUpperCase()}
          </span>
          <span className="mng-h-name ell grow">{name}</span>
          <span className="dim mng-h-summary">
            {harness?.down === 'notInstalled' || version?.installed === null
              ? t('install.notInstalled')
              : harness
                ? t(`harness.state.${harness.state}`)
                : t('devices.harness.unknown')}
          </span>
          {pending ? (
            <span className="pill wait" data-pending-pill>
              {t('manage.pending')}
            </span>
          ) : null}
          <Forward />
        </button>
      </section>
    )
  }

  return (
    <section
      className="mng-h"
      data-harness-block={harnessId}
      data-state={harness?.state ?? 'unknown'}
      data-pending={pending}
      data-restarting={restarting}
      data-open={detail}
    >
      <header className="mng-h-head">
        <h3>
          <span className="mng-h-label">
            <span className={ready ? 'chip' : 'chip off'}>
              {harness?.badge ?? harnessId.slice(0, 2).toUpperCase()}
            </span>
            <span className="mng-h-name ell">{name}</span>
            {harness?.version ? (
              <span className="mng-h-ver mono dim">{harness.version}</span>
            ) : null}
          </span>
        </h3>
        {harness ? (
          <span className={STATE_CLASS[harness.state]} data-harness-state>
            {t(`harness.state.${harness.state}`)}
          </span>
        ) : null}
        {pending ? (
          <span className="pill wait" data-pending-pill>
            {t('manage.pending')}
          </span>
        ) : null}
        {harness ? (
          <button
            type="button"
            className="ibtn"
            title={t(
              restarting
                ? 'manage.restarting'
                : harness?.state === 'disabled'
                  ? 'harness.state.disabled'
                  : 'manage.restart',
            )}
            aria-label={t(restarting ? 'manage.restarting' : 'manage.restart')}
            data-act="restart"
            // 停用了的不会启动，没有什么可重启的
            disabled={restarting || harness.state === 'disabled'}
            onClick={() => void restart(false)}
          >
            <Icon name="reload" />
          </button>
        ) : null}
      </header>
      <InstallRow device={device} harnessId={harnessId} view={install} name={name} />
      {detail ? (
        <div className="mng-h-body">
          {selected || candidates.length ? (
            <div className="harness-runtime" data-harness-runtime>
              <div className="harness-runtime-line">
                <span className="dim">
                  {t(harness?.cli ? 'harness.runtime.actual' : 'harness.runtime.selected')}
                </span>
                <span className="mono ell" title={selected?.path}>
                  {selected
                    ? `${selected.version || t('devices.harness.unknown')} · ${selected.path}`
                    : t('harness.runtime.none')}
                </span>
                {candidates.length > 1 ? (
                  <button
                    type="button"
                    className="ibtn"
                    aria-label={t('harness.runtime.candidates')}
                    title={t('harness.runtime.candidates')}
                    aria-expanded={copiesOpen}
                    onClick={() => setCopiesOpen(!copiesOpen)}
                  >
                    <Icon name={copiesOpen ? 'up' : 'down'} />
                  </button>
                ) : null}
              </div>
              {copiesOpen
                ? candidates.map((candidate) => (
                    <div
                      className="harness-runtime-line"
                      key={candidate.path}
                      data-cli-selected={candidate.selected}
                    >
                      <span className="mono">
                        {candidate.version || t('devices.harness.unknown')} · {candidate.path}
                      </span>
                      {candidate.selected ? (
                        <span className="dim">
                          {t(harness?.cli ? 'harness.runtime.inUse' : 'harness.runtime.chosen')}
                        </span>
                      ) : null}
                    </div>
                  ))
                : null}
            </div>
          ) : null}
          {/* 停用状态由下面的启用设置表达，不重复说明。 */}
          {harness && !ready && harness.state !== 'disabled' ? (
            <div className="mng-h-why">
              <HarnessWhy harness={harness} />
            </div>
          ) : null}
          {pending ? <div className="mng-h-note">{t('manage.pending.note', { name })}</div> : null}
          <div className="mng-rows">{children}</div>
        </div>
      ) : null}
      {asking ? (
        <Confirm
          title={t('manage.restart.busy.title', { name })}
          note={t('manage.restart.busy.note')}
          yes={t('manage.restart.busy.yes')}
          no={t('manage.restart.busy.no')}
          onYes={() => void restart(true)}
          onClose={() => setAsking(false)}
        />
      ) : null}
    </section>
  )
}
