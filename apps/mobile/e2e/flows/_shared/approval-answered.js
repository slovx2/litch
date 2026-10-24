// 等手机的答复到桌面端那一头，用扫码时记下的批准公钥验签（scripts/e2e.mjs 的 /approval/answered），验过的卡片收掉
const response = http.get(`${HELPER}/approval/answered`)
const answered = response.status === 200 ? json(response.body) : null
output.verified = answered ? answered.verified : false
output.ref = answered ? String(answered.ref) : 'none'
output.decision = answered ? answered.decision : 'none'
