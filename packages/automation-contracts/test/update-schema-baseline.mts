// npm run update:automation-baseline：按唯一源重录工具 schema 基线，打出变了哪几套。
import { readBaseline, writeBaseline } from './schema-baseline.mjs'

const before = readBaseline().sha256
const after = writeBaseline().sha256
const changed = Object.keys({ ...before, ...after }).filter((name) => before[name] !== after[name])
console.log(changed.length ? `基线已更新：${changed.join('、')}` : '基线没有变化')
