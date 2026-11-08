// 显式清理两个固定名称，不启动模型、不改 harness 配置。
import { removeAutomationSkills, sharedAutomationRoots } from './automation-skills.mjs'

if (process.argv.length !== 3 || process.argv[2] !== '--remove')
  throw new Error('用法：automation-skills-cli.mjs --remove')
console.log(JSON.stringify(sharedAutomationRoots().flatMap(removeAutomationSkills)))
