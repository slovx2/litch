// 只检查跟随字号的组件规则。新增组件文件要加入 text-size-scope；混合文件按选择器归属检查。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  bareTextPixels,
  followsText,
  sharedFiles,
  textFiles,
  textRules,
} from './text-size-scope.mjs'

const root = fileURLToPath(new URL('../packages/ui/src/styles/', import.meta.url))
const errors = []
for (const file of [...textFiles, ...sharedFiles]) {
  const css = readFileSync(`${root}${file}`, 'utf8')
  for (const rule of textRules(css)) {
    if (!followsText(file, rule.selector)) continue
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
