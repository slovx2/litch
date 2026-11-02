// always() 调用；只读取本作业的 step context，不上传环境变量或凭据。
import { appendFileSync } from 'node:fs'

const steps = JSON.parse(process.env.CI_STEPS ?? '{}')
const lines = ['\n### 缓存与首次失败', '| 缓存 | 精确命中（前缀恢复见缓存日志） |', '|---|---|']
for (const [name, step] of Object.entries(steps)) {
  if (name.startsWith('cache-'))
    lines.push(`| ${name} | ${step.outputs?.['cache-hit'] || 'false / 未完成'} |`)
}
const failed = Object.entries(steps).filter(([, step]) => step.outcome === 'failure')
lines.push(`\n首次失败步骤：${failed[0]?.[0] ?? '无（具体阶段与耗时见运行总览）'}。`)
lines.push(`GitHub attempt：${process.env.GITHUB_RUN_ATTEMPT ?? '1'}；测试自动重试：0。`)
appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`)
