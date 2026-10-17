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

type keyDescription struct {
	PrivateKey  string `json:"privateKey,omitempty"`
	PublicKey   string `json:"publicKey"`
	Fingerprint string `json:"fingerprint"`
}

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

func InspectPrivateKey(privateKey, passphrase string) (string, error) {
	signer, err := parseSigner(privateKey, passphrase)
	if err != nil {
		return "", err
	}
	typeName := signer.PublicKey().Type()
	if typeName != ssh.KeyAlgoED25519 && typeName != ssh.KeyAlgoRSA &&
		!strings.HasPrefix(typeName, "ecdsa-sha2-") {
		return "", errors.New("只支持 Ed25519、RSA 或 ECDSA OpenSSH 私钥")
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
			return nil, errors.New("私钥已加密，需要口令")
		}
		return nil, errors.New("OpenSSH 私钥或口令无效")
	}
	return signer, nil
}

func marshalJSON(value any) (string, error) {
	encoded, err := json.Marshal(value)
	return string(encoded), err
}
