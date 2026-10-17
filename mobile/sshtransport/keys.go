package sshtransport

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"encoding/pem"
	"errors"
	"strings"

	"golang.org/x/crypto/ssh"
)

// 钥匙的说明：生成时连私钥一起给（存进系统的安全存储），检查导入的私钥时只给公钥和指纹
type keyDescription struct {
	PrivateKey  string `json:"privateKey,omitempty"`
	PublicKey   string `json:"publicKey"`
	Fingerprint string `json:"fingerprint"`
}

// GenerateEd25519Key 生成一把新的 Ed25519 钥匙（返回 JSON：keyDescription，带私钥）
func GenerateEd25519Key() (string, error) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return "", err
	}
	block, err := ssh.MarshalPrivateKey(privateKey, "litch-mobile")
	if err != nil {
		return "", err
	}
	signer, err := ssh.NewSignerFromKey(privateKey)
	if err != nil {
		return "", err
	}
	return marshalJSON(keyDescription{
		PrivateKey:  string(pem.EncodeToMemory(block)),
		PublicKey:   strings.TrimSpace(string(ssh.MarshalAuthorizedKey(signer.PublicKey()))),
		Fingerprint: ssh.FingerprintSHA256(signer.PublicKey()),
	})
}

// InspectPrivateKey 检查导入的 OpenSSH 私钥（Ed25519、RSA、ECDSA，可以带口令），返回公钥和指纹（JSON：keyDescription，不带私钥）
func InspectPrivateKey(privateKey, passphrase string) (string, error) {
	signer, err := parseSigner(privateKey, passphrase)
	if err != nil {
		return "", err
	}
	typeName := signer.PublicKey().Type()
	if typeName != ssh.KeyAlgoED25519 && typeName != ssh.KeyAlgoRSA &&
		!strings.HasPrefix(typeName, "ecdsa-sha2-") {
		return "", kindf(kindKey, "只支持 Ed25519、RSA 或 ECDSA OpenSSH 私钥")
	}
	return marshalJSON(keyDescription{
		PublicKey:   strings.TrimSpace(string(ssh.MarshalAuthorizedKey(signer.PublicKey()))),
		Fingerprint: ssh.FingerprintSHA256(signer.PublicKey()),
	})
}

func parseSigner(privateKey, passphrase string) (ssh.Signer, error) {
	encoded := []byte(strings.TrimSpace(privateKey) + "\n")
	var signer ssh.Signer
	var err error
	if passphrase == "" {
		signer, err = ssh.ParsePrivateKey(encoded)
	} else {
		signer, err = ssh.ParsePrivateKeyWithPassphrase(encoded, []byte(passphrase))
	}
	if err != nil {
		var missing *ssh.PassphraseMissingError
		if errors.As(err, &missing) {
			return nil, kindf(kindKeyLocked, "私钥已加密，需要口令")
		}
		return nil, kindf(kindKey, "OpenSSH 私钥或口令无效")
	}
	return signer, nil
}

func marshalJSON(value any) (string, error) {
	encoded, err := json.Marshal(value)
	return string(encoded), err
}
