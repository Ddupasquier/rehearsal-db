#!/usr/bin/env bash
# Linux-only fixture helper: signals only the direct child whose identity was captured.
owned_daemon_snapshot() {
  local pid=$1 parent=$2 executable=$3 uid=$4 proc_root=${5:-/proc} row tail owner actual
  [[ $pid =~ ^[1-9][0-9]*$ && $parent =~ ^[1-9][0-9]*$ ]] || return 1
  [[ -d $proc_root && -r $proc_root && -x $proc_root && -r "$proc_root/self/stat" ]] || return 1
  if [[ ! -d "$proc_root/$pid" ]]; then
    [[ ! -e "$proc_root/$pid" && ! -L "$proc_root/$pid" ]] || return 1
    return 3
  fi
  [[ -r "$proc_root/$pid/stat" ]] || return 1
  IFS= read -r row < "$proc_root/$pid/stat" || return 1
  tail=${row##*) }
  local -a fields
  read -r -a fields <<< "$tail"
  [[ ${#fields[@]} -ge 20 && ${fields[1]} == "$parent" && ${fields[19]} =~ ^[0-9]+$ ]] || return 1
  owner=$(stat -c %u "$proc_root/$pid") || return 1
  [[ $owner == "$uid" ]] || return 1
  if [[ ${fields[0]} == Z ]]; then printf '%s:exited\n' "${fields[19]}"; return 0; fi
  actual=$(readlink "$proc_root/$pid/exe") || return 1
  [[ $actual == "$executable" ]] || return 1
  printf '%s:live\n' "${fields[19]}"
}
# Linux monotonic elapsed clock. No subprocess clock or wall-clock adjustment.
owned_daemon_now_ms() {
  local uptime ignored whole fraction
  read -r uptime ignored < /proc/uptime || return 1
  [[ $uptime =~ ^[0-9]+\.[0-9]+$ ]] || return 1
  whole=${uptime%.*}; fraction=${uptime#*.}000
  printf '%s\n' "$((10#$whole * 1000 + 10#${fraction:0:3}))"
}
owned_daemon_capture() {
  local pid=$1 parent=$2 executable=$3 uid=$4 snapshot now deadline
  now=$(owned_daemon_now_ms) || return 1
  deadline=$((now+1000))
  while :; do
    if snapshot=$(owned_daemon_snapshot "$pid" "$parent" "$executable" "$uid"); then
      now=$(owned_daemon_now_ms) || return 1
      ((now < deadline)) || return 1
      [[ $snapshot == *:live ]] || return 1
      printf '%s\n' "${snapshot%:*}"; return 0
    fi
    now=$(owned_daemon_now_ms) || return 1
    ((now < deadline)) || return 1
    sleep 0.05
  done
}
owned_daemon_state() {
  local snapshot status
  if snapshot=$(owned_daemon_snapshot "$1" "$2" "$3" "$4"); then
    [[ ${snapshot%:*} == "$5" ]] || return 1
    [[ $snapshot == *:exited ]] && return 3
    return 0
  else
    status=$?
    return "$status"
  fi
}
owned_daemon_shutdown() {
  local pid=$1 parent=$2 executable=$3 uid=$4 started=$5 status phase now deadline duration
  for phase in TERM KILL; do
    duration=30000
    [[ $phase == KILL ]] && duration=2000
    now=$(owned_daemon_now_ms) || return 1
    deadline=$((now+duration))
    if owned_daemon_state "$pid" "$parent" "$executable" "$uid" "$started"; then status=0; else status=$?; fi
    now=$(owned_daemon_now_ms) || return 1
    ((now < deadline)) || return 1
    if [[ $status == 3 ]]; then wait "$pid" 2>/dev/null || true; return 0; fi
    [[ $status == 0 ]] || return 1
    kill -s "$phase" "$pid" || return 1
    while :; do
      # Absolute elapsed bounds include every metadata probe and sleep. They
      # cannot interrupt a kernel-stalled shell builtin or metadata syscall.
      if owned_daemon_state "$pid" "$parent" "$executable" "$uid" "$started"; then status=0; else status=$?; fi
      now=$(owned_daemon_now_ms) || return 1
      if ((now >= deadline)); then break; fi
      if [[ $status == 3 ]]; then wait "$pid" 2>/dev/null || true; return 0; fi
      [[ $status == 0 ]] || return 1
      sleep 0.1
    done
  done
  return 1
}
owned_daemon_cleanup_status() {
  local original=$1 cleaned=$2
  shift 2
  if [[ $cleaned != true ]] && ! owned_daemon_shutdown "$@"; then
    printf '%s\n' 'Owned CI daemon cleanup could not be confirmed within its fixed bounds.' >&2
    [[ $original != 0 ]] || original=1
  fi
  return "$original"
}
