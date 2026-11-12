// 33 条真实引用的写法回归；仅保留匿名路径、记录当时确认的布局，不读真实会话或用户文件。
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { RpcError } from '../src/connection/rpc.mjs'
import { channelFailure } from '../src/device/faults.mjs'
import { createFiles, type FilesHost } from '../src/device/files.mjs'
import {
  explicitFileRef,
  type FileRef,
  fileRefOf,
  findFileRefs,
} from '../src/projection/file-refs.mjs'
import { fakeClock } from './helpers.mjs'

interface Sample {
  id: number
  kind: string
  cwd: string
  entryCwd: string
  value: string
  before: FileRef | null
  beforeEntry: FileRef | null
  files: string[]
  mobileBefore: boolean
}

test('33 条样本：隔离文件布局对照 S0、S1 与全部项目根；不跨设备寻找 #30', async () => {
  const samples = JSON.parse(
    await readFile(new URL('../../../../test/file-link-samples.json', import.meta.url), 'utf8'),
  ) as Sample[]
  const fixture = await mkdtemp(join(tmpdir(), 'litch-link-samples-'))
  const counts = {
    beforeS0: 0,
    beforeS1: 0,
    beforeMobile: 0,
    afterS0: 0,
    afterS1: 0,
    afterRoots: 0,
    choices: 0,
  }
  try {
    for (const sample of samples) {
      const disk = (path: string) => join(fixture, String(sample.id), path.replace(/^\/+/, ''))
      for (const path of sample.files) {
        await mkdir(dirname(disk(path)), { recursive: true })
        await writeFile(disk(path), `fixture ${sample.id}: ${path}\n`)
      }
      const recordedFound = (ref: FileRef | null) =>
        !!ref && [ref.path, ref.alt].some((path) => path && sample.files.includes(path))
      if (recordedFound(sample.before)) counts.beforeS0++
      if (recordedFound(sample.beforeEntry)) counts.beforeS1++
      if (sample.mobileBefore && recordedFound(sample.before)) counts.beforeMobile++
      const host: FilesHost = {
        clock: fakeClock().clock,
        online: () => true,
        home: () => '/home/fixture',
        platform: () => 'linux',
        knownRoot: () => false,
        previewSupported: () => true,
        browserSupported: () => true,
        realpathSupported: () => true,
        shortMediaSupported: () => true,
        fail: channelFailure,
        log() {},
        request: async (method, params) => {
          const path = (params as { path: string }).path
          // 设备路径映射进本样本的隔离目录；无法读到开发机上的同名绝对文件。
          assert.ok(path.startsWith('/') && !path.split('/').includes('..'))
          try {
            if (method === 'fs/getMetadata') {
              const info = await stat(disk(path))
              return {
                litchResolved: { path },
                isFile: info.isFile(),
                isDirectory: info.isDirectory(),
                isSymlink: false,
                createdAtMs: 0,
                modifiedAtMs: 0,
              } as never
            }
            return { dataBase64: (await readFile(disk(path))).toString('base64') } as never
          } catch (error) {
            throw new RpcError(-32603, String(error))
          }
        },
      }
      const files = createFiles(host)
      for (const mode of ['afterS0', 'afterS1', 'afterRoots'] as const) {
        const scope = {
          root: sample.cwd,
          cwd: mode === 'afterS0' ? sample.cwd : sample.entryCwd,
          roots: mode === 'afterRoots' ? [sample.cwd, '/work/example/litch'] : [sample.cwd],
        }
        const ref =
          sample.kind === 'explicit'
            ? explicitFileRef(sample.value, scope)
            : sample.kind === 'prose'
              ? findFileRefs(sample.value, scope)[0]?.ref
              : fileRefOf(sample.value, scope)
        if (!ref) {
          assert.equal(sample.id, 27)
          continue
        }
        const result = await files.resolve(scope.root, ref, sample.value)
        if (result.candidates.length) counts[mode]++
        if (mode === 'afterRoots' && result.status === 'choose') counts.choices++
        if (sample.id === 30) assert.equal(result.status, 'failed')
      }
    }
    assert.equal(samples.length, 33)
    assert.deepEqual([counts.beforeS0, counts.beforeS1, counts.beforeMobile], [10, 17, 4])
    assert.deepEqual([counts.afterS0, counts.afterS1, counts.afterRoots], [13, 20, 26])
    console.log('文件样本回归（可找到候选，不代表真机点击成功）：', counts)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})
