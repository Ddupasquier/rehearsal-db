# Only GitHub's disposable Windows 2025 runner is in scope. Never adopt a user's distro.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'This provisioner runs only on an isolated GitHub Windows runner.'
}
$distribution = 'Ubuntu-24.04'
$created = $false
$ciRoot = Join-Path $env:RUNNER_TEMP "rehearsal-wsl-$env:GITHUB_RUN_ID-$env:GITHUB_RUN_ATTEMPT"
New-Item -ItemType Directory -Path $ciRoot -ErrorAction Stop | Out-Null
function Invoke-Wsl([string[]] $Command) {
    & wsl.exe --distribution $distribution --user root --exec @Command
    if ($LASTEXITCODE -ne 0) { throw "Owned WSL command failed with exit $LASTEXITCODE." }
}
& wsl.exe --status
if ($LASTEXITCODE -ne 0) { throw 'The runner cannot establish WSL2 availability.' }
$existing = @(& wsl.exe --list --quiet) -join "`n"
if ($LASTEXITCODE -ne 0) {
    # A fresh WSL install can report no distributions with a nonzero exit. Accept
    # that case only when the per-user registration store independently is empty.
    $registrations = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss'
    if ((Test-Path -LiteralPath $registrations) -and
        @(Get-ChildItem -LiteralPath $registrations -ErrorAction Stop).Count -gt 0) {
        throw 'Could not inspect existing registered WSL distributions.'
    }
    $existing = ''
}
if (($existing -replace "`0", '') -match '(?m)^Ubuntu-24\.04\s*$') {
    throw 'Refusing to adopt an existing Ubuntu-24.04 distribution.'
}
try {
    & wsl.exe --install --distribution $distribution --web-download --no-launch
    if ($LASTEXITCODE -ne 0) { throw 'Fresh Ubuntu installation failed.' }
    $created = $true
    & wsl.exe --set-version $distribution 2
    if ($LASTEXITCODE -ne 0) { throw 'The owned distribution must use WSL2.' }
    $archive = Join-Path $ciRoot 'reviewed-source.tar'
    & git archive --format=tar --output=$archive HEAD
    if ($LASTEXITCODE -ne 0) { throw 'Could not archive the reviewed source.' }
    $linuxArchive = @(& wsl.exe --distribution $distribution --user root --exec wslpath -u $archive) -join ''
    if ($LASTEXITCODE -ne 0) { throw 'Could not resolve the task-owned source archive.' }
    Invoke-Wsl -Command @('mkdir', '-m', '700', '-p', '/opt/rehearsal-ci/source')
    Invoke-Wsl -Command @('tar', '-xf', $linuxArchive.Trim(), '-C', '/opt/rehearsal-ci/source')
    Invoke-Wsl -Command @('bash', '/opt/rehearsal-ci/source/scripts/verification/platform_wsl.sh')
    $reports = Join-Path $PWD 'test-results/platform'
    New-Item -ItemType Directory -Path $reports -Force | Out-Null
    $linuxReports = @(& wsl.exe --distribution $distribution --user root --exec wslpath -u $reports) -join ''
    if ($LASTEXITCODE -ne 0) { throw 'Could not resolve the task-owned report destination.' }
    Invoke-Wsl -Command @('cp', '/opt/rehearsal-ci/source/test-results/platform/node-linux-x64.json', $linuxReports.Trim())
    Invoke-Wsl -Command @('cp', '/opt/rehearsal-ci/source/test-results/platform/wsl-postgresql.json', $linuxReports.Trim())
} finally {
    if ($created) {
        & wsl.exe --terminate $distribution
        & wsl.exe --unregister $distribution
        if ($LASTEXITCODE -ne 0) { throw 'Could not remove the task-owned WSL distribution.' }
    }
}
