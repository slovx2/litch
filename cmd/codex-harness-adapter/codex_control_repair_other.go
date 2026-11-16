//go:build !windows

package main

import (
	"context"
	"errors"
)

func repairCodexControlDirectory(context.Context, configuration) error {
	return errors.New("Codex control permission repair requires Windows")
}
