// 使用正式问题卡和副本键；发出的用户答复只记在隔离夹具中，不连接任何设备。
import '../src/styles/index.css'
import {
  type CoreChannel,
  createReplica,
  keys,
  parseAskReply,
  type SessionQuestionSettlement,
} from '@litch/core'
import { createRoot } from 'react-dom/client'
import { setAppearance } from '../src/app/appearance.ts'
import { ServicesProvider } from '../src/app/services.tsx'
import { AskSheet } from '../src/transcript/AskCard.tsx'

const params = new URLSearchParams(location.search)
setAppearance({ lang: params.get('lang') === 'en' ? 'en' : 'zh-CN' })
const calls: unknown[] = []
const channel = {
  async command(name, args) {
    calls.push({ name, args })
    const answers = Object.fromEntries(
      (parseAskReply(args.text) ?? []).map((reply) => [reply.questionItemId, reply.answer]),
    )
    replica.store.set(keys.answers('fixture', 'child'), answers)
    return undefined
  },
} as CoreChannel
const replica = createReplica(channel)
const records: SessionQuestionSettlement[] = ['answer', 'withdraw'].map((action, index) => ({
  id: `record-${index}`,
  questionId: `source-${index}`,
  threadId: 'child',
  sourceIds: [`source-${index}`],
  replyIds: [`q-${index}`],
  title: index ? '是否发布这次变更？' : '是否运行完整测试？',
  action: action as 'answer' | 'withdraw',
  text: index ? '发布计划已取消，保留本地提交。' : '用户已在经理对话里要求运行相关测试。',
  sourceThreadId: 'manager',
  sourceTitle: '开发经理',
  at: 1,
}))
replica.store.set(keys.questionSettlements('fixture', 'child'), records)
replica.store.set(keys.pendingQuestions('fixture', 'child'), [])
replica.store.set(keys.session('fixture', 'child'), { live: true })
replica.store.set(keys.device('fixture'), { connection: 'online' })
Object.assign(window, { __questionSettlements: { calls } })
createRoot(document.getElementById('root')!).render(
  <ServicesProvider value={{ channel, replica, shell: 'browser' }}>
    <main style={{ maxWidth: 720, padding: 20 }}>
      {records.map((record) => (
        <AskSheet
          key={record.id}
          deviceId="fixture"
          sessionId="child"
          toggleId={record.id}
          questions={[{ id: record.replyIds[0], title: record.title, options: [] }]}
        />
      ))}
    </main>
  </ServicesProvider>,
)
