// 文件交付格式只有这一份：适配器经呈现指令注入，原生 Codex 经既有开发者指令恢复机制注入。
import type { ClientToolNamespaceSpec } from './client-tools.mjs'

export const FILE_LINK_NAMESPACE = 'litch_file_links'
export const FILE_LINK_RULES = [
  'File links in Litch. Reference existing files with standard Markdown links whose targets are full absolute paths on the device running this session. Use a short filename as the label, for example [report.md](</absolute/path/report.md>) or [source.ts](</absolute/path/source.ts#L12>).',
  'For source locations append #L followed by the starting line number. Put targets with spaces in angle brackets. Encode literal # and % in filenames as %23 and %25. On Windows prefer C:/path/file.ts#L12. Do not wrap the whole link in backticks.',
  'The file viewer can read any existing absolute path on this session device, including outside the project or worktree. It is read-only and does not search another device, container or web sandbox. Relative paths are tried against the session cwd and project roots; prefer absolute paths to avoid ambiguity. A leading ~ refers to this session device home, never the viewing computer home.',
  'Link existing directories the same way, with a trailing slash; opening one locates and expands it in the file tree. Confirm a deliverable exists before linking it. Identify the device and location of artifacts on other machines and do not promise that the current viewer can open them. Mark illustrative or not-yet-created paths as examples.',
  'Do not use file://, UNC network shares or editor-specific URLs. A recognized link does not guarantee preview support: formats and byte limits still apply, and restricted previews reject symlinks or document resources escaping the selected directory.',
].join('\n')

/** 只在 Litch 与自己的设备层之间携带；给原生 Codex 前抽成 developerInstructions，并去掉空命名空间。 */
export const FILE_LINK_SPEC: ClientToolNamespaceSpec = {
  type: 'namespace',
  name: FILE_LINK_NAMESPACE,
  description: 'File references in Litch. No tools.',
  tools: [],
  instructions: FILE_LINK_RULES,
}
