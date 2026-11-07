// 唯一源在 contracts；设备包只消费 protocol 内的自包含投影。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const automationRoot = fileURLToPath(new URL('../', import.meta.url))
export const projections = [
  ['litch/client-tools-browser.mts', 'client-tools-browser.mts'],
  ['litch/client-tools-computer.mts', 'client-tools-computer.mts'],
  ['litch/client-tools-computer-portable.mts', 'client-tools-computer-portable.mts'],
  ['litch/chrome-browser.mts', 'chrome-browser.mts'],
  ['automation-surface.mts', 'automation-surface.mts'],
  ['tool-spec.mts', 'automation-tool-spec.mts'],
]

export function projectContracts(root = automationRoot, check = true) {
  for (const [source, target] of projections) {
    const content = readFileSync(
      join(root, 'packages/automation-contracts/src', source),
      'utf8',
    ).replaceAll("from '../tool-spec.mjs'", "from './automation-tool-spec.mjs'")
    const expected = `// 由 scripts/generate-automation-contracts.mjs 生成；请修改 automation-contracts/src/${source}。\n${content}`
    const output = join(root, 'packages/protocol/src', target)
    if (check) {
      if (readFileSync(output, 'utf8') !== expected) throw new Error(`公共合同投影过期：${target}`)
    } else {
      mkdirSync(dirname(output), { recursive: true })
      // 大文件分段写，避免一次写入整份定义；内容仍完全由唯一源生成。
      const lines = expected.split('\n')
      writeFileSync(output, '')
      for (let offset = 0; offset < lines.length; offset += 200) {
        const chunk = lines.slice(offset, offset + 200).join('\n')
        writeFileSync(output, `${offset ? '\n' : ''}${chunk}`, { flag: 'a' })
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  if (args.length !== 1 || !['--check', '--write'].includes(args[0])) {
    throw new Error('请明确指定 --check 或 --write')
  }
  projectContracts(automationRoot, args[0] === '--check')
  console.log('自动化公共合同投影一致')
}
