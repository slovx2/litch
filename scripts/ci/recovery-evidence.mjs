// 只解出一个失败步骤的文本，不落盘、不执行来源代码，无法精确定位就拒绝。
import { execFileSync } from 'node:child_process'

// GNU tar不能读取Actions日志ZIP。统一用runner已有的Python标准库内存读取，
// 不写临时日志、不提取目录；解压前限制单文件尺寸，读取时校验ZIP CRC。
const readZip = `
import io
import sys
import zipfile

data: bytes = sys.stdin.buffer.read(64 * 1024 * 1024 + 1)
if len(data) > 64 * 1024 * 1024:
    raise ValueError("archive size")
with zipfile.ZipFile(io.BytesIO(data)) as archive:
    entries: list[zipfile.ZipInfo] = archive.infolist()
    if len(entries) > 10000:
        raise ValueError("entry count")
    matches: list[zipfile.ZipInfo] = [entry for entry in entries if entry.filename == sys.argv[1]]
    if len(matches) != 1:
        raise ValueError("missing or duplicate step")
    entry: zipfile.ZipInfo = matches[0]
    if entry.is_dir() or entry.flag_bits & 1 or entry.file_size > 4 * 1024 * 1024:
        raise ValueError("step size or type")
    if entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
        raise ValueError("unsupported compression")
    with archive.open(entry) as source:
        text: bytes = source.read(4 * 1024 * 1024 + 1)
    if len(text) != entry.file_size or len(text) > 4 * 1024 * 1024:
        raise ValueError("step length")
    sys.stdout.buffer.write(text)
`

const safeLogName = (name) => name.replace(/[<>:"/\\|?*]/g, '_')
export function stepLogPath(job, step) {
  return `${safeLogName(job.name)}/${step.number}_${safeLogName(step.name)}.txt`
}

export function readStepLog(archive, job, step, unpack = execFileSync) {
  const path = stepLogPath(job, step)
  return { number: step.number, complete: true, text: readZipText(archive, path, unpack) }
}

export function readZipText(archive, path, unpack = execFileSync) {
  if (path.startsWith('-') || path.split('/').includes('..') || /[\r\n\0]/.test(path))
    throw new Error('不接受的日志路径')
  if (!Buffer.isBuffer(archive) || archive.length > 64 * 1024 * 1024)
    throw new Error('日志归档超过边界')
  let text
  try {
    text = unpack('python3', ['-I', '-c', readZip, path], {
      input: archive,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch {
    // 不把Python异常中可能包含的来源内容写进审计或CI输出。
    throw new Error('失败步骤ZIP读取失败：缺失、不唯一、损坏或超过边界')
  }
  if (!text.trim()) throw new Error('步骤日志为空')
  return text
}
