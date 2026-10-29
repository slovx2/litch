//go:build !darwin && !linux

package main

import "errors"

type systemWakeSource struct{}

func (*systemWakeSource) sample() (wakeSample, error) {
	return wakeSample{}, errors.New("system wake observation is unsupported")
}
