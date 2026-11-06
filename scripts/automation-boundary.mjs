// 用支持 TypeScript 的 AST 检查依赖，不遗漏 type import/export 或动态 import。
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { parse } from '@babel/parser'
import { automationRoot, projections } from './generate-automation-contracts.mjs'

export function importsOf(text, file = 'input.mts') {
  const source = parse(text, {
    sourceType: 'module',
    plugins: ['typescript'],
    createImportExpressions: true,
  })
  const imports = []
  function add(node) {
    assert.ok(node?.type === 'StringLiteral', `${file} 的动态依赖必须为字面量`)
    imports.push(node.value)
  }
  function visit(node) {
    if (
      [
        'ImportDeclaration',
        'ExportNamedDeclaration',
        'ExportAllDeclaration',
        'ImportExpression',
      ].includes(node.type) &&
      node.source
    )
      add(node.source)
    if (node.type === 'TSImportType') add(node.argument)
    if (node.type === 'TSExternalModuleReference') add(node.expression)
    if (
      node.type === 'CallExpression' &&
      node.callee?.type === 'Identifier' &&
      node.callee.name === 'require'
    )
      add(node.arguments[0])
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) if (child?.type) visit(child)
      } else if (value && typeof value === 'object' && typeof value.type === 'string') visit(value)
    }
  }
  visit(source)
  for (const comment of source.comments ?? [])
    assert.ok(
      !/<reference\s+(path|types)\s*=/.test(comment.value),
      `${file} 不允许 reference types/path`,
    )
  return [...new Set(imports)]
}

export function checkClosure(entries, root) {
  const boundary = realpathSync(root),
    checked = new Set()
  function visit(file) {
    const actual = realpathSync(file),
      path = relative(boundary, actual)
    assert.ok(path && !path.startsWith('..') && !path.startsWith('/'), `依赖越界：${file}`)
    if (checked.has(actual)) return
    checked.add(actual)
    for (const specifier of importsOf(readFileSync(actual, 'utf8'), actual)) {
      assert.ok(
        specifier.startsWith('./') || specifier.startsWith('../'),
        `非自包含依赖：${specifier}`,
      )
      const target = resolve(dirname(actual), specifier.replace(/\.mjs$/, '.mts'))
      assert.ok(existsSync(target), `依赖不存在：${specifier}`)
      visit(target)
    }
  }
  entries.forEach(visit)
  return checked.size
}

export function checkAutomationBoundary(root = automationRoot) {
  const source = join(root, 'packages/automation-contracts/src')
  const files = readdirSync(source, { recursive: true }).filter((file) => file.endsWith('.mts'))
  const count = checkClosure(
    files.map((file) => join(source, file)),
    source,
  )
  const protocol = join(root, 'packages/protocol/src')
  checkClosure(
    projections.map(([, target]) => join(protocol, target)),
    protocol,
  )
  checkClosure([join(protocol, 'client-tools.mts')], protocol)
  return count
}
