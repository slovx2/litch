// 本地 HTTPS 控制面、DERP 和 netstack SSH 转发器；不是发布物的一部分。
package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"tailscale.com/derp/derpserver"
	"tailscale.com/envknob"
	"tailscale.com/logtail"
	"tailscale.com/net/netns"
	"tailscale.com/tailcfg"
	"tailscale.com/tsnet"
	"tailscale.com/tstest/integration/testcontrol"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	// 不继承运行者的代理或任何 Tailscale 登录凭据。
	for _, name := range []string{"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "TS_AUTHKEY", "TS_CLIENT_SECRET", "TS_CLIENT_ID", "TS_ID_TOKEN", "TS_AUDIENCE"} {
		if err := os.Unsetenv(name); err != nil {
			return err
		}
	}
	listen := flag.String("listen", "127.0.0.1", "监听 IP；Android 可用 0.0.0.0")
	advertise := flag.String("advertise", "127.0.0.1", "模拟器访问宿主的地址；Android 用 10.0.2.2")
	ca := flag.String("ca", "", "可选临时 CA PEM，必须同时指定 ca-key")
	caKey := flag.String("ca-key", "", "可选临时 ECDSA CA 的 PKCS8 PEM")
	sshAddress := flag.String("ssh", "", "已有隔离 sshd 的回环地址，如 127.0.0.1:59516")
	output := flag.String("out", "", "输出配置文件，含临时 CA 路径")
	flag.Parse()
	host, _, err := net.SplitHostPort(*sshAddress)
	if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
		return fmt.Errorf("ssh 必须指向隔离 sshd 的回环地址")
	}
	if *output == "" {
		return fmt.Errorf("需要 out 配置路径")
	}
	directory, err := os.MkdirTemp("", "litch-tailnet-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(directory)
	defer os.Remove(*output)
	if err = os.Setenv("TS_LOGS_DIR", directory); err != nil {
		return err
	}
	envknob.SetNoLogsNoSupport()
	logtail.Disable()
	netns.SetEnabled(false)
	certificate, caPath, err := certificates(directory, *advertise, *ca, *caKey)
	if err != nil {
		return err
	}
	derp := derpserver.New(key.NewNode(), logger.Discard)
	defer derp.Close()
	relay, err := net.Listen("tcp", net.JoinHostPort(*listen, "0"))
	if err != nil {
		return err
	}
	defer relay.Close()
	relayHTTP := &http.Server{Handler: derpserver.Handler(derp), ReadHeaderTimeout: 10 * time.Second,
		TLSNextProto: map[string]func(*http.Server, *tls.Conn, http.Handler){}}
	defer relayHTTP.Close()
	go relayHTTP.Serve(tls.NewListener(relay, &tls.Config{Certificates: []tls.Certificate{certificate}, MinVersion: tls.VersionTLS12}))
	// 同一个区域提供回环和模拟器宿主入口；宿主侧节点与 Android 各用可达的入口。
	nodes := []*tailcfg.DERPNode{}
	addresses := []string{"127.0.0.1"}
	if *advertise != "127.0.0.1" {
		addresses = append(addresses, *advertise)
	}
	for i, address := range addresses {
		nodes = append(nodes, &tailcfg.DERPNode{Name: fmt.Sprintf("local%d", i), RegionID: 1, HostName: address,
			IPv4: address, IPv6: "none", DERPPort: relay.Addr().(*net.TCPAddr).Port, STUNPort: -1, InsecureForTests: true})
	}
	control := &testcontrol.Server{Logf: logger.Discard, MagicDNSDomain: "litch.test",
		DNSConfig: &tailcfg.DNSConfig{Proxied: true},
		DERPMap:   &tailcfg.DERPMap{Regions: map[tailcfg.DERPRegionID]*tailcfg.DERPRegion{1: {RegionID: 1, RegionCode: "local", Nodes: nodes}}}}
	external, err := net.Listen("tcp", net.JoinHostPort(*listen, "0"))
	if err != nil {
		return err
	}
	defer external.Close()
	controlURL := "https://" + net.JoinHostPort(*advertise, fmt.Sprint(external.Addr().(*net.TCPAddr).Port))
	control.ExplicitBaseURL = controlURL
	externalHTTP := &http.Server{Handler: control, ReadHeaderTimeout: 10 * time.Second}
	defer externalHTTP.Close()
	go externalHTTP.Serve(tls.NewListener(external, &tls.Config{Certificates: []tls.Certificate{certificate}, MinVersion: tls.VersionTLS12}))
	// 宿主节点只走回环 HTTP，避免把临时 CA 装进用户电脑的信任库。
	local := httptest.NewServer(control)
	defer local.Close()
	server := &tsnet.Server{Dir: filepath.Join(directory, "server"), Hostname: "server", ControlURL: local.URL,
		Logf: logger.Discard, UserLogf: logger.Discard}
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if _, err = server.Up(ctx); err != nil {
		return err
	}
	listener, err := server.Listen("tcp", ":2222")
	if err != nil {
		return err
	}
	defer listener.Close()
	go func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer connection.Close()
				local, err := net.DialTimeout("tcp", *sshAddress, 5*time.Second)
				if err != nil {
					return
				}
				defer local.Close()
				go func() { _, _ = io.Copy(local, connection); _ = local.Close() }()
				_, _ = io.Copy(connection, local)
			}()
		}
	}()
	config, err := json.Marshal(map[string]any{"controlURL": controlURL, "ca": caPath, "host": "server.litch.test", "port": 2222})
	if err != nil {
		return err
	}
	if err = os.WriteFile(*output, config, 0600); err != nil {
		return err
	}
	fmt.Printf("隔离 tailnet 已就绪，配置：%s\n", *output)
	stopped := make(chan os.Signal, 1)
	signal.Notify(stopped, syscall.SIGTERM, syscall.SIGINT)
	defer signal.Stop(stopped)
	<-stopped
	return nil
}
