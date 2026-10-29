package main

import "strings"

// 只认 pmset 的供电来源行。电池的 charging/discharging 描述不是供电来源。
func parsePowerSource(output string) string {
	for _, line := range strings.Split(output, "\n") {
		switch strings.TrimSpace(line) {
		case "Now drawing from 'AC Power'":
			return "ac"
		case "Now drawing from 'Battery Power'":
			return "battery"
		}
	}
	return "unknown"
}
