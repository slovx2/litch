//go:build darwin

package main

import "golang.org/x/sys/unix"

type systemWakeSource struct{}

func (*systemWakeSource) sample() (wakeSample, error) {
	value, err := unix.SysctlTimeval("kern.waketime")
	if err != nil {
		return wakeSample{}, err
	}
	stamp := value.Nano() / 1_000_000
	return wakeSample{mark: stamp, resumedAt: stamp}, nil
}
