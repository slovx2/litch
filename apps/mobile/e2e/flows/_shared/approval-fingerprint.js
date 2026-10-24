// 扫码时手机送来的批准公钥的指纹（scripts/e2e.mjs 的 /approval/fingerprint），手机设置里应该显示同一串
const response = http.get(`${HELPER}/approval/fingerprint`)
output.fingerprint = response.status === 200 ? response.body : 'none'
