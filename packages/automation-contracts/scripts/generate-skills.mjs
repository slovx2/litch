// 完整合同同时服务尚未接入原生技能的宿主；技能正文只收录原文，不另维护一套操作规则。
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const specifier = (file) => new URL(`src/litch/${file}.mts`, root).href
const source = `
import { browserToolsSpec } from ${JSON.stringify(specifier('client-tools-browser'))};
import { computerToolsSpec } from ${JSON.stringify(specifier('client-tools-computer'))};
import { portableComputerTools } from ${JSON.stringify(specifier('client-tools-computer-portable'))};
console.log(JSON.stringify({browser:browserToolsSpec(true),mac:computerToolsSpec('darwin',true),win:computerToolsSpec('win32',true),portable:portableComputerTools()}));`
const specs = JSON.parse(
  execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
    cwd: fileURLToPath(root),
    encoding: 'utf8',
  }),
)
const section = (spec) =>
  [
    spec.description,
    spec.instructions,
    ...spec.tools.map((tool) => `## ${tool.name}\n\n${tool.description}`),
  ]
    .filter(Boolean)
    .join('\n\n') + '\n'
const front = (name, description) =>
  `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n`
const files = {
  'litch-browser-automation/SKILL.md':
    front(
      'litch-browser-automation',
      'Use Litch browser tools for the built-in browser or Chrome.',
    ) + section(specs.browser),
  'litch-computer-automation/SKILL.md':
    front(
      'litch-computer-automation',
      'Use Litch Computer Use tools to read or operate macOS or Windows apps.',
    ) +
    section(specs.portable) +
    '\n\n## Platform\n\n- macOS: [references/macos.md](references/macos.md)\n- Windows: [references/windows.md](references/windows.md)\n',
  'litch-computer-automation/references/macos.md': section(specs.mac),
  'litch-computer-automation/references/windows.md': section(specs.win),
}
const outputs = Object.entries(files).map(([path, text]) => [`skills/${path}`, text])
outputs.push([
  'src/litch/automation-skill-files.mts',
  '// 由 scripts/generate-skills.mjs 生成；正文逐字来自完整工具合同。\n' +
    `export const AUTOMATION_SKILL_FILES: Readonly<Record<string, string>> = ${JSON.stringify(files, null, 2)}\n` +
    `export const AUTOMATION_SKILL_TOOLS: Readonly<Record<string, string[]>> = ${JSON.stringify({ litch_browser: specs.browser.tools.map((t) => t.name), litch_computer: specs.mac.tools.map((t) => t.name) }, null, 2)}\n`,
])
for (const [path, content] of outputs) {
  const output = new URL(path, root)
  // 生成的模块同样遵守仓库格式，检查模式与写入模式共用完全相同的正文。
  const text = path.endsWith('.mts')
    ? execFileSync(
        process.execPath,
        [
          fileURLToPath(new URL('../../../node_modules/@biomejs/biome/bin/biome', import.meta.url)),
          'format',
          `--stdin-file-path=${fileURLToPath(output)}`,
        ],
        { input: content, encoding: 'utf8', cwd: fileURLToPath(root) },
      )
    : content
  if (process.argv.includes('--write')) {
    mkdirSync(dirname(fileURLToPath(output)), { recursive: true })
    const lines = text.split('\n')
    writeFileSync(output, '')
    for (let offset = 0; offset < lines.length; offset += 150)
      writeFileSync(
        output,
        `${offset ? '\n' : ''}${lines.slice(offset, offset + 150).join('\n')}`,
        { flag: 'a' },
      )
  } else if (readFileSync(output, 'utf8') !== text) throw new Error(`技能正文未同步：${path}`)
}
console.log('自动化技能正文与完整合同一致')
