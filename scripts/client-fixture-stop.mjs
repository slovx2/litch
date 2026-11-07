// 中断耗时验收专用：持续文字与前台命令，两家真正的 CLI 都只访问回环模型。
export const STOP_TOOL = /中断耗时工具/
export const STOP_TEXT = /中断耗时文字/
// 使用实际计算工作；新版 Claude CLI 不执行单独的前台 sleep。
export const STOP_COMMAND = `node -e "const {scryptSync}=require('node:crypto');for(let i=0;i<1000;i++)scryptSync('litch-stop-work','fixture',32)"`

export function stopResponses(body, said) {
  if (STOP_TEXT.test(said))
    return { text: '持续输出用于中断测量。'.repeat(100), pieces: 100, pace: 200 }
  if (!STOP_TOOL.test(said)) return null
  const input = Array.isArray(body.input) ? body.input : []
  const since = input.slice(input.findLastIndex((item) => item?.role === 'user') + 1)
  if (since.some((item) => item?.type === 'function_call_output')) return { text: '命令已完成' }
  return {
    call: {
      name: 'exec_command',
      arguments: JSON.stringify({ cmd: STOP_COMMAND, yield_time_ms: 30000 }),
    },
  }
}
