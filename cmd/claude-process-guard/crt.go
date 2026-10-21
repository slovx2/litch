package main

import "encoding/binary"

// 按 C 运行库（也是 libuv 的 process-stdio.c）的格式取第 fd 个句柄：
// 开头 4 字节是个数 n，接着 n 个字节的标记，再接 n 个句柄（各占一个指针宽，不对齐）。
func crtHandle(buffer []byte, fd int, pointer int) (uintptr, bool) {
	if len(buffer) < 4 {
		return 0, false
	}
	count := int(binary.LittleEndian.Uint32(buffer))
	if fd < 0 || fd >= count || len(buffer) < 4+count+count*pointer {
		return 0, false
	}
	offset := 4 + count + fd*pointer
	var handle uint64
	if pointer == 8 {
		handle = binary.LittleEndian.Uint64(buffer[offset:])
	} else {
		handle = uint64(binary.LittleEndian.Uint32(buffer[offset:]))
	}
	// 0 和 -1 是没有给这一项
	if handle == 0 || uintptr(handle) == ^uintptr(0) {
		return 0, false
	}
	return uintptr(handle), true
}
