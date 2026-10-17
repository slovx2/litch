// 新会话：选 harness（设备上可用的不止一个时）、建在哪（工作区、不属于任何工作区、或者自己填一个目录）、
// 模型和权限这些（没选的显示对面不带设置新建时会用的，建会话时照显示的发），写第一句话发出去。
// 建会话和发第一条消息是一条命令（session.create），成了就把这一页换成详情页；没成就把文字还回输入框。
// 建不了的时候（设备没连上、没有可用的 harness、明说的工作区不在了）当场写原因，不悄悄换去处。
import {
  type DeviceView,
  type HarnessView,
  type ImageAttachment,
  keys,
  newSessionSettings,
  type SessionSettings,
  type WorkspaceView,
} from '@litch/core'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { KeyboardStickyView, useKeyboardState } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { acquireStore, releaseStore } from '../../core/store-cache'
import { ComposeBox, useDraft } from '../../detail/composer/ComposeBox'
import { draftKey } from '../../detail/composer/drafts'
import { useComposeOptions, useNewSessionDefaults } from '../../detail/composer/options'
import { SettingsBar } from '../../detail/composer/SettingsBar'
import type { RootStackParamList } from '../../nav/routes'
import { useChannel, useKey } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Row, SectionLabel } from '../../ui/kit/controls'
import { Prompt } from '../../ui/kit/overlays'
import { Screen } from '../../ui/kit/Screen'
import { useTheme } from '../../ui/theme'
import { lastPlace, pickHarness, recallPicks, remember } from './remembered'

type Props = NativeStackScreenProps<RootStackParamList, 'NewSession'>

/** 建在哪：一个工作区、不属于任何工作区（cwd 由对面定），或者自己填的一个目录 */
type Where = { kind: 'workspace'; id: string } | { kind: 'loose' } | { kind: 'dir'; path: string }

/** 建好之后最多等这么久，让会话的内容先到再切过去（切过去的第一帧就有那条消息） */
const HANDOVER_MS = 1500

export function NewSessionScreen({ navigation, route }: Props) {
  const { deviceId } = route.params
  const channel = useChannel()
  const t = useT()
  const insets = useSafeAreaInsets()
  const keyboard = useKeyboardState((state) => (state.isVisible ? state.height : 0))
  const lifted = keyboard > 0 ? keyboard - insets.bottom : 0
  const { c } = useTheme()
  const device = useKey<DeviceView>(keys.device(deviceId))
  const workspaces = useKey<WorkspaceView[]>(keys.workspaces(deviceId))
  const [where, setWhere] = useState<Where>(() => {
    const id = route.params.workspaceId ?? lastPlace(deviceId)
    return id ? { kind: 'workspace', id } : { kind: 'loose' }
  })
  const [asking, setAsking] = useState(false)
  const [chosenHarness, setChosenHarness] = useState<string | undefined>(undefined)
  const [own, setOwn] = useState<{ slot: string; picks: Partial<SessionSettings> }>({
    slot: '',
    picks: {},
  })
  const [error, setError] = useState<string | null>(null)
  const draft = useDraft(draftKey(deviceId, 'new'))

  const workspaceId = where.kind === 'workspace' ? where.id : null
  const workspace = workspaces?.find((entry) => entry.id === workspaceId)
  const cwd = where.kind === 'dir' ? where.path : (workspace?.roots[0] ?? null)
  const ready = device?.harnesses.filter((entry) => entry.state === 'ready') ?? []
  const offered = device?.harnesses.filter((entry) => entry.state !== 'disabled') ?? []
  const harness = pickHarness(ready, deviceId, workspaceId, chosenHarness)
  const harnessId = harness?.id ?? ''
  const options = useComposeOptions(deviceId, harness?.id)
  const defaults = useNewSessionDefaults(deviceId, harness?.id, cwd)

  // 选过的设置只在同一台设备的同一个 harness 上作数
  const slot = `${deviceId}/${harnessId}`
  const mine = own.slot === slot ? own.picks : {}
  const picks = { ...(options ? recallPicks(deviceId, harnessId, options) : {}), ...mine }
  const settled = options ? newSessionSettings(picks, defaults, options) : null
  const shown: SessionSettings = {
    model: settled?.model ?? null,
    effort: settled?.effort ?? null,
    permission: settled?.permission ?? null,
    mode: options?.plan ? (mine.mode ?? 'default') : null,
  }
  // 问到了对面的默认就把显示的几项都明着发；没问到只发选了的，免得把猜的当成选的发出去
  const sent: Partial<SessionSettings> =
    defaults && settled
      ? {
          ...picks,
          ...Object.fromEntries(Object.entries(settled).filter(([, value]) => value !== null)),
        }
      : picks

  const missing = where.kind === 'workspace' && workspaces !== undefined && !workspace
  const blocked = !device
    ? t('newSession.noDevice')
    : device.connection === 'connecting' || device.connection === 'reconnecting'
      ? t('newSession.deviceConnecting', { name: t.text(device.name) })
      : device.connection !== 'online'
        ? t('newSession.deviceOffline', { name: t.text(device.name) })
        : !harness
          ? t('newSession.noHarness')
          : missing
            ? t('newSession.workspaceGone')
            : null
  const imagesOff =
    harness?.abilities?.images === false
      ? t('composer.image.harness')
      : options?.models.find((entry) => entry.id === shown.model)?.acceptsImages === false
        ? t('composer.image.unsupported')
        : null

  const create = async (text: string, images: ImageAttachment[]) => {
    const { sessionId } = await channel.command('session.create', {
      deviceId,
      ...(harness ? { harness: harness.id } : {}),
      // 归在哪个工作区明说：只按工作目录去认的话，目录在两个工作区里都算得上时会认错
      ...(workspaceId ? { workspaceId } : {}),
      cwd,
      text,
      images,
      settings: sent,
    })
    const { mode: _thisOnce, ...kept } = picks
    remember(deviceId, workspaceId, harness?.id, kept)
    // 先把会话订阅上，内容到了（或者等过了时限）再换页：详情页拿的是同一份会话存储
    const store = acquireStore(channel, deviceId, sessionId)
    await new Promise<void>((done) => {
      if (store.getMeta()) return done()
      const timer = setTimeout(finish, HANDOVER_MS)
      const stop = store.subscribeMeta(finish)
      function finish() {
        clearTimeout(timer)
        stop()
        done()
      }
    })
    const title = text.split('\n')[0]?.slice(0, 80) || undefined
    navigation.replace('Detail', { deviceId, sessionId, ...(title ? { title } : {}) })
    // 详情页接上了再放掉这一次
    setTimeout(() => releaseStore(store), 0)
  }

  const pickWhere = (next: Where) => {
    setError(null)
    setWhere(next)
  }
  const harnessRow = (entry: HarnessView) => {
    const usable = entry.state === 'ready'
    return (
      <Row
        key={entry.id}
        testID={`new:harness:${entry.id}`}
        title={`${entry.badge}  ${entry.name}`}
        detail={
          usable
            ? (entry.version ?? undefined)
            : entry.reason
              ? t.text(entry.reason)
              : t(`harness.state.${entry.state}`)
        }
        selected={entry.id === harness?.id}
        {...(usable ? { onPress: () => setChosenHarness(entry.id) } : {})}
      />
    )
  }

  return (
    <Screen
      title={t('newSession.title')}
      subtitle={device ? t.text(device.name) : deviceId}
      wire={device ? c.wire[device.wire] : undefined}
      testID="new-session"
    >
      {/* 和详情页同一个做法：整块跟着键盘在 UI 线程上平移，移出去的那一截裁在标题栏下沿；
          键盘开着时选项上面垫出同样高，翻到顶还看得全 */}
      <View style={styles.clip}>
        <KeyboardStickyView offset={{ closed: 0, opened: insets.bottom }} style={styles.body}>
          <ScrollView
            style={styles.body}
            contentContainerStyle={{ paddingTop: lifted }}
            keyboardShouldPersistTaps="handled"
          >
            {ready.length > 1 ? (
              <>
                <SectionLabel>{t('newSession.harness')}</SectionLabel>
                {offered.map(harnessRow)}
              </>
            ) : null}
            <SectionLabel>{t('compose.new.where')}</SectionLabel>
            {missing ? (
              <Row testID="new:where:gone" title={t('newSession.workspaceGone.title')} selected />
            ) : null}
            {(workspaces ?? []).map((entry) => (
              <Row
                key={entry.id}
                testID={`new:where:${entry.id}`}
                title={entry.name}
                detail={entry.roots[0]}
                left={
                  entry.color ? (
                    <View style={[styles.swatch, { backgroundColor: c.wire[entry.color] }]} />
                  ) : undefined
                }
                selected={where.kind === 'workspace' && where.id === entry.id}
                onPress={() => pickWhere({ kind: 'workspace', id: entry.id })}
              />
            ))}
            <Row
              testID="new:where:loose"
              title={t('workspace.none')}
              detail={
                device && harness
                  ? t('newSession.looseNote', {
                      device: t.text(device.name),
                      harness: harness.name,
                    })
                  : undefined
              }
              selected={where.kind === 'loose'}
              onPress={() => pickWhere({ kind: 'loose' })}
            />
            <Row
              testID="new:where:dir"
              title={where.kind === 'dir' ? where.path : t('compose.new.otherDir')}
              detail={where.kind === 'dir' ? t('compose.new.dir') : undefined}
              selected={where.kind === 'dir'}
              onPress={() => setAsking(true)}
            />
            {blocked && device ? (
              <Text testID="new:blocked" style={[styles.blocked, { color: c.err }]}>
                {blocked}
              </Text>
            ) : null}
          </ScrollView>
          <View style={{ paddingBottom: insets.bottom, backgroundColor: c.panel }}>
            <ComposeBox
              testID="new"
              draft={draft}
              placeholder={t('compose.new.placeholder')}
              running={false}
              blocked={blocked}
              imagesOff={imagesOff}
              error={error}
              onSend={create}
              onError={setError}
              bar={
                <SettingsBar
                  fresh
                  options={options}
                  settings={shown}
                  onChange={(patch) => setOwn({ slot, picks: { ...mine, ...patch } })}
                />
              }
            />
          </View>
        </KeyboardStickyView>
      </View>
      <Prompt
        visible={asking}
        title={t('compose.new.dirTitle')}
        initial={where.kind === 'dir' ? where.path : (cwd ?? '')}
        placeholder={t('compose.new.dirPlaceholder')}
        submitLabel={t('form.confirm')}
        onSubmit={(path) => pickWhere({ kind: 'dir', path })}
        onClose={() => setAsking(false)}
      />
    </Screen>
  )
}

const styles = StyleSheet.create({
  body: { flex: 1 },
  clip: { flex: 1, overflow: 'hidden' },
  swatch: { width: 4, alignSelf: 'stretch' },
  blocked: { paddingHorizontal: 16, paddingVertical: 12, fontSize: 14, lineHeight: 20 },
})
