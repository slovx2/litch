// PowerShell 5.1/7 都支持。命令及文件参数用 UTF-16LE 编码传入，不经过 cmd 的引号规则。
// 文件内容直接走原始字节流；不让 PowerShell 的文本管线改编码或换行。
import { encodeBase64 } from '../../text/bytes.mjs'

export function powershellCommand(script: string): string[] {
  const bytes = new Uint8Array(script.length * 2)
  for (let at = 0; at < script.length; at++) {
    const code = script.charCodeAt(at)
    bytes[at * 2] = code & 255
    bytes[at * 2 + 1] = code >>> 8
  }
  return [
    'powershell.exe',
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-OutputFormat',
    'Text',
    '-EncodedCommand',
    encodeBase64(bytes),
  ]
}

const literal = (value: string): string => `'${value.replace(/'/g, "''")}'`
const array = (values: readonly string[]): string => `@(${values.map(literal).join(',')})`
// 首次加载模块会把进度序列化成 CLIXML 写到 stderr，必须在 New-Object 之前关闭进度。
const UTF8 = `$ProgressPreference = 'SilentlyContinue'
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8`

// 用句柄解析 junction、符号链接和 8.3 别名。只对不存在的尾段退到父目录；拒绝访问必须失败，不能回退原路径。
const REAL = String.raw`Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class LitchMachinePath {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint mode, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern uint GetFinalPathNameByHandle(SafeFileHandle file, StringBuilder path, uint size, uint flags);
  public static string Real(string path) {
    path = Path.GetFullPath(path);
    using (var file = CreateFile(path, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
      if (file.IsInvalid) {
        int error = Marshal.GetLastWin32Error();
        if (error != 2 && error != 3) throw new IOException(path + ": " + new Win32Exception(error).Message);
        string parent = Path.GetDirectoryName(path.TrimEnd('\\'));
        if (String.IsNullOrEmpty(parent)) throw new IOException(path + ": " + new Win32Exception(error).Message);
        return Real(parent).TrimEnd('/') + "/" + Path.GetFileName(path);
      }
      var result = new StringBuilder(32768);
      uint length = GetFinalPathNameByHandle(file, result, (uint)result.Capacity, 0);
      if (length == 0 || length >= result.Capacity) throw new IOException(path + ": " + new Win32Exception(Marshal.GetLastWin32Error()).Message);
      string resolved = result.ToString();
      if (resolved.StartsWith(@"\\?\UNC\")) resolved = @"\\" + resolved.Substring(8);
      else if (resolved.StartsWith(@"\\?\")) resolved = resolved.Substring(4);
      return resolved.Replace('\\', '/');
    }
  }
}
'@`

const helper = (script: string): string[] =>
  powershellCommand(`${UTF8}
$ErrorActionPreference = 'Stop'
try {
${script}
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}`)

export const windowsScripts = {
  probe: (path: string, denied: readonly string[]): string[] =>
    helper(`${REAL}
$path = ${literal(path)}
$real = [LitchMachinePath]::Real($path)
$kind = 'm'; $size = 0
if (Test-Path -LiteralPath $path) {
  $item = Get-Item -LiteralPath $real -Force
  if ($item.PSIsContainer) { $kind = 'd' } else { $kind = 'f'; $size = $item.Length }
}
[Console]::Write($real + [char]0 + $kind + [char]0 + $size + [char]0)
foreach ($rule in ${array(denied)}) { [Console]::Write([LitchMachinePath]::Real($rule) + [char]0) }`),
  list: (root: string, depth: number | null, _icase: boolean, prune: readonly string[]): string[] =>
    helper(`
$prune = ${array(prune)}
function Walk([string]$folder, [int]$level) {
  foreach ($entry in Get-ChildItem -LiteralPath $folder -Force) {
    $path = $entry.FullName.Replace('\\', '/')
    $link = ''; $size = 0
    if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { $kind = 'l'; $link = [string]$entry.Target }
    elseif ($entry.PSIsContainer) { $kind = 'd' }
    else { $kind = 'f'; $size = $entry.Length }
    $time = ([DateTimeOffset]$entry.LastWriteTimeUtc).ToUnixTimeSeconds()
    [Console]::Write($kind + [char]9 + $size + [char]9 + $time + [char]9 + $link + [char]9 + $path + [char]0)
    if ($kind -eq 'd' -and $level -lt ${depth ?? 2147483647} -and $prune -notcontains $path) { Walk $entry.FullName ($level + 1) }
  }
}
Walk ${literal(root)} 1`),
  readRange: (path: string, offset: number, length: number): string[] =>
    helper(`
$file = [IO.File]::OpenRead(${literal(path)})
try {
  [void]$file.Seek(${offset}, [IO.SeekOrigin]::Begin)
  $out = [Console]::OpenStandardOutput()
  $buffer = New-Object byte[] 65536
  $left = ${length}
  while ($left -gt 0) {
    $count = $file.Read($buffer, 0, [Math]::Min($left, $buffer.Length))
    if ($count -eq 0) { break }
    $out.Write($buffer, 0, $count); $left -= $count
  }
} finally { $file.Dispose() }`),
  write: (path: string): string[] => write(path, false),
  append: (path: string): string[] => write(path, true),
  signal: (_signal: string, _pid: number): string[] => {
    throw new Error(
      'Windows does not support POSIX signals here. Use action kill to stop the entire process tree.',
    )
  },
}

function write(path: string, append: boolean): string[] {
  return helper(`$file = [IO.File]::Open(${literal(path)}, [IO.FileMode]::${append ? 'Append' : 'Create'}, [IO.FileAccess]::Write)
try { [Console]::OpenStandardInput().CopyTo($file) } finally { $file.Dispose() }`)
}

export function windowsExec(command: string): string[] {
  return powershellCommand(`${UTF8}
[Console]::Error.WriteLine(([string][char]30) + 'litch-pid ' + $PID)
$global:LASTEXITCODE = 0
try {
  & ([ScriptBlock]::Create(${literal(command)}))
  if (-not $?) { exit 1 }
  exit $LASTEXITCODE
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}`)
}
