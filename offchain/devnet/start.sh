#!/usr/bin/env bash
#
# Copyright 2026 IOG.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#
# Starts the devnet on a fresh chain, waits until its Blockfrost compatible
# API answers and copies the Shelley genesis of the cluster it created to
# run/, from which the runs read the slot configuration of the chain. The
# devnet creates its cluster from scratch on every start, so the chain of a
# previous start and the reference scripts it recorded are deleted first.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"

store_url="${DEVNET_STORE_URL:-http://localhost:8080/api/v1}"
admin_url="${DEVNET_ADMIN_URL:-http://localhost:10000/local-cluster/api}"
genesis_in_cluster="run/clusters/nodes/default/node/genesis/shelley-genesis.json"
ready_timeout="${DEVNET_READY_TIMEOUT:-300}"

docker compose down -v >/dev/null 2>&1 || true
rm -rf run
rm -f ../networks/devnet.json
mkdir -p run/clusters
docker compose up -d

echo "Waiting for the devnet to answer at ${store_url}"
deadline=$((SECONDS + ready_timeout))
until curl -fsS -o /dev/null "${store_url}/blocks/latest" 2>/dev/null; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "The devnet did not answer at ${store_url} within ${ready_timeout} seconds" >&2
    docker compose logs --tail 40 >&2
    exit 1
  fi
  sleep 2
done

echo "Waiting for the devnet to report the protocol parameters"
until [ "$(curl -fsS "${store_url}/epochs/latest/parameters" | grep -c cost_models_raw || true)" -gt 0 ]; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "The devnet never reported its protocol parameters" >&2
    exit 1
  fi
  sleep 2
done

cp "$genesis_in_cluster" run/shelley-genesis.json
echo "Devnet ready"
echo "  Blockfrost compatible API : ${store_url}"
echo "  Admin API                 : ${admin_url}"
echo "  Shelley genesis           : $(cd "$here" && pwd)/run/shelley-genesis.json"
