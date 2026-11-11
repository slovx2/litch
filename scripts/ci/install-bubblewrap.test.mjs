import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'

const script = new URL('./install-bubblewrap.sh', import.meta.url).pathname
const hash = '2461f1beee9cb04c8942739fe1a2b37e7b7c2a3d518f0779dc75f9245baa3094'
const version = '0.9.0-1ubuntu0.3'

// 提权、apt与安装命令均为隔离替身；摘要替身仍对仓库内真实包计算SHA256。
function run(t, flags = {}) {
  const root = mkdtempSync(join(tmpdir(), 'litch-bwrap-install-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const mock = join(root, 'command.mjs')
  writeFileSync(
    mock,
    `#!${process.execPath}
import {appendFileSync,existsSync,readFileSync,writeFileSync} from 'node:fs'
import {basename,join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
const cmd=basename(process.argv[1]), args=process.argv.slice(2)
const root=process.env.MOCK_ROOT
appendFileSync(join(root,'calls'),JSON.stringify([cmd,...args])+'\\n')
const fail=process.env
const installed=join(root,'installed')
if(cmd==='sudo'||cmd==='timeout'){
 const forwarded=cmd==='timeout'?args.slice(1):args
 const child=spawnSync(forwarded[0],forwarded.slice(1),{stdio:'inherit',env:process.env})
 process.exit(child.status??1)
}
if(cmd==='dpkg'){
 if(args[0]==='--print-architecture')console.log(fail.MOCK_ARCH??'amd64')
 else if(args[0]==='--field')console.log(args.at(-1)==='Package'?(fail.MOCK_DEB_NAME??'bubblewrap'):args.at(-1)==='Version'?(fail.MOCK_DEB_VERSION??'${version}'):(fail.MOCK_DEB_ARCH??'amd64'))
 else {if(fail.MOCK_DPKG_FAIL)process.exit(1);writeFileSync(installed,'yes')}
} else if(cmd==='apt-get'){
 const update=args.includes('update')
 if((update&&fail.MOCK_UPDATE_FAIL)||(!update&&fail.MOCK_INSTALL_FAIL))process.exit(100)
 if(!update)writeFileSync(installed,'yes')
} else if(cmd==='curl'){
 process.exit(6)
} else if(cmd==='sha256sum'){
 const input=readFileSync(0,'utf8')
 if(!input.startsWith('${hash}  ')||fail.MOCK_HASH_FAIL)process.exit(1)
 const actual=createHash('sha256').update(readFileSync(input.trim().slice(66))).digest('hex')
 if(actual!=='${hash}')process.exit(1)
} else if(cmd==='dpkg-query'){
 if(!existsSync(installed))process.exit(1)
 console.log('install ok installed '+(fail.MOCK_FINAL_VERSION??'${version}'))
} else if(cmd==='bwrap'){
 if(fail.MOCK_BWRAP_FAIL)process.exit(1)
 console.log('bubblewrap 0.9.0')
} else process.exit(1)
`,
    { mode: 0o755 },
  )
  for (const name of [
    'sudo',
    'timeout',
    'apt-get',
    'dpkg',
    'dpkg-query',
    'curl',
    'sha256sum',
    'bwrap',
  ])
    symlinkSync(mock, join(root, name))
  const result = spawnSync('/bin/bash', [script], {
    encoding: 'utf8',
    env: { PATH: `${root}:/usr/bin:/bin`, HOME: root, TMPDIR: root, MOCK_ROOT: root, ...flags },
  })
  const calls = readFileSync(join(root, 'calls'), 'utf8').trim().split('\n').map(JSON.parse)
  return { result, calls, invoked: (name) => calls.filter(([cmd]) => cmd === name) }
}

test('amd64 直接安装仓库包，摘要与元数据校验在安装前，不访问apt或网络', (t) => {
  const f = run(t)
  assert.equal(f.result.status, 0, f.result.stderr)
  assert.equal(f.invoked('apt-get').length, 0)
  assert.equal(f.invoked('curl').length, 0)
  const checked = f.calls.findIndex(([cmd]) => cmd === 'sha256sum')
  const installed = f.calls.findIndex(([cmd, arg]) => cmd === 'dpkg' && arg === '-i')
  assert.ok(checked >= 0 && installed > checked)
  assert.ok(
    f
      .invoked('dpkg')
      .some((call) => call.at(-1)?.endsWith(`/vendor/bubblewrap_${version}_amd64.deb`)),
  )
  assert.equal(f.invoked('dpkg-query').length, 1)
  assert.equal(f.invoked('bwrap').length, 1)
})

test('仓库内包字节的SHA256与固定值一致', () => {
  const deb = readFileSync(new URL(`./vendor/bubblewrap_${version}_amd64.deb`, import.meta.url))
  assert.equal(createHash('sha256').update(deb).digest('hex'), hash)
})

for (const failure of ['MOCK_HASH_FAIL', 'MOCK_DEB_NAME', 'MOCK_DEB_VERSION', 'MOCK_DEB_ARCH'])
  test(`${failure}：摘要或包元数据错误不得进入dpkg安装`, (t) => {
    const f = run(t, { [failure]: 'wrong' })
    assert.notEqual(f.result.status, 0)
    assert.equal(
      f.calls.some(([cmd, arg]) => cmd === 'dpkg' && arg === '-i'),
      false,
    )
  })

for (const failure of ['MOCK_DPKG_FAIL', 'MOCK_FINAL_VERSION', 'MOCK_BWRAP_FAIL'])
  test(`${failure}：安装或安装后验证失败使步骤失败`, (t) => {
    const f = run(t, { [failure]: 'wrong' })
    assert.notEqual(f.result.status, 0)
  })

test('非amd64使用固定版本apt，不接触仓库内amd64包', (t) => {
  const f = run(t, { MOCK_ARCH: 'arm64' })
  assert.equal(f.result.status, 0, f.result.stderr)
  const apt = f.invoked('apt-get')
  assert.equal(apt.length, 2)
  assert.ok(apt.every((call) => call.includes('Acquire::Retries=2')))
  assert.ok(apt[0].includes('APT::Update::Error-Mode=any'))
  assert.ok(apt[1].includes(`bubblewrap=${version}`))
  assert.equal(
    f.calls.some(([cmd, arg]) => cmd === 'dpkg' && arg === '-i'),
    false,
  )
  assert.equal(f.invoked('sha256sum').length, 0)
  assert.equal(f.invoked('curl').length, 0)
})

for (const failure of ['MOCK_UPDATE_FAIL', 'MOCK_INSTALL_FAIL'])
  test(`非amd64的${failure}仍使作业失败，不改装amd64包`, (t) => {
    const f = run(t, { MOCK_ARCH: 'arm64', [failure]: '1' })
    assert.notEqual(f.result.status, 0)
    assert.equal(f.invoked('sha256sum').length, 0)
  })

test('五份工作流的8个调用统一使用安装器，没有跳过安装的错误豁免', () => {
  let count = 0
  for (const name of ['ci', 'full', 'linux-desktop', 'mac-equivalence', 'runtime-artifacts']) {
    const source = readFileSync(
      new URL(`../../.github/workflows/${name}.yml`, import.meta.url),
      'utf8',
    )
    assert.doesNotMatch(source, /apt-get install[^\n]*bubblewrap/)
    const workflow = parse(source)
    for (const job of Object.values(workflow.jobs))
      for (const step of job.steps ?? [])
        if (step.run?.includes('bash scripts/ci/install-bubblewrap.sh')) {
          count++
          const runners =
            job['runs-on'] === '${{ matrix.os }}'
              ? job.strategy.matrix.os.filter((os) => os.startsWith('ubuntu-'))
              : [job['runs-on']]
          assert.deepEqual(runners, ['ubuntu-24.04'], '当前Linux调用必须使用已核实的amd64 runner')
          assert.notEqual(step['continue-on-error'], true)
          assert.ok(step.run.includes('kernel.apparmor_restrict_unprivileged_userns=0'))
        }
  }
  assert.equal(count, 8)
})
