// 飞书端到端用例的公共夹具：起假飞书和隔离的设备，管理员连接声明 litchFeishu，接好一个应用。
import type { TestContext } from 'node:test'
import { FEISHU_METHOD as M } from '../../protocol/src/feishu.mjs'
import { FakeFeishu } from './feishu-fake.mjs'
import { rig, TestClient } from './helpers.mjs'

export class FeishuFakeHarness {
  readonly fake: FakeFeishu
  readonly env: ReturnType<typeof rig>
  readonly admin: TestClient

  private constructor(fake: FakeFeishu, env: ReturnType<typeof rig>, admin: TestClient) {
    this.fake = fake
    this.env = env
    this.admin = admin
  }

  static async start(t: TestContext): Promise<FeishuFakeHarness> {
    const fake = new FakeFeishu()
    await fake.start()
    const env = rig(
      {},
      {},
      { feishu: { fixture: { origin: fake.origin, registrationIntervalMs: 10 } } },
    )
    const admin = new TestClient((wire) => env.device.attach(wire, true))
    await admin.initialize(['harness', 'litchFeishu'])
    t.after(async () => {
      admin.close()
      await env.close()
      await fake.close()
    })
    return new FeishuFakeHarness(fake, env, admin)
  }

  /** 手动填写一个假服务端上已有的应用，等长连接连上 */
  async configure(appId: string): Promise<void> {
    await this.admin.call(M.appConfigure, {
      operationId: `configure-${appId}`,
      appId,
      appSecret: `secret-${appId}`,
    })
    await this.until(() => this.fake.connected(appId) === 1)
  }

  async until<T>(
    read: () => T | undefined | false | Promise<T | undefined | false>,
    timeoutMs = 5000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const value = await read()
      if (value) return value
      if (Date.now() > deadline) throw new Error('等待超时')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
}
