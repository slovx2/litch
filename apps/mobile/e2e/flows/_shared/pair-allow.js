// 演“电脑上点了允许”（litch/pair/decide）
const response = http.post(`${HELPER}/pair/allow`, { body: '' })
output.allowed = response.status === 200
