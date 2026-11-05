package sshtransport

import (
	"context"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"tailscale.com/envknob"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/logtail"
	"tailscale.com/tsnet"
)

const defaultTailControl = "https://controlplane.tailscale.com"

type tailStatus struct {
	State      string `json:"state"`
	Hostname   string `json:"hostname"`
	Tailnet    string `json:"tailnet"`
	AuthURL    string `json:"authURL"`
	ControlURL string `json:"controlURL"`
}

var tailNode = struct {
	sync.Mutex
	dir, hostname  string
	storage        TailscaleStorage
	store          *tailStore
	server         *tsnet.Server
	lifetime       context.Context
	cancel         context.CancelFunc
	paused, resume bool
	loginUntil     time.Time
	loginTimer     *time.Timer
}{}

// TailscaleInitialize 仅加载原生加密存储，不联网。进程中只初始化一次；目录必须为应用私有目录。
func TailscaleInitialize(directory, hostname string, storage TailscaleStorage) error {
	tailNode.Lock()
	defer tailNode.Unlock()
	if storage == nil || !filepath.IsAbs(directory) || strings.TrimSpace(hostname) == "" {
		return fmt.Errorf("[tailscaleUnavailable] 缺少原生存储、目录或节点名")
	}
	if tailNode.storage != nil {
		return fmt.Errorf("[tailscaleUnavailable] Tailscale 已初始化")
	}
	envknob.SetNoLogsNoSupport()
	// tsnet 自建 Logger，不经过读取环境开关的 logpolicy.New；同时使用进程级禁用闸门。
	logtail.Disable()
	// 先记下原生存储，即使解密失败，也允许用户通过 Clear 恢复。
	tailNode.storage, tailNode.dir, tailNode.hostname = storage, directory, hostname
	store, err := newTailStore(storage)
	tailNode.store = store
	// 冷启动同样要恢复已启用的身份，不能只认本进程里的后台暂停标记。
	tailNode.resume = err == nil && store.enabled()
	return err
}

func tailControl(value string) (string, error) {
	if strings.TrimSpace(value) == "" {
		return defaultTailControl, nil
	}
	u, err := url.Parse(strings.TrimSpace(value))
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("[tailscaleControl] 控制服务器必须是 HTTPS 地址，不得含凭据、查询或片段")
	}
	return strings.TrimRight(u.String(), "/"), nil
}

func startTailLocked() error {
	if tailNode.storage == nil {
		return fmt.Errorf("[tailscaleUnavailable] 此平台暂不支持 Tailscale")
	}
	if tailNode.store == nil {
		return fmt.Errorf("[tailscaleStorage] 无法读取加密状态，请清除状态后登录")
	}
	if tailNode.paused {
		return fmt.Errorf("[tailscalePaused] 后台连接已暂停")
	}
	if tailNode.server != nil {
		return nil
	}
	if tailNode.store.control() == "" || !tailNode.store.enabled() {
		return fmt.Errorf("[tailscaleLogin] 请先在 Tailscale 设置中登录")
	}
	// Android 没有 HOME/可写工作目录；即使禁用上报，sockstat 初始化仍会调用 LogsDir。
	// 必须在创建后端前提供存在的私有路径，否则上游会 panic。不要改进程 HOME。
	logs := filepath.Join(tailNode.dir, "logs")
	if err := os.MkdirAll(logs, 0700); err != nil {
		return fmt.Errorf("[tailscaleStorage] 创建私有日志目录: %w", err)
	}
	if err := os.Setenv("TS_LOGS_DIR", logs); err != nil {
		return err
	}
	s := &tsnet.Server{Dir: tailNode.dir, Hostname: tailNode.hostname, Store: tailNode.store, ControlURL: tailNode.store.control(),
		Logf: func(string, ...any) {}, UserLogf: func(string, ...any) {}}
	if err := s.Start(); err != nil {
		_ = s.Close()
		return fmt.Errorf("[tailscaleStart] 启动 Tailscale 失败: %w", err)
	}
	tailNode.server = s
	tailNode.resume = false
	tailNode.lifetime, tailNode.cancel = context.WithCancel(context.Background())
	return nil
}

// TailscaleLogin 返回状态 JSON；authURL 可能稍后才出现，界面继续查询状态。不会等待用户完成登录。
func TailscaleLogin(controlURL string) (string, error) {
	control, err := tailControl(controlURL)
	if err != nil {
		return "", err
	}
	tailNode.Lock()
	defer tailNode.Unlock()
	if tailNode.store == nil {
		return "", fmt.Errorf("[tailscaleStorage] 原生安全存储不可用，请清除状态后重试")
	}
	if err := tailNode.store.setControl(control); err != nil {
		return "", err
	}
	// tsnet.Start 自己会发起交互认证，首次启动不能再次调用并替换尚未返回的 URL。
	existing := tailNode.server != nil
	if err := startTailLocked(); err != nil {
		return "", err
	}
	lc, err := tailNode.server.LocalClient()
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	st, err := lc.Status(ctx)
	if err != nil {
		return "", err
	}
	if st.BackendState == "Stopped" {
		return "", fmt.Errorf("[tailscaleLogin] 节点已停止，请清除状态后重新登录")
	}
	if existing && st.BackendState == "NeedsLogin" && st.AuthURL == "" {
		if err := lc.StartLoginInteractive(ctx); err != nil {
			return "", err
		}
	}
	if st.BackendState != "Running" && st.BackendState != "NeedsMachineAuth" {
		protectTailLoginLocked()
	}
	return statusTailLocked()
}

// 系统浏览器认证需要离开应用。只延长节点本身的寿命，SSH 仍遵守后台断开策略。
// 设上限避免用户放弃登录后留下常驻节点；系统杀进程仍由持久化身份恢复。
func protectTailLoginLocked() {
	tailNode.loginUntil = time.Now().Add(10 * time.Minute)
	if tailNode.loginTimer != nil {
		tailNode.loginTimer.Stop()
	}
	tailNode.loginTimer = time.AfterFunc(10*time.Minute, func() {
		tailNode.Lock()
		defer tailNode.Unlock()
		if tailNode.paused && !time.Now().Before(tailNode.loginUntil) {
			tailNode.resume = tailNode.server != nil
			_ = stopTailLocked()
		}
	})
}

func statusTailLocked() (string, error) {
	st := tailStatus{State: "stopped", Hostname: tailNode.hostname, ControlURL: defaultTailControl}
	if tailNode.store != nil && tailNode.store.control() != "" {
		st.ControlURL = tailNode.store.control()
	}
	if tailNode.paused {
		st.State = "suspended"
	}
	if tailNode.server != nil {
		lc, err := tailNode.server.LocalClient()
		if err != nil {
			return "", err
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		s, err := lc.Status(ctx)
		if err != nil {
			return "", err
		}
		st.State = map[string]string{"Running": "connected", "NeedsLogin": "needsLogin", "NeedsMachineAuth": "needsApproval", "Starting": "starting", "Stopped": "stopped"}[s.BackendState]
		if st.State == "" {
			st.State = "starting"
		}
		// 只把 HTTPS 登录地址交给浏览器。
		if u, err := url.Parse(s.AuthURL); err == nil && u.Scheme == "https" && u.Host != "" && u.User == nil {
			st.AuthURL = u.String()
		}
		if s.BackendState == "Running" || s.BackendState == "NeedsMachineAuth" {
			tailNode.loginUntil = time.Time{}
			if tailNode.loginTimer != nil && !tailNode.paused {
				tailNode.loginTimer.Stop()
			}
		}
		if s.Self != nil && s.Self.HostName != "" && s.CurrentTailnet != nil {
			st.Hostname = s.Self.HostName
		}
		if s.CurrentTailnet != nil {
			st.Tailnet = s.CurrentTailnet.Name
		}
	}
	return marshalJSON(st)
}

func TailscaleStatus() (string, error) {
	tailNode.Lock()
	defer tailNode.Unlock()
	if tailNode.storage == nil {
		return "", fmt.Errorf("[tailscaleUnavailable] 此平台暂不支持 Tailscale")
	}
	if tailNode.store == nil {
		return "", fmt.Errorf("[tailscaleStorage] 加密状态不可用，请清除状态")
	}
	if tailNode.resume && !tailNode.paused {
		if err := startTailLocked(); err != nil {
			return "", err
		}
	}
	return statusTailLocked()
}

func stopTailLocked() error {
	tailNode.loginUntil = time.Time{}
	if tailNode.loginTimer != nil {
		tailNode.loginTimer.Stop()
		tailNode.loginTimer = nil
	}
	if tailNode.cancel != nil {
		tailNode.cancel()
		tailNode.cancel = nil
	}
	s := tailNode.server
	tailNode.server = nil
	if s != nil {
		return s.Close()
	}
	return nil
}

func TailscaleStop() error {
	tailNode.Lock()
	defer tailNode.Unlock()
	tailNode.resume = false
	return stopTailLocked()
}

func TailscaleLogout() error {
	tailNode.Lock()
	defer tailNode.Unlock()
	if err := startTailLocked(); err != nil {
		return err
	}
	defer stopTailLocked()
	tailNode.resume = false
	if err := tailNode.store.disable(); err != nil {
		return err
	}
	lc, err := tailNode.server.LocalClient()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := lc.Logout(ctx); err != nil {
		return err
	}
	return nil
}

func TailscaleClear() error {
	tailNode.Lock()
	defer tailNode.Unlock()
	tailNode.resume = false
	if err := stopTailLocked(); err != nil {
		return err
	}
	if tailNode.storage == nil {
		return fmt.Errorf("[tailscaleUnavailable] 原生存储不可用")
	}
	tailNode.store = nil
	// 先删目录，再删密钥，避免删除失败后继续使用残留数据。
	if err := os.RemoveAll(tailNode.dir); err != nil {
		return err
	}
	if err := tailNode.storage.Clear(); err != nil {
		return err
	}
	store, err := newTailStore(tailNode.storage)
	tailNode.store = store
	return err
}

func pauseTailscale(paused bool) {
	tailNode.Lock()
	defer tailNode.Unlock()
	tailNode.paused = paused
	if paused {
		tailNode.resume = tailNode.server != nil
		if !time.Now().Before(tailNode.loginUntil) {
			_ = stopTailLocked()
		}
	} else if tailNode.resume {
		// 回到前台后由下一次 SSH 拨号或状态查询恢复，避免无界面的空闲常驻节点。
	}
}

// 只解析 peer/self 的网络图，永不把未知主机交给系统 DNS 或公网直连。
func tailAddress(host string, port int, status *ipnstate.Status) (string, error) {
	if ip, err := netip.ParseAddr(host); err == nil {
		if netip.MustParsePrefix("100.64.0.0/10").Contains(ip) || netip.MustParsePrefix("fd7a:115c:a1e0::/48").Contains(ip) {
			return net.JoinHostPort(ip.String(), fmt.Sprint(port)), nil
		}
		return "", fmt.Errorf("[tailscaleAddress] 地址不在 Tailscale 网络内")
	}
	name := strings.TrimSuffix(strings.ToLower(host), ".")
	peers := []*ipnstate.PeerStatus{status.Self}
	for _, p := range status.Peer {
		peers = append(peers, p)
	}
	var found string
	for _, p := range peers {
		if p == nil || len(p.TailscaleIPs) == 0 {
			continue
		}
		dns := strings.TrimSuffix(strings.ToLower(p.DNSName), ".")
		if name == strings.ToLower(p.HostName) || (dns != "" && (name == dns || name == strings.SplitN(dns, ".", 2)[0])) {
			address := net.JoinHostPort(p.TailscaleIPs[0].String(), fmt.Sprint(port))
			if found != "" && found != address {
				return "", fmt.Errorf("[tailscaleAddress] 节点名称不唯一，请使用完整 MagicDNS 名")
			}
			found = address
		}
	}
	if found == "" {
		return "", fmt.Errorf("[tailscaleAddress] 未找到 tailnet 节点，请使用 MagicDNS 名或 tailnet IP")
	}
	return found, nil
}

func dialTailscale(ctx context.Context, host string, port int) (net.Conn, error) {
	tailNode.Lock()
	if err := startTailLocked(); err != nil {
		tailNode.Unlock()
		return nil, err
	}
	s, lifetime := tailNode.server, tailNode.lifetime
	tailNode.Unlock()
	lc, err := s.LocalClient()
	if err != nil {
		return nil, err
	}
	var status *ipnstate.Status
	for {
		status, err = lc.Status(ctx)
		if err != nil {
			return nil, fmt.Errorf("[tailscaleConnecting] 无法读取节点状态: %w", err)
		}
		if status.BackendState == "Running" {
			break
		}
		if err := tailStateError(status.BackendState); err != nil {
			return nil, err
		}
		select {
		case <-ctx.Done():
			return nil, fmt.Errorf("[tailscaleConnecting] 节点尚未就绪: %w", ctx.Err())
		case <-time.After(100 * time.Millisecond):
		}
	}
	address, err := tailAddress(host, port, status)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(lifetime, cancel)
	defer func() { stop(); cancel() }()
	// 官方 Server.Dial 在 peer map 变化或 IP 不属于节点时会回退系统拨号。
	// 固定版本的 tsnet netstack 拨号器保证通道始终在本节点里，不接触系统 TCP 路由。
	connection, err := s.Sys().Dialer.Get().NetstackDialTCP(ctx, netip.MustParseAddrPort(address))
	if err != nil {
		return nil, fmt.Errorf("[tailscaleConnect] 无法通过 Tailscale 连接 SSH: %w", err)
	}
	wrapped := &tailConnection{Conn: connection}
	wrapped.stop = context.AfterFunc(lifetime, func() { _ = connection.Close() })
	return wrapped, nil
}

func tailStateError(state string) error {
	switch state {
	case "NeedsMachineAuth":
		return fmt.Errorf("[tailscaleApproval] 请在 Tailscale 管理台批准此设备")
	case "NeedsLogin", "Stopped":
		return fmt.Errorf("[tailscaleLogin] 请先在 Tailscale 设置中登录")
	default:
		return nil
	}
}

type tailConnection struct {
	net.Conn
	stop func() bool
}

func (c *tailConnection) Close() error { c.stop(); return c.Conn.Close() }

func dialSSH(ctx context.Context, host string, port int, mode string) (net.Conn, error) {
	address, err := sshAddress(host, port)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	viaTail, err := selectTailRoute(ctx, host, port, mode)
	if err != nil {
		return nil, err
	}
	rememberRoute(host, port, mode, viaTail)
	if viaTail {
		return dialTailscale(ctx, host, port)
	}
	connection, err := (&net.Dialer{}).DialContext(ctx, "tcp", address)
	if err != nil && mode != "never" && obviousTailAddress(host) {
		return nil, fmt.Errorf("[tailscaleAutoLogin] 系统网络无法连接此 tailnet 地址，请登录内置 Tailscale: %w", err)
	}
	if err == nil && mode != "never" && obviousTailAddress(host) {
		return &systemTailConnection{Conn: connection}, nil
	}
	return connection, err
}

// 部分系统 VPN 在目标不可达时也先接受 TCP，再让 SSH 握手超时；提示不能只覆盖 Dial 错误。
type systemTailConnection struct{ net.Conn }

func systemTailFailure(connection net.Conn, kind string, err error) error {
	if _, ok := connection.(*systemTailConnection); ok && kind == kindUnreachable {
		return fmt.Errorf("[tailscaleAutoLogin] 系统网络无法连接此 tailnet 地址，请登录内置 Tailscale: %w", err)
	}
	return err
}
