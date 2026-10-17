// 演“用户在电脑上授权了手机的钥匙”：把流程里复制下来的公钥交给入口脚本（scripts/e2e.mjs 的小口），它写进夹具的 authorized_keys
const response = http.post(`${HELPER}/authorize`, { body: maestro.copiedText })
output.authorized = response.status === 200
