//go:build !windows

package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"io"
	"os"
	"sync"
	"sync/atomic"

	"github.com/creack/pty"
)

// 桥往标准输出写的东西都经过这里：一条一行，整行一次写出去，几处同时写也不会搅在一起。
type ptyBridgeOutput struct {
	mu      sync.Mutex
	stopped atomic.Bool
	closed  bool
	// 写不出去时（对面先关了）调用，用来结束命令。命令起来之后才填。
	broken func()
}

func (o *ptyBridgeOutput) event(message map[string]any) {
	line, err := json.Marshal(message)
	if err != nil {
		return
	}
	o.write(append(line, '\n'))
}

// base64 的字符用不着转义，这一行自己拼：输出量大的时候不值得让 JSON 编码器把整段再扫一遍。
func (o *ptyBridgeOutput) output(data []byte) {
	if o.stopped.Load() {
		return
	}
	const head, tail = `{"stream":"stdout","delta":"`, "\"}\n"
	line := make([]byte, 0, len(head)+base64.StdEncoding.EncodedLen(len(data))+len(tail))
	line = append(line, head...)
	line = base64.StdEncoding.AppendEncode(line, data)
	o.write(append(line, tail...))
}

func (o *ptyBridgeOutput) write(line []byte) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.closed {
		return
	}
	if _, err := os.Stdout.Write(line); err != nil {
		o.closed = true
		if o.broken != nil {
			o.broken()
		}
	}
}

// stop 之后新读到的输出不再往外发，立刻生效；close 还要等正在写的那一行写完，免得留下半行。
// 对面按着不读的时候 close 会一直等，和输出本身被按住是一回事。
func (o *ptyBridgeOutput) stop() { o.stopped.Store(true) }
func (o *ptyBridgeOutput) close() {
	o.mu.Lock()
	o.closed = true
	o.mu.Unlock()
}

// 要对终端做的事（写入、改大小）按收到的次序排在这里，由单独的一头去做。
// 读指令和做指令分开，是因为往终端里写会堵住：命令不读输入、终端的输入队列满了，写就停在那里。
// 堵着的时候 kill 指令和标准输入的结束仍然要立刻生效，否则对面没了以后这条命令就成了没人管的。
// 队列不设上限：对面发多少这里就得收多少，丢了或者不收都会让它那边的次序乱掉。
type ptyBridgeWrites struct {
	mu      sync.Mutex
	ready   *sync.Cond
	pending []func()
}

func newPtyBridgeWrites() *ptyBridgeWrites {
	writes := &ptyBridgeWrites{}
	writes.ready = sync.NewCond(&writes.mu)
	return writes
}

func (w *ptyBridgeWrites) add(action func()) {
	w.mu.Lock()
	w.pending = append(w.pending, action)
	w.mu.Unlock()
	w.ready.Signal()
}

func (w *ptyBridgeWrites) run() {
	for {
		w.mu.Lock()
		for len(w.pending) == 0 {
			w.ready.Wait()
		}
		batch := w.pending
		w.pending = nil
		w.mu.Unlock()
		for _, action := range batch {
			action()
		}
	}
}

// 读对面发来的指令，直到标准输入结束。认不出的行、不合规矩的值都跳过，不因为一条坏指令把终端带走。
func readPtyBridgeCommands(input io.Reader, master *os.File, writes *ptyBridgeWrites, kill func()) {
	reader := bufio.NewReaderSize(input, ptyReadSize)
	for {
		// 一行可以很长（一次粘贴的内容都在一条 input 里），不设上限。
		line, err := reader.ReadBytes('\n')
		if err != nil {
			// 标准输入结束就是对面没了，和 kill 一样处理。没读完的半行不算数。
			kill()
			return
		}
		var message struct {
			Action, Data string
			Rows, Cols   int
		}
		if json.Unmarshal(line, &message) != nil {
			continue
		}
		switch message.Action {
		case "input":
			data, err := base64.StdEncoding.DecodeString(message.Data)
			if err != nil {
				continue
			}
			writes.add(func() { _, _ = master.Write(data) })
		case "resize":
			if !ptySizeValid(message.Rows) || !ptySizeValid(message.Cols) {
				continue
			}
			size := &pty.Winsize{Rows: uint16(message.Rows), Cols: uint16(message.Cols)}
			writes.add(func() { _ = pty.Setsize(master, size) })
		case "eof":
			writes.add(func() { _, _ = master.Write([]byte{4}) })
		case "kill":
			kill()
		}
	}
}
