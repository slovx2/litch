package main

import (
	"errors"
	"testing"
)

type fakeWakeSource struct {
	value   wakeSample
	failure error
}

func (s *fakeWakeSource) sample() (wakeSample, error) { return s.value, s.failure }

func TestWakeObserverNewKernelMarkerOnly(t *testing.T) {
	source := &fakeWakeSource{value: wakeSample{mark: 123, resumedAt: 123}}
	w := newWakeObserver(source)
	if w.poll() || !w.read().Supported {
		t.Fatal("历史唤醒只建立基线")
	}
	if w.poll() {
		t.Fatal("同一唤醒重复通知")
	}
	source.value = wakeSample{mark: 456, resumedAt: 456}
	if !w.poll() || w.read().Sequence != 1 || w.read().ResumedAt != 456 {
		t.Fatal(w.read())
	}
	source.failure = errors.New("unavailable")
	if w.poll() || w.read().Sequence != 1 {
		t.Fatal("采样失败不能伪造唤醒")
	}
}

func TestWakeLinuxClockDifference(t *testing.T) {
	var sample sleepAccumulator
	if sample.sample(10_000_000_000, 100).mark != 0 {
		t.Fatal("历史睡眠不是新事件")
	}
	if sample.sample(10_000_000_100, 200).mark != 0 {
		t.Fatal("采样误差不能当唤醒")
	}
	if got := sample.sample(40_000_000_000, 300); got.mark != 1 || got.resumedAt != 300 {
		t.Fatal(got)
	}
	if sample.sample(40_000_000_100, 400).mark != 1 {
		t.Fatal("同一次唤醒重复")
	}
}

func TestWakeSystemSampleReadOnly(t *testing.T) {
	source := &systemWakeSource{}
	first, err := source.sample()
	if err != nil {
		t.Skipf("平台不支持或无法读取：%v", err)
	}
	second, err := source.sample()
	if err != nil {
		t.Fatal(err)
	}
	if second.mark != first.mark {
		t.Fatal("连续采样出现意外新唤醒，请检查机器是否真的睡眠", first, second)
	}
}
