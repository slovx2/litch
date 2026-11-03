// 手工局部验收：当前客户端核心连接指定版本的完整设备代码，所有 harness 均为假引擎。
// 用法：node scripts/check-manager-create-versions.mjs [working HEAD v0.29.0 v0.28.2 v0.28.1 v0.28.0]
// 历史源码只解包到临时夹具目录，不创建或切换 Git 工作树。结果包含原始设备错误与客户端文案。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fixtureEnvironment } from './fixture-environment.mjs'

const repo = fileURLToPath(new URL('..', import.meta.url))
const script = fileURLToPath(import.meta.url)
if (process.argv[2] !== '--child') {
  execFileSync('npm', ['run', 'build', '--prefix', 'packages/core'], {
    cwd: repo,
    stdio: 'inherit',
  })
  const root = mkdtempSync(join(tmpdir(), 'manager-create-'))
  console.log(`证据目录：${root}`)
  const refs = process.argv.slice(2)
  for (const ref of refs.length
    ? refs
    : ['working', 'HEAD', 'v0.29.0', 'v0.28.2', 'v0.28.1', 'v0.28.0']) {
    const directory = join(root, ref.replaceAll('/', '_'))
    mkdirSync(directory)
    if (ref !== 'working') {
      const archive = execFileSync(
        'git',
        [
          'archive',
          ref,
          'tsconfig.json',
          'package.json',
          'packages/device',
          'packages/protocol',
          'packages/shared',
          'protocol',
        ],
        { cwd: repo, maxBuffer: 64 * 1024 * 1024 },
      )
      execFileSync('tar', ['-xf', '-', '-C', directory], { input: archive })
      symlinkSync(join(repo, 'node_modules'), join(directory, 'node_modules'), 'dir')
    }
    const home = join(directory, 'home')
    mkdirSync(home)
    const env = {
      ...fixtureEnvironment(),
      HOME: home,
      CODEX_HOME: join(home, '.codex'),
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
    }
    const source = ref === 'working' ? repo : directory
    execFileSync(
      process.execPath,
      [join(repo, 'node_modules/typescript/bin/tsc'), '-p', 'packages/device/tsconfig.json'],
      { cwd: source, env, stdio: 'inherit' },
    )
    execFileSync(process.execPath, [script, '--child', source, ref], {
      cwd: directory,
      env,
      stdio: 'inherit',
    })
  }
} else {
  const directory = process.argv[3]
  const ref = process.argv[4]
  // 按解包的实现确定断言，HEAD 在修复合入后也应能重复验收，不把引用名称当版本能力。
  const validatesModels = existsSync(
    join(directory, 'packages/device/src/manager-create-validation.mts'),
  )
  const expandsHome = existsSync(join(directory, 'packages/device/src/directory-validation.mts'))
  const device = (path) => import(pathToFileURL(join(directory, 'packages/device/dist', path)).href)
  const { rig } = await device('device/test/helpers.mjs')
  const { FakeEngine } = await device('device/test/fake-engine.mjs')
  const { createManagers } = await import(
    '../packages/core/dist/packages/core/src/device/manager.mjs'
  )
  const { RpcError } = await import('../packages/core/dist/packages/core/src/connection/rpc.mjs')
  const codex = new FakeEngine('codex')
  codex.handlers['model/list'] = () => ({
    data: [
      {
        id: 'gpt-6-astra',
        model: 'gpt-6-astra',
        isDefault: true,
        supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
      },
    ],
    nextCursor: null,
  })
  const env = rig({ codex, pi: new FakeEngine('pi') })
  try {
    const client = env.connect()
    await client.initialize(['harness', 'litchManager'])
    const base = {
      name: '',
      scope: '',
      rules: '',
      firstTask: '',
      template: 'blank',
      cwd: env.stateDir,
      harness: 'pi',
      model: null,
      effort: null,
      permission: null,
      dispatch: {
        harness: 'codex',
        model: 'gpt-6-astra',
        effort: 'high',
        worktree: false,
        merge: 'manager',
        maxRunningLines: 4,
      },
      contact: { desktopNotification: true, unanswered: 'wait' },
    }
    let lastError
    const core = createManagers({
      deviceId: 'fixture',
      online: () => true,
      supported: () => true,
      features: () => ({ feedback: true, posts: true, ignore: true }),
      changed() {},
      log() {},
      fail: (error) => error,
      request: async (method, params) => {
        try {
          return await client.call(method, params)
        } catch (error) {
          lastError = error
          throw new RpcError(error.code, error.message, error.data)
        }
      },
    })
    const cases = [
      ['截图配置', {}, true],
      ['经理也用Codex', { harness: 'codex', model: 'gpt-6-astra', effort: 'high' }, true],
      ['目标设备home', { cwd: '~' }, expandsHome],
      ['相对目录', { cwd: 'project' }, false],
      ['波浪目录', { cwd: '~/project' }, false],
      ['目录不存在', { cwd: join(env.stateDir, 'deleted-project') }, false],
      ['路径是文件', { cwd: join(directory, 'package.json') }, false],
      ['经理harness未配置', { harness: 'removed' }, false],
      ['子会话harness未配置', { dispatch: { ...base.dispatch, harness: 'removed' } }, false],
      [
        '失效模型和强度',
        { dispatch: { ...base.dispatch, model: 'removed-model', effort: 'removed-effort' } },
        !validatesModels,
      ],
      [
        '显示名当模型ID',
        { dispatch: { ...base.dispatch, model: 'GPT-6-Astra' } },
        !validatesModels,
      ],
      ['并行数0', { dispatch: { ...base.dispatch, maxRunningLines: 0 } }, false],
      ['并行数小数', { dispatch: { ...base.dispatch, maxRunningLines: 1.5 } }, false],
      [
        '并行数最大安全整数',
        { dispatch: { ...base.dispatch, maxRunningLines: Number.MAX_SAFE_INTEGER } },
        true,
      ],
      ['空名称范围规则', { name: '', scope: '', rules: '' }, true],
      ['长规则', { rules: '规则'.repeat(50000) }, true],
      ['范围null', { scope: null }, false],
      ['隐藏联系方式', { contact: { ...base.contact, unanswered: 'notify' } }, false],
      ['未知字段', { staleField: true }, false],
    ]
    for (const [name, patch, valid] of cases) {
      const input = { ...base, ...patch }
      lastError = null
      // 原始 RPC 单独执行，避免新版客户端预校验掩盖旧设备行为。
      let raw
      try {
        const result = await client.call('litch/manager/create', input)
        assert.ok(env.device.managers.store.manager(result.manager.id))
        raw = { success: true }
      } catch (error) {
        if (error instanceof assert.AssertionError || error instanceof TypeError) throw error
        raw = error
      }
      assert.equal(raw.success === true, valid, `${ref}: ${name}: ${JSON.stringify(raw)}`)
      let mapped
      try {
        await core.create(input)
        mapped = { success: true }
      } catch (error) {
        mapped = { code: error.code, key: error.key, said: error.said, deviceError: lastError }
      }
      console.log(JSON.stringify({ ref, case: name, raw, client: mapped }))
    }
  } finally {
    await env.close()
  }
}
