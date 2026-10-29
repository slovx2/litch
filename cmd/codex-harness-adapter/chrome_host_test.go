package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"testing"
)

func TestChromeNativeFraming(t *testing.T) {
	payload := []byte(`{"kind":"request","args":{"text":"中文"}}`)
	var input bytes.Buffer
	if err := binary.Write(&input, binary.LittleEndian, uint32(len(payload))); err != nil {
		t.Fatal(err)
	}
	input.Write(payload)
	var wire bytes.Buffer
	if err := chromeNativeToBridge(&input, &wire); !errors.Is(err, io.EOF) {
		t.Fatal(err)
	}
	if !bytes.Equal(wire.Bytes(), append(payload, '\n')) {
		t.Fatal("native frame changed")
	}
	var back bytes.Buffer
	if err := chromeBridgeToNative(&wire, &back); !errors.Is(err, io.EOF) {
		t.Fatal(err)
	}
	if binary.LittleEndian.Uint32(back.Bytes()[:4]) != uint32(len(payload)) || !bytes.Equal(back.Bytes()[4:], payload) {
		t.Fatal("bridge frame changed")
	}
}

func TestChromeRejectsMalformedFrames(t *testing.T) {
	cases := [][]byte{{0, 0, 0, 0}, {1, 0, 0, 2}, {3, 0, 0, 0, 'b', 'a', 'd'}, {4, 0, 0, 0, '{', '}'}}
	for _, data := range cases {
		var output bytes.Buffer
		if err := chromeNativeToBridge(bytes.NewReader(data), &output); err == nil {
			t.Fatal("accepted invalid input")
		}
		if output.Len() != 0 {
			t.Fatal("forwarded invalid input")
		}
	}
	var output bytes.Buffer
	if err := chromeBridgeToNative(bytes.NewBufferString("invalid\n"), &output); err == nil {
		t.Fatal("accepted invalid JSON")
	}
	if output.Len() != 0 {
		t.Fatal("forwarded invalid bridge input")
	}
}
