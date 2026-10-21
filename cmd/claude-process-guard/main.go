// claude-process-guard 夹在 Claude 入口与 Claude Code CLI 之间，保证 CLI 无论怎么结束都不留下没人管的进程。
//
// CLI 把后台命令放在各自独立的会话与进程组里，杀 CLI 所在的进程组碰不到它们；
// CLI 被 SIGKILL 时来不及清理，这些命令会变成孤儿一直跑下去。所以停止分两步：
// 先只对 CLI 发 SIGTERM，让它自己停掉后台命令并退出；它没有及时退出，或者是自己崩溃的，
// 再由守护进程按之前记下的进程身份补杀。
//
// 入口崩溃导致 EOF 时，CLI 可能把 MCP 断线当成工具错误继续请求模型；
// 守护进程保持 CLI 输入打开并立刻发 SIGTERM，CLI 在退出前不会再调用模型。
//
// 和入口（packages/claude/src/native-process.mts）的约定：
//   - 命令行：claude-process-guard <CLI 命令> <参数…>，环境和工作目录原样交给 CLI；
//   - 标准输入输出：转发给 CLI。标准输入结束时先不关 CLI 的输入，等入口说可以了（见 g）；
//   - 文件描述符 3：CLI 起来后写一行 {"childPid":<进程号>}；
//   - 文件描述符 4：入口写过来的单字节指令，g 是可以随标准输入结束关掉 CLI 的输入，
//     s 是记下 CLI 当前的后台命令进程；这条管道由入口持有，读到结束就是入口没了，开始停止；
//   - 入口以独立进程组（detached）起它，CLI 和同组的工具继承这一进程组。
package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"sync"
	"time"
)

const grace = 500 * time.Millisecond

type guard struct {
	mu sync.Mutex
	// 下面几项都由 mu 守着
	child      *exec.Cmd
	childIn    *os.File
	closed     bool
	stopping   bool
	graceful   bool
	inputEnded bool
	tracked    []row

	control *os.File
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "缺少 Claude CLI 命令")
		os.Exit(1)
	}
	os.Exit(run(os.Args[1], os.Args[2:]))
}

func run(command string, args []string) int {
	identity := inheritedFile(3, "identity")
	control := inheritedFile(4, "control")
	if identity == nil || control == nil {
		fmt.Fprintln(os.Stderr, "守护进程缺少入口给的管道（文件描述符 3、4）")
		return 1
	}
	g := &guard{control: control}
	watchSignals(g.stop)

	inRead, inWrite, err := os.Pipe()
	if err != nil {
		return g.spawnFailed(err)
	}
	outRead, outWrite, err := os.Pipe()
	if err != nil {
		return g.spawnFailed(err)
	}
	errRead, errWrite, err := os.Pipe()
	if err != nil {
		return g.spawnFailed(err)
	}
	child := exec.Command(command, args...)
	child.Stdin, child.Stdout, child.Stderr = inRead, outWrite, errWrite
	if err := child.Start(); err != nil {
		return g.spawnFailed(err)
	}
	// 子进程那一端只留给它：自己这边关掉，它和它的后代都关了才读得到结束。
	_ = inRead.Close()
	_ = outWrite.Close()
	_ = errWrite.Close()
	g.mu.Lock()
	g.child, g.childIn = child, inWrite
	g.mu.Unlock()
	_, _ = identity.WriteString(`{"childPid":` + strconv.Itoa(child.Process.Pid) + "}\n")

	go g.forwardInput()
	go g.readControl()
	var output sync.WaitGroup
	output.Add(2)
	go g.forwardOutput(&output, outRead, os.Stdout)
	go g.forwardOutput(&output, errRead, os.Stderr)

	waitErr := child.Wait()
	// 和 node 的 close 事件一样：进程退出、输出也都读完才算结束
	output.Wait()
	return g.childClosed(child.ProcessState, waitErr)
}

// CLI 没起来：报出原因，退出码 1。
func (g *guard) spawnFailed(err error) int {
	g.mu.Lock()
	g.closed = true
	g.mu.Unlock()
	fmt.Fprint(os.Stderr, err.Error())
	_ = g.control.Close()
	return 1
}

// 入口的标准输入转给 CLI。读到结束先记下，等入口说可以了再关 CLI 的输入。
func (g *guard) forwardInput() {
	buffer := make([]byte, 64*1024)
	for {
		n, err := os.Stdin.Read(buffer)
		if n > 0 {
			if _, writeErr := g.childIn.Write(buffer[:n]); writeErr != nil {
				g.stop()
				return
			}
		}
		if errors.Is(err, io.EOF) {
			g.mu.Lock()
			g.inputEnded = true
			if g.graceful {
				_ = g.childIn.Close()
			}
			g.mu.Unlock()
			return
		}
		if err != nil {
			g.stop()
			return
		}
	}
}

// CLI 的输出转给入口。写不出去就是入口那头没了，开始停止，但照样读完，免得 CLI 卡在写上。
func (g *guard) forwardOutput(done *sync.WaitGroup, from *os.File, to *os.File) {
	defer done.Done()
	buffer := make([]byte, 64*1024)
	broken := false
	for {
		n, err := from.Read(buffer)
		if n > 0 && !broken {
			if _, writeErr := to.Write(buffer[:n]); writeErr != nil {
				broken = true
				g.stop()
			}
		}
		if err != nil {
			_ = from.Close()
			return
		}
	}
}

func (g *guard) readControl() {
	buffer := make([]byte, 64)
	for {
		n, err := g.control.Read(buffer)
		for _, flag := range buffer[:n] {
			switch flag {
			case 'g':
				g.mu.Lock()
				g.graceful = true
				if g.inputEnded {
					_ = g.childIn.Close()
				}
				g.mu.Unlock()
			case 's':
				g.snapshot()
			}
		}
		if err != nil {
			// 入口持有这条管道，不受 SDK 关闭标准输入影响；入口死了一定读到结束。
			g.stop()
			return
		}
	}
}

// CLI 退出、输出也读完了。
func (g *guard) childClosed(state *os.ProcessState, waitErr error) int {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.closed = true
	if g.stopping && stopKillsGroup {
		g.finish()
	}
	// CLI 自己退出（正常结束或崩溃）：它没来得及停掉的后台命令在这里补杀。
	g.killTracked()
	_ = os.Stdin.Close()
	_ = g.control.Close()
	if state == nil {
		fmt.Fprint(os.Stderr, waitErr)
		return 1
	}
	if code := state.ExitCode(); code >= 0 {
		return code
	}
	// 被信号结束的
	return 1
}
