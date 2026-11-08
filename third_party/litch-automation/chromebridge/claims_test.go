package chromebridge

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"testing"
	"time"
)

func claimFrame(id, lease, target string) []byte {
	frame, _ := json.Marshal(map[string]any{"kind": "request", "id": id, "op": "claim",
		"args": map[string]any{"targetId": target, "grant": map[string]string{"leaseId": lease}}})
	return frame
}

const testTarget = "1CD987F78CC5EEB07AD66D2E47FD76C6"

func TestClaimLockExclusiveAndRelease(t *testing.T) {
	directory := t.TempDir()
	a, err := newClaimLocks(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer a.close()
	b, err := newClaimLocks(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer b.close()
	if reply, err := a.before(claimFrame("a", "lease-a", testTarget)); err != nil || reply != nil {
		t.Fatalf("first: %s %v", reply, err)
	}
	if reply, err := b.before(claimFrame("b", "lease-b", testTarget)); err != nil || reply == nil {
		t.Fatalf("competing: %s %v", reply, err)
	}
	// 成功响应不放锁；必须等扩展已经 detach 后的 revoked。
	a.after([]byte(`{"kind":"result","id":"a","result":{}}`))
	if reply, _ := b.before(claimFrame("b", "lease-b", testTarget)); reply == nil {
		t.Fatal("released before detach")
	}
	a.after([]byte(`{"kind":"revoked","leaseId":"lease-a"}`))
	if reply, err := b.before(claimFrame("b", "lease-b", testTarget)); err != nil || reply != nil {
		t.Fatalf("after release: %s %v", reply, err)
	}
	b.after([]byte(`{"kind":"result","id":"b","error":{"code":"staleDocument"}}`))
	if reply, _ := a.before(claimFrame("again", "lease-again", testTarget)); reply != nil {
		t.Fatal(string(reply))
	}
}

func TestClaimLockLegacyAndInvalidTarget(t *testing.T) {
	locks, err := newClaimLocks("")
	if err != nil {
		t.Fatal(err)
	}
	defer locks.close()
	if reply, err := locks.before(claimFrame("legacy", "lease", "")); err != nil || reply != nil {
		t.Fatal("wire 1 legacy changed")
	}
	if reply, _ := locks.before(claimFrame("new", "lease", testTarget)); reply == nil {
		t.Fatal("new metadata bypassed missing lock configuration")
	}
	configured, err := newClaimLocks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer configured.close()
	if reply, _ := configured.before(claimFrame("invalid", "lease", "../../other")); reply == nil {
		t.Fatal("invalid target accepted")
	}
}

func TestClaimLockChild(t *testing.T) {
	directory := os.Getenv("LITCH_CLAIM_LOCK_CHILD")
	if directory == "" {
		return
	}
	locks, err := newClaimLocks(directory)
	if err != nil {
		t.Fatal(err)
	}
	if reply, err := locks.before(claimFrame("child", "child", testTarget)); err != nil || reply != nil {
		t.Fatalf("%s %v", reply, err)
	}
	fmt.Println("locked")
	_, _ = bufio.NewReader(os.Stdin).ReadByte()
	locks.close()
}

func TestClaimLockProcessExitReleasesKernelLock(t *testing.T) {
	directory := t.TempDir()
	child := exec.Command(os.Args[0], "-test.run=^TestClaimLockChild$")
	child.Env = append(os.Environ(), "LITCH_CLAIM_LOCK_CHILD="+directory)
	input, err := child.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	output, err := child.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = child.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = child.Process.Kill() })
	line, err := bufio.NewReader(output).ReadString('\n')
	if err != nil || line != "locked\n" {
		t.Fatalf("child: %q %v", line, err)
	}
	locks, err := newClaimLocks(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer locks.close()
	if reply, _ := locks.before(claimFrame("parent", "parent", testTarget)); reply == nil {
		t.Fatal("cross-process lock bypassed")
	}
	if err = child.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = child.Wait()
	if reply, err := locks.before(claimFrame("parent", "parent", testTarget)); err != nil || reply != nil {
		t.Fatalf("crash left lock: %s %v", reply, err)
	}
}

func TestClaimLockLatency(t *testing.T) {
	locks, err := newClaimLocks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer locks.close()
	const count = 1000
	durations := make([]time.Duration, count)
	frame := claimFrame("bench", "bench", testTarget)
	for index := range durations {
		start := time.Now()
		if reply, err := locks.before(frame); err != nil || reply != nil {
			t.Fatalf("%s %v", reply, err)
		}
		locks.after([]byte(`{"kind":"revoked","leaseId":"bench"}`))
		durations[index] = time.Since(start)
	}
	sort.Slice(durations, func(i, j int) bool { return durations[i] < durations[j] })
	t.Logf("claim lock acquire+release, n=%d p50=%s p95=%s p99=%s max=%s", count,
		durations[count/2], durations[count*95/100], durations[count*99/100], durations[count-1])
}
