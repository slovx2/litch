// 回环 sshd + 真设备服务/单入口；仅使用夹具钥匙、HOME、文件和假模型，不起窗口。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from '../apps/desktop/node_modules/esbuild/lib/main.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(root, '.local/file-preview-ssh')
mkdirSync(output, { recursive: true })
const home = mkdtempSync(join(tmpdir(), 'litch-preview-ssh-home-'))
const env = { PATH: process.env.PATH, HOME: home, TMPDIR: tmpdir() }
const fixture = spawn(process.execPath, ['scripts/client-ssh-fixture.mjs'], {
  cwd: root,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
})
const exited = new Promise((resolve) => fixture.once('exit', resolve))
try {
  const info = await new Promise((resolve, reject) => {
    let log = ''
    const timer = setTimeout(() => reject(Error('SSH 夹具超时')), 60000)
    const read = (data) => {
      log += data
      const line = log.split('\n').find((s) => s.startsWith('LITCH_SSH_FIXTURE '))
      if (line) {
        clearTimeout(timer)
        resolve(JSON.parse(line.slice('LITCH_SSH_FIXTURE '.length)))
      }
    }
    fixture.stdout.on('data', read)
    fixture.stderr.on('data', read)
    fixture.once('exit', (code) => {
      clearTimeout(timer)
      reject(Error(`夹具退出 ${code}: ${log}`))
    })
  })
  const remoteRoot = join(info.root, 'preview-remote'),
    localRoot = join(info.root, 'preview-local')
  mkdirSync(remoteRoot)
  mkdirSync(localRoot)
  writeFileSync(join(remoteRoot, 'same.md'), '# remote file\n')
  writeFileSync(join(localRoot, 'same.md'), '# local file must not appear\n')
  await build({
    stdin: {
      resolveDir: root,
      contents: `
import assert from 'node:assert/strict';
import { createLink } from './packages/core/src/index.mts';
import { sshOpener } from './apps/desktop/src/transport-ssh.mts';
const [alias, root, outside] = process.argv.slice(2);
const clock = { now: () => Date.now(), setTimer(fn, ms) { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); } };
let started = false;
const link = createLink({ open: sshOpener({kind:'alias',alias}), clock, clientInfo:{name:'preview-test',title:null,version:'0.0.0'}, notification(){}, state(state){
 if (state.phase === 'failed' || state.phase === 'waiting') { console.error(state); process.exit(1); }
 if(state.phase !== 'connected' || started) return; started = true;
 (async()=>{
  const info = await link.request('runtime/info', {});
  assert((info.device?.extensions ?? info.extensions).includes('filePreview'));
  const result = await link.request('fs/readFile', {path:root+'/same.md',litchPreview:{root,maxBytes:100}});
  assert.equal(Buffer.from(result.dataBase64,'base64').toString(),'# remote file\\n');
  await assert.rejects(link.request('fs/readFile',{path:root+'/same.md',litchPreview:{root,maxBytes:2}}),e=>e.data?.litchPreview.kind==='tooLarge');
  await assert.rejects(link.request('fs/readFile',{path:outside+'/same.md',litchPreview:{root,maxBytes:100}}),e=>e.data?.litchPreview.kind==='outside');
  console.log(JSON.stringify({alias,result:'passed',preview:result.dataBase64}));
 })().then(()=>{link.stop();setTimeout(()=>process.exit(0),500)},error=>{console.error(error);link.stop();setTimeout(()=>process.exit(1),500)});
}});link.start();
`,
    },
    outfile: join(output, 'driver.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    alias: { '@litch/core': join(root, 'packages/core/src/index.mts') },
    banner: {
      js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);",
    },
  })
  for (const alias of [info.aliases.svc, info.aliases.ok]) {
    const run = spawn(
      process.execPath,
      [join(output, 'driver.mjs'), alias, remoteRoot, localRoot],
      {
        cwd: root,
        env: {
          ...env,
          LITCH_SSH_CONFIG: info.config,
          LITCH_REMOTE_CODEX: info.codex,
          LITCH_REMOTE_ADAPTER: info.adapter,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let log = ''
    run.stdout.on('data', (data) => {
      log += data
    })
    run.stderr.on('data', (data) => {
      log += data
    })
    const timer = setTimeout(() => run.kill('SIGTERM'), 90000)
    const code = await new Promise((resolve) => run.once('exit', resolve))
    clearTimeout(timer)
    writeFileSync(join(output, `${alias}.log`), log)
    assert.equal(code, 0, log)
    console.log(log.trim())
  }
} finally {
  fixture.kill('SIGTERM')
  await exited
  rmSync(home, { recursive: true, force: true })
}
