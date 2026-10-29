// 复用仓库假模型夹具，只在忽略的产物目录生成副本；不改共享 scripts/ 或读取个人配置。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const source = join(root, 'scripts/client-fixture.mjs')
const out = join(root, 'apps/computer-use/.artifacts/integration')
mkdirSync(out, { recursive: true })
let text = readFileSync(source, 'utf8')
text = text.replace(
  "const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')",
  `const repo = ${JSON.stringify(root)}`,
)
text = text.replaceAll(
  /from '(\.\/client[^']+)'/g,
  (_, name) => `from ${JSON.stringify(pathToFileURL(join(root, 'scripts', name)).href)}`,
)
text =
  `import { computerReply as fixtureComputerReply } from ${JSON.stringify(pathToFileURL(join(root, 'scripts/client-fixture-computer.mjs')).href)}
// Pi 将工具图片作为合成 user 消息附在后面；假模型只需按原测试脚本推进。
function computerReply(body) {
  const messages = (body.messages ?? []).filter(message => {
    const content = typeof message.content === 'string' ? message.content :
      (message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('');
    return !(message.role === 'user' && content.startsWith('Attached image(s) from tool result:'));
  });
  const normalized = { ...body, messages };
  return fixtureComputerReply(normalized, lastUserText(normalized));
}
` + text
text = text.replace(
  '(planReply(body, lastUserText(body)) ??',
  '(computerReply(body, lastUserText(body)) ?? planReply(body, lastUserText(body)) ??',
)
writeFileSync(join(out, 'fixture.mjs'), text)
console.log(join(out, 'fixture.mjs'))
