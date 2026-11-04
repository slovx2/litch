import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { artifactFor, digest, installArtifact, verifyBinary } from '../../src/install.mjs'
import { wheelMember } from '../../src/wheel.mjs'

test('六个平台制品都有独立固定 URL、wheel/binary/schema SHA-256', () => {
  for (const platform of ['darwin', 'linux', 'win32'] as const)
    for (const arch of ['arm64', 'x64'] as const) {
      const artifact = artifactFor(platform, arch)
      assert.ok(artifact.url.startsWith('https://files.pythonhosted.org/'))
      for (const hash of [artifact.wheelSha256, artifact.binarySha256, artifact.schemaSha256])
        assert.match(hash, /^[a-f0-9]{64}$/)
    }
})
test('下载校验失败不安装，不接受非官方源；已有文件摘要仍核验', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agy-download-'))
  try {
    const artifact = artifactFor()
    await assert.rejects(
      installArtifact(directory, artifact, async () => new Response('corrupt')),
      /下载校验失败/,
    )
    assert.deepEqual(await readdir(directory), [])
    await assert.rejects(
      installArtifact(directory, { ...artifact, url: 'http://evil.test' }),
      /官方 PyPI/,
    )
    const binary = join(directory, 'existing')
    await writeFile(binary, 'corrupt')
    await assert.rejects(verifyBinary(binary, artifact), /SHA-256/)
    assert.throws(() => wheelMember(Buffer.from('not zip'), 'file'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
test('校验后的已安装文件直接复用，不联网', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agy-existing-'))
  try {
    const artifact = {
      ...artifactFor(),
      member: 'google/antigravity/bin/localharness',
      binarySha256: digest(Buffer.from('fixture')),
    }
    await writeFile(join(directory, 'localharness'), 'fixture')
    assert.equal(
      await installArtifact(directory, artifact, async () => {
        throw new Error('不该联网')
      }),
      join(directory, 'localharness'),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
