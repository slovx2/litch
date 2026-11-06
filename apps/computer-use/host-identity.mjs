// Litch 实例的构建配置；第三方传完整配置，不继承任何 Litch 的 peer 身份。
export const LITCH_HOST_IDENTITY = Object.freeze({
  productName: 'Litch',
  helperName: 'Litch Computer Use',
  helperId: 'io.github.slovx2.litch.computer-use',
  allowedPeerIds: ['io.github.slovx2.litch'],
  protectedTargetIds: ['io.github.slovx2.litch'],
  isolationEnvironmentKeys: ['LITCH_PROFILE', 'LITCH_MOCK'],
  directoryEnvironmentKey: 'LITCH_COMPUTER_USE_DIR',
  tokenEnvironmentKey: 'LITCH_COMPUTER_USE_TOKEN',
  defaultStateSubdirectory: 'Library/Application Support/Litch/computer-use',
})
export function validateHostIdentity(identity) {
  if (!identity || typeof identity !== 'object') throw new Error('必须提供完整宿主身份')
  for (const key of [
    'productName',
    'helperName',
    'helperId',
    'directoryEnvironmentKey',
    'tokenEnvironmentKey',
    'defaultStateSubdirectory',
  ]) {
    if (
      typeof identity[key] !== 'string' ||
      !identity[key].trim() ||
      /[\x00-\x1f]/.test(identity[key])
    )
      throw new Error(`无效宿主身份字段：${key}`)
  }
  for (const key of ['allowedPeerIds', 'protectedTargetIds', 'isolationEnvironmentKeys']) {
    if (
      !Array.isArray(identity[key]) ||
      (key !== 'isolationEnvironmentKeys' && !identity[key].length) ||
      identity[key].some(
        (value) => typeof value !== 'string' || !value || /[\x00-\x1f]/.test(value),
      )
    )
      throw new Error(`无效宿主身份列表：${key}`)
  }
  for (const key of [
    ...identity.isolationEnvironmentKeys,
    identity.directoryEnvironmentKey,
    identity.tokenEnvironmentKey,
  ]) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error('环境键必须是大写标识符')
  }
  if (
    identity.defaultStateSubdirectory.startsWith('/') ||
    identity.defaultStateSubdirectory.split('/').includes('..')
  )
    throw new Error('状态子目录必须位于宿主 HOME 下')
  return identity
}
