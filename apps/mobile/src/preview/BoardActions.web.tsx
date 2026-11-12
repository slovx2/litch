// 正式报告卡和共用操作栏：隔离模拟核心，不连接个人设备。
import { connectChannel, createMockCore, createPortPair, serveChannel } from '@litch/core'
import { NavigationContainer } from '@react-navigation/native'
import { useState } from 'react'
import { Text, View } from 'react-native'
import { KeyboardProvider } from 'react-native-keyboard-controller'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { sampleReport } from '../../../../packages/core/src/mock/manager-posts.mts'
import { sampleManagers } from '../../../../packages/core/src/mock/sample-manager.mts'
import { BoardActionScrollView, CardActionArea, CardActions } from '../screens/managers/CardActions'
import { Issue } from '../screens/managers/Issue'
import { clock } from '../shell/boot'
import { loadPrefs, ServicesProvider } from '../shell/services'
import { I18nContext, translator } from '../ui/i18n'
import { Button } from '../ui/kit/controls'
import { makeTheme, ThemeContext } from '../ui/theme'

const core = createMockCore({ clock, lang: 'zh-CN' })
const [client, server] = createPortPair()
serveChannel(server, core, { clock })
const booted = {
  mode: 'mock' as const,
  work: null,
  channel: connectChannel(client),
  stop: () => {
    booted.channel.close()
  },
}
const calls: unknown[] = []
Object.assign(window, { __boardActionCalls: calls })
booted.channel.command = new Proxy(booted.channel.command, {
  apply(target, receiver, args) {
    if (args[0] === 'managers.report.read') calls.push(args)
    return Reflect.apply(target, receiver, args)
  },
})
const { managers, boards } = sampleManagers('local', Date.now(), 'zh-CN')
const { manager, board } = (() => {
  const manager = managers[0]
  const board = boards[0]
  if (!manager || !board) throw new Error('缺少隔离看板数据')
  return { manager, board }
})()
const report = sampleReport(Date.now(), 'zh-CN')
report.title = '星云项目 · 长报告操作栏'
report.body = `${Array.from(
  { length: 32 },
  (_, i) => `第 ${i + 1} 段：核对星云项目的进度、验收记录和下一步安排。`,
).join('\n\n')}\n\n正文最后一行：全部内容可见。`
const noop = () => {}

export function BoardActionsPreview() {
  const [count, setCount] = useState(0)
  const theme = makeTheme('standard', true)
  return (
    <SafeAreaProvider>
      <I18nContext.Provider value={translator('zh-CN')}>
        <ServicesProvider booted={booted} prefs={loadPrefs()} setPrefs={noop}>
          <ThemeContext.Provider value={theme}>
            <NavigationContainer>
              <KeyboardProvider>
                <View style={{ flex: 1, backgroundColor: theme.c.win }}>
                  <Text style={{ color: theme.c.ink, padding: 16 }}>星云项目 · 经理看板</Text>
                  <BoardActionScrollView
                    testID="board-actions-scroll"
                    style={{ flex: 1 }}
                    contentContainerStyle={{ padding: 12, gap: 16 }}
                  >
                    <Issue
                      manager={manager}
                      board={board}
                      post={report}
                      suggestions={[]}
                      talking={false}
                      onTalk={noop}
                      onBack={noop}
                      onPosition={noop}
                    />
                    {['决策', '建议', '请你做', 'issue'].map((kind) => (
                      <CardActionArea
                        key={kind}
                        testID={`board-kind:${kind}`}
                        style={{
                          padding: 12,
                          borderWidth: 1,
                          borderColor: theme.c.line1,
                          backgroundColor: theme.c.panel,
                        }}
                      >
                        <Text style={{ color: theme.c.ink }}>{kind} · 星云项目</Text>
                        {Array.from(
                          { length: 24 },
                          (_, i) => `正文第 ${i + 1} 段，核对项目进度与验收。`,
                        ).map((paragraph) => (
                          <Text key={paragraph} style={{ color: theme.c.ink, paddingVertical: 16 }}>
                            {kind} {paragraph}
                          </Text>
                        ))}
                        <Text testID="board-end" style={{ color: theme.c.ink }}>
                          正文最后一行：全部内容可见。
                        </Text>
                        <View>
                          <View>
                            <CardActions>
                              <Button
                                label={`处理 ${kind} · ${count}`}
                                onPress={() => setCount(count + 1)}
                              />
                            </CardActions>
                          </View>
                        </View>
                        <CardActionArea>
                          <CardActions>
                            <Button label="回复" onPress={noop} />
                          </CardActions>
                        </CardActionArea>
                      </CardActionArea>
                    ))}
                  </BoardActionScrollView>
                </View>
              </KeyboardProvider>
            </NavigationContainer>
          </ThemeContext.Provider>
        </ServicesProvider>
      </I18nContext.Provider>
    </SafeAreaProvider>
  )
}
