// 探针的构建与通用启动器共用身份，不能继承生产包装器固定的助手身份。
export const PROBE_IDENTITY = Object.freeze({
  helperId: 'io.github.slovx2.litch.background-input-probe',
  helperName: 'Litch Background Input Probe',
  executableName: 'Probe',
  directoryEnv: 'LITCH_COMPUTER_USE_DIR',
  tokenEnv: 'LITCH_COMPUTER_USE_TOKEN',
})
