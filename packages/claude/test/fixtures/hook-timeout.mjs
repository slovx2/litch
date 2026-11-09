// 真实 Hook 超时夹具：由测试释放闸门才会正常完成，不能让一段短 sleep 抢在超时处理前结束。
import { access, appendFile, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

const [effect, gate] = process.argv.slice(2)
if (!effect || !gate) throw new Error('需要副作用文件和闸门文件')
await writeFile(`${effect}.pid`, String(process.pid))
await appendFile(effect, 'TIMEOUT_STARTED\n')
// 仅用于失败清理；测试明确拒绝 SELF_TIMEOUT，不能把夹具自行退出算成原生超时。
const deadline = Date.now() + 30_000
while (
  !(await access(gate).then(
    () => true,
    () => false,
  ))
) {
  if (Date.now() >= deadline) {
    await appendFile(effect, 'SELF_TIMEOUT\n')
    process.exit(124)
  }
  await delay(10)
}
await appendFile(effect, 'AFTER_TIMEOUT\n')
