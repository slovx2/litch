// 仅供隔离模拟器验收；此命令不被 sshtransport 或 gomobile 引用。
package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"time"
)

func certificates(directory, host, caPath, keyPath string) (tls.Certificate, string, error) {
	var ca *x509.Certificate
	var caKey *ecdsa.PrivateKey
	if caPath != "" || keyPath != "" {
		encoded, err := os.ReadFile(caPath)
		if err != nil {
			return tls.Certificate{}, "", err
		}
		block, _ := pem.Decode(encoded)
		if block == nil {
			return tls.Certificate{}, "", fmt.Errorf("CA 不是 PEM")
		}
		ca, err = x509.ParseCertificate(block.Bytes)
		if err != nil {
			return tls.Certificate{}, "", err
		}
		encoded, err = os.ReadFile(keyPath)
		if err != nil {
			return tls.Certificate{}, "", err
		}
		block, _ = pem.Decode(encoded)
		if block == nil {
			return tls.Certificate{}, "", fmt.Errorf("CA key 不是 PEM")
		}
		parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
		if err != nil {
			return tls.Certificate{}, "", err
		}
		var ok bool
		caKey, ok = parsed.(*ecdsa.PrivateKey)
		if !ok {
			return tls.Certificate{}, "", fmt.Errorf("需要 ECDSA CA key")
		}
	} else {
		var err error
		caKey, err = ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			return tls.Certificate{}, "", err
		}
		ca = &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "Litch isolated simulator CA"},
			NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour), IsCA: true,
			BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature}
		der, err := x509.CreateCertificate(rand.Reader, ca, ca, &caKey.PublicKey, caKey)
		if err != nil {
			return tls.Certificate{}, "", err
		}
		ca, err = x509.ParseCertificate(der)
		if err != nil {
			return tls.Certificate{}, "", err
		}
		caPath = filepath.Join(directory, "ca.pem")
		if err = os.WriteFile(caPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0600); err != nil {
			return tls.Certificate{}, "", err
		}
		encoded, err := x509.MarshalPKCS8PrivateKey(caKey)
		if err != nil {
			return tls.Certificate{}, "", err
		}
		if err = os.WriteFile(filepath.Join(directory, "ca-key.pem"), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: encoded}), 0600); err != nil {
			return tls.Certificate{}, "", err
		}
	}
	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, "", err
	}
	leaf := &x509.Certificate{SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: host},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(12 * time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses: []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("10.0.2.2")}}
	if ip := net.ParseIP(host); ip != nil {
		leaf.IPAddresses = append(leaf.IPAddresses, ip)
	} else {
		leaf.DNSNames = []string{host}
	}
	der, err := x509.CreateCertificate(rand.Reader, leaf, ca, &leafKey.PublicKey, caKey)
	if err != nil {
		return tls.Certificate{}, "", err
	}
	return tls.Certificate{Certificate: [][]byte{der, ca.Raw}, PrivateKey: leafKey}, caPath, nil
}
