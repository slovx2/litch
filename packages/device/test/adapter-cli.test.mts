// 伪终端桥用的是哪一份命令行：命令行（Go）经环境变量交过来的那一份，没人交时才从文件的位置往上找。
// 那个变量是模块装载时读的，所以每条用例都另起一个进程来看。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ENVIRONMENT = 'CHA_ADAPTER_CLI'
const shared = (file: string) => new URL(`../../shared/src/${file}`, import.meta.url).href
/** 仓库根目录 bin/ 里的那一份，测试之前由 scripts/build-cli.mjs 编出来 */
const built = fileURLToPath(
  new URL(
    `../../../../../bin/codex-harness-adapter${process.platform === 'win32' ? '.exe' : ''}`,
    import.meta.url,
  ),
)

/** 另起一个进程跑一段模块代码，它打印的最后一行是 JSON */
function probe(script: string, given: string | null): Record<string, unknown> {
  const env = { ...process.env }
  delete env[ENVIRONMENT]
  if (given !== null) env[ENVIRONMENT] = given
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env,
    encoding: 'utf8',
    timeout: 30_000,
  })
  return JSON.parse(out.trim().split('\n').at(-1) ?? '{}') as Record<string, unknown>
}

const WHERE = `
  import { adapterCliPath } from ${JSON.stringify(shared('adapter-cli.mjs'))}
  console.log(JSON.stringify({ path: adapterCliPath(), left: process.env.${ENVIRONMENT} ?? null }))
`

test('命令行交过来的路径以它为准，读走就从环境里拿掉', () => {
  // 交过来的不查在不在：它说是哪一份就是哪一份，不悄悄换成找到的另一份
  assert.deepEqual(probe(WHERE, '/somewhere/else/codex-harness-adapter'), {
    path: '/somewhere/else/codex-harness-adapter',
    left: null,
  })
})

test('没人交路径时，从文件的位置往上找到 bin/ 里的那一份', () => {
  assert.ok(existsSync(built), `测试要先编出命令行：${built}`)
  assert.deepEqual(probe(WHERE, null), { path: built, left: null })
  // 空的等于没给
  assert.deepEqual(probe(WHERE, ''), { path: built, left: null })
})

test('带终端的进程由交过来的那一份的 pty-bridge 子命令来起；这个变量不传给用户的命令', {
  skip: process.platform === 'win32',
}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'cli-'))
  try {
    // 一份记下自己怎么被调用、再把事情原样交给真命令行的替身
    const calls = join(directory, 'calls')
    const stand = join(directory, 'stand-in')
    writeFileSync(stand, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexec '${built}' "$@"\n`)
    chmodSync(stand, 0o700)
    const command = `stty size; echo "cli=[\${${ENVIRONMENT}-unset}]"; exit 5`
    const script = `
        import { ProcessRpc } from ${JSON.stringify(shared('process-rpc.mjs'))}
        const rpc = new ProcessRpc((command) => command)
        const chunks = []
        let finish
        const exited = new Promise((resolve) => { finish = resolve })
        const peer = {
          id: 'probe',
          close() {},
          send(message) {
            if (message.method === 'process/outputDelta')
              chunks.push(Buffer.from(message.params.deltaBase64, 'base64'))
            if (message.method === 'process/exited') finish(message.params)
          },
        }
        await rpc.start(peer, 'process', {
          processHandle: 'terminal',
          cwd: process.cwd(),
          tty: true,
          size: { rows: 9, cols: 31 },
          command: ['/bin/sh', '-c', ${JSON.stringify(command)}],
        })
        const { exitCode } = await exited
        await rpc.close()
        console.log(JSON.stringify({ exitCode, screen: Buffer.concat(chunks).toString() }))
      `
    const result = probe(script, stand)
    assert.equal(result.exitCode, 5)
    assert.match(String(result.screen), /9 31\r+\ncli=\[unset\]\r+\n/)
    assert.equal(
      readFileSync(calls, 'utf8'),
      `pty-bridge --rows 9 --cols 31 -- /bin/sh -c ${command}\n`,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
