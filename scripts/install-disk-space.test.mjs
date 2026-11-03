import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const installer = fileURLToPath(new URL('./install.sh', import.meta.url))
const name = 'codex-harness-adapter'
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`

// 只有 HOME / TMPDIR / PATH 指向测试目录，压缩包中的 Node 与 CLI 都是无副作用的替身。
function fixture(t, system = 'Darwin') {
  const root = mkdtempSync(join(tmpdir(), 'litch-disk-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'home with spaces')
  const temp = join(root, 'temporary')
  const bin = join(root, 'bin')
  const base = join(home, '.local/share', name)
  for (const path of [home, temp, bin, join(base, '0.1.0/bin')])
    mkdirSync(path, { recursive: true })
  symlinkSync('0.1.0', join(base, 'current'))
  writeFileSync(join(base, 'history'), '0.1.0\n')
  const executable = (path, script) =>
    writeFileSync(path, `#!/bin/sh\n${script}\n`, { mode: 0o755 })
  executable(join(base, '0.1.0/bin', name), 'echo old-version')
  const target = system === 'Linux' ? 'linux-x64' : 'darwin-arm64'
  const packed = `${name}-0.2.0-${target}`
  const tree = join(root, packed)
  mkdirSync(join(tree, 'bin'), { recursive: true })
  mkdirSync(join(tree, 'libexec/node/bin'), { recursive: true })
  executable(join(tree, 'bin', name), `echo '${name} 0.2.0'`)
  executable(join(tree, 'libexec/node/bin/node'), 'echo v24.0.0')
  const archive = join(root, `${packed}.tar.gz`)
  const tar = spawnSync('/usr/bin/tar', ['-czf', archive, '-C', root, packed], { encoding: 'utf8' })
  assert.equal(tar.status, 0, tar.stderr)
  const data = readFileSync(archive)
  writeFileSync(
    join(root, `${name}-SHA256SUMS.txt`),
    `${createHash('sha256').update(data).digest('hex')}  ${packed}.tar.gz\n`,
  )
  executable(
    join(bin, 'uname'),
    `case $1 in -s) echo ${system};; -m) echo ${system === 'Linux' ? 'x86_64' : 'arm64'};; esac`,
  )
  executable(join(bin, 'getconf'), 'echo "glibc 2.41"')
  executable(join(bin, 'id'), 'echo 1000')
  const disk = (available, tempAvailable = available) =>
    executable(
      join(bin, 'df'),
      `
test "$1" = -Pk || exit 2
case $2 in ${quote(temp)}) available=${tempAvailable};; *) available=${available};; esac
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/test 9999999 1 %s 1%% /\n' "$available"`,
    )
  disk(9999999)
  const env = {
    HOME: home,
    TMPDIR: temp,
    PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    CHA_LANG: 'en',
    LC_ALL: 'C',
  }
  const run = (args = ['--from', archive]) =>
    spawnSync('/bin/sh', [installer, ...args], { env, encoding: 'utf8' })
  const intact = () => {
    assert.equal(readlinkSync(join(base, 'current')), '0.1.0')
    assert.equal(readFileSync(join(base, 'history'), 'utf8'), '0.1.0\n')
    assert.equal(
      readFileSync(join(base, '0.1.0/bin', name), 'utf8'),
      '#!/bin/sh\necho old-version\n',
    )
    assert.deepEqual(readdirSync(base).sort(), ['0.1.0', 'current', 'history'])
  }
  return {
    root,
    home,
    temp,
    bin,
    base,
    archive,
    env,
    executable,
    disk,
    run,
    intact,
    required: Math.ceil((gunzipSync(data).length * 1.5) / 1024) + 65536,
  }
}

for (const system of ['Darwin', 'Linux']) {
  test(`${system}：按展开大小预检，失败清理且旧版不变，释放空间可重试`, (t) => {
    const f = fixture(t, system)
    f.disk(f.required - 1)
    const result = f.run()
    assert.equal(result.status, 28, result.stderr)
    assert.ok(
      result.stderr.includes(
        `LITCH_INSTALL_DISK_SPACE\t${f.base}\t${f.required}\t${f.required - 1}`,
      ),
    )
    f.intact()
    f.disk(f.required)
    const retried = f.run()
    assert.equal(retried.status, 0, retried.stderr)
    assert.equal(readlinkSync(join(f.base, 'current')), '0.2.0')
    assert.ok(readdirSync(f.base).includes('0.1.0'))
    assert.ok(!readdirSync(f.base).some((entry) => entry.startsWith('.tmp.')))
  })
}

test('目标分区完全满或 Available 为负：下载之前拒绝，不使用 root 保留块', (t) => {
  const f = fixture(t)
  for (const available of [0, -4096]) {
    f.disk(available)
    const result = f.run(['--version', '0.2.0', '--base-url', 'http://127.0.0.1:1'])
    assert.equal(result.status, 28, result.stderr)
    assert.ok(result.stderr.includes(`LITCH_INSTALL_DISK_SPACE\t${f.base}\t65536\t0`))
    assert.ok(!result.stdout.includes('Downloading'))
    f.intact()
  }
})

test('TMPDIR 是另一分区时单独检查并报告临时路径', (t) => {
  const f = fixture(t)
  f.disk(9999999, 12)
  const result = f.run()
  assert.equal(result.status, 28, result.stderr)
  assert.ok(result.stderr.includes(`LITCH_INSTALL_DISK_SPACE\t${f.temp}\t65536\t12`))
  f.intact()
})

test('Linux root 可使用保留块；macOS 不把 APFS 总量减已用当作可用量', (t) => {
  for (const system of ['Linux', 'Darwin']) {
    const f = fixture(t, system)
    f.executable(join(f.bin, 'id'), 'echo 0')
    f.disk(0)
    const result = f.run()
    assert.equal(result.status, system === 'Linux' ? 0 : 28, result.stderr)
    if (system === 'Linux') assert.equal(readlinkSync(join(f.base, 'current')), '0.2.0')
    else f.intact()
  }
})

test('下载中途空间耗尽按空间不足报告，网络错误保持普通下载失败', (t) => {
  const f = fixture(t)
  f.executable(
    join(f.bin, 'curl'),
    'echo "curl: failed writing received data" >&2; touch "$HOME/ran-download"; exit 23',
  )
  for (const low of [false, true]) {
    f.executable(
      join(f.bin, 'df'),
      `available=9999999
if [ -f "$HOME/ran-download" ] && ${low}; then available=0; fi
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/test 9999999 1 %s 1%% /\\n' "$available"`,
    )
    rmSync(join(f.home, 'ran-download'), { force: true })
    const result = f.run(['--version', '0.2.0'])
    assert.equal(result.status, low ? 28 : 1, result.stderr)
    assert.match(result.stderr, /curl: failed writing received data/)
    assert.equal(result.stderr.includes('LITCH_INSTALL_DISK_SPACE'), low)
    f.intact()
  }
})

test('宿主真实 df 和 tar：仅安装到隔离 HOME', (t) => {
  const f = fixture(t)
  rmSync(join(f.bin, 'df'))
  const result = f.run()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readlinkSync(join(f.base, 'current')), '0.2.0')
})

test('首次安装路径尚不存在：检查祖先分区，中文提示保留目标路径，失败不留半截目录', (t) => {
  const f = fixture(t)
  rmSync(f.base, { recursive: true })
  f.env.CHA_LANG = 'zh-CN'
  f.disk(f.required - 1)
  const result = f.run()
  assert.equal(result.status, 28, result.stderr)
  assert.match(result.stderr, /磁盘空间不足/)
  assert.ok(result.stderr.includes(`LITCH_INSTALL_DISK_SPACE\t${f.base}`))
  assert.equal(existsSync(f.base), false)
})

test('tar 只报短写时重新检查空间，仍能识别并清理解压残留', (t) => {
  const f = fixture(t)
  f.executable(
    join(f.bin, 'df'),
    `available=9999999
if [ -f "$HOME/filled" ]; then available=0; fi
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/test 9999999 1 %s 1%% /\\n' "$available"`,
  )
  f.executable(
    join(f.bin, 'tar'),
    'touch "$HOME/filled"; echo partial > "$4/partial"; echo "tar: Wrote only 9216 of 10240 bytes" >&2; exit 2',
  )
  const result = f.run()
  assert.equal(result.status, 28, result.stderr)
  assert.match(result.stderr, /Wrote only 9216/)
  assert.ok(result.stderr.includes(`LITCH_INSTALL_DISK_SPACE\t${f.base}\t${f.required}\t0`))
  f.intact()
})

for (const reason of ['No space left on device', 'Permission denied']) {
  test(`解压中途 ${reason}：保留原始报错、清理半截文件、旧版不变`, (t) => {
    const f = fixture(t)
    f.executable(
      join(f.bin, 'tar'),
      `mkdir "$4/partial"; echo partial > "$4/partial/file"; echo 'tar: original: ${reason}' >&2; exit 2`,
    )
    const result = f.run()
    assert.equal(result.status, reason.startsWith('No space') ? 28 : 1, result.stderr)
    assert.ok(result.stderr.includes(`tar: original: ${reason}`))
    assert.equal(result.stderr.includes('LITCH_INSTALL_DISK_SPACE'), reason.startsWith('No space'))
    f.intact()
  })
}

test('df 失败不当成零空间，损坏 gzip 不进入解压', (t) => {
  const f = fixture(t)
  f.executable(join(f.bin, 'df'), 'exit 1')
  const unavailable = f.run()
  assert.equal(unavailable.status, 1)
  assert.match(unavailable.stderr, /Cannot check available disk space/)
  f.disk(9999999)
  const broken = join(f.root, 'broken.tar.gz')
  writeFileSync(broken, 'not gzip')
  const checksums = join(f.root, 'broken-checksums.txt')
  writeFileSync(
    checksums,
    `${createHash('sha256').update('not gzip').digest('hex')}  broken.tar.gz\n`,
  )
  const result = f.run(['--from', broken, '--checksums', checksums])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Damaged archive/)
  assert.ok(!result.stderr.includes('LITCH_INSTALL_DISK_SPACE'))
  f.intact()
})
