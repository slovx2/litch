/** 设备身份取自核心；本机路径是否仍可访问，点击时由主进程核验。 */
export function fileDestination(
  kind: 'local' | 'ssh' | undefined,
  directory: boolean,
  capabilities: { reveal: boolean; save: boolean },
): 'revealLocal' | 'saveLocal' | null {
  if (kind === 'local') return capabilities.reveal ? 'revealLocal' : null
  return kind === 'ssh' && !directory && capabilities.save ? 'saveLocal' : null
}

export function revealLabel(platform: string | undefined) {
  return platform === 'darwin' ? 'files.action.revealFinder' : 'files.action.revealManager'
}
