//go:build linux

package main

import (
	"errors"
	"time"

	"golang.org/x/sys/unix"
)

type systemWakeSource struct{ sleep sleepAccumulator }

func (s *systemWakeSource) sample() (wakeSample, error) {
	var awake, boot, after unix.Timespec
	if err := unix.ClockGettime(unix.CLOCK_MONOTONIC, &awake); err != nil {
		return wakeSample{}, err
	}
	if err := unix.ClockGettime(unix.CLOCK_BOOTTIME, &boot); err != nil {
		return wakeSample{}, err
	}
	if err := unix.ClockGettime(unix.CLOCK_MONOTONIC, &after); err != nil {
		return wakeSample{}, err
	}
	// 采样间进程被抢占时，差值可能混入调度延迟；丢弃本次，下一轮再读。
	if after.Nano()-awake.Nano() > int64(100*time.Millisecond) {
		return wakeSample{}, errors.New("wake clock sample interrupted")
	}
	return s.sleep.sample(boot.Nano()-awake.Nano(), time.Now().UnixMilli()), nil
}
