package dev.litch.ssh

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import java.net.NetworkInterface
import org.json.JSONArray
import org.json.JSONObject
import sshtransport.Sshtransport

// 公开 Java API 使用 Android 允许的接口枚举路径，不能换回 Go net.Interfaces/netlink。
class TailscaleNetwork(context: Context) {
  private val connectivity = context.getSystemService(ConnectivityManager::class.java)
  private val callback = object : ConnectivityManager.NetworkCallback() {
    override fun onAvailable(network: Network) { refreshSafely() }
    override fun onLost(network: Network) { refreshSafely() }
    override fun onLinkPropertiesChanged(network: Network, properties: LinkProperties) { refreshSafely() }
    override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) { refreshSafely() }
  }
  private var registered = false

  @Synchronized fun attach() {
    refresh()
    if (!registered) {
      connectivity.registerDefaultNetworkCallback(callback)
      registered = true
    }
  }

  @Synchronized fun refresh() {
    val result = JSONArray()
    NetworkInterface.getNetworkInterfaces()?.toList()?.forEach { network ->
      val addresses = JSONArray()
      network.interfaceAddresses.forEach { address ->
        // IPv6 scope id 不属于 CIDR；只把实际 IP 和 prefix length 传给 Go。
        addresses.put("${address.address.hostAddress?.substringBefore('%')}/${address.networkPrefixLength}")
      }
      result.put(JSONObject().put("index", network.index).put("name", network.name)
        .put("mtu", network.mtu).put("up", network.isUp).put("loopback", network.isLoopback)
        .put("pointToPoint", network.isPointToPoint).put("multicast", network.supportsMulticast())
        .put("addresses", addresses))
    }
    Sshtransport.setTailscaleInterfaces(result.toString())
  }

  private fun refreshSafely() {
    try { refresh() } catch (_: Exception) {
      // 网络切换时接口可能消失；下一次拨号前会同步刷新并向用户报告失败。
    }
  }

  fun detach() {
    if (registered) connectivity.unregisterNetworkCallback(callback)
    registered = false
  }
}
