// 只检查跟随字号的组件规则。新增组件文件要加入 text-size-scope；混合文件按选择器归属检查。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  bareTextPixels,
  chatPortals,
  sharedFiles,
  textFiles,
  textRules,
  textScope,
} from './text-size-scope.mjs'

const root = fileURLToPath(new URL('../packages/ui/src/styles/', import.meta.url))
const errors = []
// 字号公式正确也可能继承到 1：挂到 body 的评论浮层必须单独选择对话倍率。
const boundaries = textRules(readFileSync(`${root}text-size.css`, 'utf8'))
for (const name of chatPortals) {
  const rules = boundaries.filter((rule) =>
    rule.selector.split(',').some((part) => part.trim() === `.${name}`),
  )
  const values = rules.flatMap((rule) =>
    [...rule.body.matchAll(/--fs\s*:\s*([^;]+);/g)].map((match) => match[1].trim()),
  )
  if (values.length !== 1 || values[0] !== 'var(--fs-chat)')
    errors.push(`${name}: portal 必须选择 --fs-chat，不能重置为固定倍率`)
}
for (const file of [...textFiles, ...sharedFiles]) {
  const css = readFileSync(`${root}${file}`, 'utf8')
  for (const rule of textRules(css)) {
    if (!/(?:^|;)\s*(font-size|font|line-height)\s*:/.test(rule.body)) continue
    const scope = textScope(file, rule.selector)
    if (scope === 'unknown') {
      errors.push(`${file} ${rule.selector}: 请在 text-size-scope.mjs 声明字号归属`)
      continue
    }
    if (scope === 'fixed') continue
    for (const value of bareTextPixels(rule.body)) {
      const line = css.slice(0, rule.at).split('\n').length
      errors.push(`${file}:${line} ${rule.selector}: ${value}`)
    }
  }
}
if (errors.length) {
  console.error(`跟随区域的字号必须乘 var(--fs)，像素行高还须取整：\n${errors.join('\n')}`)
  process.exitCode = 1
} else console.log('区域字号检查通过')
