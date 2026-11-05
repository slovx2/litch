// 只解析并校验分发所需字段；证书和描述文件内容不输出。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function readProfile(path) {
  const xml = execFileSync('/usr/bin/security', ['cms', '-D', '-i', path], { encoding: 'utf8' })
  const field = (key, format = 'json', optional = false) => {
    try {
      const value = execFileSync('/usr/bin/plutil', ['-extract', key, format, '-o', '-', '-'], {
        input: xml,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      return format === 'json' ? JSON.parse(value) : value.trim()
    } catch (error) {
      if (optional && String(error.stderr).includes('No value at that key path')) return undefined
      throw error
    }
  }
  assert.equal(
    field('DeveloperCertificates.1', 'raw', true),
    undefined,
    '专用描述文件必须只绑定一张证书',
  )
  return {
    UUID: field('UUID', 'raw'),
    Name: field('Name', 'raw'),
    Entitlements: field('Entitlements'),
    TeamIdentifier: field('TeamIdentifier'),
    ExpirationDate: field('ExpirationDate', 'raw'),
    ProvisionedDevices: field('ProvisionedDevices', 'json', true),
    ProvisionsAllDevices: field('ProvisionsAllDevices', 'json', true),
    certificateSHA1: createHash('sha1')
      .update(Buffer.from(field('DeveloperCertificates.0', 'raw'), 'base64'))
      .digest('hex')
      .toUpperCase(),
  }
}

export function checkProfile(profile, team) {
  assert.match(profile.UUID, /^[A-F0-9-]{36}$/i)
  assert.match(profile.certificateSHA1, /^[A-F0-9]{40}$/)
  assert.ok(profile.TeamIdentifier.includes(team))
  assert.equal(profile.Entitlements['get-task-allow'], false)
  assert.ok(profile.Entitlements['application-identifier'].endsWith('.dev.litch.app'))
  assert.ok(!profile.ProvisionedDevices, '不能使用开发或 ad-hoc 描述文件')
  assert.ok(!profile.ProvisionsAllDevices, '不能使用企业描述文件')
  assert.ok(Date.parse(profile.ExpirationDate) > Date.now(), '描述文件已过期')
}

export function withInstalledProfile(source, profile, action) {
  const dir = join(homedir(), 'Library/Developer/Xcode/UserData/Provisioning Profiles')
  mkdirSync(dir, { recursive: true })
  const destination = join(dir, `${profile.UUID}.mobileprovision`)
  const existed = existsSync(destination)
  const data = readFileSync(source)
  if (existed) assert.ok(readFileSync(destination).equals(data), '拒绝覆盖同 UUID 的其他描述文件')
  else writeFileSync(destination, data, { mode: 0o600 })
  try {
    return action()
  } finally {
    if (!existed) rmSync(destination)
  }
}
