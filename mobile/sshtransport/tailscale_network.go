package sshtransport

import (
	"encoding/json"
	"fmt"
	"net"
	"net/netip"
	"sync"

	"tailscale.com/net/netmon"
)

// Android 通过公开平台 API 提供快照；Go 不再调用受 SELinux 限制的 netlink。
var tailInterfaces struct {
	sync.RWMutex
	once sync.Once
	list []netmon.Interface
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
