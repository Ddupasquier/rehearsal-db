param(
  [Parameter(Position = 0)][string]$Project,
  [string]$Distribution,
  [string]$NodePath = 'node',
  [switch]$InstallCli,
  [switch]$InstallExtension,
  [switch]$Install
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT') { throw 'Use this helper on Windows; use the Linux or macOS helper on those hosts.' }
$Wsl = Get-Command wsl.exe -ErrorAction SilentlyContinue
if (-not $Wsl) { throw 'WSL is not installed. Set up WSL 2 manually first. This helper never installs Windows features or changes security settings.' }
$Inventory = (& $Wsl.Source --list --verbose | Out-String).Replace([string][char]0, '')
if ($LASTEXITCODE -ne 0) { throw 'WSL distribution inspection failed; no setup was attempted.' }
if (-not $Distribution -or -not $Project) {
  Write-Output $Inventory
  Write-Output 'Check an existing Linux-home project: .\setup.ps1 -Distribution Ubuntu -Project "/home/you/my app"'
  Write-Output 'Default is check only. Add -InstallCli to explicitly install the CLI, then use the Remote - WSL Extensions view for the editor. No distribution, Node, Docker or database is installed or started by this check.'
  exit 0
}
if ($Distribution.StartsWith('-') -or $Distribution -match '[\x00-\x1f\x7f"]' -or $Project -match '[\x00-\x1f\x7f"\\]') {
  throw 'Choose distribution and Linux paths without control characters, double quotes or Windows separators. This helper will not guess native argument escaping.'
}
if ($NodePath -ne 'node' -and (-not $NodePath.StartsWith('/') -or $NodePath -match '[\x00-\x1f\x7f"\\]')) {
  throw '-NodePath must be an absolute Linux Node executable path, without control characters, double quotes or Windows separators.'
}
if ($Install -or $InstallExtension) {
  throw 'No installation was started. Use -InstallCli for the CLI, then open VS Code Remote - WSL and install Rehearsal DB from that window''s Extensions view. This helper will not guess the editor host.'
}
$Row = '(?m)^\s*\*?\s*' + [regex]::Escape($Distribution) + '\s+.+\s+2\s*$'
if ($Inventory -notmatch $Row) { throw 'The selected distribution is not proven WSL 2. Review wsl --list --verbose; this helper never converts a distribution.' }
if (-not $Project.StartsWith('/') -or $Project.StartsWith('/mnt/') -or $Project.Contains([string][char]0)) {
  throw 'Choose an existing absolute Linux-home project path, not a Windows path or /mnt/c. Existing projects are never moved automatically.'
}
$SharedWindows = (Resolve-Path (Join-Path $PSScriptRoot '../shared/setup.mjs')).Path
$SharedLinux = (& $Wsl.Source --distribution $Distribution --exec wslpath -a -u $SharedWindows | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or -not $SharedLinux.StartsWith('/')) { throw 'Could not resolve the shared setup helper inside WSL.' }
$Arguments = @('--distribution', $Distribution, '--cd', $Project, '--exec', $NodePath, $SharedLinux, '--platform=windows-wsl', '--project', $Project)
if ($Install -or $InstallCli) { $Arguments += '--install-cli' }
if ($Install -or $InstallExtension) { $Arguments += '--install-extension' }
& $Wsl.Source @Arguments
if ($LASTEXITCODE -ne 0) { throw 'WSL setup stopped. Read its diagnostic above; no automatic retry or native-Windows fallback was attempted.' }
