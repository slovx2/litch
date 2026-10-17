package sshtransport

import (
	"bufio"
	"bytes"
	"io"
	"net"
	"net/http"
	"strings"
)

// readLegalUpgrade 读本机连上来的那条 HTTP 升级请求。路径必须带着这条流的随机令牌：
// 同一台手机上的别的应用也能连回环地址，没有令牌的一律不接
func readLegalUpgrade(connection net.Conn, expectedPath string) ([]byte, bool) {
	const maximumHeader = 32 * 1024
	header := make([]byte, 0, 1024)
	one := []byte{0}
	for len(header) < maximumHeader {
		if _, err := io.ReadFull(connection, one); err != nil {
			return nil, false
		}
		header = append(header, one[0])
		if len(header) >= 4 && bytes.Equal(header[len(header)-4:], []byte("\r\n\r\n")) {
			break
		}
	}
	if len(header) < 4 || len(header) >= maximumHeader {
		return nil, false
	}
	request, err := http.ReadRequest(bufio.NewReader(bytes.NewReader(header)))
	if err != nil {
		return nil, false
	}
	_ = request.Body.Close()
	return header, request.Method == http.MethodGet && request.URL.Path == expectedPath &&
		headerHasToken(request.Header.Get("Connection"), "upgrade") &&
		strings.EqualFold(request.Header.Get("Upgrade"), "websocket") &&
		request.Header.Get("Sec-WebSocket-Key") != "" &&
		request.Header.Get("Sec-WebSocket-Version") == "13"
}

func headerHasToken(value, token string) bool {
	for _, item := range strings.Split(value, ",") {
		if strings.EqualFold(strings.TrimSpace(item), token) {
			return true
		}
	}
	return false
}

// rewriteUpgrade 把请求改成设备服务认的样子：路径换成 /（令牌只给本机这一段用），
// 去掉压缩扩展的声明（安卓的 OkHttp 总会要 permessage-deflate，桌面端也是关着它连的）。
// 101 之后的帧原样转发
func rewriteUpgrade(header []byte) []byte {
	lines := bytes.Split(header, []byte("\r\n"))
	filtered := make([][]byte, 0, len(lines))
	for index, line := range lines {
		if index == 0 {
			parts := bytes.SplitN(line, []byte(" "), 3)
			if len(parts) == 3 {
				line = bytes.Join([][]byte{parts[0], []byte("/"), parts[2]}, []byte(" "))
			}
			filtered = append(filtered, line)
			continue
		}
		name, _, found := bytes.Cut(line, []byte(":"))
		if found && strings.EqualFold(strings.TrimSpace(string(name)), "Sec-WebSocket-Extensions") {
			continue
		}
		filtered = append(filtered, line)
	}
	return bytes.Join(filtered, []byte("\r\n"))
}
