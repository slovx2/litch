# 定向 ACL 回归：只操作新建的隔离目录，不接触用户 Codex 数据或启动真实模型。
param([Parameter(Mandatory=$true)][string]$FixtureDirectory)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$fixture = [IO.Path]::GetFullPath($FixtureDirectory)
if (Test-Path -LiteralPath $fixture) { throw 'The fixture directory must not already exist.' }
[IO.Directory]::CreateDirectory($fixture) | Out-Null
$repair = Join-Path $PSScriptRoot 'repair-codex-control-windows.ps1'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$source = Join-Path $fixture 'codex'
$directory = Join-Path $source 'app-server-control'
[IO.Directory]::CreateDirectory($directory) | Out-Null
$bad = New-Object Security.AccessControl.DirectorySecurity
$bad.SetSecurityDescriptorSddlForm("O:${sid}D:AI(A;OICI;FA;;;${sid})(A;OICI;FA;;;BA)")
Set-Acl -LiteralPath $directory -AclObject $bad
$initial = (Get-Acl -LiteralPath $directory).Sddl
$preview = (& $repair -CodexHome $source -BackupDirectory (Join-Path $fixture 'backups')) | ConvertFrom-Json
if ($preview.changed -or (Get-Acl -LiteralPath $directory).Sddl -ne $initial) { throw 'Preview changed the ACL.' }
Write-Output 'PASS preview does not change ACL'
for ($index=0; $index -lt 5; $index++) {
    Set-Acl -LiteralPath $directory -AclObject $bad
    $result = (& $repair -CodexHome $source -BackupDirectory (Join-Path $fixture 'backups') -Apply) | ConvertFrom-Json
    if (-not $result.changed -or $result.state -ne 'private') { throw 'Repair did not protect the directory.' }
}
if (@(Get-ChildItem -LiteralPath (Join-Path $fixture 'backups')).Count -ne 4) { throw 'ACL backups were not bounded to four.' }
Write-Output 'PASS protected current-user-only ACL and four backups'
$again = (& $repair -CodexHome $source -BackupDirectory (Join-Path $fixture 'backups') -Apply) | ConvertFrom-Json
if ($again.changed -or $again.state -ne 'already-private') { throw 'Repeated repair changed a private ACL.' }
Write-Output 'PASS private ACL is unchanged'
$unknown = Join-Path $directory 'other-file'
[IO.File]::WriteAllText($unknown, 'fixture')
$refused = $false
try { & $repair -CodexHome $source -BackupDirectory (Join-Path $fixture 'backups') -Apply | Out-Null } catch { $refused = $true }
if (-not $refused) { throw 'Repair accepted unknown directory contents.' }
Write-Output 'PASS unknown contents are refused'
[IO.File]::Delete($unknown)
$lock = Join-Path $directory 'app-server-startup.lock'
$held = [IO.File]::Open($lock, [IO.FileMode]::Create, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {
    $refused = $false
    try { & $repair -CodexHome $source -BackupDirectory (Join-Path $fixture 'backups') -Apply | Out-Null } catch { $refused = $true }
    if (-not $refused) { throw 'Repair accepted a held startup lock.' }
} finally { $held.Dispose() }
Write-Output 'PASS active startup lock is refused'
Write-Output 'All ACL repair checks passed. The isolated fixture is retained for inspection.'
