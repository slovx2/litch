package chromebridge

// Chrome 的 Native Messaging 宿主只转发受限帧，不执行网页代码或模型命令。
import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"

	"github.com/slovx2/litch/internal/hostplatform"
)

// 桌面端在 macOS、Linux 上监听 Unix 套接字，Windows 上是命名管道。
func socketPathValid(path string) bool {
	if runtime.GOOS == "windows" {
		return strings.HasPrefix(path, `\\.\pipe\`) && len(path) > len(`\\.\pipe\`)
	}
	return filepath.IsAbs(path)
}

type Config struct {
	SocketPath         string   `json:"socketPath"`
	Token              string   `json:"token"`
	ExtensionIDs       []string `json:"extensionIds"`
	ClaimLockDirectory string   `json:"claimLockDirectory,omitempty"`
}

var extensionIDPattern = regexp.MustCompile(`^[a-p]{32}$`)
var parentWindowPattern = regexp.MustCompile(`^--parent-window=\d+$`)

// Chrome 起宿主时第一个参数是调用方扩展的来源；Windows 上还会在后面带 --parent-window=<句柄>。
func HostOrigin(args []string) (string, error) {
	if len(args) == 0 || len(args) > 2 || (len(args) == 2 && !parentWindowPattern.MatchString(args[1])) {
		return "", errors.New("invalid Chrome native host arguments")
	}
	return args[0], nil
}

func Run(ctx context.Context, args []string, input io.Reader, output io.Writer) error {
	flags := flag.NewFlagSet("chrome-host", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	configPath := flags.String("config", "", "")
	if err := flags.Parse(args); err != nil {
		return errors.New("invalid Chrome native host arguments")
	}
	origin, err := HostOrigin(flags.Args())
	if err != nil {
		return err
	}
	if !filepath.IsAbs(*configPath) {
		return errors.New("Chrome native host requires an absolute config path")
	}
	info, err := os.Lstat(*configPath)
	// Windows 的文件权限位不反映访问控制，配置放在用户自己的应用数据目录里，靠目录的权限
	private := runtime.GOOS == "windows" || info != nil && info.Mode().Perm()&0077 == 0
	if err != nil || !info.Mode().IsRegular() || !private || info.Size() > 8192 {
		return errors.New("Chrome native host configuration is unavailable or not private")
	}
	data, err := os.ReadFile(*configPath)
	if err != nil {
		return errors.New("cannot read Chrome native host configuration")
	}
	var config Config
	if json.Unmarshal(data, &config) != nil || len(config.Token) != 64 || !socketPathValid(config.SocketPath) || len(config.ExtensionIDs) == 0 {
		return errors.New("invalid Chrome native host configuration")
	}
	allowed := false
	for _, id := range config.ExtensionIDs {
		if extensionIDPattern.MatchString(id) && origin == "chrome-extension://"+id+"/" {
			allowed = true
		}
	}
	if !allowed {
		return errors.New("Chrome extension origin was not authorized")
	}
	conn, err := hostplatform.Dial(config.SocketPath)
	if err != nil {
		return errors.New("Chrome bridge is not running")
	}
	defer conn.Close()
	locks, err := newClaimLocks(config.ClaimLockDirectory)
	if err != nil {
		return errors.New("Chrome native host claim lock directory is unavailable")
	}
	defer locks.close()
	hello, _ := json.Marshal(map[string]string{"kind": "nativeHello", "token": config.Token, "origin": origin})
	if _, err = conn.Write(append(hello, '\n')); err != nil {
		return errors.New("Chrome bridge handshake failed")
	}
	done := make(chan error, 2)
	writer := &serialWriter{output: conn}
	go func() { done <- nativeToBridge(input, writer, locks.after) }()
	go func() {
		done <- bridgeToNative(conn, output, func(frame []byte) (bool, error) {
			reply, err := locks.before(frame)
			if err != nil {
				return false, err
			}
			if reply != nil {
				_, err = writer.Write(append(reply, '\n'))
				return false, err
			}
			return true, nil
		})
	}()
	select {
	case err = <-done:
	case <-ctx.Done():
		return nil
	}
	if errors.Is(err, io.EOF) {
		return nil
	}
	return err
}

func NativeToBridge(input io.Reader, output io.Writer) error {
	return nativeToBridge(input, output, nil)
}

type serialWriter struct {
	mu     sync.Mutex
	output io.Writer
}

func (writer *serialWriter) Write(data []byte) (int, error) {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	return writer.output.Write(data)
}

func nativeToBridge(input io.Reader, output io.Writer, after func([]byte)) error {
	for {
		var header [4]byte
		if _, err := io.ReadFull(input, header[:]); err != nil {
			return err
		}
		size := binary.LittleEndian.Uint32(header[:])
		if size == 0 || size > 16*1024*1024 {
			return errors.New("Chrome native frame exceeds limit")
		}
		frame := make([]byte, size)
		if _, err := io.ReadFull(input, frame); err != nil {
			return err
		}
		if !json.Valid(frame) {
			return errors.New("invalid Chrome native JSON")
		}
		if after != nil {
			after(frame)
		}
		if _, err := output.Write(append(frame, '\n')); err != nil {
			return err
		}
	}
}

func BridgeToNative(input io.Reader, output io.Writer) error {
	return bridgeToNative(input, output, nil)
}

func bridgeToNative(input io.Reader, output io.Writer, before func([]byte) (bool, error)) error {
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), 512*1024+1)
	for scanner.Scan() {
		frame := scanner.Bytes()
		if !json.Valid(frame) {
			return errors.New("invalid Chrome bridge JSON")
		}
		if before != nil {
			forward, err := before(frame)
			if err != nil {
				return err
			}
			if !forward {
				continue
			}
		}
		var header [4]byte
		binary.LittleEndian.PutUint32(header[:], uint32(len(frame)))
		if _, err := output.Write(header[:]); err != nil {
			return err
		}
		if _, err := output.Write(frame); err != nil {
			return err
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("Chrome bridge frame could not be read: %w", err)
	}
	return io.EOF
}
