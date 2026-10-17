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
	// 每个会话上设的环境变量。只有对面的 sshd 放行（AcceptEnv）的才生效；测试夹具靠它区分情形
	Env map[string]string `json:"env"`
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

// ProbeHost 只读主机指纹，不认证。第一次连之前给人确认用
func ProbeHost(host string, port int, user string) (string, error) {
	address, err := sshAddress(host, port)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(user) == "" {
		return "", errors.New("SSH 用户不能为空")
	}
	var fingerprint string
	config := &ssh.ClientConfig{
		User: strings.TrimSpace(user),
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			fingerprint = ssh.FingerprintSHA256(key)
			return nil
		},
	}
	connection, err := (&net.Dialer{Timeout: 10 * time.Second}).Dial("tcp", address)
	if err != nil {
		return "", fmt.Errorf("连接 SSH 主机: %w", err)
	}
	defer func() { _ = connection.Close() }()
	_ = connection.SetDeadline(time.Now().Add(10 * time.Second))
	clientConnection, _, _, handshakeErr := ssh.NewClientConn(connection, address, config)
	if clientConnection != nil {
		_ = clientConnection.Close()
	}
	if fingerprint != "" {
		return fingerprint, nil
	}
	return "", fmt.Errorf("读取 SSH 主机指纹: %w", handshakeErr)
}

func connectSSH(ctx context.Context, target Target) (*ssh.Client, error) {
	address, err := sshAddress(target.Host, target.Port)
	if err != nil {
		return nil, err
	}
	if target.User == "" {
		return nil, errors.New("SSH 用户不能为空")
	}
	expected := strings.TrimSpace(target.HostFingerprint)
	if expected == "" {
		return nil, errors.New("尚未确认 SSH 主机 SHA-256 指纹")
	}
	signer, err := parseSigner(target.PrivateKey, target.Passphrase)
	if err != nil {
		return nil, err
	}
	config := &ssh.ClientConfig{
		User:            target.User,
		Auth:            []ssh.AuthMethod{ssh.PublicKeys(signer)},
		HostKeyCallback: pinnedHostKeyCallback(expected),
	}
	connection, err := (&net.Dialer{Timeout: 12 * time.Second}).DialContext(ctx, "tcp", address)
	if err != nil {
		return nil, fmt.Errorf("连接 SSH 主机: %w", err)
	}
	_ = connection.SetDeadline(time.Now().Add(15 * time.Second))
	clientConnection, channels, requests, err := ssh.NewClientConn(connection, address, config)
	if err != nil {
		_ = connection.Close()
		return nil, fmt.Errorf("SSH 握手失败: %w", err)
	}
	_ = connection.SetDeadline(time.Time{})
	return ssh.NewClient(clientConnection, channels, requests), nil
}

// keepAlive 定期发一个全局请求：手机网络常常静默断开，没有动静就发现不了
func keepAlive(ctx context.Context, client *ssh.Client) {
	ticker := time.NewTicker(15 * time.Second)
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
					_ = client.Close()
					return
				}
			case <-time.After(10 * time.Second):
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

func pinnedHostKeyCallback(expected string) ssh.HostKeyCallback {
	return func(_ string, _ net.Addr, key ssh.PublicKey) error {
		actual := ssh.FingerprintSHA256(key)
		if subtle.ConstantTimeCompare([]byte(actual), []byte(expected)) != 1 {
			return fmt.Errorf("SSH 主机指纹已变化：期望 %s，实际 %s", expected, actual)
		}
		return nil
	}
}

func sshAddress(host string, port int) (string, error) {
	host = strings.TrimSpace(host)
	if host == "" || port < 1 || port > 65535 {
		return "", errors.New("SSH Host 或 Port 无效")
	}
	return net.JoinHostPort(host, strconv.Itoa(port)), nil
}
