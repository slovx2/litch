//go:build darwin && !ios

package sshtransport

import (
	"net"
	"os"
	"os/exec"
	"syscall"
	"testing"

	"golang.org/x/sys/unix"
	"tailscale.com/net/netmon"
	"tailscale.com/net/netns"
	"tailscale.com/types/logger"
)

// 只修改进程内 netmon 提示和 socket 选项；不建 utun、不改系统路由、不向目标发包。
func TestTailIOSUsesSystemRouting(t *testing.T) {
	if os.Getenv("LITCH_TEST_IOS_ROUTING_CHILD") != "1" {
		child := exec.Command(os.Args[0], "-test.run=^TestTailIOSUsesSystemRouting$", "-test.v")
		child.Env = append(os.Environ(), "LITCH_TEST_IOS_ROUTING_CHILD=1")
		output, err := child.CombinedOutput()
		t.Log(string(output))
		if err != nil {
			t.Fatal(err)
		}
		return
	}
	monitor := netmon.NewStatic()
	defer monitor.Close()
	loopback, err := net.InterfaceByName("lo0")
	if err != nil {
		t.Fatal(err)
	}
	netmon.UpdateLastKnownDefaultRouteInterface("lo0")
	// 上游没有清空默认接口提示的 API；子进程隔离防止影响其他测试。
	t.Cleanup(func() { netns.SetEnabled(true) })
	for _, tc := range []struct {
		name, network, address      string
		family, kind, proto, option int
	}{
		{"control-fake-ip", "tcp4", "198.18.0.1:443", unix.AF_INET, unix.SOCK_STREAM, unix.IPPROTO_IP, unix.IP_BOUND_IF},
		{"derp-fake-ip", "tcp4", "198.19.0.1:443", unix.AF_INET, unix.SOCK_STREAM, unix.IPPROTO_IP, unix.IP_BOUND_IF},
		{"udp4", "udp4", "0.0.0.0:0", unix.AF_INET, unix.SOCK_DGRAM, unix.IPPROTO_IP, unix.IP_BOUND_IF},
		{"tcp6", "tcp6", "[2001:db8::1]:443", unix.AF_INET6, unix.SOCK_STREAM, unix.IPPROTO_IPV6, unix.IPV6_BOUND_IF},
		{"udp6", "udp6", "[::]:0", unix.AF_INET6, unix.SOCK_DGRAM, unix.IPPROTO_IPV6, unix.IPV6_BOUND_IF},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, platform := range []string{"darwin", "android", "ios"} {
				netns.SetEnabled(true)
				configureTailNetwork(platform)
				// 模拟 ipnlocal 收到普通网络图时重置调试能力位，修复必须继续生效。
				netns.SetDisableBindConnToInterface(logger.Discard, false)
				fd, err := unix.Socket(tc.family, tc.kind, 0)
				if err != nil {
					t.Fatal(err)
				}
				defer unix.Close(fd)
				var control func(string, string, syscall.RawConn) error
				if tc.kind == unix.SOCK_DGRAM {
					control = netns.Listener(logger.Discard, monitor).Control
				} else {
					dialer := &net.Dialer{}
					netns.FromDialer(logger.Discard, monitor, dialer)
					control = dialer.Control
				}
				if control != nil {
					if err := control(tc.network, tc.address, tailTestRawConn(fd)); err != nil {
						t.Fatal(err)
					}
				}
				bound, err := unix.GetsockoptInt(fd, tc.proto, tc.option)
				if err != nil {
					t.Fatal(err)
				}
				want := loopback.Index
				if platform == "ios" {
					want = 0
				}
				if bound != want {
					t.Fatalf("%s: bound interface=%d, want %d", platform, bound, want)
				}
				t.Logf("%s: bound interface=%d", platform, bound)
			}
		})
	}
}

type tailTestRawConn int

func (c tailTestRawConn) Control(f func(uintptr)) error  { f(uintptr(c)); return nil }
func (c tailTestRawConn) Read(func(uintptr) bool) error  { panic("不进行网络读取") }
func (c tailTestRawConn) Write(func(uintptr) bool) error { panic("不进行网络写入") }
