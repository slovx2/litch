# Windows Codex 的共享启动锁目录权限修复。默认只读预览；不改会话、配置、凭据或递归 ACL。
# .\scripts\repair-codex-control-windows.ps1 -CodexHome C:\path\to\.codex -BackupDirectory C:\path\to\backup [-Apply]
param(
    [Parameter(Mandatory=$true)][string]$CodexHome,
    [Parameter(Mandatory=$true)][string]$BackupDirectory,
    [switch]$Apply
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if ($env:OS -ne 'Windows_NT') { throw 'This repair requires Windows.' }
$directory = [IO.Path]::GetFullPath((Join-Path $CodexHome 'app-server-control'))
# 拒绝目标及其祖先中的链接，避免通过 CODEX_HOME 的 junction 越过修复边界。
function Assert-PlainPath([string]$path) {
    $current = $path
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $part = Get-Item -LiteralPath $current -Force
            if ($part.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing a reparse point in the repair path.' }
        }
        $parent = [IO.Path]::GetDirectoryName($current)
        if ($parent -eq $current) { break }
        $current = $parent
    }
}
Assert-PlainPath $directory
$item = Get-Item -LiteralPath $directory -Force
if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Refusing a non-directory or reparse point.'
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$userSid = $identity.User
$acl = Get-Acl -LiteralPath $directory
$owner = $acl.GetOwner([Security.Principal.SecurityIdentifier])
$adminSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if ($owner -ne $userSid -and -not ($owner -eq $adminSid -and $principal.IsInRole($adminSid))) {
    throw 'Refusing a directory not owned by this user or its elevated Administrators group.'
}

# 运行中的官方 daemon、其他文件或链接不在此修复范围内。
$entries = @(Get-ChildItem -LiteralPath $directory -Force)
foreach ($entry in $entries) {
    if ($entry.Name -ne 'app-server-startup.lock' -or $entry.PSIsContainer -or
        ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Close the Codex daemon first; this repair only accepts an idle startup-lock directory.'
    }
}
$held = $null
try {
    if ($entries.Count -gt 0 -or $Apply) {
        # FileShare.None 要求没有其他进程持有文件；不打断正在启动的 Codex。
        $held = [IO.File]::Open((Join-Path $directory 'app-server-startup.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    }
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    $private = $owner -eq $userSid -and $acl.AreAccessRulesProtected -and $rules.Count -eq 1 -and
        $rules[0].IdentityReference -eq $userSid -and $rules[0].AccessControlType -eq 'Allow' -and
        [int]$rules[0].FileSystemRights -eq 2032127 -and [int]$rules[0].InheritanceFlags -eq 3 -and
        [int]$rules[0].PropagationFlags -eq 0 -and -not $rules[0].IsInherited
    if ($private) {
        [pscustomobject]@{ directory=$directory; state='already-private'; changed=$false } | ConvertTo-Json
        return
    }
    if (-not $Apply) {
        [pscustomobject]@{ directory=$directory; state='requires-private-acl'; changed=$false; owner=$owner.Value; inherited=-not $acl.AreAccessRulesProtected; entries=$rules.Count } | ConvertTo-Json
        return
    }
    $backup = [IO.Path]::GetFullPath($BackupDirectory)
    Assert-PlainPath $backup
    [IO.Directory]::CreateDirectory($backup) | Out-Null
    for ($index=1; $index -le 4; $index++) {
        $target = Join-Path $backup "codex-control-acl.$index.json"
        Assert-PlainPath $target
        if ((Test-Path -LiteralPath $target) -and (Get-Item -LiteralPath $target -Force).PSIsContainer) {
            throw 'Refusing a non-file ACL backup.'
        }
    }
    $base = Join-Path $backup 'codex-control-acl'
    # 只轮换本脚本生成的四份 ACL 备份。
    for ($index=3; $index -ge 1; $index--) {
        $source = "$base.$index.json"
        if ([IO.File]::Exists($source)) { [IO.File]::Copy($source, "$base.$($index+1).json", $true) }
    }
    $record = [pscustomobject]@{ directory=$directory; sddl=$acl.Sddl; at=[DateTimeOffset]::Now.ToString('o') }
    [IO.File]::WriteAllText("$base.1.json", ($record | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
    $secured = New-Object Security.AccessControl.DirectorySecurity
    $secured.SetSecurityDescriptorSddlForm("O:$($userSid.Value)D:P(A;OICI;FA;;;$($userSid.Value))")
    Set-Acl -LiteralPath $directory -AclObject $secured
    $verified = Get-Acl -LiteralPath $directory
    $raw = New-Object Security.AccessControl.RawSecurityDescriptor($verified.Sddl)
    if ($raw.Owner -ne $userSid -or $raw.DiscretionaryAcl.Count -ne 1 -or
        $raw.DiscretionaryAcl[0].SecurityIdentifier -ne $userSid -or
        [int]$raw.DiscretionaryAcl[0].AccessMask -ne 2032127 -or
        [int]$raw.DiscretionaryAcl[0].AceFlags -ne 3 -or -not $verified.AreAccessRulesProtected) {
        throw "The repaired ACL did not match Codex's private-directory contract; restore from $base.1.json."
    }
    [pscustomobject]@{ directory=$directory; state='private'; changed=$true; backup="$base.1.json" } | ConvertTo-Json
} finally {
    if ($null -ne $held) { $held.Dispose() }
}
