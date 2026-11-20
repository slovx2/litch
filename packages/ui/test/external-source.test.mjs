import assert from 'node:assert/strict'
import test from 'node:test'
import { csv, draftReady } from '../src/devices/external-source-form.ts'

test('界面拦下重复仓库及重复标签，默认 litch 标签不要求另填 ID', () => {
  const repo = {
    repoId: '9',
    localRoot: '/checkout',
    allowedBase: ['main'],
    headNamespace: 'litch/',
    labelRoutes: [],
  }
  const draft = {
    sourceId: 'github-9',
    credentialRef: 'ref',
    botUserId: '9007199254740993',
    interval: 120,
    repos: [repo],
  }
  assert.equal(draftReady(draft), true)
  assert.equal(draftReady({ ...draft, repos: [repo, repo] }), false)
  assert.equal(
    draftReady({
      ...draft,
      repos: [
        {
          ...repo,
          labelRoutes: [
            { labelId: '20', managerId: 'm1' },
            { labelId: '20', managerId: 'm2' },
          ],
        },
      ],
    }),
    false,
  )
  assert.deepEqual(csv('main, release, main, '), ['main', 'release'])
})
