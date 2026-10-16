#!/usr/bin/env node
// 从上游 codex 的协议定义里提取“方法 → 应答类型”的对照表。
// 上游导出的结构定义快照（protocol/codex-app-server/<版本>/json-schema）里只有各个类型，
// 没有“哪个方法的应答是哪个类型”，这一层写在定义宏里。协议兼容性测试靠这张表找到每个应答该按哪个类型校验。
//
// 用法（上游仓库只读，用标签取文件，不切分支）：
//   git -C <codex 仓库> show rust-v<版本>:codex-rs/app-server-protocol/src/protocol/common.rs \
//     | node scripts/extract-protocol-methods.mjs <版本> > protocol/compat/methods-<版本>.json
import { readFileSync } from 'node:fs'

const version = process.argv[2]
if (!version) {
  console.error('用法：extract-protocol-methods.mjs <协议版本>，定义文件从标准输入读')
  process.exit(2)
}
const source = readFileSync(0, 'utf8')

// 取出一个定义宏调用的正文：从“名字! {”到与之配对的右花括号。
function macroBody(name) {
  const start = source.indexOf(`\n${name}! {`)
  if (start < 0) throw new Error(`上游定义里没有 ${name}!`)
  let depth = 0
  for (let index = source.indexOf('{', start); index < source.length; index++) {
    if (source[index] === '{') depth++
    else if (source[index] === '}' && --depth === 0)
      return source.slice(source.indexOf('{', start) + 1, index)
  }
  throw new Error(`${name}! 的花括号不配对`)
}

// 每一项形如：[#[experimental("…")]] 变体 => "方法" { params: 类型, …, response: 类型, }
// 参数类型不取：快照里的 ClientRequest.json、ServerRequest.json 已经按方法给了参数的结构。
function requests(name) {
  const entries = {}
  const pattern =
    /((?:\s*(?:#\[[^\]]*\]|\/\/[^\n]*)\s*)*)\b(\w+)\s*=>\s*"([^"]+)"\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g
  for (const [, attributes, , method, body] of macroBody(name).matchAll(pattern)) {
    const response = /\bresponse:\s*([^,]+),/.exec(body)
    if (!response) throw new Error(`${name}! 里的 ${method} 读不出应答类型`)
    entries[method] = {
      response: response[1].trim().split('::').at(-1),
      ...(/#\[experimental\(/.test(attributes) ? { experimental: true } : {}),
    }
  }
  if (!Object.keys(entries).length) throw new Error(`${name}! 里一项也没读出来`)
  return entries
}

const table = {
  note: '从上游 codex 的定义宏里提取的“方法 → 应答类型”（带 experimental 的是握手声明了 experimentalApi 才能用的），由 scripts/extract-protocol-methods.mjs 生成，不要手改。协议兼容性测试用它找到每个应答该按哪个类型校验。',
  source: `openai/codex 标签 rust-v${version}，codex-rs/app-server-protocol/src/protocol/common.rs`,
  version,
  clientRequests: requests('client_request_definitions'),
  serverRequests: requests('server_request_definitions'),
}
process.stdout.write(`${JSON.stringify(table, null, 2)}\n`)
