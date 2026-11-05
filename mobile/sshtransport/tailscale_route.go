package sshtransport

import (
	"context"
	"fmt"
	"net/netip"
	"strings"
	"sync"
	"time"

	"tailscale.com/ipn/ipnstate"
)

func obviousTailAddress(host string) bool {
	if ip, err := netip.ParseAddr(host); err == nil {
		return netip.MustParsePrefix("100.64.0.0/10").Contains(ip) || netip.MustParsePrefix("fd7a:115c:a1e0::/48").Contains(ip)
	}
	return strings.HasSuffix(strings.TrimSuffix(strings.ToLower(host), "."), ".ts.net")
}

func routeInTailnet(host string, port int, status *ipnstate.Status) bool {
	if status.BackendState != "Running" && status.BackendState != "NeedsMachineAuth" {
		return false
	}
	if obviousTailAddress(host) {
		return true
	}
	_, err := tailAddress(host, port, status)
	return err == nil
}

// 自动模式只在持久化身份启用且当前控制面确认登录后选内嵌节点。
// 一旦选中，就不因超时、ACL 或 SSH 失败回退系统网络。
func selectTailRoute(ctx context.Context, host string, port int, mode string) (bool, error) {
	switch mode {
	case "always":
		return true, nil
	case "never":
		return false, nil
	case "", "auto":
	default:
		return false, fmt.Errorf("[invalid] 未知网络模式")
	}
	tailNode.Lock()
	if tailNode.store == nil || !tailNode.store.enabled() {
		tailNode.Unlock()
		return false, nil
	}
	err := startTailLocked()
	s := tailNode.server
	tailNode.Unlock()
	if err != nil {
		return false, err
	}
	lc, err := s.LocalClient()
	if err != nil {
		return false, err
	}
	for {
		status, err := lc.Status(ctx)
		if err != nil {
			return false, fmt.Errorf("[tailscaleConnecting] 无法确定节点路由: %w", err)
		}
		if status.BackendState != "Starting" && status.BackendState != "NoState" && status.BackendState != "" {
			return routeInTailnet(host, port, status), nil
		}
		select {
		case <-ctx.Done():
			return false, fmt.Errorf("[tailscaleConnecting] 节点正在恢复: %w", ctx.Err())
		case <-time.After(100 * time.Millisecond):
		}
	}
}

var tailRoutes = struct {
	sync.Mutex
	values map[string]string
}{values: make(map[string]string)}

func routeKey(host string, port int, mode string) string {
	if mode == "" {
		mode = "auto"
	}
	return fmt.Sprintf("%s:%d:%s", host, port, mode)
}

func rememberRoute(host string, port int, mode string, embedded bool) {
	tailRoutes.Lock()
	defer tailRoutes.Unlock()
	// 仅供当前进程显示最近拨号路径，限制长期进程的内存占用。
	if len(tailRoutes.values) >= 256 {
		clear(tailRoutes.values)
	}
	route := "system"
	if embedded {
		route = "tailscale"
	}
	tailRoutes.values[routeKey(host, port, mode)] = route
}

// ConnectionRoute 只返回该连接最近实际选用的路径；从未拨号返回空串，不推测系统 VPN。
func ConnectionRoute(host string, port int, mode string) string {
	tailRoutes.Lock()
	defer tailRoutes.Unlock()
	return tailRoutes.values[routeKey(host, port, mode)]
}
