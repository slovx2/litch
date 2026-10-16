import {
  type DeviceView,
  type DiscoveredHost,
  keys,
  type RemoteCheck,
  type RemoteTarget,
  sameTarget,
} from '@litch/core'
import { useEffect, useRef, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { useKey, useServices } from '../app/services.tsx'
import type { Translator } from '../i18n/index.ts'

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** 一次检查走到哪了。没有这一项就是还没检查 */
type Checked = RemoteCheck | 'checking'

/** 检查的结果，一个小标 */
function CheckPill({ check }: { check: Checked | undefined }) {
  const t = useT()
  if (!check) return <span className="pill mute">{t('add.unchecked')}</span>
  if (check === 'checking') return <span className="pill wait">{t('add.checking')}</span>
  if (check.ok) {
    // 对面是哪一种：设备服务，或者只有 codex
    return (
      <span className="pill ok" data-peer={check.peer}>
        {t(check.peer === 'service' ? 'add.peer.service' : 'add.peer.codex', {
          version: check.version,
        })}
      </span>
    )
  }
  return <span className="pill err">{t(`add.stage.${check.failure.stage}`)}</span>
}

/** 能连的那台，连上之后是什么样：设备服务说上面有哪些 harness，只有 codex 的说会以单 harness 的方式连 */
function peerNote(name: string, check: Extract<RemoteCheck, { ok: true }>, t: Translator): string {
  if (check.peer === 'codex') return t('add.note.codex', { name })
  // 服务没在跑：只是看一眼，不替用户启动它，上面有什么连上之后才知道
  if (!check.running) return t('add.note.service.idle', { name })
  if (!check.harnesses) return t('add.note.service.unknown', { name })
  const ready = check.harnesses.filter((harness) => harness.state === 'ready')
  if (ready.length === 0) return t('add.note.service.down', { name })
  return t('add.note.service', {
    name,
    names: ready.map((harness) => harness.name).join(t('list.comma')),
  })
}

/** 检查的结果，一行说明：能连的说会怎么连，不能连的说为什么 */
function CheckLine({ name, check }: { name: string; check: Checked | undefined }) {
  const t = useT()
  if (!check || check === 'checking') return null
  return check.ok ? (
    <div className="check pass" data-peer={check.peer}>
      <span className="mk">✓</span>
      <span>{peerNote(name, check, t)}</span>
    </div>
  ) : (
    <div className="check fail">
      <span className="mk">×</span>
      <span>
        <b>{name}</b> {t.text(check.failure.text)}
      </span>
    </div>
  )
}

interface Form {
  name: string
  host: string
  port: string
  user: string
  keyFile: string
}

const EMPTY: Form = { name: '', host: '', port: '', user: '', keyFile: '' }

/** 手动填的那几栏变成连接配置。只填了名字就当它是别名：端口、用户、密钥都听 ssh 配置的 */
function targetOf(form: Form): RemoteTarget | null {
  const host = form.host.trim()
  if (!host) return null
  const port = form.port.trim()
  const user = form.user.trim()
  const keyFile = form.keyFile.trim()
  if (!port && !user && !keyFile) return { kind: 'alias', alias: host }
  return {
    kind: 'host',
    host,
    port: port ? Number(port) : null,
    user: user || null,
    keyFile: keyFile || null,
  }
}

const formOf = (device: DeviceView | undefined, name: string): Form => {
  const target = device?.target
  if (!target) return EMPTY
  if (target.kind === 'alias') return { ...EMPTY, name, host: target.alias }
  return {
    name,
    host: target.host,
    port: target.port ? String(target.port) : '',
    user: target.user ?? '',
    keyFile: target.keyFile ?? '',
  }
}

const portOk = (text: string): boolean => {
  if (!text.trim()) return true
  const port = Number(text)
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

interface AddDeviceProps {
  /** 给了就是改这台设备的连接，不是添加 */
  edit: string | null
  onClose(): void
}

/**
 * 添加设备：从 ssh 配置里发现的主机里勾，或者手动填。也用来改一台已有设备的连接。
 * 这里没有密码输入框：登录交给系统的 ssh 和密钥代理。
 */
export function AddDevice({ edit, onClose }: AddDeviceProps) {
  const { channel, replica } = useServices()
  const t = useT()
  const dialog = useRef<HTMLDialogElement>(null)
  const deviceIds = useKey<string[]>(keys.devices) ?? []
  const editing = useKey<DeviceView>(keys.device(edit ?? ''))
  const [mode, setMode] = useState<'config' | 'manual'>(edit ? 'manual' : 'config')
  const [hosts, setHosts] = useState<DiscoveredHost[] | null>(null)
  const [scanFailure, setScanFailure] = useState<string | null>(null)
  const [picked, setPicked] = useState<readonly string[]>([])
  /** 各台主机检查的结果，键是别名；手动填的那一台用空的键 */
  const [checks, setChecks] = useState<Record<string, Checked>>({})
  const [form, setForm] = useState<Form>(() => formOf(editing, editing ? t.text(editing.name) : ''))
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  /** 对话框关掉之后，还在路上的检查都不要了 */
  const abort = useRef<AbortController | null>(null)

  // 用模态方式打开：焦点留在里面，Esc 由浏览器处理
  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) element.showModal()
    const controller = new AbortController()
    abort.current = controller
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (edit) return
    const controller = new AbortController()
    channel
      .command('remote.discover', {}, { signal: controller.signal })
      .then(({ hosts: found }) => setHosts(found))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setHosts([])
        setScanFailure(t('add.scanFailed', { reason: reasonOf(error) }))
      })
    return () => controller.abort()
  }, [channel, edit, t])

  /** 已经加过的那些连接配置 */
  const existing = deviceIds
    .map((id) => replica.store.get<DeviceView>(keys.device(id))?.target)
    .filter((target): target is RemoteTarget => Boolean(target))
  const added = (alias: string) =>
    existing.some((target) => sameTarget(target, { kind: 'alias', alias }))

  const check = (key: string, target: RemoteTarget) => {
    setChecks((current) => ({ ...current, [key]: 'checking' }))
    channel
      .command('remote.check', { target }, abort.current ? { signal: abort.current.signal } : {})
      .then((result) => setChecks((current) => ({ ...current, [key]: result })))
      .catch(() =>
        setChecks((current) => {
          const { [key]: _gone, ...rest } = current
          return rest
        }),
      )
  }

  const toggle = (alias: string) => {
    if (picked.includes(alias)) {
      setPicked(picked.filter((entry) => entry !== alias))
      return
    }
    setPicked([...picked, alias])
    // 勾上就去看一眼对面有什么
    if (!checks[alias]) check(alias, { kind: 'alias', alias })
  }

  const target = targetOf(form)
  const formValid = target !== null && portOk(form.port)

  const submit = async (event?: { preventDefault(): void }) => {
    event?.preventDefault()
    if (busy) return
    setBusy(true)
    setFailure(null)
    try {
      if (edit) {
        if (!target || !formValid) return
        await channel.command('device.update', { deviceId: edit, name: form.name, target })
      } else if (mode === 'manual') {
        if (!target || !formValid) return
        await channel.command('device.add', { name: form.name, target })
      } else {
        for (const alias of picked) {
          await channel.command('device.add', { name: '', target: { kind: 'alias', alias } })
          setPicked((current) => current.filter((entry) => entry !== alias))
        }
      }
      onClose()
    } catch (error) {
      setFailure(t('devices.failed', { reason: reasonOf(error) }))
    } finally {
      setBusy(false)
    }
  }

  const field = (
    id: keyof Form,
    label: string,
    hint: string | null,
    extra: { wrong?: boolean; mono?: boolean; placeholder?: string } = {},
  ) => (
    <div className="form-field">
      <label className="form-label" htmlFor={`add-${id}`}>
        {label}
      </label>
      <input
        id={`add-${id}`}
        className={['req-input', extra.wrong ? 'wrong' : '', extra.mono ? 'mono' : '']
          .filter(Boolean)
          .join(' ')}
        value={form[id]}
        placeholder={extra.placeholder}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        aria-invalid={extra.wrong}
        onChange={(event) => {
          setForm({ ...form, [id]: event.target.value })
          // 改了连接配置，之前那次检查就不算数了
          if (id !== 'name') setChecks(({ '': _gone, ...rest }) => rest)
        }}
      />
      {hint ? <span className="form-note">{hint}</span> : null}
    </div>
  )

  return (
    <dialog
      ref={dialog}
      className="modal"
      aria-label={t(edit ? 'devices.edit' : 'add.title')}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <div className="modal-head">
          <span className="grow">{t(edit ? 'devices.edit' : 'add.title')}</span>
          {edit ? null : (
            // biome-ignore lint/a11y/useSemanticElements: 这一组没有自己的边框和标题，不用 fieldset
            <div className="seg" role="group" aria-label={t('add.title')}>
              <button
                type="button"
                aria-pressed={mode === 'config'}
                onClick={() => setMode('config')}
              >
                {t('add.fromConfig')}
              </button>
              <button
                type="button"
                aria-pressed={mode === 'manual'}
                onClick={() => setMode('manual')}
              >
                {t('add.manual')}
              </button>
            </div>
          )}
        </div>
        <div className="modal-body">
          {mode === 'config' ? (
            <>
              {hosts === null ? <div className="modal-note">{t('add.scanning')}</div> : null}
              {hosts?.length === 0 ? (
                <div className="modal-note">{scanFailure ?? t('add.noHosts')}</div>
              ) : null}
              {hosts && hosts.length > 0 ? (
                <ul className="hosts">
                  {hosts.map((host) => {
                    const has = added(host.alias)
                    const on = picked.includes(host.alias)
                    return (
                      <li key={host.alias} className="host">
                        <label>
                          <input
                            type="checkbox"
                            checked={on}
                            disabled={has || busy}
                            onChange={() => toggle(host.alias)}
                          />
                          <span className="nm ell">{host.alias}</span>
                        </label>
                        <span className="ad ell grow">
                          {host.host
                            ? `${host.user ? `${host.user}@` : ''}${host.host}${
                                host.port && host.port !== 22 ? `:${host.port}` : ''
                              }`
                            : ''}
                        </span>
                        {has ? (
                          <span className="pill mute">{t('add.added')}</span>
                        ) : (
                          <CheckPill check={checks[host.alias]} />
                        )}
                      </li>
                    )
                  })}
                </ul>
              ) : null}
              {picked.length > 0 ? (
                <div className="steps">
                  {picked.map((alias) => (
                    <CheckLine key={alias} name={alias} check={checks[alias]} />
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            <>
              {field('host', t('add.host'), t('add.host.hint'), { mono: true })}
              <div className="form-row">
                {field('user', t('add.user'), null, { mono: true })}
                {field('port', t('add.port'), null, {
                  mono: true,
                  wrong: !portOk(form.port),
                  placeholder: '22',
                })}
              </div>
              {field('keyFile', t('add.keyFile'), t('add.keyFile.hint'), { mono: true })}
              {field('name', t('add.name'), t('add.name.hint'))}
              <div className="steps">
                <div className="check">
                  <button
                    type="button"
                    className="btn"
                    disabled={!formValid || checks[''] === 'checking'}
                    onClick={() => target && check('', target)}
                  >
                    {t('add.check')}
                  </button>
                  {checks[''] ? <CheckPill check={checks['']} /> : null}
                </div>
                <CheckLine name={form.host.trim()} check={checks['']} />
              </div>
            </>
          )}
          <div className="callout">{t('add.noPassword')}</div>
          {failure ? <div className="modal-note err">{failure}</div> : null}
        </div>
        <div className="modal-foot">
          <span className="dim grow">
            {mode === 'config' && !edit && picked.length > 0
              ? t('add.picked', { count: picked.length })
              : ''}
          </span>
          <button type="button" className="btn" onClick={onClose}>
            {t('add.cancel')}
          </button>
          <button
            type="submit"
            className="btn primary"
            disabled={busy || (mode === 'config' && !edit ? picked.length === 0 : !formValid)}
          >
            {edit
              ? t('devices.save')
              : mode === 'config'
                ? t('add.submit', { count: picked.length })
                : t('add.submitOne')}
          </button>
        </div>
      </form>
    </dialog>
  )
}
