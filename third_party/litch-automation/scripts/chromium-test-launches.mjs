import { parse } from '@babel/parser'

function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  if (typeof node.type === 'string') visit(node)
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'comments', 'tokens'].includes(key)) continue
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visit)
    } else if (value && typeof value === 'object') walk(value, visit)
  }
}

// 检查实际启动参数，而非文件里是否恰巧出现两个开关。静态识别测试常用的进程/Playwright入口。
export function chromiumTestLaunches(source) {
  const tree = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
  const bindings = new Map()
  const helpers = new Set()
  const browserImports = new Set()
  const processCalls = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync'])
  walk(tree, (node) => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier')
      bindings.set(node.id.name, node.init)
    if (node.type !== 'ImportDeclaration') return
    if (/playwright|puppeteer/.test(node.source.value)) {
      for (const specifier of node.specifiers) browserImports.add(specifier.local.name)
    }
    if (node.source.value.endsWith('/chromium-test-args.mjs')) {
      for (const specifier of node.specifiers) {
        if (specifier.imported?.name === 'withChromiumTestArgs') helpers.add(specifier.local.name)
      }
    }
    if (node.source.value === 'node:child_process' || node.source.value === 'child_process') {
      for (const specifier of node.specifiers) {
        if (processCalls.has(specifier.imported?.name)) processCalls.add(specifier.local.name)
      }
    }
  })
  const text = (node) => (node ? source.slice(node.start, node.end) : '')
  function expanded(node, seen = new Set()) {
    if (node?.type === 'Identifier' && bindings.has(node.name) && !seen.has(node.name))
      return expanded(bindings.get(node.name), new Set([...seen, node.name]))
    return text(node)
  }
  const helperCall = (node) => node?.type === 'CallExpression' && helpers.has(node.callee.name)
  function protectedArgs(node, seen = new Set()) {
    if (helperCall(node)) return true
    if (node?.type === 'Identifier' && !seen.has(node.name))
      return protectedArgs(bindings.get(node.name), new Set([...seen, node.name]))
    if (node?.type === 'ConditionalExpression')
      return protectedArgs(node.consequent, seen) && protectedArgs(node.alternate, seen)
    return false
  }
  const launches = []
  walk(tree, (node) => {
    if (node.type !== 'CallExpression') return
    const callee = text(node.callee)
    const [binary, args] = node.arguments
    let kind
    let argumentsNode = args
    if (
      /(?:^|\.)(?:spawn|spawnSync|execFile|execFileSync)$/.test(callee) ||
      processCalls.has(callee)
    ) {
      const browser =
        /\belectron\b|\bchromium\b|\bchrome\b|\bchromeBinary\b|LITCH_CHROME_BINARY|Contents\/MacOS|packedBinary/i.test(
          `${text(binary)} ${expanded(binary)}`,
        ) || binary?.name === 'app'
      const switches = /--(?:remote-debugging-(?:port|pipe)|user-data-dir|headless)/.test(
        expanded(args),
      )
      if (browser || switches) kind = 'process'
      if (text(binary).includes('/usr/bin/open') && expanded(args).includes('--args')) kind = 'open'
    } else if (
      /\.(?:launch|launchPersistentContext)$/.test(callee) &&
      (/chromium|chrome|browser|puppeteer|playwright/i.test(
        `${callee} ${expanded(node.callee.object)}`,
      ) ||
        browserImports.has(node.callee.object?.name))
    ) {
      kind = 'playwright'
      const options = node.arguments.at(-1)
      argumentsNode = options?.properties?.find((property) => property.key?.name === 'args')?.value
    }
    if (!kind) return
    let protectedLaunch = protectedArgs(argumentsNode)
    if (kind === 'open' && argumentsNode?.type === 'ArrayExpression') {
      const separator = argumentsNode.elements.findIndex((item) => item?.value === '--args')
      const tail = argumentsNode.elements.slice(separator + 1)
      protectedLaunch =
        tail.length === 1 && tail[0]?.type === 'SpreadElement' && protectedArgs(tail[0].argument)
    }
    launches.push({ node, args: argumentsNode, kind, protected: protectedLaunch })
  })
  return launches
}
