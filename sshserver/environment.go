package sshserver

import (
	"runtime"
	"strings"
)

func shellQuote(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'" }

func environmentValue(environment []string, name string) string {
	for _, entry := range environment {
		if key, value, ok := strings.Cut(entry, "="); ok && (key == name || runtime.GOOS == "windows" && strings.EqualFold(key, name)) {
			return value
		}
	}
	return ""
}

func replaceEnvironment(base []string, values map[string]string) []string {
	result := make([]string, 0, len(base)+len(values))
	for _, entry := range base {
		key, _, _ := strings.Cut(entry, "=")
		exists := false
		for name := range values {
			if key == name || runtime.GOOS == "windows" && strings.EqualFold(key, name) {
				exists = true
				break
			}
		}
		if !exists {
			result = append(result, entry)
		}
	}
	for key, value := range values {
		result = append(result, key+"="+value)
	}
	return result
}
