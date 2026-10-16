import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { approvalHarness } from './approval-harness.mjs'

// config/read 报的默认（模型、强度、权限档 default_permissions）就是不带这几项新建会话时真的会用的。
// 客户端的新建页照它显示（决 149）。Pi 只有一个权限档，审批开不开都是它；
// 强度照 Pi 建会话时的取法：这个模型单独记的档、全局默认档、medium，再钳到模型支持的范围。

/** 把夹具里的假模型改成能思考的，设置里写上 extra */
async function reasoning(agentDir: string, extra: Record<string, unknown>): Promise<void> {
  const modelsPath = join(agentDir, 'models.json')
  const models = JSON.parse(await readFile(modelsPath, 'utf8'))
  models.providers.gate.models[0].reasoning = true
  await writeFile(modelsPath, JSON.stringify(models))
  const settingsPath = join(agentDir, 'settings.json')
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'))
  await writeFile(settingsPath, JSON.stringify({ ...settings, ...extra }))
}

for (const approvals of [false, true]) {
  test(`CONFIG-DEFAULT-001：config/read 的默认和不带设置新建的会话一致（审批${approvals ? '打开' : '没打开'}）`, {
    timeout: 60000,
  }, async () => {
    const h = await approvalHarness({
      approvals,
      // 这个模型单独记的档比全局的优先，超出模型支持范围的钳下来
      prepare: (agentDir) =>
        reasoning(agentDir, {
          defaultThinkingLevel: 'low',
          modelThinkingLevels: { 'gate/gate': 'xhigh' },
        }),
    })
    try {
      const c = await h.connect('desktop')
      const check = async () => {
        const { config } = await c.ok('config/read', { cwd: h.cwd })
        assert.equal(config.default_permissions, ':danger-full-access')
        const started = await c.ok('thread/start', { cwd: h.cwd })
        assert.equal(started.thread.activePermissionProfile, config.default_permissions)
        assert.equal(started.model, config.model)
        assert.equal(started.reasoningEffort, config.model_reasoning_effort)
        return config.model_reasoning_effort
      }
      assert.equal(await check(), 'high')
      // 没有单独记的档：用全局的
      await reasoning(h.agentDir, { modelThinkingLevels: {} })
      assert.equal(await check(), 'low')
      assert.deepEqual(h.invalid, [])
    } finally {
      await h.dispose()
    }
  })
}
