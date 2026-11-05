// 普通回归场景显式点击新的数据同意卡；产品断言保留，隐私专项自行验证同意/取消。
// 不预写同意记录、不在 App 中绕过闸门，也不重试失败的产品动作。
import { cpSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseAllDocuments, stringify } from 'yaml'

export function withConsentSteps(source, filename) {
  if (!filename.endsWith('.yaml')) return source
  const docs = parseAllDocuments(source)
  if (docs.some((doc) => doc.errors.length)) throw new Error(`无效 Maestro YAML：${filename}`)
  const header = docs[0]?.toJS()
  const steps = docs[1]?.toJS()
  if (!Array.isArray(steps) || header?.tags?.includes('privacy')) return source
  const walk = (commands) =>
    commands.flatMap((step) => {
      for (const value of Object.values(step)) {
        if (value && typeof value === 'object' && Array.isArray(value.commands))
          value.commands = walk(value.commands)
      }
      const target = step.extendedWaitUntil?.visible ?? step.assertVisible
      const selector = typeof target === 'string' ? { text: target } : target
      const kind = selector?.id ? 'id' : selector?.text ? 'text' : null
      if (!kind || String(selector[kind]).includes('ai-consent:')) return [step]
      const alternative =
        kind === 'id' ? 'ai-consent:title' : '向 AI 服务发送数据|Share data with AI services'
      return [
        {
          extendedWaitUntil: {
            visible: { [kind]: `(?:${selector[kind]})|(?:${alternative})` },
            timeout: step.extendedWaitUntil?.timeout ?? 10000,
          },
        },
        {
          runFlow: {
            when: { visible: { id: 'ai-consent:title' } },
            commands: [
              {
                scrollUntilVisible: {
                  element: { id: 'ai-consent:allow' },
                  direction: 'DOWN',
                  timeout: 5000,
                },
              },
              { tapOn: { id: 'ai-consent:allow' } },
            ],
          },
        },
        step,
      ]
    })
  return `${stringify(header)}---\n${stringify(walk(steps))}`
}

export function prepareConsentFlows(source, destination) {
  cpSync(source, destination, { recursive: true })
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name)
      if (entry.isDirectory()) visit(file)
      else if (entry.name.endsWith('.yaml'))
        writeFileSync(file, withConsentSteps(readFileSync(file, 'utf8'), file))
    }
  }
  visit(destination)
}
