import {
  type DeviceView,
  type HarnessView,
  type ImageAttachment,
  keys,
  LOOSE,
  localUserMessage,
  type MessageExtra,
  newSessionSettings,
  type SessionSettings,
  type UserMessageItem,
  type WorkspaceView,
} from '@litch/core'
import { useEffect, useState } from 'react'
import type { Draft, Selection } from '../app/App.tsx'
import { requestAssistant } from '../app/actions.ts'
import { useT } from '../app/appearance.ts'
import { nameOf, nextStep, wireStyle } from '../app/device.ts'
import { useKey, useServices } from '../app/services.tsx'
import { useAssistant, warmManualDir } from '../assist/useAssistant.ts'
import { FailureNote, shownState, useReconnect } from '../devices/status.tsx'
import { InstallRow } from '../install/InstallRow.tsx'
import { useInstall } from '../install/useInstall.ts'
import { WorkspaceDialog } from '../sidebar/WorkspaceDialog.tsx'
import { UserAttachments } from '../transcript/messages.tsx'
import { Composer } from './Composer.tsx'
import type { PlaceWish } from './new-place.ts'
import { Picker, type PickerOption } from './Picker.tsx'
import {
  pickHarness,
  recallPicks,
  rememberHarness,
  rememberPicks,
  rememberPlace,
  useNewHarness,
} from './remembered.ts'
import { useComposeOptions, useNewSessionDefaults } from './SettingsBar.tsx'
import { useDevices } from './useNewPlace.ts'

interface NewSessionProps {
  /** 现在指着哪台设备、哪个工作区。一台设备都没有就是 null */
  draft: Draft | null
  /** 在页上换了设备或者工作区 */
  onPlace(wish: PlaceWish): void
  onCreated(selection: Selection): void
  /** 打开“设备”一页 */
  onDevices(): void
  /** 第几次点配置助手（0 是没点过）：变了就往输入框里放好那一句（useAssistant.ts） */
  assist: number
}

/** 等会话的内容到了界面这一侧再切过去，免得切换的那一下气泡闪没了。最多等这么久 */
const HANDOVER_MS = 1500

interface PlaceBarProps {
  draft: Draft
  device: DeviceView | undefined
  harness: HarnessView | undefined
  workspaces: WorkspaceView[] | undefined
  /** 指着的工作区不在这台设备的表里 */
  missing: boolean
  onPlace(wish: PlaceWish): void
}

/** 工作区选择器最后那一项“添加工作区…”的标识。不会和工作区的标识、LOOSE 撞上 */
const ADD_WORKSPACE = '\u0000add'

/** 输入框下面那一排：建在哪台设备上、哪个工作区里。先设备后工作区，因为工作区是设备上的 */
function PlaceBar({ draft, device, harness, workspaces, missing, onPlace }: PlaceBarProps) {
  const t = useT()
  const devices = useDevices()
  const { deviceId, workspaceId } = draft
  /** 添加工作区的对话框开着没有 */
  const [adding, setAdding] = useState(false)
  /** 刚添加的那个工作区：等它出现在这台设备的表里，页上就指过去 */
  const [added, setAdded] = useState<{ deviceId: string; workspaceId: string } | null>(null)
  useEffect(() => {
    if (!added) return
    // 这期间人把设备换了：不跟着跳回去
    if (added.deviceId !== deviceId) setAdded(null)
    else if (workspaces?.some((entry) => entry.id === added.workspaceId)) {
      onPlace(added)
      setAdded(null)
    }
  }, [added, deviceId, workspaces, onPlace])
  const deviceOptions: PickerOption[] = devices.map((entry) => {
    const state = shownState(entry)
    return {
      id: entry.id,
      title: t.text(entry.name),
      lead: (
        <i
          className={entry.connection === 'online' ? 'wire-sq' : 'wire-sq off'}
          style={wireStyle(entry.wire)}
        />
      ),
      // 连着的写主机，没连着的写状态：为什么没连上，选了它之后页上会说
      note: state === 'online' ? entry.host : t(`devices.state.${state}`),
    }
  })
  const workspaceOptions: PickerOption[] = [
    // 指着的那个不在了：留一项占着位置，让人看得出要换一个
    ...(missing && workspaceId
      ? [{ id: workspaceId, title: t('newSession.workspaceGone.title'), disabled: true }]
      : []),
    ...(workspaces ?? []).map((entry) => ({
      id: entry.id,
      title: entry.name,
      ...(entry.color ? { lead: <i className="ws-dot" style={wireStyle(entry.color)} /> } : {}),
      ...(entry.roots[0] ? { note: entry.roots[0] } : {}),
    })),
    {
      id: LOOSE,
      title: t('workspace.none'),
      ...(device && harness
        ? {
            note: t('newSession.looseNote', {
              device: t.text(device.name),
              harness: nameOf(device, harness.id),
            }),
          }
        : {}),
    },
    // 能在这台设备上管工作区的话，最后一项是添加一个：添加成了页上就指着它
    ...(device?.organizable && device.connection === 'online'
      ? [{ id: ADD_WORKSPACE, title: t('workspace.add'), action: true }]
      : []),
  ]
  return (
    <div className="new-place">
      <span className="new-place-item">
        <span className="new-place-label">{t('newSession.device')}</span>
        <Picker
          kind="device"
          label={t('newSession.device.label')}
          value={deviceId}
          options={deviceOptions}
          onPick={(id) => onPlace({ deviceId: id })}
        />
      </span>
      <span className="new-place-item">
        <span className="new-place-label">{t('newSession.workspace')}</span>
        <Picker
          kind="workspace"
          label={t('newSession.workspace.label')}
          value={workspaceId ?? LOOSE}
          options={workspaceOptions}
          onPick={(id) => {
            if (id === ADD_WORKSPACE) setAdding(true)
            else onPlace({ deviceId, workspaceId: id === LOOSE ? null : id })
          }}
        />
      </span>
      {adding ? (
        <WorkspaceDialog
          deviceId={deviceId}
          workspace={null}
          onAdded={(id) => setAdded({ deviceId, workspaceId: id })}
          onClose={() => setAdding(false)}
        />
      ) : null}
    </div>
  )
}

/** 设备没连上的时候：没连上的原因、该怎么办（和侧栏、设备页说的是同一份） */
function DeviceDown({ device }: { device: DeviceView }) {
  const t = useT()
  const reconnect = useReconnect(device.id)
  if (device.failure) {
    return <FailureNote failure={device.failure} target={device.target} onRetry={reconnect} />
  }
  return device.note ? <div>{t.text(device.note)}</div> : null
}

/**
 * 设备连着，可上面一个可用的 harness 都没有：每个 harness 是怎么回事、下一步做什么。
 * 设备能装 harness 时，没装的那几项直接带安装按钮（和设备页同一个组件）
 */
function HarnessesDown({ device }: { device: DeviceView }) {
  const t = useT()
  const install = useInstall(device)
  return device.harnesses.map((entry) => (
    <div key={entry.id} className="new-why-row" data-harness={entry.id}>
      <span className="chip off">{entry.badge}</span>
      <b>{entry.name}</b>
      <span className="grow">
        {t('harness.whyNext', {
          reason: entry.reason ? t.text(entry.reason) : t(`harness.state.${entry.state}`),
          next: nextStep(entry, t),
        })}
        {entry.state === 'unavailable' ? (
          <InstallRow
            device={device}
            harnessId={entry.id}
            view={install}
            name={entry.name}
            compact
          />
        ) : null}
      </span>
    </div>
  ))
}

/**
 * 新建对话页：应用启动、没有选中会话的时候主区域就是它。正中一句提示语，下面是输入区，
 * 输入区上能选建在哪个 harness 上、用什么模型、强度、权限，输入区下面一排选设备和工作区。
 * 先写第一条消息，发出去的那一刻才真的建：消息立刻显示在对话的位置上，不等会话建好；
 * 没建成就把文字还回输入框。
 */
export function NewSession({ draft, onPlace, onCreated, onDevices, assist }: NewSessionProps) {
  const deviceId = draft?.deviceId ?? ''
  const workspaceId = draft?.workspaceId ?? null
  const { channel, replica } = useServices()
  const t = useT()
  const listed = useKey<string[]>(keys.devices)
  const device = useKey<DeviceView>(keys.device(deviceId))
  const workspaces = useKey<WorkspaceView[]>(keys.workspaces(deviceId))
  const workspace = workspaces?.find((entry) => entry.id === workspaceId)
  /** 建在哪个 harness 上。设备上只有一个可用的就是它；一个可用的都没有就是 undefined */
  const harness = useNewHarness(device, workspaceId)
  const harnessId = harness?.id ?? ''
  const options = useComposeOptions(deviceId, harness?.id)
  /**
   * 用户这次自己选的，连同是在哪台设备的哪个 harness 上选的：模型这些是 harness 自己的，
   * 换了设备或者 harness 就不作数了。没选的用上次的，上次也没有就让对面用它的默认值
   */
  const slot = `${deviceId}/${harnessId}`
  const [chosen, setChosen] = useState<{ slot: string; picks: Partial<SessionSettings> }>({
    slot,
    picks: {},
  })
  /** 已经发出去、会话还没建好的那条消息 */
  const [pending, setPending] = useState<UserMessageItem | null>(null)

  const cwd = workspace?.roots[0] ?? null
  // 配置助手：点了之后设备切到本机，这里放好那一句（有手册的技能就带技能片）
  useAssistant(assist, { device, harness, cwd }, 'new')
  useEffect(warmManualDir, [])
  /** 对面不带设置新建会话时会用的。还在问是 undefined，问不到是 null */
  const defaults = useNewSessionDefaults(deviceId, harness?.id, cwd)
  // 还在问的时候底栏先不出选择器：先按清单猜一个、问回来再换掉的话，底栏会跳一下，
  // 正点开的选项（比如那个模型才有的强度）会在手底下没了
  const holding = defaults === undefined

  const own = chosen.slot === slot ? chosen.picks : {}
  const picks = { ...(options ? recallPicks(deviceId, harnessId, options) : {}), ...own }
  // 底栏上显示的：选过的；没选的是对面不带设置新建时会用的，建会话时也照显示的发，显示的就是会用的
  const settled = options && !holding ? newSessionSettings(picks, defaults, options) : null
  const shown: SessionSettings = {
    model: settled?.model ?? null,
    effort: settled?.effort ?? null,
    speed: settled?.speed ?? null,
    permission: settled?.permission ?? null,
    // 计划模式只管眼前这一个新对话，不记到下一次；这个 harness 不会的话没有这个开关
    mode: options?.plan ? (own.mode ?? 'default') : null,
  }
  // 发出去的：问到了对面的默认，就把显示的几项都明着发（没有的不发）；没问到照以前，只发选了的，
  // 免得把猜的（清单里标了默认的那个）当成选的发出去
  const sent: Partial<SessionSettings> =
    defaults && settled
      ? {
          ...picks,
          ...Object.fromEntries(Object.entries(settled).filter(([, value]) => value !== null)),
        }
      : picks
  // 指着的工作区不在这台设备的表里（被删了）：不能悄悄建成不属于工作区的会话
  const missing = workspaceId !== null && !workspace

  const create = async (text: string, images: ImageAttachment[], extras: MessageExtra[]) => {
    // 和会话里先显示出来的那一条是同一个算法：带着的文字并进正文，技能和图片列在上面
    setPending(
      localUserMessage('pending', { text, images, extras }, harness?.abilities?.mentions === true),
    )
    try {
      const { sessionId } = await channel.command('session.create', {
        deviceId,
        ...(harness ? { harness: harness.id } : {}),
        // 归在哪个工作区明说：只按工作目录去认的话，目录在两个工作区里都算得上时会认错
        ...(workspaceId ? { workspaceId } : {}),
        cwd,
        text,
        images,
        extras,
        settings: sent,
      })
      const { mode: _thisOnce, ...kept } = picks
      rememberPicks(deviceId, harnessId, kept)
      if (harness) rememberHarness(deviceId, workspaceId, harness.id)
      rememberPlace(deviceId, workspaceId)
      // 先把这个会话的内容订阅过来，等内容和侧栏上的那一行都到了再切：
      // 切过去的第一帧就有那条消息，标题栏也不会空一下
      const close = replica.openSession(deviceId, sessionId)
      const wanted = [keys.session(deviceId, sessionId), keys.summary(deviceId, sessionId)]
      await new Promise<void>((done) => {
        const ready = () => wanted.every((key) => replica.store.get(key) !== undefined)
        if (ready()) return done()
        const stops = wanted.map((key) => replica.store.subscribe(key, () => ready() && finish()))
        const timer = window.setTimeout(finish, HANDOVER_MS)
        function finish() {
          for (const stop of stops) stop()
          window.clearTimeout(timer)
          done()
        }
      })
      onCreated({ deviceId, sessionId })
      // 对话区自己会再订阅一次；等它接上了再放掉这一次，中间不退订
      window.setTimeout(close, 0)
    } catch (error) {
      setPending(null)
      throw error
    }
  }

  // 设备的清单还没到（刚启动的头一两帧）：先空着，免得闪一下“还没有设备”
  if (listed === undefined) return <div className="new-page" />

  // 可用的不止一个才出选择；一时用不了的也列在里面（选不了），旁边写着为什么。
  // 在设置里停用了的不列：那是用户自己关掉的，不是“现在暂时用不了”
  const usable = device?.harnesses.filter((entry) => entry.state === 'ready') ?? []
  const offered = device?.harnesses.filter((entry) => entry.state !== 'disabled') ?? []
  const choice =
    device && harness && usable.length > 1 ? (
      <Picker
        kind="harness"
        label={t('newSession.harness')}
        value={harness.id}
        options={offered.map((entry) => ({
          id: entry.id,
          title: entry.name,
          ...(entry.state === 'ready'
            ? {}
            : {
                disabled: true,
                note: t('harness.whyNext', {
                  reason: entry.reason ? t.text(entry.reason) : t('harness.state.unavailable'),
                  next: nextStep(entry, t),
                }),
              }),
        }))}
        onPick={(id) => pickHarness(deviceId, workspaceId, id)}
      />
    ) : null

  /**
   * 现在建不了的话：一句为什么（写在输入框下面），和它后面的细节、下一步。
   * down 说的是哪一种，自检按它认；细节里有去“设备”一页的按钮的那几种，该去那一页处理
   */
  let blocked: string | null = null
  let down: 'none' | 'device' | 'harness' | 'workspace' | null = null
  if (!device) {
    blocked = t('newSession.noDevice')
    down = 'none'
  } else if (device.connection !== 'online') {
    const state = shownState(device)
    const waiting = state === 'connecting' || state === 'reconnecting'
    blocked = t(waiting ? 'newSession.deviceConnecting' : 'newSession.deviceOffline', {
      name: t.text(device.name),
    })
    down = 'device'
  } else if (!harness) {
    blocked = t('newSession.noHarness')
    down = 'harness'
  } else if (missing) {
    blocked = t('newSession.workspaceGone')
    down = 'workspace'
  }
  const why =
    down && down !== 'workspace' ? (
      <div className="new-why" data-down={down}>
        {device && down === 'device' ? <DeviceDown device={device} /> : null}
        {device && down === 'harness' ? <HarnessesDown device={device} /> : null}
        <div className="new-why-acts">
          <button type="button" className="btn" data-act="open-devices" onClick={onDevices}>
            {t('newSession.openDevices')}
          </button>
        </div>
      </div>
    ) : null

  return (
    <div className={pending === null ? 'new-page' : 'new-page sending'}>
      {pending === null ? (
        <div className="new-hero">
          <h1>{t('newSession.hero')}</h1>
          <button
            type="button"
            className="new-assist"
            data-act="assistant"
            title={t('assist.button.note')}
            onClick={requestAssistant}
          >
            {t('assist.button')}
          </button>
        </div>
      ) : (
        <div className="tr-scroll">
          <div className="tr">
            <section className="turn">
              <div className="umsg">
                <UserAttachments attachments={pending.attachments} />
                {pending.text ? <div className="umsg-text">{pending.text}</div> : null}
              </div>
              <div className="running-line">
                <i className="st run" />
                <span>{t('newSession.creating')}</span>
              </div>
            </section>
          </div>
        </div>
      )}
      <div className="dock-wrap">
        <div className="dock" style={wireStyle(device?.wire)}>
          <div className="dock-in">
            <Composer
              deviceId={deviceId}
              harness={harness?.id}
              // 整个新建对话页只有一份草稿：在页上换设备、换工作区，写了一半的字不动
              draftKey="new"
              cwd={cwd}
              placeholder={t('newSession.placeholder')}
              blocked={blocked}
              fresh
              lead={choice}
              // 发出去之后不再让换去处，这一排收起来：输入区的高度和会话里的一样，建好切过去时不跳
              below={
                draft && pending === null ? (
                  <PlaceBar
                    draft={draft}
                    device={device}
                    harness={harness}
                    workspaces={workspaces}
                    missing={missing}
                    onPlace={onPlace}
                  />
                ) : null
              }
              running={false}
              queued={[]}
              settings={shown}
              holdSettings={holding}
              onSettings={(patch) => setChosen({ slot, picks: { ...own, ...patch } })}
              onSend={create}
              failure={(reason) => t('newSession.failed', { reason })}
            />
            {pending === null ? why : null}
          </div>
        </div>
      </div>
    </div>
  )
}
