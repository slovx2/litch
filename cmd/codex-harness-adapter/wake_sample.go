package main

// BOOTTIME 与 MONOTONIC 的差是累计睡眠时间。两次系统调用的微小误差不算新唤醒。
// 单独放在通用文件，所有平台都能跑合成采样测试，不需要真的休眠。
type sleepAccumulator struct {
	baseline  int64
	seeded    bool
	sequence  int64
	resumedAt int64
}

func (s *sleepAccumulator) sample(difference, now int64) wakeSample {
	if !s.seeded {
		s.baseline, s.seeded = difference, true
	} else if difference-s.baseline > 2_000_000_000 {
		s.baseline, s.resumedAt = difference, now
		s.sequence++
	}
	return wakeSample{mark: s.sequence, resumedAt: s.resumedAt}
}
