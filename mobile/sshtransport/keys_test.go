package sshtransport

import (
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"encoding/pem"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
)

func mustDescribe(t *testing.T, encoded string, err error) keyDescription {
	t.Helper()
	if err != nil {
		t.Fatalf("意外的错误: %v", err)
	}
	var description keyDescription
	if err := json.Unmarshal([]byte(encoded), &description); err != nil {
		t.Fatalf("不是 JSON: %v", err)
	}
	return description
}

func expectKind(t *testing.T, err error, kind string) {
	t.Helper()
	if err == nil || !strings.HasPrefix(err.Error(), "["+kind+"] ") {
		t.Fatalf("要 [%s] 开头的错误，实际 %v", kind, err)
	}
}

func TestGenerateAndInspectEd25519Key(t *testing.T) {
	encoded, err := GenerateEd25519Key()
	generated := mustDescribe(t, encoded, err)
	if !strings.Contains(generated.PrivateKey, "OPENSSH PRIVATE KEY") ||
		!strings.HasPrefix(generated.PublicKey, "ssh-ed25519 ") ||
		!strings.HasPrefix(generated.Fingerprint, "SHA256:") {
		t.Fatalf("生成的钥匙不对: %+v", generated)
	}
	inspected, err := InspectPrivateKey(generated.PrivateKey, "")
	description := mustDescribe(t, inspected, err)
	if description.PublicKey != generated.PublicKey || description.Fingerprint != generated.Fingerprint {
		t.Fatalf("检查出来的公钥和生成的不一样")
	}
	if description.PrivateKey != "" {
		t.Fatalf("检查的结果里不该带私钥")
	}
}

func TestInspectEncryptedEd25519AndRSAAndECDSAKeys(t *testing.T) {
	_, edPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	edBlock, err := ssh.MarshalPrivateKeyWithPassphrase(edPrivate, "test", []byte("secret"))
	if err != nil {
		t.Fatal(err)
	}
	edEncoded := string(pem.EncodeToMemory(edBlock))
	_, err = InspectPrivateKey(edEncoded, "")
	expectKind(t, err, kindKeyLocked)
	_, err = InspectPrivateKey(edEncoded, "wrong")
	expectKind(t, err, kindKey)
	inspected, err := InspectPrivateKey(edEncoded, "secret")
	mustDescribe(t, inspected, err)

	rsaPrivate, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	rsaBlock, err := ssh.MarshalPrivateKey(rsaPrivate, "test-rsa")
	if err != nil {
		t.Fatal(err)
	}
	rsaEncoded, err := InspectPrivateKey(string(pem.EncodeToMemory(rsaBlock)), "")
	if !strings.HasPrefix(mustDescribe(t, rsaEncoded, err).PublicKey, "ssh-rsa ") {
		t.Fatalf("RSA 的公钥不对")
	}

	ecdsaPrivate, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ecdsaBlock, err := ssh.MarshalPrivateKey(ecdsaPrivate, "test-ecdsa")
	if err != nil {
		t.Fatal(err)
	}
	ecdsaEncoded, err := InspectPrivateKey(string(pem.EncodeToMemory(ecdsaBlock)), "")
	if !strings.HasPrefix(mustDescribe(t, ecdsaEncoded, err).PublicKey, "ecdsa-sha2-nistp256 ") {
		t.Fatalf("ECDSA 的公钥不对")
	}

	_, err = InspectPrivateKey("不是钥匙", "")
	expectKind(t, err, kindKey)
}
