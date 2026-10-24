// 演“桌面端挂了一张代理登录的卡片”：入口脚本（scripts/e2e.mjs 的 /approval/open）在最近的会话上挂卡片
const response = http.post(`${HELPER}/approval/open`, { body: '' })
output.opened = response.status === 200
