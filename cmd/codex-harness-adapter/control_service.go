package main

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"sync"
	"time"
)

// 控制通道上和“停服务”有关的那一部分：device-stop 请服务自己停（service.stop）；
// 带着 ifIdle 来的，停之前先看忙不忙。
//
// 忙不忙有三样要看：有没有回合在跑、有没有属于设备的终端在跑、有没有客户端连着。
// 前两样和聚合面上的连接数只有设备进程知道（回合还可能是官方桌面端经 SSH 入口发起的，
// 设备进程会另开连接去问每个运行时），所以这一层反过来问它一句（ask）；
// 经 SSH 入口连着的官方桌面端是这一层自己数的。

// 等设备进程答“忙不忙”最多等这么久。它问每个运行时最多等 15 秒，几个运行时是一起问的。
var activityTimeout = 25 * time.Second

// 服务不闲的一条原因。
type busyReason struct {
	// activeTurns     harnesses 里的这几个有回合在跑（或者判断不了，按有算）
	// deviceProcesses 有 count 个属于设备的终端在跑
	// clients         有 count 个客户端连着：聚合面上的，加上经 SSH 入口连着的官方桌面端
	// undetermined    设备进程没有答，而 harnesses 里的这几个运行时在跑：有没有回合判断不了
	Reason    string   `json:"reason"`
	Harnesses []string `json:"harnesses,omitempty"`
	Count     int      `json:"count,omitempty"`
}

// service.stop 的应答。这是跨版本的接口：新版的 device-stop 会拿它去停旧版的服务，形状只增不改。
// 请求的形状没问题时总是给 result：对面收到 error，就知道这份服务不认识这个请求。
type stopReply struct {
	// true：这就停。false：不闲，没有停，原因在 Busy 里。
	Stopping bool `json:"stopping"`
	// 答话的这个进程。控制通道只有拿着设备锁的进程在听，所以它就是拿着锁的那一个。
	PID     int           `json:"pid"`
	Service *serviceFacts `json:"service"`
	Busy    []busyReason  `json:"busy,omitempty"`
}

// 设备进程对 activity 的回答。
type deviceActivity struct {
	// 有回合在跑（或者判断不了）的 harness。
	Turns []string `json:"turns"`
	// 在跑的、属于设备的终端。
	Processes int `json:"processes"`
	// 聚合面上连着的客户端。
	Connections int `json:"connections"`
}

type askAnswer struct {
	result json.RawMessage
	ok     bool
}

type pendingAsk struct {
	answers chan askAnswer
	// 问过、还没有答的连接。
	asked map[net.Conn]bool
}

// ask 问设备进程一件事，等它答。连着控制通道的不只它（还有 device-stop），所以每条连接都问一遍，
// 提出这次请求的那一条（requester）除外；头一个像样的回答算数。没有人可问、都答不上、等太久，都返回 false。
func (s *controlServer) ask(method string, requester net.Conn, timeout time.Duration) (json.RawMessage, bool) {
	s.mu.Lock()
	s.nextAsk++
	id := s.nextAsk
	pending := &pendingAsk{asked: map[net.Conn]bool{}}
	targets := map[net.Conn]*sync.Mutex{}
	for connection, lock := range s.peers {
		if connection != requester {
			targets[connection], pending.asked[connection] = lock, true
		}
	}
	pending.answers = make(chan askAnswer, len(targets))
	s.asks[id] = pending
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.asks, id)
		s.mu.Unlock()
	}()
	for connection, lock := range targets {
		s.send(connection, lock, map[string]any{"ask": id, "method": method})
	}
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	for remaining := len(targets); remaining > 0; remaining-- {
		select {
		case answer := <-pending.answers:
			if answer.ok {
				return answer.result, true
			}
		case <-deadline.C:
			return nil, false
		case <-s.ctx.Done():
			return nil, false
		}
	}
	return nil, false
}

// 一条连接答了第 id 个问题。每条连接只算一次。
func (s *controlServer) answered(connection net.Conn, id int, result json.RawMessage, failed bool) {
	s.mu.Lock()
	pending := s.asks[id]
	if pending == nil || !pending.asked[connection] {
		s.mu.Unlock()
		return
	}
	delete(pending.asked, connection)
	s.mu.Unlock()
	pending.answers <- askAnswer{result: result, ok: !failed && len(result) > 0}
}

// 一条连接断了：问过它、它还没答的，都当它答不上。
func (s *controlServer) departed(connection net.Conn) {
	s.mu.Lock()
	waiting := []*pendingAsk{}
	for _, pending := range s.asks {
		if pending.asked[connection] {
			delete(pending.asked, connection)
			waiting = append(waiting, pending)
		}
	}
	s.mu.Unlock()
	for _, pending := range waiting {
		pending.answers <- askAnswer{}
	}
}

// busy 给出服务现在不闲的原因；闲着就是空的。requester 是来问的那条连接。
func (s *controlServer) busy(requester net.Conn) []busyReason {
	reasons := []busyReason{}
	clients := int(s.manager.desktops.Load())
	var activity deviceActivity
	answer, answered := s.ask("activity", requester, activityTimeout)
	if answered && json.Unmarshal(answer, &activity) == nil {
		if len(activity.Turns) > 0 {
			reasons = append(reasons, busyReason{Reason: "activeTurns", Harnesses: activity.Turns})
		}
		if activity.Processes > 0 {
			reasons = append(reasons, busyReason{Reason: "deviceProcesses", Count: activity.Processes})
		}
		clients += activity.Connections
	} else {
		// 设备进程没有答（没起来、正在重新拉起、卡住了）。聚合面上的客户端和属于设备的终端都随它，
		// 它不在就都没有；但运行时里可能还有回合在跑，这一层自己问不了。有运行时在跑就按判断不了算。
		running := []string{}
		for _, id := range knownHarnesses {
			if state, _, _ := s.manager.status(id); state == stateRunning {
				running = append(running, id)
			}
		}
		if len(running) > 0 {
			reasons = append(reasons, busyReason{Reason: "undetermined", Harnesses: running})
		}
	}
	if clients > 0 {
		reasons = append(reasons, busyReason{Reason: "clients", Count: clients})
	}
	return reasons
}

// stopService 处理 service.stop：答完话再停。答话在前，对面才知道停的是谁、该等哪个进程退出。
func (s *controlServer) stopService(connection net.Conn, lock *sync.Mutex, request controlRequest) {
	var params struct {
		IfIdle bool `json:"ifIdle"`
	}
	if failure := decodeControlParams(request.Params, &params); failure != nil {
		s.send(connection, lock, map[string]any{"id": request.ID, "error": failure})
		return
	}
	reply := stopReply{PID: os.Getpid(), Service: s.facts}
	if params.IfIdle {
		reply.Busy = s.busy(connection)
	}
	reply.Stopping = len(reply.Busy) == 0
	s.send(connection, lock, map[string]any{"id": request.ID, "result": reply})
	if reply.Stopping {
		fmt.Println(tr("收到停止请求（device-stop），正在停止服务。", "Stop requested (device-stop); shutting the service down."))
		s.shutdown()
	}
}
