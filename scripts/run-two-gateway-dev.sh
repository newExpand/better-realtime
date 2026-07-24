#!/usr/bin/env bash
set -euo pipefail

resolve_script_directory() {
  local source=${BASH_SOURCE[0]}
  local directory target
  while [[ -L "$source" ]]; do
    directory=$(cd -P -- "$(dirname -- "$source")" >/dev/null 2>&1 && pwd) || return 1
    target=$(readlink -- "$source") || return 1
    if [[ "$target" == /* ]]; then
      source=$target
    else
      source=$directory/$target
    fi
  done
  cd -P -- "$(dirname -- "$source")" >/dev/null 2>&1 && pwd
}

if ! script_dir=$(resolve_script_directory); then
  echo "failed to resolve the two-gateway harness directory" >&2
  exit 1
fi
if ! repository_root=$(cd -P -- "$script_dir/.." >/dev/null 2>&1 && pwd); then
  echo "failed to resolve the repository root" >&2
  exit 1
fi
container_name=${REALTIME_POSTGRES_CONTAINER_NAME:-"better-realtime-two-gateway-dev-$$"}
container_name_pattern='^better-realtime-two-gateway-[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$'
if [[ ! "$container_name" =~ $container_name_pattern ]]; then
  echo "refusing an unscoped PostgreSQL harness container name" >&2
  exit 1
fi
if [[ ${REALTIME_HARNESS_OWNER_TOKEN+x} == x ]]; then
  owner_token=$REALTIME_HARNESS_OWNER_TOKEN
elif ! owner_token=$(node -e 'const { randomUUID } = require("node:crypto"); process.stdout.write(randomUUID());'); then
  echo "failed to generate a harness owner token" >&2
  exit 1
fi
owner_token_pattern='^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$'
if [[ ! "$owner_token" =~ $owner_token_pattern ]]; then
  echo "refusing an invalid PostgreSQL harness owner token" >&2
  exit 1
fi

cleanup() {
  local inspection container_id observed_owner
  if [[ -n "${readiness_file:-}" ]]; then
    rm -f -- "$readiness_file" || true
  fi
  inspection=$(docker inspect --format '{{.Id}}|{{index .Config.Labels "better-realtime.harness-owner"}}' "$container_name" 2>/dev/null) || return 0
  container_id=${inspection%%|*}
  observed_owner=${inspection#*|}
  local container_id_pattern='^[a-f0-9]{12,64}$'
  if [[ "$observed_owner" == "$owner_token" && "$container_id" =~ $container_id_pattern ]]; then
    docker rm -f -v -- "$container_id" >/dev/null 2>&1 || true
  fi
}

child_pid=
child_ready=0
readiness_file=
requested_signal=
requested_exit_status=0
signal_grace_seconds=${REALTIME_HARNESS_SIGNAL_GRACE_SECONDS:-5}
if [[ ! "$signal_grace_seconds" =~ ^[1-9][0-9]?$ ]] || (( signal_grace_seconds > 30 )); then
  echo "refusing an invalid harness signal grace period" >&2
  exit 1
fi
process_group_alive() {
  [[ -n "$child_pid" ]] && kill -0 -- "-$child_pid" 2>/dev/null
}
signal_child_group() {
  local signal=$1
  if process_group_alive; then
    kill -s "$signal" -- "-$child_pid" 2>/dev/null || true
  elif [[ -n "$child_pid" ]] && kill -0 "$child_pid" 2>/dev/null; then
    kill -s "$signal" "$child_pid" 2>/dev/null || true
  fi
}
forward_signal() {
  local signal=$1 status=$2
  requested_signal=$signal
  requested_exit_status=$status
  if (( child_ready == 1 )); then
    signal_child_group "$signal"
  fi
}

trap cleanup EXIT
trap 'forward_signal INT 130' INT
trap 'forward_signal TERM 143' TERM
trap 'forward_signal HUP 129' HUP

if ! readiness_file=$(mktemp "${TMPDIR:-/tmp}/better-realtime-two-gateway-ready.XXXXXX"); then
  echo "failed to create the harness readiness boundary" >&2
  exit 1
fi
cd "$repository_root"
if (( requested_exit_status != 0 )); then
  exit "$requested_exit_status"
fi
set -m
(
  trap - INT TERM HUP
  printf 'ready\n' > "$readiness_file"
  export REALTIME_POSTGRES_CONTAINER_NAME="$container_name"
  export REALTIME_HARNESS_OWNER_TOKEN="$owner_token"
  exec pnpm exec tsx packages/server-node/src/two-gateway-dev.ts
) &
child_pid=$!
for ((readiness_attempt = 0; readiness_attempt < 500; readiness_attempt += 1)); do
  if [[ $(<"$readiness_file") == ready ]]; then
    child_ready=1
    break
  fi
  if ! kill -0 "$child_pid" 2>/dev/null; then
    break
  fi
  sleep 0.01
done
if (( child_ready != 1 )); then
  signal_child_group KILL
  set +e
  wait "$child_pid"
  child_status=$?
  set -e
  exit "${child_status:-1}"
fi
rm -f -- "$readiness_file"
readiness_file=
if [[ -n "$requested_signal" ]]; then
  signal_child_group "$requested_signal"
fi
set +e
wait "$child_pid"
child_status=$?
if (( requested_exit_status != 0 )); then
  signal_poll_limit=$((signal_grace_seconds * 20))
  for ((signal_poll_attempt = 0; signal_poll_attempt < signal_poll_limit; signal_poll_attempt += 1)); do
    if ! process_group_alive; then
      break
    fi
    sleep 0.05
  done
  if process_group_alive; then
    signal_child_group KILL
  fi
  wait "$child_pid" 2>/dev/null
  child_pid=
  set +m
  set -e
  exit "$requested_exit_status"
fi
child_pid=
set +m
set -e
exit "$child_status"
