package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func autoConflict() *autostartRepair {
	return autoRepair("registrationConflict", "同名服务与 Litch 的登记不符；请核对系统服务后重试。", "A service with this name does not match Litch's registration. Check the system service and try again.")
}

func autoAccess() *autostartRepair {
	return autoRepair("permissionDenied", "无法读取或改动当前用户的自启登记；请检查权限。", "Cannot read or change the current user's autostart registration. Check permissions.")
}

// 只接受曾授权的规格。仅名字符合、改过文件、符号链接都不能证明归属。
func autoFileStatus(path string, content func(autostartSpec) string, target autostartSpec, owned ...autostartSpec) (exists, ours, exact bool, err error) {
	st, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, false, false, nil
	}
	if err != nil {
		return false, false, false, err
	}
	if !st.Mode().IsRegular() || st.Size() > 64*1024 {
		return true, false, false, nil
	}
	actual, err := os.ReadFile(path)
	if err != nil {
		return true, false, false, err
	}
	exact = bytes.Equal(actual, []byte(content(target)))
	for _, spec := range owned {
		if spec.ID != "" && bytes.Equal(actual, []byte(content(spec))) {
			ours = true
		}
	}
	return true, ours, exact, nil
}

func writeAutoRegistration(path, contents string, replace bool) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".litch-autostart-")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	_, err = f.WriteString(contents)
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if !replace {
		// Link 的目标存在就失败；首次登记绝不覆盖同名文件。
		return os.Link(f.Name(), path)
	}
	return os.Rename(f.Name(), path)
}

func autoProperties(output string) map[string]string {
	result := make(map[string]string)
	for _, line := range strings.Split(output, "\n") {
		if k, v, ok := strings.Cut(strings.TrimSpace(line), "="); ok {
			result[strings.TrimSpace(k)] = strings.TrimSpace(v)
		}
	}
	return result
}

func autoManagerFailure(repair *autostartRepair) error {
	return fmt.Errorf("%s", repair.Text.String())
}

func autoPermissionError(output string) bool {
	s := strings.ToLower(output)
	return strings.Contains(s, "permission denied") || strings.Contains(s, "access denied") ||
		strings.Contains(s, "access is denied") || strings.Contains(s, "operation not permitted") ||
		strings.Contains(s, "0x80070005")
}
