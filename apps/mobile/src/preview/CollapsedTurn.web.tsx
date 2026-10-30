// 预览专用：用 R2 的插话形状、正式行构建器和单元格检查分段、长来源与小屏触控区域。
import type { SessionBackgroundView } from '@litch/core'
import { useEffect, useState } from 'react'
import { ScrollView } from 'react-native'
import { RowBuilder } from '../core/rows'
import { OriginCell } from '../detail/background/OriginCell'
import { MarkdownCell, StatusCell, UserCell } from '../detail/cells'
import { BackgroundContext, TranscriptContext } from '../detail/context'
import { GroupCell, GroupEndCell, ProcessCell, StepCell } from '../detail/steps'
import { type Booted, boot } from '../shell/boot'
import { loadPrefs, ServicesProvider } from '../shell/services'
import { I18nContext, translator } from '../ui/i18n'
import { makeTheme, SKINS, type Skin, ThemeContext } from '../ui/theme'
import { midTurnFixture } from './mid-turn-fixture.web.ts'

const noop = () => {}
const now = new Date()
now.setHours(14, 45, 0, 0)
const startedAt = now.getTime() - 9000
const background: SessionBackgroundView = {
  running: 0,
  wakesOnFinish: true,
  tasks: [
    {
      id: 'tests',
      kind: 'shell',
      status: 'completed',
      title: 'cd /root/tyrs-hand/litch && npm run client:test',
      itemId: 'tests',
      turnId: 'first',
      agentThreadId: null,
      startedAt,
      endedAt: now.getTime(),
    },
  ],
}

export function CollapsedTurnPreview({ params }: { params: URLSearchParams }) {
  const initialSkin = params.get('skin') as Skin
  const [look, setLook] = useState({
    skin: SKINS.includes(initialSkin) ? initialSkin : 'retro',
    theme: params.get('appearance') ?? 'light',
    lang: params.get('lang') ?? 'zh-CN',
  })
  const [, setExpanded] = useState(false)
  const [booted, setBooted] = useState<Booted | null>(null)
  useEffect(() => {
    let stopped = false
    let core: Booted | null = null
    void boot('mock', 'zh-CN').then((value) => {
      core = value
      if (stopped) value.stop()
      else setBooted(value)
    })
    return () => {
      stopped = true
      core?.stop()
    }
  }, [])
  Object.assign(window, {
    __litchLook: {
      set: (patch: Partial<typeof look>) => setLook((current) => ({ ...current, ...patch })),
    },
  })
  const zh = look.lang !== 'en'
  const theme = makeTheme(look.skin, look.theme === 'dark')
  const [builder] = useState(() => new RowBuilder())
  const rows = builder.build(midTurnFixture(), 'all')
  if (!booted) return null
  return (
    <ServicesProvider booted={booted} prefs={loadPrefs()} setPrefs={noop}>
      <ThemeContext.Provider value={theme}>
        <I18nContext.Provider value={translator(zh ? 'zh-CN' : 'en')}>
          <TranscriptContext.Provider
            value={{
              deviceId: 'local',
              sessionId: 's3',
              harness: 'Codex',
              scope: null,
              root: null,
              toggle: (key, turnId) => {
                builder.toggle(key, turnId)
                setExpanded((current) => !current)
              },
              openLink: noop,
              turnMenu: noop,
              openDiff: noop,
              openSession: noop,
              viewImage: noop,
              viewMermaid: noop,
            }}
          >
            <BackgroundContext.Provider value={background}>
              <ScrollView
                style={{ flex: 1, backgroundColor: theme.c.win }}
                contentContainerStyle={{ paddingVertical: 40 }}
              >
                {rows.map((row) => {
                  if (row.type === 'origin') return <OriginCell key={row.key} row={row} />
                  if (row.type === 'process') return <ProcessCell key={row.key} row={row} />
                  if (row.type === 'group') return <GroupCell key={row.key} row={row} />
                  if (row.type === 'step') return <StepCell key={row.key} row={row} />
                  if (row.type === 'groupEnd') return <GroupEndCell key={row.key} row={row} />
                  if (row.type === 'user') return <UserCell key={row.key} row={row} />
                  if (row.type === 'md') return <MarkdownCell key={row.key} row={row} />
                  if (row.type === 'status') return <StatusCell key={row.key} row={row} />
                  return null
                })}
              </ScrollView>
            </BackgroundContext.Provider>
          </TranscriptContext.Provider>
        </I18nContext.Provider>
      </ThemeContext.Provider>
    </ServicesProvider>
  )
}
