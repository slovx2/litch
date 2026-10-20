import { createDecipheriv, pbkdf2Sync } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readMacKeychain } from './mac-keychain.mjs'
import { powershell, type RunCommand, runCommand } from './process.mjs'
import { checkCancelled, ReadFault } from './result.mjs'
import type { Snapshot } from './snapshot.mjs'
import type { BrowserId, ProtectedReadInput } from './types.mjs'

export interface SystemSecrets {
  keychain(browser: BrowserId, signal: AbortSignal): Promise<Buffer>
  unprotect(encrypted: Buffer, signal: AbortSignal): Promise<Buffer>
}

export function systemSecrets(run: RunCommand = runCommand): SystemSecrets {
  return {
    keychain: readMacKeychain,
    async unprotect(encrypted, signal) {
      const input = Buffer.from(encrypted.toString('base64'))
      const output = await powershell(
        `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Security
  $encrypted = [Convert]::FromBase64String([Console]::In.ReadToEnd())
  $plain = [Security.Cryptography.ProtectedData]::Unprotect($encrypted, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Convert]::ToBase64String($plain))
  [Array]::Clear($plain, 0, $plain.Length)
  exit 0
} catch [UnauthorizedAccessException] { exit 3 }
catch [Security.Cryptography.CryptographicException] { exit 2 }
catch { exit 1 }
`,
        input,
        signal,
        run,
      ).finally(() => input.fill(0))
      try {
        if (output.code !== 0) throw new ReadFault(output.code === 3 ? 'denied' : 'failed')
        return Buffer.from(output.stdout.toString('ascii'), 'base64')
      } finally {
        output.stdout.fill(0)
        output.stderr.fill(0)
      }
    },
  }
}

export class ChromiumCrypto {
  private key: Buffer | undefined
  private keyFault: unknown
  private readonly platform: NodeJS.Platform
  private readonly input: ProtectedReadInput
  private readonly snapshot: Snapshot
  private readonly secrets: SystemSecrets
  constructor(
    platform: NodeJS.Platform,
    input: ProtectedReadInput,
    snapshot: Snapshot,
    secrets: SystemSecrets,
  ) {
    this.platform = platform
    this.input = input
    this.snapshot = snapshot
    this.secrets = secrets
  }

  private async getKey(): Promise<Buffer> {
    if (this.key) return this.key
    if (this.keyFault) throw this.keyFault
    try {
      if (this.platform === 'darwin') {
        const password = await this.secrets.keychain(this.input.browser, this.input.signal)
        try {
          this.key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')
        } finally {
          password.fill(0)
        }
      } else {
        const path = await this.snapshot.file(
          join(this.input.root, 'Local State'),
          this.input.signal,
        )
        if (!path) throw new ReadFault('failed')
        const data = await readFile(path)
        let encoded: unknown
        try {
          encoded = JSON.parse(data.toString('utf8'))?.os_crypt?.encrypted_key
        } finally {
          data.fill(0)
        }
        if (typeof encoded !== 'string') throw new ReadFault('unsupported')
        const encrypted = Buffer.from(encoded, 'base64')
        try {
          if (encrypted.subarray(0, 5).toString('ascii') !== 'DPAPI')
            throw new ReadFault('unsupported')
          this.key = await this.secrets.unprotect(encrypted.subarray(5), this.input.signal)
          if (this.key.length !== 32) {
            this.dispose()
            throw new ReadFault('failed')
          }
        } finally {
          encrypted.fill(0)
        }
      }
      checkCancelled(this.input.signal)
      return this.key
    } catch (error) {
      this.keyFault = error
      throw error
    }
  }

  async decrypt(encrypted: Buffer): Promise<Buffer> {
    checkCancelled(this.input.signal)
    const version = encrypted.subarray(0, 3).toString('ascii')
    if (version === 'v20') {
      // 不注入来源浏览器、不模拟其身份、不启用 SYSTEM 服务来绕过应用绑定。
      throw new ReadFault(
        this.platform === 'win32' && !this.input.allowElevated ? 'needs-elevation' : 'unsupported',
      )
    }
    if (this.platform === 'darwin') {
      if (version !== 'v10') throw new ReadFault('unsupported')
      const decipher = createDecipheriv('aes-128-cbc', await this.getKey(), Buffer.alloc(16, 0x20))
      const plain = decipher.update(encrypted.subarray(3))
      try {
        return Buffer.concat([plain, decipher.final()])
      } finally {
        plain.fill(0)
      }
    }
    if (version === 'v10' || version === 'v11') {
      if (encrypted.length < 31) throw new ReadFault('failed')
      const decipher = createDecipheriv(
        'aes-256-gcm',
        await this.getKey(),
        encrypted.subarray(3, 15),
      )
      decipher.setAuthTag(encrypted.subarray(-16))
      const plain = decipher.update(encrypted.subarray(15, -16))
      try {
        return Buffer.concat([plain, decipher.final()])
      } finally {
        plain.fill(0)
      }
    }
    if (/^v\d\d$/.test(version)) throw new ReadFault('unsupported')
    return this.secrets.unprotect(encrypted, this.input.signal)
  }

  dispose(): void {
    this.key?.fill(0)
    this.key = undefined
    this.keyFault = undefined
  }
}
