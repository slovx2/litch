package main

// Chrome 的 Native Messaging 宿主只转发受限帧，不执行网页代码或模型命令。
import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
)

type chromeHostConfig struct {
	SocketPath  string `json:"socketPath"`
	Token       string `json:"token"`
	ExtensionID string `json:"extensionId"`
}

func runChromeHost(args []string) error {
	flags := flag.NewFlagSet("chrome-host", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	configPath := flags.String("config", "", "")
	if err := flags.Parse(args); err != nil || len(flags.Args()) != 1 {
		return errors.New("invalid Chrome native host arguments")
	}
	if runtime.GOOS != "darwin" || !filepath.IsAbs(*configPath) {
		return errors.New("Chrome native host requires macOS and an absolute config path")
	}
	info, err := os.Lstat(*configPath)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > 8192 {
		return errors.New("Chrome native host configuration is unavailable or not private")
	}
	data, err := os.ReadFile(*configPath)
	if err != nil {
		return errors.New("cannot read Chrome native host configuration")
	}
	var config chromeHostConfig
	if json.Unmarshal(data, &config) != nil || len(config.Token) != 64 || !filepath.IsAbs(config.SocketPath) || len(config.ExtensionID) != 32 {
		return errors.New("invalid Chrome native host configuration")
	}
	origin := flags.Args()[0]
	if origin != "chrome-extension://"+config.ExtensionID+"/" {
		return errors.New("Chrome extension origin was not authorized")
	}
	conn, err := net.Dial("unix", config.SocketPath)
	if err != nil {
		return errors.New("Litch Chrome bridge is not running")
	}
	defer conn.Close()
	hello, _ := json.Marshal(map[string]string{"kind": "nativeHello", "token": config.Token, "origin": origin})
	if _, err = conn.Write(append(hello, '\n')); err != nil {
		return errors.New("Chrome bridge handshake failed")
	}
	done := make(chan error, 2)
	go func() { done <- chromeNativeToBridge(os.Stdin, conn) }()
	go func() { done <- chromeBridgeToNative(conn, os.Stdout) }()
	err = <-done
	if errors.Is(err, io.EOF) {
		return nil
	}
	return err
}

func chromeNativeToBridge(input io.Reader, output io.Writer) error {
	for {
		var header [4]byte
		if _, err := io.ReadFull(input, header[:]); err != nil {
			return err
		}
		size := binary.LittleEndian.Uint32(header[:])
		if size == 0 || size > 16*1024*1024 {
			return errors.New("Chrome native frame exceeds limit")
		}
		frame := make([]byte, size)
		if _, err := io.ReadFull(input, frame); err != nil {
			return err
		}
		if !json.Valid(frame) {
			return errors.New("invalid Chrome native JSON")
		}
		if _, err := output.Write(append(frame, '\n')); err != nil {
			return err
		}
	}
}

func chromeBridgeToNative(input io.Reader, output io.Writer) error {
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), 512*1024+1)
	for scanner.Scan() {
		frame := scanner.Bytes()
		if !json.Valid(frame) {
			return errors.New("invalid Chrome bridge JSON")
		}
		var header [4]byte
		binary.LittleEndian.PutUint32(header[:], uint32(len(frame)))
		if _, err := output.Write(header[:]); err != nil {
			return err
		}
		if _, err := output.Write(frame); err != nil {
			return err
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("Chrome bridge frame could not be read: %w", err)
	}
	return io.EOF
}
