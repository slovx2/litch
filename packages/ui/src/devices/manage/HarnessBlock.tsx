// 一个 harness 占一块，平时只有一行：它是谁、现在什么状态、开没开、能不能重启。
// 点开才是用不了的原因、它自己的那些设置和各自的说明。里面有没保存的改动时一定开着，不把问题藏在收起的块里。
// “启用”也只是按声明画出来的一项，界面不认它的键：标题行上的开关是设备服务标了“启用开关”角色的那一项（见 ManagePanel）。
import type { DeviceView, HarnessView, InstallTopicView } from '@litch/core'
import { type ReactNode, useId, useState } from 'react'
import { useT } from '../../app/appearance.ts'
import { Confirm } from '../../app/Confirm.tsx'
import { whyNot } from '../../app/errors.ts'
import { Fold, useFold } from '../../app/Fold.tsx'
import { useServices } from '../../app/services.tsx'
import { showToast } from '../../app/toasts.tsx'
import { InstallRow } from '../../install/InstallRow.tsx'
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
  /** 它的设置里有没保存的改动：这一块一定开着 */
  forced: boolean
  /** 标题行上的开关。设备服务没有给哪一项标“启用开关”的角色就没有 */
  toggle: ReactNode
  /** 详情设置：打开它；'unsupported' 是设备支持而这个 harness 还不支持；null 是设备不支持，不提 */
  settings: (() => void) | 'unsupported' | null
  children: ReactNode
}

export function HarnessBlock(props: HarnessBlockProps) {
  const { device, harnessId, harness, install, pending, forced, toggle, settings, children } = props
  const { channel } = useServices()
  const t = useT()
  const fold = useFold(forced)
  const bodyId = useId()
  const [restarting, setRestarting] = useState(false)
  /** 它有回合在跑，设备服务没有照做：问用户要不要仍然重启 */
  const [asking, setAsking] = useState(false)
  const deviceId = device.id
  const name = harness?.name ?? harnessId
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

  return (
    <section
      className="mng-h"
      data-harness-block={harnessId}
      data-state={harness?.state ?? 'unknown'}
      data-pending={pending}
      data-restarting={restarting}
      data-open={fold.open}
    >
      <header className="mng-h-head">
        <h3>
          <Fold
            open={fold.open}
            onToggle={fold.toggle}
            controls={bodyId}
            title={forced ? t('manage.fold.locked') : undefined}
          >
            <span className={ready ? 'chip' : 'chip off'}>
              {harness?.badge ?? harnessId.slice(0, 2).toUpperCase()}
            </span>
            <span className="mng-h-name ell">{name}</span>
            {harness?.version ? (
              <span className="mng-h-ver mono dim">{harness.version}</span>
            ) : null}
          </Fold>
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
        {toggle}
        {typeof settings === 'function' ? (
          <button type="button" className="btn" data-act="harness-settings" onClick={settings}>
            {t('hc.entry')}
          </button>
        ) : null}
        {harness ? (
          <button
            type="button"
            className="btn"
            data-act="restart"
            // 停用了的不会启动，没有什么可重启的
            disabled={restarting || harness.state === 'disabled'}
            onClick={() => void restart(false)}
          >
            {t(restarting ? 'manage.restarting' : 'manage.restart')}
          </button>
        ) : null}
      </header>
      <InstallRow device={device} harnessId={harnessId} view={install} name={name} />
      {fold.open ? (
        <div id={bodyId} className="mng-h-body">
          {/* 停用了的：开关就在标题行上，不用再解释 */}
          {harness && !ready && harness.state !== 'disabled' ? (
            <div className="mng-h-why">
              <HarnessWhy harness={harness} />
            </div>
          ) : null}
          {pending ? <div className="mng-h-note">{t('manage.pending.note', { name })}</div> : null}
          {settings === 'unsupported' ? (
            <div className="mng-h-note dim" data-hc-unsupported>
              {t('hc.entry.unsupported')}
            </div>
          ) : null}
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
