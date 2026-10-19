package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/UserExistsError/conpty"
	"github.com/slovx2/litch/internal/hostplatform"
	"golang.org/x/sys/windows"
)

var procSetConsoleCtrlHandler = windows.NewLazySystemDLL("kernel32.dll").NewProc("SetConsoleCtrlHandler")

// 与 POSIX PTY 桥（pty_bridge_unix.go，协议写在那里）采用同一 JSON 字节协议，终端由原生 ConPTY 提供。
func runPtyBridge(args []string) int {
	// 清掉继承来的“忽略 Ctrl+C”：服务是带 CREATE_NEW_PROCESS_GROUP 起的（hostplatform），这个标记一路传给子孙进程，
	// 不清的话终端里的程序收不到 Ctrl+C，打不断。桥自己不挂在伪终端上，伪终端里的 Ctrl+C 到不了它
	_, _, _ = procSetConsoleCtrlHandler.Call(0, 0)
	flags := flag.NewFlagSet("pty-bridge", flag.ContinueOnError)
	rows, cols := flags.Int("rows", 24, "行数"), flags.Int("cols", 80, "列数")
	var mutex sync.Mutex
	emit := func(value any) { mutex.Lock(); defer mutex.Unlock(); _ = json.NewEncoder(os.Stdout).Encode(value) }
	fail := func(err error) int { emit(map[string]any{"event": "spawnError", "message": err.Error()}); return 127 }
	if err := flags.Parse(args); err != nil {
		return fail(err)
	}
	command := flags.Args()
	if len(command) == 0 || *rows < 1 || *cols < 1 || *rows > 32767 || *cols > 32767 {
		return fail(fmt.Errorf("无效终端参数"))
	}
	path, err := exec.LookPath(command[0])
	if err != nil {
		return fail(err)
	}
	command[0] = path
	cwd, err := os.Getwd()
	if err != nil {
		return fail(err)
	}
	terminal, err := conpty.Start(windows.ComposeCommandLine(command), conpty.ConPtyDimensions(*cols, *rows), conpty.ConPtyWorkDir(cwd), conpty.ConPtyEnv(os.Environ()))
	if err != nil {
		return fail(err)
	}
	cleanup, err := hostplatform.TrackPID(terminal.Pid())
	if err != nil {
		_ = terminal.Close()
		return fail(err)
	}
	var once sync.Once
	closeTerminal := func() { once.Do(func() { cleanup(); _ = terminal.Close() }) }
	defer closeTerminal()
	emit(map[string]any{"event": "spawned", "pid": terminal.Pid()})
	drained := make(chan struct{})
	go func() {
		defer close(drained)
		buffer := make([]byte, 65536)
		for {
			n, err := terminal.Read(buffer)
			if n > 0 {
				emit(map[string]any{"stream": "stdout", "delta": base64.StdEncoding.EncodeToString(buffer[:n])})
			}
			if err != nil {
				return
			}
		}
	}()
	go func() {
		scanner := bufio.NewScanner(os.Stdin)
		scanner.Buffer(make([]byte, 4096), 8<<20)
		for scanner.Scan() {
			var msg struct {
				Action, Data string
				Rows, Cols   int
			}
			if json.Unmarshal(scanner.Bytes(), &msg) != nil {
				continue
			}
			switch msg.Action {
			case "input":
				if data, err := base64.StdEncoding.DecodeString(msg.Data); err == nil {
					_, _ = terminal.Write(data)
				}
			case "resize":
				if msg.Rows > 0 && msg.Cols > 0 && msg.Rows <= 32767 && msg.Cols <= 32767 {
					_ = terminal.Resize(msg.Cols, msg.Rows)
				}
			case "eof":
				_, _ = terminal.Write([]byte{4})
			case "kill":
				closeTerminal()
				return
			}
		}
		closeTerminal()
	}()
	code, err := terminal.Wait(context.Background())
	select {
	case <-drained:
	case <-time.After(2 * time.Second):
	}
	if err != nil {
		return 1
	}
	return int(code)
}
