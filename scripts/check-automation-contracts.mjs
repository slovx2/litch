// Litch 自己检查协议投影；通用包的构建/消费者检查不依赖产品目录。
import { execFileSync } from 'node:child_process'
import { checkAutomationBoundary } from './automation-boundary.mjs'
import { projectContracts, automationRoot as root } from './generate-automation-contracts.mjs'

projectContracts(root, true)
checkAutomationBoundary(root)
await import(
  '../third_party/litch-automation/packages/automation-contracts/scripts/check-package.mjs'
)
for (const args of [
  ['--test', 'scripts/automation-boundary.test.mjs'],
  ['--import', 'tsx', '--test', 'packages/protocol/test/automation-contracts-projection.test.mts'],
])
  execFileSync(process.execPath, args, { cwd: root, stdio: 'inherit' })
