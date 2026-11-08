// 独立包的源码边界检查器；不依赖 Litch 根目录脚本。
import assert from 'node:assert/strict'
import { parse } from '@babel/parser'

export function importsOf(text, file = 'input.mts') {
  const source = parse(text, {
    sourceType: 'module',
    plugins: ['typescript'],
    createImportExpressions: true,
  })
  const imports = []
  const add = (node) => {
    assert.ok(node?.type === 'StringLiteral', `${file} 的动态依赖必须为字面量`)
    imports.push(node.value)
  }
  const visit = (node) => {
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
