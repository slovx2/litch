// 预览专用：正式投影与 EventCell，四种经理事件加未来事件；不提供导航或看板操作。
import { projectItem } from '@litch/core'
import { useState } from 'react'
import { ScrollView } from 'react-native'
import { formatSessionEvent } from '../../../../packages/protocol/src/session-tree.mts'
import type { Row } from '../core/rows'
import { TranscriptContext } from '../detail/context'
import { EventCell } from '../detail/proposals/EventCell'
import { I18nContext, translator } from '../ui/i18n'
import { makeTheme, ThemeContext } from '../ui/theme'

export function ManagerEventsPreview({ params }: { params: URLSearchParams }) {
  const [look, setLook] = useState({
    theme: params.get('appearance') ?? 'light',
    lang: params.get('lang') ?? 'zh-CN',
  })
  Object.assign(window, {
    __litchLook: {
      set: (patch: Partial<typeof look>) => setLook((current) => ({ ...current, ...patch })),
    },
  })
  const zh = look.lang !== 'en'
  const theme = makeTheme('standard', look.theme === 'dark')
  const texts = [
    [
      'manager-open',
      zh
        ? '请核对迭代范围，列出待办并等待确认。'
        : 'Review the iteration scope and list the work for confirmation.',
    ],
    ['manager-answers', zh ? '按已提交的答复继续。' : 'Continue using the submitted answers.'],
    [
      'manager-end',
      zh
        ? '整理完成情况，保留尚未完成的事项。'
        : 'Summarize the results and retain unfinished items.',
    ],
    [
      'manager-rules',
      zh ? '范围：本轮只验证停报功能。' : 'Scope: verify reporting controls in this iteration.',
    ],
  ] as const
  const rows = texts.map(([kind, text]) =>
    formatSessionEvent({
      kind,
      notes: [],
      manager: {
        managerId: 'm1',
        text,
        ...(kind === 'manager-answers'
          ? {
              answers: [
                {
                  decisionId: 'D-1',
                  title: zh ? '范围' : 'Scope',
                  optionId: null,
                  optionLabel: null,
                  text: zh ? '只修改本轮功能' : 'Only change this feature',
                },
                {
                  decisionId: 'D-3',
                  title: zh ? '验收' : 'Checks',
                  optionId: null,
                  optionLabel: null,
                  text: zh ? '补齐回归测试' : 'Add regression tests',
                },
              ],
            }
          : {}),
      },
    }),
  )
  rows.push(
    '<litch-session-event kind="future-notice">\nA future event body.\n<!-- {"kind":"future-notice","notes":[]} -->\n</litch-session-event>',
  )
  const noop = () => {}
  return (
    <ThemeContext.Provider value={theme}>
      <I18nContext.Provider value={translator(zh ? 'zh-CN' : 'en')}>
        <TranscriptContext.Provider
          value={{
            deviceId: 'preview',
            sessionId: 'manager-events',
            harness: 'Codex',
            scope: null,
            root: null,
            toggle: noop,
            openLink: noop,
            turnMenu: noop,
            openDiff: noop,
            openSession: noop,
            viewImage: noop,
            viewMermaid: noop,
          }}
        >
          <ScrollView
            style={{ flex: 1, backgroundColor: theme.c.win }}
            contentContainerStyle={{ paddingVertical: 20 }}
          >
            {rows.map((text, i) => {
              const item = projectItem({
                type: 'userMessage',
                id: `event-${i}`,
                clientId: null,
                content: [{ type: 'text', text, text_elements: [] }],
              })
              if (item.kind !== 'userMessage' || !item.event) return null
              const row: Extract<Row, { type: 'event' }> = {
                type: 'event',
                key: item.id,
                turnId: `turn-${i}`,
                ...item.event,
              }
              return <EventCell key={row.key} row={row} />
            })}
          </ScrollView>
        </TranscriptContext.Provider>
      </I18nContext.Provider>
    </ThemeContext.Provider>
  )
}
