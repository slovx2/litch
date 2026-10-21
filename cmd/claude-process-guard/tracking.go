package main

import (
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
)

// CLI 直接起的、不在本进程组里的子进程（后台命令的包装进程）。
// 身份用进程号加启动时间确认，进程号被别的进程复用时不会误杀。
type row struct {
	pid     int
	ppid    int
	pgid    int
	started string
}

var psArgs = []string{"-A", "-o", "pid=,ppid=,pgid=,lstart="}

var psLine = regexp.MustCompile(`^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$`)

func parseTable(output string) []row {
	var rows []row
	for _, line := range strings.Split(output, "\n") {
		match := psLine.FindStringSubmatch(line)
		if match == nil {
			continue
		}
		pid, _ := strconv.Atoi(match[1])
		ppid, _ := strconv.Atoi(match[2])
		pgid, _ := strconv.Atoi(match[3])
		rows = append(rows, row{pid: pid, ppid: ppid, pgid: pgid, started: match[4]})
	}
	return rows
}

func table() []row {
	output, err := exec.Command("ps", psArgs...).Output()
	if err != nil {
		// 没有 ps 的环境退回到只杀本进程组。
		return nil
	}
	return parseTable(string(output))
}

// 只在 CLI 活着时有意义：这时它的后台命令都还是它的直接子进程。调用方拿着 mu。
func (g *guard) remember(rows []row) {
	if g.closed || g.child == nil || len(rows) == 0 {
		return
	}
	childPid := g.child.Process.Pid
	own := os.Getpid()
	for _, entry := range rows {
		if entry.pid == own {
			own = entry.pgid
			break
		}
	}
	g.tracked = backgroundOf(rows, childPid, own)
}

func backgroundOf(rows []row, childPid int, ownGroup int) []row {
	var found []row
	for _, entry := range rows {
		if entry.ppid == childPid && entry.pgid != ownGroup {
			found = append(found, entry)
		}
	}
	return found
}

// 运行期间的快照不能阻塞：守护进程一停顿，CLI 与入口之间的消息就跟着延迟，
// 会改变 CLI 内部事件的先后。只有停止时才同步取一次。
func (g *guard) snapshot() {
	g.mu.Lock()
	skip := g.closed || g.stopping || !tracksBackground
	g.mu.Unlock()
	if skip {
		return
	}
	go func() {
		output, err := exec.Command("ps", psArgs...).Output()
		if err != nil {
			return
		}
		rows := parseTable(string(output))
		g.mu.Lock()
		defer g.mu.Unlock()
		if !g.stopping {
			g.remember(rows)
		}
	}()
}

// 调用方拿着 mu。
func (g *guard) killTracked() {
	if len(g.tracked) == 0 {
		return
	}
	now := table()
	for _, entry := range g.tracked {
		for _, current := range now {
			if current.pid == entry.pid && current.started == entry.started {
				// 包装进程是自己那一组的组长时连同它起的命令一起结束。
				killTree(current)
				break
			}
		}
	}
	g.tracked = nil
}
