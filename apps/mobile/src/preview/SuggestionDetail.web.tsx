// 分页看板只先交公共外壳，原卡详情须由正式抽屉请求；不连接真实设备。
import {
  connectChannel,
  createMockCore,
  createPortPair,
  type SuggestionView,
  serveChannel,
} from '@litch/core'
import { NavigationContainer } from '@react-navigation/native'
import { useLayoutEffect, useState } from 'react'
import { View } from 'react-native'
import { KeyboardProvider } from 'react-native-keyboard-controller'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { sampleManagers } from '../../../../packages/core/src/mock/sample-manager.mts'
import type { ManagerIssue } from '../../../../packages/protocol/src/manager-issues.mts'
import type { ManagerPost } from '../../../../packages/protocol/src/manager-posts.mts'
import { ConsentPresentation } from '../privacy/ConsentPresentation'
import { IssueSheetDrawer } from '../screens/managers/issues/IssueConsole'
import { clock } from '../shell/boot'
import { loadPrefs, ServicesProvider } from '../shell/services'
import { I18nContext, translator } from '../ui/i18n'
import { makeTheme, ThemeContext } from '../ui/theme'

const now = Date.now()
const row: SuggestionView = {
  deviceId: 'local',
  managerId: 'm1',
  managerReview: { state: 'endorsed', reason: null, at: now },
  source: {
    threadId: 'manager-k1',
    title: '星云图片工作线',
    harness: 'codex',
    cwd: '/work/nebula',
    project: null,
    archived: false,
  },
  proposal: {
    id: 'nebula-detail',
    title: '修复星云工具图片首次查看',
    background: '已完成的过程组中，首次点击工具图片没有打开大图，需要补齐图片查看流程。',
    prompt: '保留回合展开保护，修复首次点击，并补充定向回归。',
    sourceIsManager: false,
    harness: 'codex',
    model: null,
    effort: null,
    cwd: '/work/nebula',
    kind: 'fresh',
    wakeParent: true,
    offer: false,
    status: 'pending',
    createdAt: now,
    expiresAt: now + 3600_000,
    settledAt: null,
    startedId: null,
    turnId: null,
    callId: null,
    widerSandbox: null,
    worktree: false,
    worktreeDefault: false,
  },
}
const issue: ManagerIssue = {
  id: 'S-nebula-detail',
  kind: 'suggestion',
  title: row.proposal.title,
  body: row.proposal.prompt,
  status: 'endorsed',
  stateGroup: 'pending',
  author: { kind: 'manager' },
  revision: 1,
  createdAt: now,
  updatedAt: now,
  followUp: { state: 'on', changedAt: now, changedBy: 'manager' },
  discussion: { comments: [], questions: [], summary: null },
  relations: [],
  timeline: [],
  unread: false,
  quick: { suggestion: { proposalId: row.proposal.id, canStart: true, reviewed: true } },
}
const post: ManagerPost = {
  id: 'S-nebula-detail',
  kind: 'suggestion',
  title: issue.title,
  body: issue.body,
  revision: 1,
  createdAt: now,
  updatedAt: now,
  fields: { status: 'endorsed' },
  proposalId: row.proposal.id,
  sourceThreadId: row.source.threadId,
  discussion: { messages: [], light: false, summary: null, forwarded: 0 },
  versions: [],
}
const { managers, boards } = sampleManagers('local', now, 'zh-CN')
const { manager, initial } = (() => {
  const manager = managers[0]
  const board = boards[0]
  if (!manager || !board) throw new Error('缺少隔离经理数据')
  return { manager, initial: { ...board, posts: [] } }
})()
const core = createMockCore({ clock, lang: 'zh-CN' })
const [client, server] = createPortPair()
serveChannel(server, core, { clock })
const booted = { mode: 'mock' as const, work: null, channel: connectChannel(client), stop() {} }
const calls: unknown[][] = []
let load = () => {}
const original = booted.channel.command.bind(booted.channel)
booted.channel.command = new Proxy(original, {
  apply(target, receiver, args) {
    if (args[0] === 'managers.board.detail') {
      calls.push(args)
      load()
      return Promise.resolve()
    }
    if (['session.proposal.accept', 'session.proposal.dismiss'].includes(args[0])) {
      calls.push(args)
      return Promise.resolve({ sessionId: 'nebula-child' })
    }
    return Reflect.apply(target, receiver, args)
  },
})
Object.assign(window, { __suggestionDetail: { calls } })
const noop = () => {}
export function SuggestionDetailPreview() {
  const [ready, setReady] = useState(false)
  useLayoutEffect(() => {
    load = () => setReady(true)
    return () => {
      load = noop
    }
  }, [])
  const theme = makeTheme('standard', true)
  return (
    <SafeAreaProvider>
      <I18nContext.Provider value={translator('zh-CN')}>
        <ServicesProvider booted={booted} prefs={loadPrefs()} setPrefs={noop}>
          <ThemeContext.Provider value={theme}>
            <NavigationContainer>
              <KeyboardProvider>
                <ConsentPresentation>
                  <View style={{ flex: 1, backgroundColor: theme.c.win }}>
                    <IssueSheetDrawer
                      manager={manager}
                      board={ready ? { ...initial, posts: [post] } : initial}
                      features={{
                        issues: true,
                        paging: true,
                        posts: true,
                        feedback: true,
                        ignore: true,
                      }}
                      suggestions={[row]}
                      issueId={issue.id}
                      issues={{
                        supported: true,
                        details: { [issue.id]: issue },
                        pages: {},
                        loading: [],
                        error: null,
                      }}
                      commands={{
                        list: async () => {},
                        read: async () => {},
                        create: async () => ({ issue: { id: 'X-1' } }),
                        update: async () => {},
                        comment: async () => {},
                        follow: async () => {},
                        seen: async () => {},
                      }}
                      disabled={false}
                      reason=""
                      onClose={noop}
                      onFull={noop}
                      onOpenItem={noop}
                    />
                  </View>
                </ConsentPresentation>
              </KeyboardProvider>
            </NavigationContainer>
          </ThemeContext.Provider>
        </ServicesProvider>
      </I18nContext.Provider>
    </SafeAreaProvider>
  )
}
