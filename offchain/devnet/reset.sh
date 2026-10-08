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
# Stops the devnet and deletes its chain, its database and the network file
# of the reference scripts it recorded, so that the next start is a fresh
# chain. An account is never deleted, so a reset is what gives a run a
# chain with no account on it.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"

docker compose down -v
rm -rf run
rm -f ../networks/devnet.json
echo "Devnet reset"
