// Package sshtransport 是手机端的 SSH：经 gomobile 打包给安卓和 iOS 的原生模块用。
// 手机上没有系统 ssh，连接、主机指纹校验、密钥都在这里。远端怎么走（探测、启动、代理）和桌面端一样，
// 由界面那头生成脚本交过来（apps/mobile/src/core/script.ts），这里只负责把脚本送过去、把输出拿回来。
package sshtransport

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

// Target 是一台远程机器怎么连。界面传 JSON 进来
type Target struct {
	Host            string `json:"host"`
	Port            int    `json:"port"`
	User            string `json:"user"`
	PrivateKey      string `json:"privateKey"`
	Passphrase      string `json:"passphrase"`
	HostFingerprint string `json:"hostFingerprint"`
	// 扫码绑定时的一次性钥匙：ed25519 私钥的 32 字节种子（base64url 无填充）。给了就用它，不看 PrivateKey
	Seed string `json:"seed"`
	// 只协商这一种主机钥匙（二维码里的类型，例如 ssh-ed25519）。空的就按 x/crypto 的默认
	HostKeyType string `json:"hostKeyType"`
	// 每个会话上设的环境变量。只有对面的 sshd 放行（AcceptEnv）的才生效；测试夹具靠它区分情形
	Env map[string]string `json:"env"`
	// 扫码绑定的 Tailscale 方式：登进去后执行的登记命令（二维码里的 c）。空的就是一次性钥匙方式，对面是强制命令
	EnrollCommand string `json:"enrollCommand"`
}

func parseTarget(encoded string) (Target, error) {
	var target Target
	if err := json.Unmarshal([]byte(encoded), &target); err != nil {
		return target, fmt.Errorf("连接配置不是合法的 JSON: %w", err)
	}
	target.Host = strings.TrimSpace(target.Host)
	target.User = strings.TrimSpace(target.User)
	if target.Port == 0 {
		target.Port = 22
	}
	return target, nil
}

type hostDescription struct {
	// SHA256:… 的写法，和 ssh-keygen -l -E sha256 给的一样
	Fingerprint string `json:"fingerprint"`
	// 主机钥匙的算法，例如 ssh-ed25519
	KeyType string `json:"keyType"`
}

// ProbeHost 只读主机指纹，不认证（返回 JSON：hostDescription）。第一次连之前、指纹变了之后给人确认用
func ProbeHost(host string, port int, user string) (string, error) {
	address, err := sshAddress(host, port)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(user) == "" {
		return "", kindf(kindInvalid, "SSH 用户不能为空")
	}
	var found *hostDescription
	config := &ssh.ClientConfig{
		User: strings.TrimSpace(user),
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			found = &hostDescription{Fingerprint: ssh.FingerprintSHA256(key), KeyType: key.Type()}
			// 读到就够了：拒掉，不往下认证
			return errors.New("只读指纹")
		},
	}
	connection, err := (&net.Dialer{Timeout: 10 * time.Second}).Dial("tcp", address)
	if err != nil {
		return "", kindf(kindUnreachable, "连接 SSH 主机: %w", err)
	}
	defer func() { _ = connection.Close() }()
	_ = connection.SetDeadline(time.Now().Add(10 * time.Second))
	clientConnection, _, _, handshakeErr := ssh.NewClientConn(connection, address, config)
	if clientConnection != nil {
		_ = clientConnection.Close()
	}
	if found != nil {
		return marshalJSON(found)
	}
	return "", kindf(kindUnreachable, "读取 SSH 主机指纹: %w", handshakeErr)
}

func connectSSH(ctx context.Context, target Target) (*ssh.Client, error) {
	attempt, finish, err := beginSSH(ctx)
	if err != nil {
		return nil, err
	}
	ctx = attempt
	handedOff := false
	defer func() {
		if !handedOff {
			finish()
		}
	}()
	address, err := sshAddress(target.Host, target.Port)
	if err != nil {
		return nil, err
	}
	if target.User == "" {
		return nil, kindf(kindInvalid, "SSH 用户不能为空")
	}
	expected := strings.TrimSpace(target.HostFingerprint)
	if expected == "" {
		return nil, kindf(kindHostKeyUnknown, "尚未确认 SSH 主机 SHA-256 指纹")
	}
	var signer ssh.Signer
	if target.Seed != "" {
		signer, err = seedSigner(target.Seed)
	} else {
		signer, err = parseSigner(target.PrivateKey, target.Passphrase)
	}
	if err != nil {
		return nil, err
	}
	config := &ssh.ClientConfig{
		User:            target.User,
		Auth:            []ssh.AuthMethod{ssh.PublicKeys(signer)},
		HostKeyCallback: pinnedHostKeyCallback(expected),
		// Tailscale SSH 的 ACL 是 check 模式时，tailscaled 在登录阶段发一句带链接的横幅、等人去浏览器里点。
		// 不干等：带着链接退出来，界面让人点开、验完重试（验过之后一段时间内不再要求）
		BannerCallback: func(message string) error {
			if url := tailscaleVerifyURL(message); url != "" {
				return &verifyError{url: url}
			}
			return nil
		},
	}
	if target.HostKeyType != "" {
		algorithms, err := hostKeyAlgorithms(target.HostKeyType)
		if err != nil {
			return nil, err
		}
		config.HostKeyAlgorithms = algorithms
	}
	connection, err := (&net.Dialer{Timeout: 12 * time.Second}).DialContext(ctx, "tcp", address)
	if err != nil {
		return nil, kindf(kindUnreachable, "连接 SSH 主机: %w", err)
	}
	// DialContext 只管拨号；后台到期还要能取消已拨通但卡在握手里的连接。
	stopCancel := context.AfterFunc(ctx, func() { _ = connection.Close() })
	defer func() {
		if !handedOff {
			stopCancel()
		}
	}()
	_ = connection.SetDeadline(time.Now().Add(15 * time.Second))
	clientConnection, channels, requests, err := ssh.NewClientConn(connection, address, config)
	if err != nil {
		_ = connection.Close()
		var verify *verifyError
		if errors.As(err, &verify) {
			// 种类后面只放链接：界面拿它做一个能点开的按钮
			return nil, kindf(kindVerify, "%s", verify.url)
		}
		return nil, kindf(handshakeKind(err), "SSH 握手失败: %w", err)
	}
	_ = connection.SetDeadline(time.Time{})
	client := ssh.NewClient(clientConnection, channels, requests)
	if ctx.Err() != nil {
		_ = client.Close()
		return nil, kindf(kindUnreachable, "SSH 连接已取消")
	}
	handedOff = true
	go func() {
		_ = client.Wait()
		stopCancel()
		finish()
	}()
	return client, nil
}

// 心跳：多久发一次、等多久没回音就算断了。变量是为了测试能调短
var (
	keepAliveEvery = 15 * time.Second
	keepAliveWait  = 10 * time.Second
)

// keepAlive 定期发一个全局请求：手机网络常常静默断开（切网络、休眠），没有动静就发现不了。
// 发不出去、等不到回音就关掉整条连接，上面的流跟着断，核心照常走重连。lost 收到原因（给界面的详情）
func keepAlive(ctx context.Context, client *ssh.Client, lost func(reason string)) {
	ticker := time.NewTicker(keepAliveEvery)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			done := make(chan error, 1)
			go func() {
				_, _, err := client.SendRequest("keepalive@openssh.com", true, nil)
				done <- err
			}()
			select {
			case err := <-done:
				if err != nil {
					lost(fmt.Sprintf("心跳发不出去: %v", err))
					_ = client.Close()
					return
				}
			case <-time.After(keepAliveWait):
				lost(fmt.Sprintf("心跳 %s 没有回音", keepAliveWait))
				_ = client.Close()
				return
			case <-ctx.Done():
				return
			}
		}
	}
}

func newSession(client *ssh.Client, target Target) (*ssh.Session, error) {
	session, err := client.NewSession()
	if err != nil {
		return nil, err
	}
	for name, value := range target.Env {
		// 对面不放行时 sshd 会拒绝这一项，不算错
		_ = session.Setenv(name, value)
	}
	return session, nil
}

// pinnedHostKeyCallback 只认记下的那一个指纹。常量时间比较：比较花的时间不透露对上了几个字
func pinnedHostKeyCallback(expected string) ssh.HostKeyCallback {
	return func(_ string, _ net.Addr, key ssh.PublicKey) error {
		actual := ssh.FingerprintSHA256(key)
		if subtle.ConstantTimeCompare([]byte(actual), []byte(expected)) != 1 {
			return &hostKeyChangedError{expected: expected, actual: actual}
		}
		return nil
	}
}

// hostKeyAlgorithms 把主机钥匙的类型换成握手时要协商的算法。RSA 钥匙的类型叫 ssh-rsa，
// 签名算法却有三种：新版 sshd 默认不再接受 SHA-1 的 ssh-rsa，所以只给 SHA-2 的两种
func hostKeyAlgorithms(keyType string) ([]string, error) {
	switch keyType {
	case ssh.KeyAlgoED25519, ssh.KeyAlgoECDSA256, ssh.KeyAlgoECDSA384, ssh.KeyAlgoECDSA521:
		return []string{keyType}, nil
	case ssh.KeyAlgoRSA:
		return []string{ssh.KeyAlgoRSASHA512, ssh.KeyAlgoRSASHA256}, nil
	}
	return nil, kindf(kindInvalid, "不支持的主机钥匙类型: %s", keyType)
}

func sshAddress(host string, port int) (string, error) {
	host = strings.TrimSpace(host)
	if host == "" || port < 1 || port > 65535 {
		return "", kindf(kindInvalid, "SSH Host 或 Port 无效")
	}
	return net.JoinHostPort(host, strconv.Itoa(port)), nil
}
