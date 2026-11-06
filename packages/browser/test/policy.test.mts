import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSiteBook, type SitesFile } from '../src/browser/sites.mjs'

test('注入存储保持网站许可层级，独立后端不共享批准，回合拒绝可撤销', () => {
  let saved: SitesFile | null = null
  const persistence = {
    read: () => saved,
    write: (next: SitesFile) => {
      saved = structuredClone(next)
    },
  }
  const a = createSiteBook(persistence),
    b = createSiteBook(null)
  a.allowAlways('https://a.test')
  assert.equal(createSiteBook(persistence).verdict('s', 't', 'https://a.test'), 'allow')
  assert.equal(b.verdict('s', 't', 'https://a.test'), undefined)
  a.decline('s', 't', 'https://a.test')
  assert.equal(a.verdict('s', 't', 'https://a.test'), 'decline')
  a.turnEnded('s', 't')
  assert.equal(a.verdict('s', 't', 'https://a.test'), 'allow')
  a.setTrustAll(true)
  a.block('a.test')
  assert.equal(a.verdict('s', 't', 'https://sub.a.test'), 'blocked')
})
