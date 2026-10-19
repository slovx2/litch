// 演“电脑上出了一张配对码”：入口脚本（scripts/e2e.mjs 的 /pair）写好一次性钥匙行，回配对文本
const response = http.post(`${HELPER}/pair`, { body: '' })
output.pairText = response.status === 200 ? response.body : ''
