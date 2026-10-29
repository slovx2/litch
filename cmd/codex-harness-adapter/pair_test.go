package main

// pair、pair-enroll 里不碰设备服务的部分：二维码文本的编码（和 TS 那份一字不差）、参数、读一行、画二维码。

import (
	"bytes"
	"encoding/base64"
	"io"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/slovx2/litch/internal/hostplatform"
)

func TestPairExplicitHomeIgnoresInheritedDeviceSocket(t *testing.T) {
	home := t.TempDir()
	target := resolvePairTarget(home, func(name string) string {
		if name == deviceSocketEnvironment {
			return "/real-service/device.sock"
		}
		return ""
	})
	want := hostplatform.DeviceSocketPath(filepath.Join(home, "device"))
	if target.socket != want || target.home != home {
		t.Fatalf("显式隔离目录被继承的 socket 覆盖: %#v", target)
	}
}

// 和 packages/core/test/device-pairing-payload.test.mts 的 sample 是同一份；期望值是 Node 里
// JSON.stringify 再 Buffer 转 base64url 得到的（那份测试断言 encodePairPayload 与它相等）
var pairSample = pairPayload{
	Name: "开发机 song-debian", Host: "device-ts", Port: 2222, User: "song",
	HostKeyType: "ssh-ed25519", HostKeyFP: "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU",
	Seed: base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32)), PairID: "Ab3dEf6hIj9kLm2n", ExpiresAt: 1_792_000_000_000,
}

func TestEncodePairPayloadMatchesTypeScript(t *testing.T) {
	want := "LITCHPAIR1:eyJ2IjoxLCJuIjoi5byA5Y-R5py6IHNvbmctZGViaWFuIiwiaCI6ImRldmljZS10cyIsInAiOjIyMjIsInUiOiJzb25nIiwiayI6eyJ0Ijoic3NoLWVkMjU1MTkiLCJmIjoiU0hBMjU2OitEaVkzd3Z2VjZUdUpKaGJwWmlzRi96TERBMHpQTVN2SGRrcjRVdkNPcVUifSwicyI6IkJ3Y0hCd2NIQndjSEJ3Y0hCd2NIQndjSEJ3Y0hCd2NIQndjSEJ3Y0hCd2MiLCJpIjoiQWIzZEVmNmhJajlrTG0ybiIsImUiOjE3OTIwMDAwMDAwMDB9"
	if got := encodePairPayload(pairSample); got != want {
		t.Fatalf("和 TS 编出来的不一样：\n%s\n%s", got, want)
	}
	// 名字里有四字节字符、引号、反斜杠、控制字符、U+2028 和 HTML 字符：encoding/json 会把后两种转义，JSON.stringify 不会
	odd := pairSample
	odd.Name = "手机🙂 \"q\"\\\n\t\x01\u2028<&>"
	want = "LITCHPAIR1:eyJ2IjoxLCJuIjoi5omL5py68J-ZgiBcInFcIlxcXG5cdFx1MDAwMeKAqDwmPiIsImgiOiJkZXZpY2UtdHMiLCJwIjoyMjIyLCJ1Ijoic29uZyIsImsiOnsidCI6InNzaC1lZDI1NTE5IiwiZiI6IlNIQTI1NjorRGlZM3d2dlY2VHVKSmhicFppc0YvekxEQTB6UE1Tdkhka3I0VXZDT3FVIn0sInMiOiJCd2NIQndjSEJ3Y0hCd2NIQndjSEJ3Y0hCd2NIQndjSEJ3Y0hCd2NIQndjIiwiaSI6IkFiM2RFZjZoSWo5a0xtMm4iLCJlIjoxNzkyMDAwMDAwMDAwfQ"
	if got := encodePairPayload(odd); got != want {
		t.Fatalf("特殊字符编出来和 TS 不一样：\n%s\n%s", got, want)
	}
}

func TestParsePairEnrollArgs(t *testing.T) {
	home, id, help, err := parsePairEnrollArgs([]string{"--home", "/x", "Ab3"})
	if err != nil || help || home != "/x" || id != "Ab3" {
		t.Fatalf("%q %q %v %v", home, id, help, err)
	}
	if home, id, _, err = parsePairEnrollArgs([]string{"Ab3", "--home=/y"}); err != nil || home != "/y" || id != "Ab3" {
		t.Fatalf("%q %q %v", home, id, err)
	}
	for _, argv := range [][]string{{}, {"a", "b"}, {"--home"}} {
		if _, _, _, err := parsePairEnrollArgs(argv); err == nil {
			t.Fatalf("%v 应当出错", argv)
		}
	}
	if _, _, help, _ := parsePairEnrollArgs([]string{"--help"}); !help {
		t.Fatal("--help")
	}
}

func TestParsePairArgs(t *testing.T) {
	options, err := parsePairArgs([]string{"--host", "device-ts", "--port", "2222", "--name", "开发机"})
	if err != nil || options.host != "device-ts" || options.port != 2222 || options.name != "开发机" {
		t.Fatalf("%+v %v", options, err)
	}
	if options, err = parsePairArgs(nil); err != nil || options.port != 22 || options.host != "" {
		t.Fatalf("默认值：%+v %v", options, err)
	}
	for _, argv := range [][]string{{"--port", "0"}, {"--port", "70000"}, {"extra"}, {"--nope"}} {
		if _, err := parsePairArgs(argv); err == nil {
			t.Fatalf("%v 应当出错", argv)
		}
	}
	if options, _ := parsePairArgs([]string{"-h"}); !options.help {
		t.Fatal("-h")
	}
}

func TestReadPairEnrollLine(t *testing.T) {
	cases := []struct {
		name, input, want string
		fail              bool
	}{
		{"一行带换行", "{\"v\":1}\nrest", `{"v":1}`, false},
		{"没换行就读完了", `{"v":1}`, `{"v":1}`, false},
		{"CRLF", "{\"v\":1}\r\n", `{"v":1}`, false},
		{"正好 4 KB", strings.Repeat("a", pairEnrollInputMax) + "\n", strings.Repeat("a", pairEnrollInputMax), false},
		{"超过 4 KB", strings.Repeat("a", pairEnrollInputMax+1) + "\n", "", true},
		{"空的", "", "", true},
		{"只有空白", "  \n", "", true},
	}
	for _, c := range cases {
		line, err := readPairEnrollLine(strings.NewReader(c.input), time.Second)
		if c.fail != (err != nil) || (!c.fail && string(line) != c.want) {
			t.Fatalf("%s：%q %v", c.name, line, err)
		}
	}
	// 连上来却一直不写：到时限就算输入不对，不一直挂着
	reader, writer := io.Pipe()
	defer writer.Close()
	if _, err := readPairEnrollLine(reader, 50*time.Millisecond); err == nil || !strings.Contains(err.Error(), "没有收到输入") {
		t.Fatalf("超时：%v", err)
	}
}

func TestRenderQRUsesHalfBlocks(t *testing.T) {
	var out bytes.Buffer
	if err := renderQR(&out, encodePairPayload(pairSample)); err != nil {
		t.Fatal(err)
	}
	rows := strings.Split(strings.TrimSuffix(out.String(), "\n"), "\n")
	width := -1
	for index, row := range rows {
		if !strings.HasPrefix(row, "\x1b[30;107m") || !strings.HasSuffix(row, "\x1b[0m") {
			t.Fatalf("第 %d 行没有带上颜色：%q", index, row)
		}
		body := strings.TrimSuffix(strings.TrimPrefix(row, "\x1b[30;107m"), "\x1b[0m")
		cells := len([]rune(body))
		if width < 0 {
			width = cells
		} else if cells != width {
			t.Fatalf("第 %d 行宽 %d，别的行宽 %d", index, cells, width)
		}
		if strings.Trim(body, " ▀▄█") != "" {
			t.Fatalf("第 %d 行有别的字符：%q", index, body)
		}
	}
	// 四周留白：第一行全空，最后一行要么全空、要么只剩下半格的留白
	if strings.Trim(strings.TrimSuffix(strings.TrimPrefix(rows[0], "\x1b[30;107m"), "\x1b[0m"), " ") != "" {
		t.Fatalf("第一行不是留白：%q", rows[0])
	}
	// 80 列的终端放得下，行数是宽度的一半上下
	if width > 80 || len(rows) < width/2 || len(rows) > width/2+1 {
		t.Fatalf("尺寸不对：宽 %d、%d 行", width, len(rows))
	}
}

func TestIsYes(t *testing.T) {
	for _, answer := range []string{"y", "Y", " yes ", "是"} {
		if !isYes(answer) {
			t.Fatalf("%q 应当算允许", answer)
		}
	}
	for _, answer := range []string{"", "n", "no", "yy"} {
		if isYes(answer) {
			t.Fatalf("%q 不该算允许", answer)
		}
	}
}

// 和 packages/core/test/device-pairing-payload.test.mts 的 tailscale 样例是同一份
func TestEncodeTailscalePairPayloadMatchesTypeScript(t *testing.T) {
	sample := pairPayload{
		Name: "开发机 song-debian", Host: "song-debian.tail2e2f6a.ts.net", Port: 22, User: "root",
		HostKeyType: "ssh-ed25519", HostKeyFP: "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU",
		Tailscale: true, Command: "'/opt/litch/bin/codex-harness-adapter' pair-enroll --home '/root/.codex-harness-adapter' Ab3dEf6hIj9kLm2n",
		PairID: "Ab3dEf6hIj9kLm2n", ExpiresAt: 1_792_000_000_000,
	}
	want := "LITCHPAIR1:eyJ2IjoxLCJuIjoi5byA5Y-R5py6IHNvbmctZGViaWFuIiwiaCI6InNvbmctZGViaWFuLnRhaWwyZTJmNmEudHMubmV0IiwicCI6MjIsInUiOiJyb290IiwiayI6eyJ0Ijoic3NoLWVkMjU1MTkiLCJmIjoiU0hBMjU2OitEaVkzd3Z2VjZUdUpKaGJwWmlzRi96TERBMHpQTVN2SGRrcjRVdkNPcVUifSwibSI6InRhaWxzY2FsZSIsImMiOiInL29wdC9saXRjaC9iaW4vY29kZXgtaGFybmVzcy1hZGFwdGVyJyBwYWlyLWVucm9sbCAtLWhvbWUgJy9yb290Ly5jb2RleC1oYXJuZXNzLWFkYXB0ZXInIEFiM2RFZjZoSWo5a0xtMm4iLCJpIjoiQWIzZEVmNmhJajlrTG0ybiIsImUiOjE3OTIwMDAwMDAwMDB9"
	if got := encodePairPayload(sample); got != want {
		t.Fatalf("和 TS 编出来的不一样：\n%s\n%s", got, want)
	}
}
