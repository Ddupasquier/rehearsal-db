#!/usr/bin/env bash
# Runs only inside the freshly provisioned CI distribution, on its Linux filesystem.
set -euo pipefail
test "$(id -u)" = 0
test "$(uname -m)" = x86_64
grep -Eqi 'microsoft.*WSL2' /proc/sys/kernel/osrelease
cd /opt/rehearsal-ci/source
test ! -e .git
test "$(findmnt -n -o FSTYPE -T "$PWD")" = ext4
export DEBIAN_FRONTEND=noninteractive
export REHEARSAL_UPDATE_CHECK=off
apt-get update -q
apt-get install -y --no-install-recommends ca-certificates curl xz-utils gnupg

tools=/opt/rehearsal-ci/tools
mkdir -m 700 "$tools"
node_version=24.21.0
node_archive="node-v${node_version}-linux-x64.tar.xz"
curl --fail --silent --show-error --location --proto '=https' --connect-timeout 15 --max-time 180 \
  "https://nodejs.org/dist/v${node_version}/${node_archive}" -o "$tools/$node_archive"
curl --fail --silent --show-error --location --proto '=https' --connect-timeout 15 --max-time 30 \
  "https://nodejs.org/dist/v${node_version}/SHASUMS256.txt" -o "$tools/SHASUMS256.txt"
awk -v file="$node_archive" '$2 == file { print }' "$tools/SHASUMS256.txt" > "$tools/node.sha256"
test "$(wc -l < "$tools/node.sha256")" -eq 1
(cd "$tools" && sha256sum --check --strict node.sha256)
mkdir "$tools/node"
tar -xJf "$tools/$node_archive" --strip-components=1 -C "$tools/node"
export PATH="$tools/node/bin:$PATH"
test "$(node --version)" = "v${node_version}"

# Docker's signed apt repository; no Desktop install, daemon TCP listener or remote engine.
install -m 0755 -d /etc/apt/keyrings
curl --fail --silent --show-error --location --proto '=https' --connect-timeout 15 --max-time 30 \
  https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/rehearsal-docker.asc
chmod a+r /etc/apt/keyrings/rehearsal-docker.asc
printf '%s\n' 'deb [arch=amd64 signed-by=/etc/apt/keyrings/rehearsal-docker.asc] https://download.docker.com/linux/ubuntu noble stable' \
  > /etc/apt/sources.list.d/rehearsal-docker.list
apt-get update -q
# This freshly owned distro must not start a second, unowned default daemon.
test ! -e /usr/sbin/policy-rc.d
printf '#!/bin/sh\nexit 101\n' > "$tools/policy-rc.d"
install -m 0755 "$tools/policy-rc.d" /usr/sbin/policy-rc.d
apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io
mkdir -p /run/rehearsal-ci
source scripts/verification/owned_daemon.sh
daemon_executable=$(readlink -f "$(command -v dockerd)")
dockerd --host=unix:///var/run/rehearsal-ci-docker.sock \
  --data-root=/var/lib/rehearsal-ci/docker --exec-root=/run/rehearsal-ci/docker \
  --pidfile=/run/rehearsal-ci/docker.pid > "$tools/dockerd.log" 2>&1 &
daemon_pid=$!
daemon_started=$(owned_daemon_capture "$daemon_pid" "$$" "$daemon_executable" 0) || {
  printf '%s\n' 'Owned CI daemon identity could not be established; no unverified process was signalled.' >&2
  exit 1
}
daemon_cleaned=false
cleanup() {
  local original=$?
  trap - EXIT
  if owned_daemon_cleanup_status "$original" "$daemon_cleaned" "$daemon_pid" "$$" "$daemon_executable" 0 "$daemon_started"; then
    exit 0
  else
    exit $?
  fi
}
trap cleanup EXIT
export DOCKER_HOST=unix:///var/run/rehearsal-ci-docker.sock
ready=false
for attempt in $(seq 1 30); do
  if docker info --format '{{.OSType}}' 2>/dev/null | grep -qx linux; then ready=true; break; fi
  sleep 2
done
test "$ready" = true
docker context create rehearsal-ci --docker host="$DOCKER_HOST"
docker context use rehearsal-ci
docker pull postgres:17-alpine
npm ci --ignore-scripts --no-audit --no-fund
npm run build
node scripts/verification/platform_smoke.mjs
npm run test:fixture:postgresql
npm run test:fixture:dependent
# Passing evidence includes successful bounded cleanup, not just fixture success.
if ! owned_daemon_shutdown "$daemon_pid" "$$" "$daemon_executable" 0 "$daemon_started"; then
  trap - EXIT # Do not renew the same failed cleanup bounds in the EXIT trap.
  printf '%s\n' 'Owned CI daemon cleanup could not be confirmed within its fixed bounds.' >&2
  exit 1
fi
daemon_cleaned=true
node --input-type=module <<'NODE'
import { mkdir, writeFile } from 'node:fs/promises';
import { release } from 'node:os';
await mkdir('test-results/platform', { recursive: true });
await writeFile('test-results/platform/wsl-postgresql.json', `${JSON.stringify({
  schemaVersion: 1, status: 'passed', platform: process.platform, arch: process.arch,
  kernel: release(), node: process.version, filesystem: 'ext4',
  source: 'tracked-git-archive-without-git-directory',
  engine: 'owned-linux-dockerd-unix-socket-only',
  postgresqlFixture: 'passed', dependentTargetFixture: 'passed',
  nativeWindowsRuntime: 'not-exercised', remoteWslEditor: 'not-exercised',
  wslSupabase: 'not-exercised',
}, null, 2)}\n`);
NODE
printf '%s\n' 'WSL2 Linux-filesystem PostgreSQL fixtures passed. Native Windows runtime and Remote-WSL editor remain separate evidence.'
