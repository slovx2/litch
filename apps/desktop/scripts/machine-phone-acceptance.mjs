// 真设备、真执行 Mac；脚本可用隔离钥匙检查验签，也可选用独立 Android 模拟器走真配对与批准。
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { encodePairPayload } from '../../../packages/device/dist/packages/protocol/src/device-pairing.mjs'
import {
  MACHINE_APPROVAL_METHOD as M,
  machineApprovalSignedText,
} from '../../../packages/device/dist/packages/protocol/src/machine-approvals.mjs'
import { until } from '../../../scripts/client-fixture-manager-check.mjs'

const phoneId = 'f83898df0bef57a4'
const phone = generateKeyPairSync('ed25519')
const untrusted = generateKeyPairSync('ed25519')
const rawKey = (key) => key.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64')

export function seedFixturePhone(profile) {
  writeFileSync(
    join(profile, 'trusted-phones.json'),
    JSON.stringify({
      version: 1,
      desktopId: randomUUID(),
      enabled: false,
      phones: [
        {
          phoneId,
          name: '签名测试手机',
          approvalKey: rawKey(phone.publicKey),
          source: 'pairing',
          deviceId: 'approval-fixture',
          addedAt: Date.now(),
          lastApprovedAt: null,
          conflict: false,
        },
      ],
    }),
    { mode: 0o600 },
  )
}

export async function checkSignedMachine({ client, threadId, cwd, onMac, ssh, profile }) {
  const cardFor = async (filename) => {
    const path = join(cwd, filename)
    const args = { path, content: filename }
    const prompt = `本机：write_file ${JSON.stringify(args)}`
    await onMac('session.send', { deviceId: 'approval-fixture', sessionId: threadId, text: prompt })
    const card = await until(
      '设备转发签名卡',
      async () =>
        (await client.call(M.list)).cards.find((card) => card.target.endsWith(filename)) ?? null,
      Boolean,
      20_000,
    )
    assert.equal(card.action, 'write')
    assert.equal(JSON.parse(card.review.details).content, filename)
    assert.equal(existsSync(path), false, '待批时未写入')
    return { card, path }
  }
  const replyFor = (card, key = phone.privateKey, expiresAt = card.expiresAt) => {
    const { desktopId, nonce, version, payloadHash } = card.review
    const { id, threadId } = card
    const body = {
      desktopId,
      nonce,
      version,
      payloadHash,
      id,
      threadId,
      expiresAt,
      phoneId,
      decision: 'once',
    }
    return {
      ...body,
      signature: sign(null, Buffer.from(machineApprovalSignedText(body)), key).toString('base64'),
    }
  }
  const reject = async (answer, allowMissing = false) => {
    const result = await client.call(M.answer, answer).catch((error) => {
      if (!allowMissing || error.code !== -32602) throw error
      return { accepted: false }
    })
    assert.deepEqual(result, { accepted: false })
  }
  const idle = () =>
    until(
      '原会话结束后台结果回合',
      () => client.call('thread/read', { threadId, includeTurns: true }),
      (reply) => reply.thread.turns.at(-1)?.status === 'completed',
      25_000,
    )
  const first = await cardFor('signed-first')
  const signed = replyFor(first.card)
  await reject({ ...signed, signature: undefined })
  await reject(replyFor(first.card, untrusted.privateKey))
  await reject(replyFor(first.card, phone.privateKey, Date.now() - 10))
  assert.equal(existsSync(first.path), false)
  assert.deepEqual(await client.call(M.answer, signed), { accepted: true })
  await reject(signed, true)
  await until('真实 Mac 写入', () => existsSync(first.path), Boolean, 10_000)
  assert.equal(readFileSync(first.path, 'utf8'), 'signed-first')
  await idle()
  const second = await cardFor('signed-revoked')
  assert.equal(await onMac('forgetFixturePhone', { phoneId }), true)
  await reject(replyFor(second.card))
  assert.equal(existsSync(second.path), false)
  assert.ok((await client.call(M.list)).cards.some((card) => card.id === second.card.id))
  await onMac('machine.deferredAnswer', {
    deviceId: 'approval-fixture',
    id: second.card.id,
    decision: 'decline',
  })
  await idle()
  console.log('SSH → 真实 Mac：无签名、伪造、过期签名、重放和撤销均不执行，正确签名只执行一次')

  const serial = process.env.LITCH_MACHINE_ANDROID_SERIAL
  if (serial) await checkAndroid({ serial, onMac, ssh, profile, client, threadId, cardFor })
}

async function checkAndroid({ serial, onMac, ssh, profile, client, threadId, cardFor }) {
  assert.match(serial, /^emulator-\d+$/, '仅可用于已隔离的 Android 模拟器')
  const adb = (...args) =>
    execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8', timeout: 30_000 })
  const run = (name, body) => {
    const path = join(profile, `${name}.yaml`)
    writeFileSync(path, `appId: dev.litch.app\n---\n${body}`, { mode: 0o600 })
    const child = spawn('maestro', ['--device', serial, 'test', path], {
      stdio: 'inherit',
      env: { ...process.env, MAESTRO_CLI_NO_ANALYTICS: '1' },
      timeout: 150_000,
    })
    return new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`Android 流程失败：${name}`)),
      )
    })
  }
  const { pairing } = await onMac('pairing.start', { deviceId: 'approval-fixture' })
  const address = pairing.original
  assert.equal(address.host, '127.0.0.1')
  assert.ok(pairing.approvals && pairing.seed)
  const text = encodePairPayload({
    v: 1,
    n: 'Machine approval fixture',
    h: address.host,
    p: address.port,
    u: address.user,
    k: { t: pairing.hostKey.type, f: pairing.hostKey.fingerprint },
    s: pairing.seed,
    i: pairing.pairId,
    e: pairing.expiresAt,
    a: 1,
  })
  const port = `tcp:${address.port}`
  adb('reverse', port, port)
  const waitFor = (id, timeout = 25_000) =>
    `- extendedWaitUntil:\n    visible:\n      id: "${id}"\n    timeout: ${timeout}\n`
  const tap = (id) => `- tapOn:\n    id: "${id}"\n`
  const setup = run(
    'machine-pair',
    `- launchApp:
    clearState: true
    stopApp: true
${waitFor('devices:empty:add')}- openLink: "litch://remote?adapter=${ssh.adapter}&env=LITCH_FX_MODE=svc"
${tap('devices:empty:add')}${waitFor('add:pair')}${tap('add:pair')}
- scrollUntilVisible:
    element:
      id: "pair:paste"
    direction: DOWN
${tap('pair:paste')}- inputText: "${text}"
- hideKeyboard
${tap('pair:paste:go')}${waitFor('pair:add')}${tap('pair:add')}${waitFor('pair:code')}`,
  )
  try {
    const { status } = await Promise.race([
      until(
        '实体应用登记手机批准钥匙',
        () => onMac('pairing.status', { deviceId: 'approval-fixture', pairId: pairing.pairId }),
        ({ status }) => status.state === 'requested',
        135_000,
      ),
      setup.then(() =>
        onMac('pairing.status', { deviceId: 'approval-fixture', pairId: pairing.pairId }),
      ),
    ])
    assert.ok(status.phone?.approvalKey && status.phone.code)
    await setup
    await run(
      'machine-code',
      `- assertVisible: "${status.phone.code.slice(0, 3)} ${status.phone.code.slice(3)}"\n`,
    )
    await onMac('pairing.decide', {
      deviceId: 'approval-fixture',
      pairId: pairing.pairId,
      allow: true,
    })
    await pause(750)
    const next = await cardFor('android-signed')
    await run(
      'machine-approve',
      `${waitFor('sessions', 45_000)}- openLink: "litch://open?device=ssh-1&session=${threadId}"
${waitFor('machine-deferred:once', 45_000)}- assertVisible:
    id: "machine-deferred:decline"
${tap('machine-deferred:timed')}${tap('machine-deferred:confirm')}`,
    )
    await until('Android 签名使真实 Mac 执行', () => existsSync(next.path), Boolean, 25_000)
    assert.equal(readFileSync(next.path, 'utf8'), 'android-signed')
    const list = await client.call('litch/timedApproval/list', {})
    assert.ok(
      list.grants.some((grant) => grant.threadId === threadId && grant.category === 'machine'),
    )
    console.log('Android：真实配对并核对确认码、会话卡限时批准、真实 Mac 验签执行和授时均通过')
  } finally {
    adb('reverse', '--remove', port)
  }
}
