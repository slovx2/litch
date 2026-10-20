// Cookie 的校验与规范化、去重的键、“只导这些网站”的规范化。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkCookie, existingKey } from '../cookies.mjs'
import { domainMatches, normalizeDomains } from '../pipeline.mjs'
import type { ImportedCookie } from '../protected-types.mjs'

const NOW = 1_800_000_000

const cookie = (fields: Partial<ImportedCookie> = {}): ImportedCookie => ({
  host: 'example.com',
  name: 'id',
  value: 'v',
  path: '/',
  secure: true,
  httpOnly: false,
  sameSite: 'lax',
  ...fields,
})

const reason = (fields: Partial<ImportedCookie>) => {
  const check = checkCookie(cookie(fields), NOW)
  return check.ok ? 'ok' : check.reason
}

test('Cookie 校验：合规的、不合规的、过期的、分区的', () => {
  assert.equal(reason({}), 'ok')
  assert.equal(reason({ host: '.Example.COM' }), 'ok')
  assert.equal(reason({ host: '[::1]', secure: false }), 'ok')
  assert.equal(reason({ name: '', value: 'only-value' }), 'ok')
  assert.equal(reason({ expires: NOW + 10 }), 'ok')
  for (const fields of [
    { name: 'a;b' },
    { name: 'a=b' },
    { value: 'x\ny' },
    { value: 'x;y' },
    { name: '', value: '' },
    { value: 'x'.repeat(4096) },
    { host: '' },
    { host: 'exa mple.com' },
    { host: '.[::1]' },
    { host: 'example..com' },
    { path: 'relative' },
    { path: '/a;b' },
    { name: '__Secure-id', secure: false },
    { name: '__host-id', path: '/sub' },
    { name: '__Host-id', host: '.example.com' },
    { sameSite: 'no_restriction' as const, secure: false },
    { expires: NOW },
    { expires: Number.NaN },
  ]) {
    assert.equal(reason(fields), 'invalid', JSON.stringify(fields))
  }
  assert.equal(reason({ partitionTopSite: 'https://example.com' }), 'partitioned')
})

test('Cookie 写入的参数：网址、domain、过期时间', () => {
  const host = checkCookie(cookie({ host: 'Example.com', path: '', secure: false }), NOW)
  assert.ok(host.ok)
  assert.deepEqual(host.details, {
    url: 'http://example.com/',
    name: 'id',
    value: 'v',
    path: '/',
    secure: false,
    httpOnly: false,
    sameSite: 'lax',
  })
  const domain = checkCookie(cookie({ host: '.example.com', expires: NOW + 60, path: '/a' }), NOW)
  assert.ok(domain.ok)
  assert.equal(domain.details.domain, '.example.com')
  assert.equal(domain.details.url, 'https://example.com/a')
  assert.equal(domain.details.expirationDate, NOW + 60)
  // 去重的键：内置浏览器里已有的那条（Electron 报的形状）对得上
  assert.equal(
    domain.key,
    existingKey({ domain: '.example.com', hostOnly: false, name: 'id', path: '/a' }),
  )
  assert.equal(
    host.key,
    existingKey({ domain: 'example.com', hostOnly: true, name: 'id', path: '/' }),
  )
  assert.notEqual(host.key, existingKey({ domain: '.example.com', name: 'id', path: '/' }))
})

test('只导这些网站：规范化与匹配', () => {
  assert.equal(normalizeDomains(undefined), undefined)
  assert.equal(normalizeDomains([]), undefined)
  assert.equal(normalizeDomains([' ', '..', 'a b']), undefined)
  assert.deepEqual(
    normalizeDomains(['.Example.com.', 'https://Docs.Example.org:8443/x?y', 'example.com']),
    ['example.com', 'docs.example.org'],
  )
  assert.equal(domainMatches('.a.example.com', ['example.com']), true)
  assert.equal(domainMatches('example.com', ['example.com']), true)
  assert.equal(domainMatches('badexample.com', ['example.com']), false)
})
