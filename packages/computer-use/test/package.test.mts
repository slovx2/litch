// 真正装到仓库外，防源码相对路径、类型别名或 Electron 依赖漏进制品。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

test('独立 tarball：无仓库消费者 import、typecheck 和 fake helper 执行', () => {
  const pkg = fileURLToPath(new URL('..', import.meta.url))
  const root = fileURLToPath(new URL('../../..', import.meta.url))
  execFileSync(process.execPath, [
    join(root, 'node_modules/typescript/bin/tsc'),
    '-p',
    join(pkg, 'tsconfig.json'),
  ])
  const directory = mkdtempSync(join(tmpdir(), 'cu-consumer-'))
  const env = {
    ...process.env,
    npm_config_cache: join(directory, 'cache'),
    npm_config_ignore_scripts: 'true',
  }
  const packed = JSON.parse(
    execFileSync('npm', ['pack', pkg, '--json', '--pack-destination', directory], {
      env,
      encoding: 'utf8',
    }),
  ) as { filename: string; files: { path: string }[] }[]
  const tarball = packed[0]
  assert.ok(tarball)
  assert.ok(
    tarball.files.every(
      (file) =>
        ['README.md', 'NATIVE-PROTOCOL.md', 'LICENSE', 'package.json'].includes(file.path) ||
        file.path.startsWith('dist/'),
    ),
  )
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ type: 'module', private: true }))
  execFileSync(
    'npm',
    [
      'install',
      '--offline',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      join(directory, tarball.filename),
    ],
    { cwd: directory, env },
  )
  assert.ok(!readdirSync(join(directory, 'node_modules')).includes('electron'))
  const consumer = `import { createComputerUse, type ToolInvocation, type InvocationContext } from 'computer-use-internal';
import { computerTools } from 'computer-use-internal/tools';
import { FrameReader } from 'computer-use-internal/node';
const client = { request: async () => ({ apps: [] }) };
const runtime = createComputerUse({ hostId:'consumer', productName:'Consumer', helperName:'Consumer CU', namespace:'consumer_cu', platform:'darwin', batch:true, helper:{client:async()=>client,connected:client,restart:async()=>{}}, disposeHelper:async()=>{} });
const call: ToolInvocation = { scope:{hostId:'consumer',deviceId:'d',sessionId:'s',turnId:'t',callId:'c'},namespace:'consumer_cu',tool:'list_apps',arguments:{} };
const context: InvocationContext = {signal:new AbortController().signal,hold:()=>()=>{},approvals:{request:async()=>null,dismiss:async()=>{}}};
if (!(await runtime.executor.execute(call,context)).success) throw Error('execution failed');
if (new FrameReader().next() !== undefined) throw Error('unexpected frame');
if (computerTools({productName:'Consumer',helperName:'CU',namespace:'consumer_cu',platform:'win32',batch:true}).tools.length !== 10) throw Error('missing tools');
await runtime.dispose();
console.log('consumer ok');`
  writeFileSync(join(directory, 'consumer.mts'), consumer)
  execFileSync(
    process.execPath,
    [
      join(root, 'node_modules/typescript/bin/tsc'),
      '--strict',
      '--skipLibCheck',
      '--module',
      'NodeNext',
      '--target',
      'ES2023',
      '--types',
      'node',
      '--typeRoots',
      join(root, 'node_modules/@types'),
      '--outDir',
      join(directory, 'out'),
      join(directory, 'consumer.mts'),
    ],
    { cwd: directory },
  )
  const output = execFileSync(process.execPath, [join(directory, 'out/consumer.mjs')], {
    cwd: directory,
    encoding: 'utf8',
  })
  assert.match(output, /consumer ok/)
  const manifest = JSON.parse(
    readFileSync(join(directory, 'node_modules/computer-use-internal/package.json'), 'utf8'),
  )
  assert.equal(manifest.dependencies, undefined)
  // 临时目录保留验收制品，便于集成线复核，不写入个人配置。
})
