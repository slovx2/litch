// 手机登记上来之后，假的 pair-enroll 记下的确认码（电脑上显示的那个）；手机上显示成“123 456”
const response = http.get(`${HELPER}/pair/request`)
const request = response.status === 200 ? json(response.body) : null
output.code = request ? `${request.code.slice(0, 3)} ${request.code.slice(3)}` : 'none'
