// 隔离设备服务上的假桌面端：请求与答复均为测试数据，仍用配对时登记的真实公钥验签。
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { approvalSignedText } from '../../../packages/protocol/src/client-approvals.mts'
import { deviceRpc } from './device-rpc.mjs'

export function iosTestApprovals(socket, phone) {
  let desktop
  let card
  const answers = []
  const token = () => randomBytes(16).toString('base64url')
  return {
    close() {
      desktop?.close()
    },
    async handle(method, path) {
      if (!desktop) {
        desktop = await deviceRpc(await socket(), (method, params) => {
          if (method === 'litch/approval/answered') answers.push(params)
        })
        await desktop.call('initialize', {
          clientInfo: { name: 'litch-ios-e2e', title: 'Litch iOS e2e', version: '0.0.0' },
          capabilities: { experimentalApi: true, litchExtensions: ['harness', 'clientApprovals'] },
        })
        desktop.notify('initialized')
      }
      if (method === 'POST' && path === '/approval/open') {
        const { data } = await desktop.call('thread/list', {})
        const newest = [...data].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]
        if (!newest) return null
        card = {
          id: token(),
          threadId: newest.id,
          kind: 'browserSignIn',
          summary: {
            origin: 'https://accounts.example.com',
            site: 'Example',
            reason: '隔离登录批准测试',
            device: 'e2e-pair',
            accounts: [
              { ref: 'a1', masked: 'so•••@gmail.com' },
              { ref: 'a2', masked: 'li•••@example.com' },
            ],
            task: null,
            fillBlocked: null,
          },
          desktopId: 'e2eDesktop0000000',
          nonce: token(),
          expiresAt: null,
        }
        answers.length = 0
        await desktop.call('litch/approval/open', card)
        return JSON.stringify({ id: card.id, threadId: card.threadId })
      }
      const registered = phone()
      if (path === '/approval/fingerprint') {
        if (!registered?.approvalKey) return null
        return createHash('sha256')
          .update(Buffer.from(registered.approvalKey, 'base64'))
          .digest('hex')
          .slice(0, 16)
          .match(/.{4}/g)
          .join(' ')
      }
      if (path === '/approval/answered' && card) {
        for (let i = 0; i < 240 && !answers.some((one) => one.id === card.id); i++) await sleep(250)
        const answer = answers.find((one) => one.id === card.id)
        if (!answer) return null
        const key = createPublicKey({
          key: Buffer.concat([
            Buffer.from('302a300506032b6570032100', 'hex'),
            Buffer.from(answer.approvalKey, 'base64'),
          ]),
          format: 'der',
          type: 'spki',
        })
        const text = approvalSignedText({ ...card, origin: card.summary.origin }, answer)
        const verified =
          !!registered?.approvalKey &&
          answer.approvalKey === registered.approvalKey &&
          answer.phoneId === registered.phoneId &&
          verify(null, Buffer.from(text), key, Buffer.from(answer.signature, 'base64'))
        if (verified) await desktop.call('litch/approval/close', { id: card.id })
        return JSON.stringify({ verified, ref: answer.ref, decision: answer.decision })
      }
      return null
    },
  }
}
