// 只解出一个失败步骤的文本，不落盘、不执行来源代码，无法精确定位就拒绝。
import { execFileSync } from 'node:child_process'

const safeLogName = (name) => name.replace(/[<>:"/\\|?*]/g, '_')
export function stepLogPath(job, step) {
  return `${safeLogName(job.name)}/${step.number}_${safeLogName(step.name)}.txt`
}

export function readStepLog(archive, job, step, unpack = execFileSync) {
  const options = { input: archive, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }
  const entries = unpack('tar', ['-tf', '-'], options).trim().split('\n')
  const path = stepLogPath(job, step)
  if (entries.filter((entry) => entry === path).length !== 1)
    throw new Error('失败步骤日志缺失或路径不唯一')
  // 文件路径只能用于tar的单文件stdout读取，不能写到工作区或被当作选项。
  if (path.startsWith('-') || path.includes('/../') || path.includes('\n'))
    throw new Error('不接受的日志路径')
  const text = unpack('tar', ['-xOf', '-', '--', path], options)
  if (!text.trim()) throw new Error('步骤日志为空')
  return { number: step.number, complete: true, text }
}
