// 演“电脑上点了允许”
const response = http.post(`${HELPER}/pair/allow`, { body: '' })
output.allowed = response.status === 200
