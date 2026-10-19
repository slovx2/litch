// 设备服务列出的已绑定手机有几部、夹具 sshd 的钥匙文件里手机的钥匙行有几行（scripts/e2e.mjs 的 /pair/phones）
const response = http.get(`${HELPER}/pair/phones`)
const counted = response.status === 200 ? json(response.body) : { phones: -1, keyLines: -1 }
output.phones = counted.phones
output.keyLines = counted.keyLines
