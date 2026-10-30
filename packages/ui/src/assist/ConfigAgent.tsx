// litch config 在界面这一头（config 主题，14 号设计 3.3）：本机 harness 里的模型跑 `litch config …`，
// 核心执行器把要界面做的事交给最近订阅的这个窗口（外观、语言、两个本地偏好、打开某一页、出码对话框），
// 这里照做后用 config.reply 回话；放宽安全的那几项（E6）和撤不回的那几项（E7）出确认卡，每个窗口都有，人点允许或拒绝用 config.confirm 回。
// 卡片写清是哪个会话、哪个 harness、要做什么；两分钟没人理，核心那边当拒绝，卡片自己撤掉。
import type {
  ConfigConfirmItem,
  ConfigConfirmView,
  ConfigPrefs,
  ConfigTopicView,
  ConfigUiAsk,
  DeviceView,
} from '@litch/core'
import { keys } from '@litch/core'
import { useEffect, useRef, useState } from 'react'
import { requestDevice, requestNewSession, requestSettings, requestTasks } from '../app/actions.ts'
import {
  type Appearance,
  CHAT_WIDTHS,
  type ChatWidth,
  currentLang,
  DENSITIES,
  type Density,
  SKINS,
  type Skin,
  setAppearance,
  TEXT_SCALES,
  THEMES,
  type Theme,
  useAppearance,
  useT,
  ZOOMS,
  type Zoom,
} from '../app/appearance.ts'
import { useKey, useKeys, useServices } from '../app/services.tsx'
import { PairDialog } from '../devices/PairDialog.tsx'
import type { Translator } from '../i18n/index.ts'
import {
  notifyScope,
  notifySessions,
  setNotifyScope,
  setNotifySessions,
} from '../notify/session-notice.ts'
import { linksInApp, setLinksInBrowser } from '../side/browser/links.ts'
import { notifySuccess, setNotifySuccess } from '../tasks/notify-pref.ts'

/** 现在的偏好（执行器读、写完回给模型看的那一份） */
function prefsNow(look: Appearance): ConfigPrefs {
  return {
    skin: look.skin,
    theme: look.theme,
    density: look.density,
    chatWidth: look.chatWidth,
    zoom: look.zoom,
    treeText: look.treeText,
    chatText: look.chatText,
    lang: currentLang(),
    linksInApp: linksInApp(),
    notifySuccess: notifySuccess(),
    notifySessions: notifySessions(),
    notifyScope: notifyScope(),
  }
}

const oneOf = <T extends string | number>(list: readonly T[], value: unknown): T | undefined =>
  list.includes(value as T) ? (value as T) : undefined

/** 照执行器给的改动改偏好：认不出的值不动（执行器那边已经挡过一遍） */
function applyPrefs(patch: Partial<ConfigPrefs>): void {
  const look = pickLook(patch)
  if (Object.keys(look).length > 0) setAppearance(look)
  if (typeof patch.linksInApp === 'boolean') setLinksInBrowser(patch.linksInApp)
  if (typeof patch.notifySuccess === 'boolean') setNotifySuccess(patch.notifySuccess)
  if (typeof patch.notifySessions === 'boolean') setNotifySessions(patch.notifySessions)
  if (patch.notifyScope === 'all' || patch.notifyScope === 'main') setNotifyScope(patch.notifyScope)
}

/** 确认卡上一项的话 */
export function itemText(item: ConfigConfirmItem, t: Translator): string {
  switch (item.kind) {
    case 'tool':
      return t(item.tool === 'computer' ? 'assist.confirm.computer' : 'assist.confirm.machine', {
        device: item.device,
      })
    case 'approval':
      return t('assist.confirm.approval', { device: item.device })
    case 'access':
      return t('assist.confirm.access', { device: item.device })
    case 'site':
      return t('assist.confirm.site', { origin: item.origin })
    case 'trustAllSites':
      return t('assist.confirm.trustAll')
    case 'unblock':
      return item.host === null
        ? t('assist.confirm.unblockAll')
        : t('assist.confirm.unblock', { host: item.host })
    case 'erase':
      return t(`assist.confirm.erase.${item.what}`, {
        device: item.device ?? '',
        name: item.name ?? '',
      })
  }
}

/** 一张确认卡 */
function ConfirmCard({
  card,
  onAnswer,
}: {
  card: ConfigConfirmView
  onAnswer(allow: boolean): void
}) {
  const t = useT()
  const dialog = useRef<HTMLDialogElement>(null)
  const local = useKey<DeviceView>(keys.device('local'))
  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) element.showModal()
  }, [])
  const harness =
    local?.harnesses.find((entry) => entry.id === card.harness)?.name ?? card.harness ?? null
  const where = card.session
    ? t('assist.confirm.session', {
        title: card.session.title || t('assist.confirm.untitled'),
        harness: harness ?? '?',
      })
    : harness
      ? t('assist.confirm.harness', { harness })
      : t('assist.confirm.unknown')
  // 有撤不回的项（E7）时标题换成“删除”，并多一句撤不回
  const erase = card.items.some((item) => item.kind === 'erase')
  const title = t(erase ? 'assist.confirm.titleErase' : 'assist.confirm.title')
  return (
    <dialog
      ref={dialog}
      className="modal confirm assist-confirm"
      aria-label={title}
      data-config-confirm={card.id}
      onCancel={(event) => {
        // Esc 等于拒绝
        event.preventDefault()
        onAnswer(false)
      }}
    >
      <div className="confirm-body">
        <b>{title}</b>
        <span>{where}</span>
        <ul className="assist-items">
          {card.items.map((item) => (
            <li key={JSON.stringify(item)} data-item={item.kind}>
              {itemText(item, t)}
            </li>
          ))}
        </ul>
        <code className="mono assist-cmd">litch config {card.command}</code>
        {erase && <b className="assist-erase">{t('assist.confirm.eraseNote')}</b>}
        <span className="dim">{t('assist.confirm.note')}</span>
        <div className="pick-ask-actions">
          <button
            type="button"
            className="btn ghost"
            data-act="config-decline"
            // biome-ignore lint/a11y/noAutofocus: 一打开焦点落在不做事的那个按钮上，顺手回车不会放行
            autoFocus
            onClick={() => onAnswer(false)}
          >
            {t('assist.confirm.decline')}
          </button>
          <button
            type="button"
            className="btn danger confirm-yes"
            data-act="config-allow"
            onClick={() => onAnswer(true)}
          >
            {t('assist.confirm.allow')}
          </button>
        </div>
      </div>
    </dialog>
  )
}

/** 盖在应用上的那一个：做执行器要界面做的事、出确认卡、开出码对话框 */
export function ConfigAgent() {
  const { channel } = useServices()
  const look = useAppearance()
  const lookRef = useRef(look)
  lookRef.current = look
  const [view, setView] = useState<ConfigTopicView>({ asks: [], confirms: [] })
  /** 做过的事：同一件不做第二遍（快照和增量可能都带着它） */
  const handled = useRef(new Set<string>())
  /** 执行器要开的出码对话框 */
  const [pair, setPair] = useState<{
    deviceId: string
    prefill: { host?: string; port?: number; user?: string }
  } | null>(null)
  const deviceIds = useKey<string[]>(keys.devices) ?? []
  const devices = useKeys<DeviceView>(deviceIds.map((id) => keys.device(id)))
  const pairDevice = pair ? devices.find((device) => device?.id === pair.deviceId) : undefined

  useEffect(
    () =>
      channel.subscribe(
        { kind: 'config' },
        {
          snapshot: (data) => setView(data),
          delta: (ops) => {
            const last = ops.at(-1)
            if (last) setView(last.view)
          },
          // 订不上：这个窗口不接执行器的事（执行器那边到点当没做成）
          error() {},
        },
      ),
    [channel],
  )

  // 执行器交来的事：照做，回话
  useEffect(() => {
    const reply = (ask: ConfigUiAsk, ok: boolean, data?: unknown, reason?: string) => {
      channel
        .command('config.reply', {
          id: ask.id,
          ok,
          ...(data === undefined ? {} : { data }),
          ...(reason === undefined ? {} : { reason }),
        })
        .catch(() => {})
    }
    for (const ask of view.asks) {
      if (handled.current.has(ask.id)) continue
      handled.current.add(ask.id)
      const { request } = ask
      switch (request.kind) {
        case 'prefs.get':
          reply(ask, true, prefsNow(lookRef.current))
          break
        case 'prefs.set':
          applyPrefs(request.patch)
          // 外观改完下一帧再读：setAppearance 是同步的，读 current 就是新的
          reply(ask, true, prefsNow({ ...lookRef.current, ...pickLook(request.patch) }))
          break
        case 'open': {
          const { place } = request
          if (place.where === 'settings') requestSettings(place.section ?? 'look')
          else if (place.where === 'device') requestDevice(place.deviceId)
          else if (place.where === 'tasks') requestTasks({ view: 'list' })
          else requestNewSession()
          reply(ask, true)
          break
        }
        case 'pair':
          setPair({ deviceId: request.deviceId, prefill: request.prefill })
          reply(ask, true)
          break
        default:
          reply(ask, false, undefined, 'This Litch window does not know how to do that.')
      }
    }
  }, [view.asks, channel])

  const answer = (id: string, allow: boolean) => {
    channel.command('config.confirm', { id, allow }).catch(() => {
      // 卡片已经不在了（别的窗口点过、到点了）：主题会把它撤掉
    })
  }

  // 同时只出一张卡：先来的先问
  const card = view.confirms[0]
  return (
    <>
      {card ? (
        <ConfirmCard key={card.id} card={card} onAnswer={(allow) => answer(card.id, allow)} />
      ) : null}
      {pair && pairDevice ? (
        <PairDialog
          key={`${pair.deviceId}:${JSON.stringify(pair.prefill)}`}
          device={pairDevice}
          prefill={pair.prefill}
          onClose={() => setPair(null)}
        />
      ) : null}
    </>
  )
}

/** 改动里属于外观的那几项（回话里的偏好要是改完的） */
function pickLook(patch: Partial<ConfigPrefs>): Partial<Appearance> {
  const look: Partial<Appearance> = {}
  const skin = oneOf<Skin>(SKINS, patch.skin)
  if (skin) look.skin = skin
  const theme = oneOf<Theme>(THEMES, patch.theme)
  if (theme) look.theme = theme
  const density = oneOf<Density>(DENSITIES, patch.density)
  if (density) look.density = density
  const chatWidth = oneOf<ChatWidth>(CHAT_WIDTHS, patch.chatWidth)
  if (chatWidth) look.chatWidth = chatWidth
  const zoom = oneOf<Zoom>(ZOOMS, patch.zoom)
  if (zoom !== undefined) look.zoom = zoom
  for (const name of ['treeText', 'chatText'] as const) {
    const scale = oneOf(TEXT_SCALES, patch[name])
    if (scale !== undefined) look[name] = scale
  }
  if (patch.lang === 'zh-CN' || patch.lang === 'en') look.lang = patch.lang
  return look
}
