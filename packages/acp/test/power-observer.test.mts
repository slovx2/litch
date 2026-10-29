import test from 'node:test'
import { checkPowerObserver } from '../../shared/test/power-observer-kit.mjs'
import { AcpServer } from '../src/server.mjs'

test('acp 电源观察只读内存，不初始化运行时、不加载历史、不清理正常会话', async () => {
  await checkPowerObserver(AcpServer.prototype, false)
})
