#!/usr/bin/env bash
set -euo pipefail

container_name="better-realtime-pg-test-$$"
container_id=""
database_user="postgres"
database_password="realtime"
database_name="realtime"

cleanup() {
  if [[ -n "$container_id" ]]; then
    docker rm -f -v -- "$container_id" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

container_id="$(docker run --rm -d \
  --name "$container_name" \
  -e "POSTGRES_USER=$database_user" \
  -e "POSTGRES_PASSWORD=$database_password" \
  -e "POSTGRES_DB=$database_name" \
  -p 127.0.0.1::5432 \
  postgres:18.4-alpine)"
container_id_pattern='^[a-f0-9]{12,64}$'
if [[ ! "$container_id" =~ $container_id_pattern ]]; then
  echo "Docker returned an invalid PostgreSQL container ID" >&2
  exit 1
fi

mapped_port="$(docker port "$container_name" 5432/tcp | sed -n 's/.*://p' | head -n 1)"
if [[ ! "$mapped_port" =~ ^[0-9]+$ ]]; then
  echo "Could not resolve the temporary PostgreSQL host port" >&2
  exit 1
fi

for attempt in {1..30}; do
  if docker exec "$container_name" pg_isready -U "$database_user" -d "$database_name" >/dev/null 2>&1; then
    postgres_scheme='postgresql://'
    POSTGRES_URL="${postgres_scheme}${database_user}:${database_password}@127.0.0.1:${mapped_port}/${database_name}" corepack pnpm test:postgres
    POSTGRES_URL="${postgres_scheme}${database_user}:${database_password}@127.0.0.1:${mapped_port}/${database_name}" corepack pnpm compatibility:postgres
    exit 0
  fi
  sleep 1
done

echo "PostgreSQL 18.4 did not become ready" >&2
exit 1
