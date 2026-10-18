package main

// machine 子命令和设备进程说话的那一段：直接连聚合面的套接字（device.sock），在上面说 WebSocket 加 JSON-RPC，
// 和 Litch 经 device-proxy 连进来时线上一样。只调 clientTools 扩展里给命令行的两个方法（litch/clientTool/invoke、
// litch/clientTool/desktops），这两个不用握手（protocol/extensions/client-tools.json），所以不发 initialize：
// 握手要设备进程替这条连接连一遍每个 harness 的运行时。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/slovx2/litch/internal/hostplatform"
)

const (
	clientToolInvokeMethod   = "litch/clientTool/invoke"
	clientToolDesktopsMethod = "litch/clientTool/desktops"
)

// 设备进程回的 JSON-RPC 错误（参数不对、执行方回了错误）
type deviceRPCError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *deviceRPCError) Error() string { return e.Message }

// 连不上设备服务（没在运行、套接字不对、握手不成）
type deviceUnreachable struct {
	socket string
	err    error
}

func (e *deviceUnreachable) Error() string {
	return fmt.Sprintf(tr("连不上这台设备上的设备服务（%s）：%v", "cannot reach the device service on this machine (%s): %v"), e.socket, e.err)
}
func (e *deviceUnreachable) Unwrap() error { return e.err }

type deviceRPC struct {
	conn  *websocket.Conn
	write sync.Mutex
	next  int
}

// dialDevice 连上聚合面。socket 是 device.sock 的路径（Windows 上是命名管道）。
func dialDevice(ctx context.Context, socket string) (*deviceRPC, error) {
	dialer := websocket.Dialer{
		HandshakeTimeout: 5 * time.Second,
		// 路径不进地址：地址里的路径会被转义（空格、中文），连哪里由这里定，地址只是摆设
		NetDialContext: func(context.Context, string, string) (net.Conn, error) {
			return hostplatform.Dial(socket)
		},
	}
	conn, response, err := dialer.DialContext(ctx, "ws://localhost/", nil)
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	if err != nil {
		return nil, &deviceUnreachable{socket: socket, err: err}
	}
	conn.SetReadLimit(64 << 20)
	return &deviceRPC{conn: conn}, nil
}

func (d *deviceRPC) Close() error { return d.conn.Close() }

// call 发一个请求，等它的应答。ctx 结束（Ctrl-C、超时）时关掉连接：设备进程据此撤回这次调用。
// 对面主动发来的通知、请求一律不理。
func (d *deviceRPC) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	d.next++
	id := d.next
	frame, err := json.Marshal(map[string]any{"id": id, "method": method, "params": params})
	if err != nil {
		return nil, err
	}
	stop := context.AfterFunc(ctx, func() { _ = d.conn.Close() })
	defer stop()
	d.write.Lock()
	err = d.conn.WriteMessage(websocket.TextMessage, frame)
	d.write.Unlock()
	if err != nil {
		return nil, d.lost(ctx, err)
	}
	for {
		_, data, err := d.conn.ReadMessage()
		if err != nil {
			return nil, d.lost(ctx, err)
		}
		var reply struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Result json.RawMessage `json:"result"`
			Error  *deviceRPCError `json:"error"`
		}
		if json.Unmarshal(data, &reply) != nil || reply.Method != "" || string(reply.ID) != fmt.Sprint(id) {
			continue
		}
		if reply.Error != nil {
			return nil, reply.Error
		}
		return reply.Result, nil
	}
}

// 连接在等应答时断了：是自己取消的就报取消，不然是设备服务那头断了
func (d *deviceRPC) lost(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return fmt.Errorf(tr("设备服务断开了连接：%w", "the device service closed the connection: %w"), err)
}

// 设备服务上连着的一台 Litch 桌面端（litch/clientTool/desktops 的一项）
type machineDesktop struct {
	Hostname   string   `json:"hostname"`
	Name       string   `json:"name,omitempty"`
	Namespaces []string `json:"namespaces"`
}

func (m machineDesktop) label() string {
	if m.Name != "" && m.Name != m.Hostname {
		return fmt.Sprintf("%q (%s)", m.Name, m.Hostname)
	}
	return m.Hostname
}

// 问一下现在连着哪些桌面端。连不上、超时都返回错误
func fetchDesktops(ctx context.Context, socket string, timeout time.Duration) ([]machineDesktop, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	rpc, err := dialDevice(ctx, socket)
	if err != nil {
		return nil, err
	}
	defer rpc.Close()
	raw, err := rpc.call(ctx, clientToolDesktopsMethod, map[string]any{})
	if err != nil {
		return nil, err
	}
	var result struct {
		Desktops []machineDesktop `json:"desktops"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, errors.New(tr("设备服务的应答看不懂", "the device service sent an answer this command cannot read"))
	}
	return result.Desktops, nil
}
