import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createExternalAccount } from '../external-account.mjs'

const publicUser =
  '{"id":9007199254740993,"login":"sample-owner","type":"User","secret":"not-public"}'

test('解析假 gh、个人主页和数字 ID；保留大整数，持久化只保存公开字段', {
  skip: process.platform === 'win32' ? '夹具使用 shell' : false,
}, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'litch-external-account-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ghDir = join(dir, 'gh')
  mkdirSync(ghDir)
  writeFileSync(join(dir, 'gh-user'), publicUser)
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh
set -eu
test "$*" = 'api user --hostname github.com'
! /usr/bin/env | /usr/bin/grep -E '^(GH_TOKEN|GITHUB_TOKEN|GH_DEBUG)='
test "$GH_CONFIG_DIR" = "${ghDir}"
/bin/cat "${dir}/gh-user"
`,
    { mode: 0o700 },
  )
  const urls: string[] = []
  const bridge = createExternalAccount(dir, {
    env: () => ({
      PATH: bin,
      HOME: dir,
      GH_CONFIG_DIR: ghDir,
      GH_TOKEN: 'dont-inherit',
      GITHUB_TOKEN: 'dont-inherit',
      GH_DEBUG: 'api',
    }),
    fetch: async (url) => {
      urls.push(String(url))
      return new Response(publicUser)
    },
  })
  const gh = await bridge.resolve({ method: 'localGh' })
  assert.deepEqual(gh, {
    provider: 'github',
    userId: '9007199254740993',
    loginCache: 'sample-owner',
    profileUrl: 'https://github.com/sample-owner',
    method: 'localGh',
  })
  assert.deepEqual(await bridge.resolve({ method: 'profileUrl', value: gh.profileUrl }), {
    ...gh,
    method: 'profileUrl',
  })
  assert.deepEqual(await bridge.resolve({ method: 'userId', value: gh.userId }), {
    ...gh,
    method: 'userId',
  })
  await assert.rejects(
    bridge.resolve({ method: 'profileUrl', value: 'https://github.com/example/repo' }),
  )
  assert.deepEqual(urls, [
    'https://api.github.com/users/sample-owner',
    'https://api.github.com/user/9007199254740993',
  ])
  assert.equal(bridge.save(gh, 0), true)
  assert.equal(bridge.save({ ...gh, userId: '7' }, 0), false)
  assert.deepEqual(bridge.get(), { owner: gh, revision: 1 })
  assert.doesNotMatch(
    readFileSync(join(dir, 'external-owner.json'), 'utf8'),
    /dont-inherit|not-public/,
  )
})
