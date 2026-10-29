//go:build !darwin

package main

import (
	"context"
	"errors"
)

type systemPowerBackend struct{}

func (systemPowerBackend) supported() bool { return false }
func (systemPowerBackend) start(context.Context) (powerLease, error) {
	return nil, errors.New("keep awake is unsupported on this platform")
}
func (systemPowerBackend) source(context.Context) (string, error) { return "unknown", nil }
