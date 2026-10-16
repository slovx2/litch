package sshserver

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pkg/sftp"
	"github.com/slovx2/litch/internal/hostplatform"
	"github.com/stretchr/testify/require"
	"golang.org/x/crypto/ssh"
)

func TestPTYResizeSFTPAndWrongKey(t *testing.T) {
	_, key, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	signer, err := ssh.NewSignerFromKey(key)
	require.NoError(t, err)
	home := t.TempDir()
	server, err := StartSSHServer(context.Background(), SSHOptions{
		ListenAddr: "127.0.0.1:0", HostKeyFile: filepath.Join(home, "host_key"), Home: home,
		CodexHome: home, Shell: hostplatform.DefaultShell(), Runtime: desktopStub{},
		AuthorizedClients: []AuthorizedClient{{ID: "test", PublicKey: signer.PublicKey()}},
	})
	require.NoError(t, err)
	defer server.Close()
	hostBytes, err := os.ReadFile(filepath.Join(home, "host_key"))
	require.NoError(t, err)
	host, err := ssh.ParsePrivateKey(hostBytes)
	require.NoError(t, err)
	config := &ssh.ClientConfig{User: "local", Auth: []ssh.AuthMethod{ssh.PublicKeys(signer)}, HostKeyCallback: ssh.FixedHostKey(host.PublicKey()), Timeout: 5 * time.Second}
	client, err := ssh.Dial("tcp", server.Addr().String(), config)
	require.NoError(t, err)
	defer client.Close()
	_, wrong, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	wrongSigner, err := ssh.NewSignerFromKey(wrong)
	require.NoError(t, err)
	wrongConfig := *config
	wrongConfig.Auth = []ssh.AuthMethod{ssh.PublicKeys(wrongSigner)}
	_, err = ssh.Dial("tcp", server.Addr().String(), &wrongConfig)
	require.Error(t, err)
	files, err := sftp.NewClient(client)
	require.NoError(t, err)
	defer files.Close()
	remoteHome, err := files.RealPath(".")
	require.NoError(t, err)
	path := remoteHome + "/sftp-example.txt"
	file, err := files.Create(path)
	require.NoError(t, err)
	_, err = file.Write([]byte("SFTP_WINDOWS_UNIX"))
	require.NoError(t, err)
	require.NoError(t, file.Close())
	data, err := os.ReadFile(filepath.Join(home, "sftp-example.txt"))
	require.NoError(t, err)
	require.Equal(t, "SFTP_WINDOWS_UNIX", string(data))
	session, err := client.NewSession()
	require.NoError(t, err)
	defer session.Close()
	require.NoError(t, session.RequestPty("xterm", 10, 20, ssh.TerminalModes{}))
	stdin, err := session.StdinPipe()
	require.NoError(t, err)
	stdout, err := session.StdoutPipe()
	require.NoError(t, err)
	node, err := exec.LookPath("node")
	require.NoError(t, err)
	command := shellQuote(hostplatform.ShellPath(node)) + " -e " + shellQuote(`process.stdout.write("PTY_READY\n");process.stdin.once("data",()=>{process.stdout._refreshSize();console.log(process.stdout.getWindowSize().reverse().join(" "));process.exit(0)})`)
	require.NoError(t, session.Start(command))
	reader := bufio.NewReader(stdout)
	ready := make(chan error, 1)
	go func() {
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				ready <- err
				return
			}
			if strings.Contains(line, "PTY_READY") {
				ready <- nil
				return
			}
		}
	}()
	select {
	case err := <-ready:
		require.NoError(t, err)
	case <-time.After(10 * time.Second):
		t.Fatal("PTY 未就绪")
	}
	accepted, err := session.SendRequest("window-change", true, ssh.Marshal(struct{ Columns, Rows, Width, Height uint32 }{22, 11, 0, 0}))
	require.NoError(t, err)
	require.True(t, accepted)
	// 同一 SSH 通道中的 window-change 先于后续输入发送，输出必须来自调整后的终端。
	// 终端 Enter 发送 CR，POSIX 行规程和 Windows 控制台都会提交输入行。
	_, err = io.WriteString(stdin, "go\r")
	require.NoError(t, err)
	output, err := io.ReadAll(reader)
	require.NoError(t, err)
	require.NoError(t, session.Wait())
	require.Contains(t, string(output), "11 22")
}
