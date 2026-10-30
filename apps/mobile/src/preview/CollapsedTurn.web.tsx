// 预览专用：固定相邻回合，用正式单元格检查收起、展开、长来源与小屏触控区域。
import type { SessionBackgroundView } from '@litch/core'
import { useEffect, useState } from 'react'
import { ScrollView } from 'react-native'
import type { Row } from '../core/rows'
import { OriginCell } from '../detail/background/OriginCell'
import { MarkdownCell, StatusCell, UserCell } from '../detail/cells'
import { BackgroundContext, TranscriptContext } from '../detail/context'
import { ProcessCell } from '../detail/steps'
import { type Booted, boot } from '../shell/boot'
import { loadPrefs, ServicesProvider } from '../shell/services'
import { I18nContext, translator } from '../ui/i18n'
import { makeTheme, SKINS, type Skin, ThemeContext } from '../ui/theme'

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
  const [expanded, setExpanded] = useState(false)
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
  const answer = (key: string, text: string): Extract<Row, { type: 'md' }> => ({
    type: 'md',
    key,
    turnId: 'first',
    itemId: key,
    text,
    open: false,
    live: false,
    plan: false,
    first: true,
  })
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
              toggle: () => setExpanded((current) => !current),
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
                <MarkdownCell
                  row={answer(
                    'answer',
                    zh
                      ? '已完成本轮检查，后台任务结束后继续核对。'
                      : 'This review is complete. I will continue checking when the background task finishes.',
                  )}
                />
                <StatusCell
                  row={{
                    type: 'status',
                    key: 'first-status',
                    turnId: 'first',
                    status: 'completed',
                    durationMs: 9000,
                    startedAt,
                    working: false,
                    retry: null,
                  }}
                />
                <OriginCell
                  row={{
                    type: 'origin',
                    key: 'origin',
                    turnId: 'second',
                    origin: 'backgroundTask',
                    startedAt: now.getTime(),
                  }}
                />
                <ProcessCell
                  row={{
                    type: 'process',
                    key: 'process',
                    turnId: 'second',
                    expanded,
                    notes: 8,
                    steps: 16,
                    agents: 0,
                    declined: 0,
                    agentsFailed: 0,
                    status: 'completed',
                    durationMs: 196000,
                    ids: '',
                  }}
                />
                {expanded ? (
                  <MarkdownCell
                    row={answer(
                      'process-note',
                      zh
                        ? '正在核对后台任务的检查结果。'
                        : 'Reviewing the background task results.',
                    )}
                  />
                ) : null}
                <StatusCell
                  row={{
                    type: 'status',
                    key: 'second-status',
                    turnId: 'second',
                    status: 'completed',
                    durationMs: 196000,
                    startedAt: now.getTime(),
                    working: false,
                    retry: null,
                  }}
                />
                <UserCell
                  row={{
                    type: 'user',
                    key: 'next-user',
                    turnId: 'third',
                    text: zh
                      ? '为什么又倒了，人物有防御吗？'
                      : 'Why did the character fall again? Does it have any defense?',
                    attachments: [],
                  }}
                />
              </ScrollView>
            </BackgroundContext.Provider>
          </TranscriptContext.Provider>
        </I18nContext.Provider>
      </ThemeContext.Provider>
    </ServicesProvider>
  )
}
