package main

import (
	"encoding/binary"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestParseTableReadsPsRows(t *testing.T) {
	output := "  101     1   101 Tue Oct 21 10:00:00 2026\n" +
		"  202   101   202 Tue Oct 21 10:00:01 2026  \n" +
		"bad line\n\n"
	require.Equal(t, []row{
		{pid: 101, ppid: 1, pgid: 101, started: "Tue Oct 21 10:00:00 2026"},
		{pid: 202, ppid: 101, pgid: 202, started: "Tue Oct 21 10:00:01 2026"},
	}, parseTable(output))
}

// 只记 CLI 的直接子进程，而且不在守护进程这一组里的（同组的停止时随组一起收掉）。
func TestBackgroundOfKeepsChildrenOutsideOwnGroup(t *testing.T) {
	rows := []row{
		{pid: 10, ppid: 1, pgid: 10},
		{pid: 11, ppid: 10, pgid: 10},
		{pid: 12, ppid: 11, pgid: 10},
		{pid: 13, ppid: 11, pgid: 13},
		{pid: 14, ppid: 13, pgid: 13},
	}
	require.Equal(t, []row{{pid: 13, ppid: 11, pgid: 13}}, backgroundOf(rows, 11, 10))
}

// libuv 在 Windows 上按 C 运行库的格式传 3 号以后的管道：个数、每项一字节标记、不对齐的句柄数组。
func TestCrtHandleFollowsLibuvLayout(t *testing.T) {
	for _, pointer := range []int{4, 8} {
		count := 5
		buffer := make([]byte, 4+count+count*pointer)
		binary.LittleEndian.PutUint32(buffer, uint32(count))
		put := func(fd int, value uint64) {
			offset := 4 + count + fd*pointer
			if pointer == 8 {
				binary.LittleEndian.PutUint64(buffer[offset:], value)
			} else {
				binary.LittleEndian.PutUint32(buffer[offset:], uint32(value))
			}
		}
		put(0, 0x10)
		put(3, 0x1234)
		put(4, 0x5678)
		if pointer == 8 {
			put(2, ^uint64(0))
		}
		handle, ok := crtHandle(buffer, 3, pointer)
		require.True(t, ok)
		require.Equal(t, uintptr(0x1234), handle)
		handle, ok = crtHandle(buffer, 4, pointer)
		require.True(t, ok)
		require.Equal(t, uintptr(0x5678), handle)
		if pointer == 8 {
			_, ok = crtHandle(buffer, 2, pointer)
			require.False(t, ok, "-1 是没给")
		}
		_, ok = crtHandle(buffer, 1, pointer)
		require.False(t, ok, "没给的一项是 0")
		_, ok = crtHandle(buffer, 5, pointer)
		require.False(t, ok, "超出个数")
		_, ok = crtHandle(buffer[:len(buffer)-1], 4, pointer)
		require.False(t, ok, "长度不够")
	}
	_, ok := crtHandle(nil, 3, 8)
	require.False(t, ok)
}
