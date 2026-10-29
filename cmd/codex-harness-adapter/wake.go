package main

import (
	"context"
	"sync"
	"time"
)

// 只读执行设备的内核时间。macOS 返回最近唤醒时刻，Linux 返回累计睡眠时间；不使用墙钟差猜测。
type wakeSample struct {
	mark      int64
	resumedAt int64
}
type wakeSource interface{ sample() (wakeSample, error) }
type wakeStatus struct {
	Supported  bool   `json:"supported"`
	Generation string `json:"generation"`
	Sequence   uint64 `json:"sequence"`
	ResumedAt  int64  `json:"resumedAt"`
}
type wakeObserver struct {
	mu       sync.Mutex
	status   wakeStatus
	previous int64
	seeded   bool
	source   wakeSource
}

func newWakeObserver(source wakeSource) *wakeObserver {
	return &wakeObserver{source: source, status: wakeStatus{Generation: time.Now().UTC().Format(time.RFC3339Nano)}}
}

func (w *wakeObserver) poll() bool {
	sample, err := w.source.sample()
	w.mu.Lock()
	defer w.mu.Unlock()
	if err != nil {
		return false
	}
	w.status.Supported = true
	if !w.seeded {
		w.seeded, w.previous = true, sample.mark
		return false // 启动时的历史唤醒不是新事件。
	}
	if sample.mark == w.previous {
		return false
	}
	w.previous = sample.mark
	w.status.Sequence++
	w.status.ResumedAt = sample.resumedAt
	return true
}

func (w *wakeObserver) read() wakeStatus {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.status
}

func (w *wakeObserver) run(ctx context.Context, changed func()) {
	w.poll()
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if w.poll() {
				changed()
			}
		}
	}
}
