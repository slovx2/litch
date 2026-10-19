package sshtransport

import (
	"bufio"
	"bytes"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"net"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

// 设计里的测试向量（packages/protocol/src/device-pairing.mts）
const (
	vectorPairID      = "Ab3dEf6hIj9kLm2n"
	vectorPublicKey   = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl"
	vectorCode        = "965093"
	vectorPhoneID     = "f83898df0bef57a4"
	vectorFingerprint = "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU"
)

func TestPairVectors(t *testing.T) {
	if code := PairConfirmCode(vectorPairID, vectorPublicKey); code != vectorCode {
		t.Fatalf("确认码 %s，要 %s", code, vectorCode)
	}
	// 公钥行带注释、前后有空白也一样
	if code := PairConfirmCode(vectorPairID, " "+vectorPublicKey+"\n"); code != vectorCode {
		t.Fatalf("去空白后确认码 %s，要 %s", code, vectorCode)
	}
	id, err := PairPhoneID(vectorPublicKey + " phone")
	if err != nil || id != vectorPhoneID {
		t.Fatalf("手机号 %s（%v），要 %s", id, err, vectorPhoneID)
	}
	key, _, _, _, err := ssh.ParseAuthorizedKey([]byte(vectorPublicKey))
	if err != nil || ssh.FingerprintSHA256(key) != vectorFingerprint {
		t.Fatalf("指纹不对: %v", err)
	}
	if _, err := PairPhoneID("不是公钥"); err == nil {
		t.Fatal("坏的公钥应该报错")
	}
}

func TestSeedSigner(t *testing.T) {
	seed := make([]byte, ed25519.SeedSize)
	_, _ = rand.Read(seed)
	signer, err := seedSigner(base64.RawURLEncoding.EncodeToString(seed))
	if err != nil {
		t.Fatal(err)
	}
	want, _ := ssh.NewPublicKey(ed25519.NewKeyFromSeed(seed).Public())
	if !bytes.Equal(signer.PublicKey().Marshal(), want.Marshal()) {
		t.Fatal("种子还原出来的公钥不对")
	}
	_, err = seedSigner(base64.RawURLEncoding.EncodeToString(seed[:31]))
	expectKind(t, err, kindKey)
	_, err = seedSigner("有+非法/字符")
	expectKind(t, err, kindKey)
}

// 假的 pair-enroll：只认一把钥匙，主机同时有 ed25519 和 ecdsa 两把钥匙；
// 会话里读一行交给 reply，reply 返回的写回标准输出（空串就什么都不写、往标准错误写一句再退出）
type enrollServer struct {
	address string
	ed25519 ssh.PublicKey
	ecdsa   ssh.PublicKey
	command chan string
}

func startEnrollServer(t *testing.T, allowed ssh.PublicKey, reply func(line string) string) *enrollServer {
	t.Helper()
	edSigner, _ := newKey(t)
	ecKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ecSigner, err := ssh.NewSignerFromKey(ecKey)
	if err != nil {
		t.Fatal(err)
	}
	config := &ssh.ServerConfig{
		PublicKeyCallback: func(_ ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			if bytes.Equal(key.Marshal(), allowed.Marshal()) {
				return &ssh.Permissions{}, nil
			}
			return nil, net.ErrClosed
		},
	}
	config.AddHostKey(edSigner)
	config.AddHostKey(ecSigner)
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	server := &enrollServer{
		address: listener.Addr().String(),
		ed25519: edSigner.PublicKey(),
		ecdsa:   ecSigner.PublicKey(),
		command: make(chan string, 4),
	}
	go func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			go server.serve(connection, config, reply)
		}
	}()
	return server
}

func (s *enrollServer) serve(connection net.Conn, config *ssh.ServerConfig, reply func(string) string) {
	_, channels, requests, err := ssh.NewServerConn(connection, config)
	if err != nil {
		_ = connection.Close()
		return
	}
	go ssh.DiscardRequests(requests)
	for incoming := range channels {
		if incoming.ChannelType() != "session" {
			_ = incoming.Reject(ssh.UnknownChannelType, "只开会话")
			continue
		}
		channel, channelRequests, err := incoming.Accept()
		if err != nil {
			continue
		}
		go func() {
			for request := range channelRequests {
				if request.Type != "exec" {
					_ = request.Reply(false, nil)
					continue
				}
				// exec 的载荷是一个带长度前缀的字符串
				s.command <- string(request.Payload[4:])
				_ = request.Reply(true, nil)
				go func() {
					line, _ := bufio.NewReader(channel).ReadString('\n')
					answer := reply(strings.TrimRight(line, "\n"))
					status := uint32(0)
					if answer == "" {
						_, _ = channel.Stderr().Write([]byte("连不上设备进程\n"))
						status = 3
					} else {
						_, _ = channel.Write([]byte(answer + "\n"))
					}
					payload := make([]byte, 4)
					binary.BigEndian.PutUint32(payload, status)
					_, _ = channel.SendRequest("exit-status", false, payload)
					_ = channel.Close()
				}()
			}
		}()
	}
}

func (s *enrollServer) target(t *testing.T, seed, keyType, fingerprint string) string {
	t.Helper()
	host, port, _ := net.SplitHostPort(s.address)
	var number int
	_ = json.Unmarshal([]byte(port), &number)
	encoded, err := json.Marshal(Target{Host: host, Port: number, User: "test", Seed: seed, HostKeyType: keyType, HostFingerprint: fingerprint})
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func newSeed(t *testing.T) (string, ssh.PublicKey) {
	t.Helper()
	seed := make([]byte, ed25519.SeedSize)
	_, _ = rand.Read(seed)
	public, err := ssh.NewPublicKey(ed25519.NewKeyFromSeed(seed).Public())
	if err != nil {
		t.Fatal(err)
	}
	return base64.RawURLEncoding.EncodeToString(seed), public
}

func TestEnrollPairWritesAndReadsOneLine(t *testing.T) {
	seed, public := newSeed(t)
	server := startEnrollServer(t, public, func(line string) string {
		return `{"ok":true,"echo":` + line + `}`
	})
	// 只协商 ecdsa：钉的是 ecdsa 那把的指纹就能连上
	target := server.target(t, seed, ssh.KeyAlgoECDSA256, ssh.FingerprintSHA256(server.ecdsa))
	line, err := EnrollPair(target, `{"v":1,"name":"手机"}`)
	if err != nil {
		t.Fatal(err)
	}
	if line != `{"ok":true,"echo":{"v":1,"name":"手机"}}` {
		t.Fatalf("回话不对: %s", line)
	}
	if command := <-server.command; command != enrollCommand {
		t.Fatalf("执行的命令是 %q", command)
	}
}

func TestEnrollPairPinsNegotiatedHostKey(t *testing.T) {
	seed, public := newSeed(t)
	server := startEnrollServer(t, public, func(string) string { return `{"ok":true}` })
	// 协商 ed25519，钉的却是 ecdsa 的指纹：不连
	_, err := EnrollPair(server.target(t, seed, ssh.KeyAlgoED25519, ssh.FingerprintSHA256(server.ecdsa)), "{}")
	expectKind(t, err, kindHostKeyChanged)
	// 不认识的主机钥匙类型
	_, err = EnrollPair(server.target(t, seed, "ssh-dss", ssh.FingerprintSHA256(server.ed25519)), "{}")
	expectKind(t, err, kindInvalid)
	// 一次性钥匙不被接受（过期了、用过了，对面删了那一行）
	other, _ := newSeed(t)
	_, err = EnrollPair(server.target(t, other, ssh.KeyAlgoED25519, ssh.FingerprintSHA256(server.ed25519)), "{}")
	expectKind(t, err, kindAuth)
	// 内容里不许有换行
	_, err = EnrollPair(server.target(t, seed, ssh.KeyAlgoED25519, ssh.FingerprintSHA256(server.ed25519)), "a\nb")
	expectKind(t, err, kindInvalid)
}

func TestEnrollPairWithoutAnswer(t *testing.T) {
	seed, public := newSeed(t)
	server := startEnrollServer(t, public, func(string) string { return "" })
	_, err := EnrollPair(server.target(t, seed, ssh.KeyAlgoED25519, ssh.FingerprintSHA256(server.ed25519)), "{}")
	expectKind(t, err, kindEnroll)
	if !strings.Contains(err.Error(), "退出码 3") || !strings.Contains(err.Error(), "连不上设备进程") {
		t.Fatalf("详情里要有退出码和标准错误: %v", err)
	}
}

func TestEnrollPairTimesOut(t *testing.T) {
	saved := enrollTimeout
	enrollTimeout = 300 * time.Millisecond
	t.Cleanup(func() { enrollTimeout = saved })
	seed, public := newSeed(t)
	block := make(chan struct{})
	t.Cleanup(func() { close(block) })
	server := startEnrollServer(t, public, func(string) string {
		<-block
		return `{"ok":true}`
	})
	_, err := EnrollPair(server.target(t, seed, ssh.KeyAlgoED25519, ssh.FingerprintSHA256(server.ed25519)), "{}")
	expectKind(t, err, kindEnroll)
}

// 登录 shell 的启动文件打出来的字排在回话前面：跳过它们，取第一行带布尔 ok 的 JSON 对象
func TestReadResultSkipsShellNoise(t *testing.T) {
	text := "Welcome to the test machine.\n{\"motd\":1}\n{\"ok\":false,\"error\":\"rejected\",\"message\":\"电脑上拒绝了\"}\n"
	line, err := readResult(strings.NewReader(text))
	if err != nil || line != `{"ok":false,"error":"rejected","message":"电脑上拒绝了"}` {
		t.Fatalf("readResult = %q, %v", line, err)
	}
	// 最后一行没有换行也认
	line, err = readResult(strings.NewReader("noise\n{\"ok\":true,\"phoneId\":\"cec3a3912e6e882d\"}"))
	if err != nil || !strings.Contains(line, `"phoneId"`) {
		t.Fatalf("没换行的结尾 = %q, %v", line, err)
	}
	// 只有杂字：错误里带上读到的东西，界面当详情
	_, err = readResult(strings.NewReader("Welcome to the test machine.\n"))
	if err == nil || !strings.Contains(err.Error(), "Welcome to the test machine.") {
		t.Fatalf("只有杂字应当报错并带上原话，得到 %v", err)
	}
}
