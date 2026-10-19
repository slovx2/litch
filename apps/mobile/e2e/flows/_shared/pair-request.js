// 手机登记上来之后设备服务给出码一方的那条请求（litch/pair/wait）里的确认码；手机上显示成“123 456”
const response = http.get(`${HELPER}/pair/request`)
const request = response.status === 200 ? json(response.body) : null
output.code = request ? `${request.code.slice(0, 3)} ${request.code.slice(3)}` : 'none'
