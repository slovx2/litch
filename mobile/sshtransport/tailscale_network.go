package sshtransport

import (
	"encoding/json"
	"fmt"
	"net"
	"net/netip"
	"sync"

	"tailscale.com/net/netmon"
	"tailscale.com/net/netns"
)

func configureTailNetwork(goos string) {
	if goos == "ios" {
		// 内嵌 tsnet 没有系统 TUN，不需要为防止回环绑定底层物理接口。
		// Darwin 默认会解开 utun 的 delegated interface，绕过其他 VPN 的路由，
		// 使 VPN 提供的 fake-IP 或仅能经 VPN 访问的控制面/DERP 无法连通。
		// 与 tailscaled 的 userspace-networking 模式一致，关闭进程内 netns。
		// 不能只 SetDisableBindConnToInterface：收到网络图后上游会按能力位重置它。
		netns.SetEnabled(false)
	}
}

// Android 通过公开平台 API 提供快照；Go 不再调用受 SELinux 限制的 netlink。
var tailInterfaces struct {
	sync.RWMutex
	once sync.Once
	list []netmon.Interface
}

// Android Network / iOS NWPath 改变时，即使接口地址相同，也必须重建底层 UDP 和 DERP。
// 此接口不启动节点、不更换身份；网络 ID 只留内存，不经过 JS 或持久化。
var tailNetworkIdentity string // 由 tailNode.Mutex 保护。

func TailscaleNetworkChanged(identity string, available bool) {
	tailNode.Lock()
	defer tailNode.Unlock()
	if identity == "" || identity == tailNetworkIdentity {
		return
	}
	tailNetworkIdentity = identity
	if tailNode.server == nil {
		return
	}
	sys := tailNode.server.Sys()
	sys.NetMon.Get().InjectEvent()
	// Android VPN 的接口/IP 可以不变，旧 HTTPS/DERP socket 却已绑定失效的底层网络。
	// 单独 Rebind 在拿不到默认接口 IP 时不会关闭 DERP，因此先显式撤销旧网络。
	sys.MagicSock.Get().SetNetworkUp(false)
	if !available {
		return
	}
	sys.MagicSock.Get().Rebind()
	sys.MagicSock.Get().SetNetworkUp(true)
	sys.MagicSock.Get().ReSTUN("mobile-network-change")
}

// SetTailscaleInterfaces 接收 [{index,name,mtu,up,loopback,pointToPoint,multicast,addresses:[CIDR]}]。
// 必须在首次 TailscaleLogin/拨号前调用；网络变化再次调用。iOS 不需要此接口。
func SetTailscaleInterfaces(encoded string) error {
	var snapshots []struct {
		Index        int      `json:"index"`
		Name         string   `json:"name"`
		MTU          int      `json:"mtu"`
		Up           bool     `json:"up"`
		Loopback     bool     `json:"loopback"`
		PointToPoint bool     `json:"pointToPoint"`
		Multicast    bool     `json:"multicast"`
		Addresses    []string `json:"addresses"`
	}
	if err := json.Unmarshal([]byte(encoded), &snapshots); err != nil {
		return err
	}
	list := make([]netmon.Interface, 0, len(snapshots))
	for _, snapshot := range snapshots {
		if snapshot.Name == "" || snapshot.Index < 1 {
			return fmt.Errorf("无效网络接口")
		}
		it := netmon.Interface{Interface: &net.Interface{Index: snapshot.Index, Name: snapshot.Name, MTU: snapshot.MTU}, AltAddrs: []net.Addr{}}
		if snapshot.Up {
			it.Flags |= net.FlagUp | net.FlagRunning
		}
		if snapshot.Loopback {
			it.Flags |= net.FlagLoopback
		}
		if snapshot.PointToPoint {
			it.Flags |= net.FlagPointToPoint
		}
		if snapshot.Multicast {
			it.Flags |= net.FlagMulticast
		}
		for _, value := range snapshot.Addresses {
			p, err := netip.ParsePrefix(value)
			if err != nil {
				return err
			}
			it.AltAddrs = append(it.AltAddrs, &net.IPNet{IP: p.Addr().AsSlice(), Mask: net.CIDRMask(p.Bits(), p.Addr().BitLen())})
		}
		list = append(list, it)
	}
	tailInterfaces.Lock()
	tailInterfaces.list = list
	tailInterfaces.Unlock()
	tailInterfaces.once.Do(func() {
		netmon.RegisterInterfaceGetter(func() ([]netmon.Interface, error) {
			tailInterfaces.RLock()
			defer tailInterfaces.RUnlock()
			return append([]netmon.Interface{}, tailInterfaces.list...), nil
		})
	})
	// 通知正在运行的节点重新采样，不必等待 Go 轮询器的下一周期。
	tailNode.Lock()
	if tailNode.server != nil {
		tailNode.server.Sys().NetMon.Get().InjectEvent()
	}
	tailNode.Unlock()
	return nil
}
