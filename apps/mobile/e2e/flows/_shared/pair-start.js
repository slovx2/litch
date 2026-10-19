// 演“电脑上出了一张配对码”：入口脚本（scripts/e2e.mjs 的 /pair）调设备服务的 litch/pair/start，回配对文本
const response = http.post(`${HELPER}/pair`, { body: '' })
output.pairText = response.status === 200 ? response.body : ''
