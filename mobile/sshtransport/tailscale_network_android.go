package sshtransport

import "tailscale.com/net/netmon"

// Android 不允许读取系统路由表；默认接口必须由 ConnectivityManager 提供。
func SetTailscaleDefaultRouteInterface(name string) {
	netmon.UpdateLastKnownDefaultRouteInterface(name)
}
