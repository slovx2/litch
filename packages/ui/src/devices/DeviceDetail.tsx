// 设备详情：从“设备”一页里点开一台设备。列表的一行上放不下、也不该放的东西都在这里。
// 上面一节是这台设备自己：怎么连的、线色、改名、改连接、移除、重新连接，没连上时的原因和该怎么办；
// 接着是这台设备上的会话能不能用这台电脑的内置浏览器、Computer Use（ToolSwitches.tsx，两个开关）；
// 再是它上面在跑的设备服务（ServiceSection.tsx）：哪一版、哪来的，本机另外说这次连接换没换版本；
// 接着是绑定了哪些手机和“在手机上使用…”（PhonesSection.tsx，扫码绑定手机）；
// 下面是它的管理（harness、设置、诊断、日志）——本机和远程是同一套，本机没有改名、改连接和移除。
// 对面没有设置接口（只有 codex 的机器、旧版的设备服务）时只有上面这一节，不摆空的管理区。
// 远程设备还说一句对面是哪一种：设备服务，还是只有 codex；只有 codex 的给出装设备服务的办法。
import { type DeviceView, keys, WIRES, type WireColor } from '@litch/core'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { viaOf, wireStyle } from '../app/device.ts'
import { reasonOf } from '../app/errors.ts'
import { Back, Close } from '../app/icons.tsx'
import { useKey, useServices } from '../app/services.tsx'
import { AddDevice } from './AddDevice.tsx'
import { INSTALL_SERVICE } from './guide.ts'
import { HarnessList } from './HarnessList.tsx'
import { HarnessSettingsPage } from './hconfig/HarnessSettingsPage.tsx'
import { ManagePanel } from './manage/ManagePanel.tsx'
import { PhonesSection } from './PhonesSection.tsx'
import { UpgradeButton } from './RemoteUpgrade.tsx'
import { ServiceSection } from './ServiceSection.tsx'
import { FailureNote, GuideSteps, StatePill, useReconnect } from './status.tsx'
import { ToolSwitches } from './ToolSwitches.tsx'

interface DeviceDetailProps {
  deviceId: string
  /** 回到设备列表 */
  onBack(): void
  /** 回到对话 */
  onClose(): void
}

export function DeviceDetail({ deviceId, onBack, onClose }: DeviceDetailProps) {
  const { channel } = useServices()
  const device = useKey<DeviceView>(keys.device(deviceId))
  const reconnect = useReconnect(deviceId)
  const t = useT()
  /** 正在改名时输入框里的字。null：没在改 */
  const [naming, setNaming] = useState<string | null>(null)
  /** 点了“移除”，正在等确认 */
  const [asking, setAsking] = useState(false)
  /** 开着“改连接”的对话框 */
  const [editing, setEditing] = useState(false)
  /** 改名、换线色、移除没做成的原因 */
  const [failure, setFailure] = useState<string | null>(null)
  /** 开着哪个 harness 的详情设置（盖住设备详情的一页） */
  const [settingsOf, setSettingsOf] = useState<string | null>(null)
  const closeSettings = useCallback(() => setSettingsOf(null), [])
  const field = useRef<HTMLInputElement>(null)
  /** 这一次改名已经有了结果（提交或者放弃）。输入框消失时还会再报一次失焦，不能当成又提交一次 */
  const settled = useRef(true)
  const renaming = naming !== null
  // 输入框一出现就全选，直接打字就是换一个名字
  useEffect(() => {
    if (!renaming) return
    field.current?.focus()
    field.current?.select()
  }, [renaming])

  // 这台设备被移除了：回到列表
  const gone = device === undefined
  useEffect(() => {
    if (gone) onBack()
  }, [gone, onBack])

  // Esc 回到设备列表。开着确认框的时候 Esc 归确认框，开着详情设置时归那一页
  const sub = settingsOf !== null
  useEffect(() => {
    if (sub) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (document.querySelector('dialog[open]')) return
      event.preventDefault()
      onBack()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onBack, sub])

  if (!device) return null
  if (settingsOf !== null) {
    return (
      <HarnessSettingsPage
        device={device}
        harnessId={settingsOf}
        onBack={closeSettings}
        onClose={onClose}
      />
    )
  }
  const online = device.connection === 'online'
  const managed = device.manageable && online
  /** 改名、改连接、移除只对加进来的远程设备有：本机就是这台电脑，只能换线色 */
  const remote = device.target !== null
  const keyFile = device.target?.kind === 'host' ? device.target.keyFile : null
  /**
   * 远程设备的对面是哪一种。连上过（这次，或者上次留下了快照）才知道：
   * 完整模式是设备服务；单 harness 模式是只有那一个（原生 codex），没有设备服务
   */
  const sole = remote && device.mode === 'single' ? device.harnesses[0] : undefined
  const peer =
    !remote || device.harnesses.length === 0
      ? null
      : sole
        ? t('devices.peer.onlyNote', { name: sole.name })
        : t('devices.peer.service', { count: device.harnesses.length })

  const fail = (error: unknown) => setFailure(t('devices.failed', { reason: reasonOf(error, t) }))
  const update = (patch: { name?: string; wire?: WireColor }) => {
    setFailure(null)
    channel.command('device.update', { deviceId, ...patch }).catch(fail)
  }
  const rename = (commit: boolean) => {
    if (settled.current) return
    settled.current = true
    const name = (naming ?? '').trim()
    setNaming(null)
    if (commit && name && name !== t.text(device.name)) update({ name })
  }
  const remove = () => {
    setAsking(false)
    setFailure(null)
    channel.command('device.remove', { deviceId }).catch(fail)
  }

  return (
    <div className="arch-page devp mng-page" style={wireStyle(device.wire)} data-detail={deviceId}>
      <header className="arch-head">
        <button
          type="button"
          className="ibtn"
          data-act="back"
          title={t('manage.back')}
          aria-label={t('manage.back')}
          onClick={onBack}
        >
          <Back />
        </button>
        <div>
          <h1 className="mng-title">
            <i className={online ? 'wire-sq' : 'wire-sq off'} />
            {naming !== null ? (
              <input
                ref={field}
                className="req-input devp-rename"
                value={naming}
                aria-label={t('devices.nameLabel')}
                onChange={(event) => setNaming(event.target.value)}
                onBlur={() => rename(true)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return
                  // 这一页自己也听 Esc（回到列表），改名时按 Esc 只是放弃改名
                  if (event.key === 'Escape') event.stopPropagation()
                  if (event.key === 'Enter') rename(true)
                  else if (event.key === 'Escape') rename(false)
                }}
              />
            ) : (
              <span className="ell" data-device-name>
                {t.text(device.name)}
              </span>
            )}
            <StatePill device={device} />
          </h1>
        </div>
        <button
          type="button"
          className="ibtn"
          title={t('devices.close')}
          aria-label={t('devices.close')}
          onClick={onClose}
        >
          <Close />
        </button>
      </header>
      <div className="arch-body">
        <div className="mng-wrap">
          <section className="mng-sec" data-sec="device">
            <div className="mng-sec-head">
              <h2>{t('manage.device')}</h2>
              <span className="grow" />
              {asking ? (
                <span className="devp-acts">
                  <span className="devp-ask">{t('devices.remove.title')}</span>
                  <button type="button" className="btn ghost" onClick={() => setAsking(false)}>
                    {t('permission.confirm.no')}
                  </button>
                  <button
                    type="button"
                    className="btn danger"
                    data-act="remove-yes"
                    onClick={remove}
                  >
                    {t('devices.remove')}
                  </button>
                </span>
              ) : (
                <span className="devp-acts">
                  {!online && device.connection !== 'connecting' ? (
                    <button type="button" className="btn" data-act="reconnect" onClick={reconnect}>
                      {t('devices.reconnect')}
                    </button>
                  ) : null}
                  {remote ? (
                    <>
                      <button
                        type="button"
                        className="btn ghost"
                        data-act="rename"
                        onClick={() => {
                          settled.current = false
                          setNaming(t.text(device.name))
                        }}
                      >
                        {t('devices.rename')}
                      </button>
                      <button
                        type="button"
                        className="btn ghost"
                        data-act="edit"
                        onClick={() => setEditing(true)}
                      >
                        {t('devices.edit')}
                      </button>
                      <button
                        type="button"
                        className="btn ghost"
                        data-act="remove"
                        onClick={() => setAsking(true)}
                      >
                        {t('devices.remove')}
                      </button>
                    </>
                  ) : null}
                </span>
              )}
            </div>
            {asking ? <div className="devp-note">{t('devices.remove.note')}</div> : null}
            <dl className="devp-facts">
              <div>
                <dt>{t('devices.via')}</dt>
                <dd>{viaOf(device, t)}</dd>
              </div>
              <div>
                <dt>{t('devices.host')}</dt>
                <dd className="mono">{device.host}</dd>
              </div>
              {keyFile ? (
                <div>
                  <dt>{t('devices.key')}</dt>
                  <dd className="mono">{keyFile}</dd>
                </div>
              ) : null}
              {peer ? (
                <div>
                  <dt>{t('devices.peer')}</dt>
                  <dd data-peer={sole ? 'codex' : 'service'}>{peer}</dd>
                </div>
              ) : null}
              {/* 能管理的时候 harness 在下面一个一块地列着，这里不再列一遍 */}
              {managed ? null : (
                <div>
                  <dt>{t('devices.harness')}</dt>
                  <dd>
                    <HarnessList device={device} />
                  </dd>
                </div>
              )}
              <div>
                <dt>{t('devices.wire')}</dt>
                <dd>
                  <span className="wires" role="radiogroup" aria-label={t('devices.wire')}>
                    {WIRES.map((wire) => (
                      // biome-ignore lint/a11y/useSemanticElements: 原生的单选框画不成一排色块
                      <button
                        key={wire}
                        type="button"
                        role="radio"
                        aria-checked={wire === device.wire}
                        aria-label={wire}
                        title={wire}
                        style={wireStyle(wire)}
                        onClick={() => update({ wire })}
                      />
                    ))}
                  </span>
                </dd>
              </div>
            </dl>
            {device.failure ? (
              <>
                <FailureNote failure={device.failure} target={device.target} />
                {/* 适配器旧到连不上：除了可复制的命令，也给一键升级（认得出安装方式时），和设备服务一节里的是同一个 */}
                {device.failure.guide === 'upgradeService' && device.remoteUpgrade ? (
                  <div className="cfail-acts" data-remote-guide>
                    <UpgradeButton device={device} view={device.remoteUpgrade} />
                  </div>
                ) : null}
              </>
            ) : device.note ? (
              <div className="devp-note">{t.text(device.note)}</div>
            ) : null}
            {online && sole ? (
              // 只有 codex 的远程机器：照旧能用，顺带说一句装上设备服务能多出什么、怎么装。
              // 装不装是用户的事，这里只给命令；装好之后点一下，重新连一次就换过去了
              <div className="cfail" data-manage-state="unsupported" data-peer-hint="codex">
                <GuideSteps
                  steps={[{ text: 'devices.hint.codexOnly', command: INSTALL_SERVICE }]}
                  args={{ name: sole.name }}
                />
                <div className="devp-note">{t('devices.hint.codexOnly.after')}</div>
                <div className="cfail-acts">
                  <button
                    type="button"
                    className="mini retry"
                    data-act="recheck"
                    onClick={reconnect}
                  >
                    {t('devices.hint.recheck')}
                  </button>
                </div>
              </div>
            ) : online && !device.manageable ? (
              <div className="devp-note" data-manage-state="unsupported">
                {t('manage.unsupported')}
              </div>
            ) : null}
            {failure ? (
              <div className="devp-note err" role="alert">
                {failure}
              </div>
            ) : null}
          </section>
          <ToolSwitches device={device} />
          <ServiceSection device={device} />
          <PhonesSection device={device} />
          {managed ? (
            <ManagePanel device={device} onSettings={setSettingsOf} />
          ) : device.manageable ? (
            <div className="mng-state" data-manage-state="offline">
              {t('manage.offline')}
            </div>
          ) : null}
        </div>
      </div>
      {editing ? <AddDevice edit={deviceId} onClose={() => setEditing(false)} /> : null}
    </div>
  )
}
