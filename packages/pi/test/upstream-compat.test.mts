// 与上游协议的兼容性：Pi 的入口。用例在 packages/shared/test/compat-suite.mts，这里只管起入口。
// 引擎是真的 Pi SDK，模型是回环上的假模型（approval-harness.mts），审批开着。
import type { RpcPeer } from '../../shared/src/types.mjs'
import type { EntryScene, SceneName, TurnScript } from '../../shared/test/compat-scene.mjs'
import { type OpenedEntry, upstreamCompatSuite } from '../../shared/test/compat-suite.mjs'
import { StandardClient } from '../../shared/test/standard-client.mjs'
import { approvalHarness } from './approval-harness.mjs'

async function open(): Promise<OpenedEntry> {
  const harness = await approvalHarness({ approvals: true })
  const client: StandardClient = new StandardClient((message) =>
    harness.server.handle(peer, message as any),
  )
  const peer: RpcPeer = { id: 'standard', close() {}, send: (message) => client.accept(message) }
  // 官方桌面端每个回合都带协作模式；Pi 的提问只在计划模式里有
  const mode = (name: 'default' | 'plan') => ({
    collaborationMode: {
      mode: name,
      settings: { model: 'gate/gate', reasoning_effort: null, developer_instructions: null },
    },
  })
  const scene: EntryScene = {
    entry: 'pi',
    cwd: harness.cwd,
    threadStart: {},
    approvalMethod: 'item/commandExecution/requestApproval',
    script(name: SceneName): TurnScript {
      if (name === 'approval') {
        harness.steps.push(
          { tools: [{ name: 'bash', args: { command: 'echo compat' } }] },
          { text: '命令跑完了。' },
        )
        return { prompt: '跑一条命令。', params: mode('default') }
      }
      if (name === 'question') {
        const questions = [
          {
            id: 'route',
            header: '路线',
            question: '走哪条路线？',
            options: [
              { label: '甲', description: '第一条' },
              { label: '乙', description: '第二条' },
            ],
          },
        ]
        harness.steps.push(
          { tools: [{ name: 'plan_mode_question', args: { questions } }] },
          { tools: [{ name: 'plan_mode_complete', args: { plan: '# 计划\n走甲。' } }] },
        )
        return { prompt: '先问我再做计划。', params: mode('plan') }
      }
      if (name === 'slow') {
        // 模型的应答压着不给，等回合被打断之后才放；Pi 不流式，等请求到了模型这边再打断
        let release = () => {}
        const held = new Promise<void>((resolve) => {
          release = resolve
        })
        let asked = () => {}
        const requested = new Promise<void>((resolve) => {
          asked = resolve
        })
        harness.steps.push(async () => {
          asked()
          await held
          return { text: '来晚了。' }
        })
        return { prompt: '慢慢说。', params: mode('default'), release, requested }
      }
      harness.steps.push({ text: '好的。' })
      return { prompt: '说一句话。', params: mode('default') }
    },
    planMode: {
      model: 'gate/gate',
      // 计划插件收下计划，回合到此结束；就绪菜单不弹（没声明 planConfirmation）
      plan() {
        harness.steps.push({
          tools: [{ name: 'plan_mode_complete', args: { plan: '# 计划\n写一个文件。' } }],
        })
      },
      implement() {
        harness.steps.push({ text: '照计划做完了。' })
      },
    },
  }
  return { client, scene, close: () => harness.dispose() }
}

upstreamCompatSuite({ entry: 'pi', title: ' Pi 的入口', open })
