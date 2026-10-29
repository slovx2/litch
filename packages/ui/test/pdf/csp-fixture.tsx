import '../../src/styles/index.css'
import '../preview/fixture.css'
import { createReplica } from '@litch/core'
import { createRoot } from 'react-dom/client'
import { createMockAutomation } from '../../../core/src/mock/mock-automation.mts'
import { ServicesProvider } from '../../src/app/services.tsx'
import { PreviewTab } from '../../src/automation-preview/PreviewTab.tsx'
import { browserClock, openChannel } from '../../src/boot/channel.ts'

// 只使用示例 JPEG 与模拟操作状态，不启动 CU 助手，不碰系统窗口。
const { channel } = await openChannel('zh-CN')
const automation = createMockAutomation(browserClock)
const subscribe = channel.subscribe.bind(channel)
channel.subscribe = ((topic, sink) =>
  topic.kind === 'automationPreview'
    ? automation.subscribe(topic.deviceId, topic.sessionId, sink)
    : subscribe(topic, sink)) as typeof channel.subscribe
const command = channel.command.bind(channel)
channel.command = ((name, params, options) =>
  name === 'automationPreview.control'
    ? Promise.resolve({})
    : command(name, params, options)) as typeof channel.command
automation.stage('local', 's3', '电脑预览')
const replica = createReplica(channel)
replica.start()
const mount = document.getElementById('root')
if (!mount) throw new Error('Fixture mount missing')
createRoot(mount).render(
  <ServicesProvider value={{ channel, replica, shell: 'browser' }}>
    <div className="preview-check">
      <PreviewTab
        place={{ deviceId: 'local', sessionId: 's3', roots: [], cwd: '/work', workspaceId: 'test' }}
        shown
      />
    </div>
  </ServicesProvider>,
)
