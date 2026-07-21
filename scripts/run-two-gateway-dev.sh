#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
repository_root=${script_dir:h}
container_name=${REALTIME_POSTGRES_CONTAINER_NAME:-"better-realtime-two-gateway-dev-$$"}
container_name_pattern='^better-realtime-two-gateway-[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$'
if [[ ! "$container_name" =~ $container_name_pattern ]]; then
  echo "refusing an unscoped PostgreSQL harness container name" >&2
  exit 1
fi
owner_token=${REALTIME_HARNESS_OWNER_TOKEN:-"$(uuidgen)"}
owner_token_pattern='^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$'
if [[ ! "$owner_token" =~ $owner_token_pattern ]]; then
  echo "refusing an invalid PostgreSQL harness owner token" >&2
  exit 1
fi

cleanup() {
  local inspection container_id observed_owner
  inspection=$(docker inspect --format '{{.Id}}|{{index .Config.Labels "better-realtime.harness-owner"}}' "$container_name" 2>/dev/null) || return 0
  container_id=${inspection%%|*}
  observed_owner=${inspection#*|}
  local container_id_pattern='^[a-f0-9]{12,64}$'
  if [[ "$observed_owner" == "$owner_token" && "$container_id" =~ $container_id_pattern ]]; then
    docker rm -f -v -- "$container_id" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

cd "$repository_root"
REALTIME_POSTGRES_CONTAINER_NAME="$container_name" REALTIME_HARNESS_OWNER_TOKEN="$owner_token" pnpm exec tsx packages/server-node/src/two-gateway-dev.ts
