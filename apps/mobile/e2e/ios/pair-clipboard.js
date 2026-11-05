// 配对码仍由真实隔离设备服务生成，使用产品已有的“从剪贴板粘贴”入口。
const response = http.post(`${HELPER}/clipboard/set`, { body: output.pairText })
output.clipboardSet = response.status === 200
