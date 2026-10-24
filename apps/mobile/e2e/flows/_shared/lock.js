// 给模拟器设（ON 为 1）或清锁屏密码 1111（scripts/e2e.mjs 的 /lock/*）：批准前的系统验证要有锁屏
const response = http.post(`${HELPER}/lock/${ON === '1' ? 'pin' : 'clear'}`, { body: '' })
output.locked = response.status === 200
