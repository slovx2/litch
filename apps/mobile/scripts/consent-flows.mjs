// 普通回归场景显式点击新的数据同意卡；产品断言保留，隐私专项自行验证同意/取消。
// 不预写同意记录、不在 App 中绕过闸门，也不重试失败的产品动作。
import { cpSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseAllDocuments, stringify } from 'yaml'

const allowConsent = () => ({
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
})

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
      const absent = step.extendedWaitUntil?.notVisible ?? step.assertNotVisible
      const target = absent ?? step.extendedWaitUntil?.visible ?? step.assertVisible
      const selector = typeof target === 'string' ? { text: target } : target
      const kind = selector?.id ? 'id' : selector?.text ? 'text' : null
      if (!kind || String(selector[kind]).includes('ai-consent:')) return [step]
      if (absent) {
        // 等输入清空时，同意框可能晚于点击出现。只轮询并处理同意，绝不重放发送。
        // 保留完整选择器（例如 id + 草稿文字）和最终断言；超时仍应暴露产品失败。
        const timeout = step.extendedWaitUntil?.timeout ?? 10000
        return [
          {
            evalScript: `\${output.litchConsentWaiting = true; output.litchConsentDeadline = Date.now() + ${timeout}}`,
          },
          {
            repeat: {
              times: 50,
              while: {
                true: '${output.litchConsentWaiting && Date.now() < output.litchConsentDeadline}',
              },
              commands: [
                { waitForAnimationToEnd: { timeout: 1000 } },
                allowConsent(),
                {
                  runFlow: {
                    when: { notVisible: selector },
                    commands: [{ evalScript: '${output.litchConsentWaiting = false}' }],
                  },
                },
              ],
            },
          },
          step,
        ]
      }
      const alternative =
        kind === 'id' ? 'ai-consent:title' : '向 AI 服务发送数据|Share data with AI services'
      return [
        {
          extendedWaitUntil: {
            visible: { [kind]: `(?:${selector[kind]})|(?:${alternative})` },
            timeout: step.extendedWaitUntil?.timeout ?? 10000,
          },
        },
        allowConsent(),
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
