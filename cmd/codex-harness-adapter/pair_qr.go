package main

// pair 的两件杂事：在终端里画二维码；用一次性钥匙经本机的 ssh 试连一次（自检，不消耗配对）。

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
	"rsc.io/qr"
)

// 二维码四周留白几格。标准是 4 格，终端里 2 格就扫得出来，省下的宽度让 80 列的终端放得下
const qrQuietZone = 2

// renderQR 用半格字符画二维码：一个字符是上下两格。颜色写死成白底黑字，深色、浅色主题的终端都能扫。
func renderQR(w io.Writer, text string) error {
	code, err := qr.Encode(text, qr.L)
	if err != nil {
		return err
	}
	const (
		on    = "\x1b[30;107m" // 黑字、亮白底
		reset = "\x1b[0m"
	)
	low, high := -qrQuietZone, code.Size+qrQuietZone
	var out strings.Builder
	for y := low; y < high; y += 2 {
		out.WriteString(on)
		for x := low; x < high; x++ {
			top, bottom := code.Black(x, y), y+1 < high && code.Black(x, y+1)
			switch {
			case top && bottom:
				out.WriteString("█")
			case top:
				out.WriteString("▀")
			case bottom:
				out.WriteString("▄")
			default:
				out.WriteString(" ")
			}
		}
		out.WriteString(reset + "\n")
	}
	_, err = io.WriteString(w, out.String())
	return err
}

// 自检的结果之一：本机没有 ssh 客户端，跳过
var errNoSSHClient = errors.New("no ssh client")

// pairSelfCheck 用一次性钥匙经系统的 ssh 连 127.0.0.1:<port>，输入自检那一行（{"v":1,"probe":true}），
// 设备服务认出是自检就只回 ok，不消耗配对。这样 sshd 不认 authorized_keys（别的 AuthorizedKeysFile、StrictModes 嫌权限、
// AuthenticationMethods 要双因素）、主机钥匙对不上，在手机扫之前就能发现。
// 私钥（种子写成 OpenSSH 格式，600）和只放这一把主机钥匙的 known_hosts 放在 dir 下新建的目录里，用完删掉；
// ssh 不读任何配置文件、不用 agent，碰不到用户自己的 ~/.ssh。
func pairSelfCheck(ctx context.Context, sshPath, dir string, start pairStartResponse, port int, user string) error {
	seed, err := base64.RawURLEncoding.DecodeString(start.Seed)
	if err != nil || len(seed) != ed25519.SeedSize {
		return errors.New(tr("设备服务给的一次性钥匙不对", "the one-time key from the device service is malformed"))
	}
	block, err := ssh.MarshalPrivateKey(ed25519.NewKeyFromSeed(seed), "litch-pair:"+start.PairID)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	work, err := os.MkdirTemp(dir, "pair-check-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(work)
	key := filepath.Join(work, "id")
	if err := os.WriteFile(key, pem.EncodeToMemory(block), 0o600); err != nil {
		return err
	}
	host := "127.0.0.1"
	if port != 22 {
		host = "[127.0.0.1]:" + strconv.Itoa(port)
	}
	knownHosts := filepath.Join(work, "known_hosts")
	if err := os.WriteFile(knownHosts, []byte(host+" "+start.HostKey.PublicKey+"\n"), 0o600); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, sshPath, pairSSHArgs(key, knownHosts, port, user)...)
	command.Stdin = strings.NewReader(`{"v":1,"probe":true}` + "\n")
	var stdout, stderr bytes.Buffer
	command.Stdout, command.Stderr = &stdout, &stderr
	runErr := command.Run()
	// 回话是第一行带布尔 ok 的 JSON 对象；前面可能有登录 shell 的启动文件打出来的字，跳过
	scanner := bufio.NewScanner(&stdout)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		var output struct {
			OK      *bool  `json:"ok"`
			Probe   bool   `json:"probe"`
			Error   string `json:"error"`
			Message string `json:"message"`
		}
		if !strings.HasPrefix(line, "{") || json.Unmarshal([]byte(line), &output) != nil || output.OK == nil {
			continue
		}
		if *output.OK && output.Probe {
			return nil
		}
		if !*output.OK {
			return fmt.Errorf("%s: %s", output.Error, output.Message)
		}
		break
	}
	said := strings.TrimSpace(stderr.String())
	if said == "" && runErr != nil {
		said = runErr.Error()
	}
	if said == "" {
		said = tr("登录后没有收到自检的应答：", "no answer to the check after logging in: ") + strings.TrimSpace(stdout.String())
	}
	return errors.New(said)
}

func pairSSHArgs(key, knownHosts string, port int, user string) []string {
	return []string{
		"-F", os.DevNull, "-T",
		"-p", strconv.Itoa(port), "-l", user, "-i", key,
		"-o", "IdentitiesOnly=yes",
		"-o", "IdentityAgent=none",
		"-o", "BatchMode=yes",
		"-o", "PreferredAuthentications=publickey",
		"-o", "StrictHostKeyChecking=yes",
		"-o", "UserKnownHostsFile=" + knownHosts,
		"-o", "GlobalKnownHostsFile=" + os.DevNull,
		"-o", "UpdateHostKeys=no",
		"-o", "ConnectTimeout=10",
		"-o", "LogLevel=ERROR",
		"127.0.0.1",
	}
}
