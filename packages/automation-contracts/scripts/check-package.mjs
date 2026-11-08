// 从源码构建，并把真实 tarball 装进仓库外消费者；不依赖仓内路径别名或发布包名。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const temp = mkdtempSync(join(tmpdir(), 'automation-consumer-'))
const home = join(temp, 'home'),
  consumer = join(temp, 'consumer')
mkdirSync(home)
mkdirSync(consumer)
const env = {
  ...process.env,
  HOME: home,
  CODEX_HOME: join(home, 'codex'),
  CLAUDE_CONFIG_DIR: join(home, 'claude'),
  CHA_STATE_DIR: join(home, 'adapter'),
  LITCH_LOG_DIR: join(home, 'logs'),
  npm_config_cache: join(temp, 'npm-cache'),
  npm_config_userconfig: join(home, '.npmrc'),
}
const run = (file, args, cwd = root) =>
  execFileSync(file, args, { cwd, env, stdio: 'pipe', encoding: 'utf8' })
const tsc = join(root, 'node_modules/typescript/bin/tsc')
run(process.execPath, [tsc, '-p', 'packages/automation-contracts/tsconfig.json'])
run(process.execPath, [tsc, '-p', 'packages/automation-contracts/test/tsconfig.json', '--noEmit'])
// CI 由 npm run check 进入，可直接使用 npm 自己报告的 JS 入口，避免 Windows .cmd 执行差异。
const npmCli = process.env.npm_execpath
assert.ok(npmCli, '请通过 npm run check:automation-contracts 执行')
const packageDir = join(root, 'packages/automation-contracts')
const pack = JSON.parse(
  run(
    process.execPath,
    [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', temp],
    packageDir,
  ),
)[0]
assert.ok(pack.files.length > 5)
const sourceFiles = readdirSync(join(packageDir, 'src'), { recursive: true }).filter((file) =>
  file.endsWith('.mts'),
)
const expectedBuild = sourceFiles
  .flatMap((file) => [
    `dist/${file.replace(/\\/g, '/').replace(/\.mts$/, '.mjs')}`,
    `dist/${file.replace(/\\/g, '/').replace(/\.mts$/, '.d.mts')}`,
  ])
  .sort()
assert.deepEqual(
  pack.files
    .map(({ path }) => path)
    .filter((path) => path.startsWith('dist/'))
    .sort(),
  expectedBuild,
  '构建不得漏入口或带入旧 dist 文件',
)
assert.ok(
  pack.files.every(({ path }) => /^(dist\/|README\.md$|LICENSE$|package\.json$)/.test(path)),
)
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
assert.equal(manifest.dependencies, undefined)
writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
run(
  process.execPath,
  [
    npmCli,
    'install',
    join(temp, pack.filename),
    '--ignore-scripts',
    '--offline',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
  ],
  consumer,
)
// 包名只从 manifest 取；示例没有把未来 npm scope 写死。
const example = readFileSync(join(packageDir, 'examples/fake-host.mts'), 'utf8')
writeFileSync(
  join(consumer, 'fake-host.mts'),
  example.replace("'../src/index.mjs'", JSON.stringify(manifest.name)),
)
cpSync(join(root, 'LICENSE'), join(consumer, 'LICENSE'))
run(
  process.execPath,
  [
    tsc,
    'fake-host.mts',
    '--target',
    'ES2023',
    '--module',
    'NodeNext',
    '--moduleResolution',
    'NodeNext',
    '--strict',
    '--skipLibCheck',
    '--lib',
    'ES2023,DOM',
    '--outDir',
    'out',
  ],
  consumer,
)
const script = `import assert from 'node:assert/strict';
import { createFakeExecutor, fakeBrowserDriver } from './out/fake-host.mjs';
import { validateChromeIdentity } from ${JSON.stringify(manifest.name)};
import { browserToolsSpec } from ${JSON.stringify(`${manifest.name}/litch`)};
validateChromeIdentity({hostName:'org.consumer.host',extensionIds:['a'.repeat(32)],productName:'Consumer'});
assert.ok(browserToolsSpec(true).tools.some(t=>t.name==='run_actions'));
const executor=createFakeExecutor(fakeBrowserDriver(),()=>1);
const scope={hostId:'consumer',deviceId:'local',sessionId:'s',turnId:'t',callId:'c'};
const result=await executor.execute({scope,namespace:'example_browser',tool:'navigate',arguments:{url:'https://example.test'}},
{signal:new AbortController().signal,hold:()=>()=>{},approvals:{dismiss:async()=>{},request:async r=>({requestId:r.id,nonce:r.nonce,scope:r.scope,decision:'once'})}});
assert.equal(result.success,true); await executor.dispose(); console.log('独立 tarball Node fake host 通过');`
writeFileSync(join(consumer, 'run.mjs'), script)
console.log(run(process.execPath, ['run.mjs'], consumer).trim())
// 源码用例同时核对抽取前哈希、投影与宿主取消/拒绝。
const tests = readdirSync(join(packageDir, 'test')).filter((file) => file.endsWith('.test.mts'))
console.log(
  run(process.execPath, [
    '--import',
    'tsx',
    '--test',
    ...tests.map((file) => join(packageDir, 'test', file)),
  ]).trim(),
)
console.log(`自动化合同检查通过；隔离消费者：${consumer}`)
