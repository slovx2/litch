// 预览场景 states：把平常示例里不出现的提示与异常状态凑到一起，给界面打磨和截图用。
// 只改示例数据，不改模拟核心的行为；默认示例和测试不受影响。
import type { RemoteChromeStatus } from '../../../protocol/src/remote-chrome.mjs'
import type { AppView } from '../model.mjs'
import { sampleHarness } from './sample-harness.mjs'

const CHROME: RemoteChromeStatus = {
  condition: 'waiting',
  enabled: false,
  hostLabel: 'dev@build-01',
  storeUrl: 'https://chromewebstore.google.com/detail/litch/sample',
  prepareCommand:
    'litch chrome prepare --device build-01 --profile ~/.config/litch/chrome-build-01',
  enableCommand: 'litch chrome enable --device build-01',
  disableCommand: 'litch chrome disable --device build-01',
}

/** 设备层：build-01 上的设备 Chrome 等待连接，Pi 启动失败（设备页直接给重启入口） */
export function applyStateDevices(app: AppView): void {
  const build = app.devices.find((device) => device.id === 'build')
  if (!build) return
  build.remoteChrome = { ...CHROME }
  build.harnesses = build.harnesses.map((harness) =>
    harness.id === 'pi'
      ? sampleHarness('pi', {
          down: {
            kind: 'startFailed',
            reason: 'harness.startFailed',
            detail: {
              'zh-CN': '进程启动后 3 秒内退出（退出码 1）：找不到 ~/.pi/agent/models.json',
              en: 'Process exited within 3 seconds (code 1): ~/.pi/agent/models.json not found',
            },
          },
        })
      : harness,
  )
}
