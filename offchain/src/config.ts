/**
 * Copyright 2026 IOG.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/* IMPORTS ********************************************************************/

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SlotConfig } from '@biglup/cometa';
import { Cometa } from './cometa.js';

/* CONSTANTS ******************************************************************/

/** The package directory, the repository root and the devnet harness directory. */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = resolve(PACKAGE_ROOT, '..');
export const DEVNET_DIRECTORY = resolve(PACKAGE_ROOT, 'devnet');

/** The environment file holding the Blockfrost project id and the funding mnemonic. */
export const ENV_PATH = resolve(REPO_ROOT, '.env');

/** Where the devnet harness copies what a run needs from the cluster it created. */
const DEVNET_RUN_DIRECTORY = resolve(DEVNET_DIRECTORY, 'run');
const DEVNET_GENESIS_PATH = resolve(DEVNET_RUN_DIRECTORY, 'shelley-genesis.json');

/** The environment of a devnet run, which is committed since the devnet keys are not secret. */
const DEVNET_ENV_PATH = resolve(DEVNET_DIRECTORY, 'devnet.env');

/** The Blockfrost endpoints the runs talk to: the hosted preprod one and the local devnet one. */
export const PREPROD_BASE_URL = 'https://cardano-preprod.blockfrost.io/api/v0';
const DEVNET_BASE_URL = 'http://localhost:8080/api/v1';

/** The networks a run can target, as the `CARDANO_NETWORK` variable names them. */
export const PREPROD_NETWORK = 'preprod';
export const DEVNET_NETWORK = 'devnet';

/**
 * The network magic the library is given for the devnet. The devnet chain
 * itself runs the magic of the cluster the devnet image creates, 42, with
 * testnet addresses; cometa takes a magic only to pick the network id of
 * the addresses it derives and a slot configuration for the wallet, and
 * puts it in no transaction, address or request, so preprod's magic gives
 * the testnet network id the chain expects and a slot configuration the
 * run replaces with the one read from the devnet genesis. The magic goes
 * through the node on submission, which checks nothing against it.
 */
const DEVNET_NETWORK_MAGIC = Cometa.NetworkMagic.Preprod;

/* TYPES **********************************************************************/

/**
 * Where a run submits and reads from: the network name whose reference
 * scripts it uses, the Blockfrost compatible base URL, the project id the
 * endpoint wants, the network magic and the slot configuration the chain
 * behind the endpoint runs with.
 */
export interface ProviderConfiguration {
  network: string;
  baseUrl: string;
  projectId: string;
  networkMagic: number;
  slotConfig: SlotConfig;
}

/* FUNCTIONS ******************************************************************/

/** The slot configuration of a chain whose Shelley genesis starts at a time and runs slots of a length. */
const slotConfigOf = (systemStart: string, slotLength: number): SlotConfig => {
  const zeroTime = Date.parse(systemStart);
  if (Number.isNaN(zeroTime)) {
    throw new Error(`${systemStart} is not a system start time`);
  }
  if (!Number.isFinite(slotLength) || slotLength <= 0) {
    throw new Error(`${slotLength} is not a slot length in seconds`);
  }
  return { zeroTime: BigInt(zeroTime), zeroSlot: 0n, slotLength: BigInt(Math.round(slotLength * 1000)) };
};

/**
 * The slot configuration of the running devnet, read from the Shelley
 * genesis the harness copied out of the cluster it created. A devnet is
 * created fresh, so its system start is only known once it runs.
 */
const devnetSlotConfig = (path: string = DEVNET_GENESIS_PATH): SlotConfig => {
  if (!existsSync(path)) {
    throw new Error(`${path} does not exist; start the devnet with "npm run devnet:start" before running against it`);
  }
  const genesis = JSON.parse(readFileSync(path, 'utf8')) as { systemStart?: string; slotLength?: number };
  if (typeof genesis.systemStart !== 'string' || typeof genesis.slotLength !== 'number') {
    throw new Error(`${path} does not record a system start and a slot length`);
  }
  return slotConfigOf(genesis.systemStart, genesis.slotLength);
};

/**
 * Loads the environment of a run and returns the network it targets. A
 * run the process environment points at the devnet, as the devnet npm
 * scripts do, loads only the committed devnet environment, whose keys
 * and endpoint belong to the chain the harness creates, so the project
 * id and the funding mnemonic of the repository file never enter it. Any
 * other run loads the repository file, and the devnet environment on top
 * when that file names the devnet.
 */
export const loadRunEnvironment = (load: (options: { path: string; override?: boolean }) => unknown, env: NodeJS.ProcessEnv = process.env): string => {
  /** The network the environment names, preprod when it names none. */
  const named = (): string => env['CARDANO_NETWORK']?.trim() || PREPROD_NETWORK;
  if (named() === DEVNET_NETWORK) {
    load({ path: DEVNET_ENV_PATH, override: true });
    return DEVNET_NETWORK;
  }
  load({ path: ENV_PATH });
  if (named() === DEVNET_NETWORK) {
    load({ path: DEVNET_ENV_PATH, override: true });
  }
  return named();
};

/**
 * Where this run submits and reads from, taken from the environment:
 * `CARDANO_NETWORK` picks preprod or the devnet, `PROVIDER_BASE_URL`
 * overrides the endpoint of either, and `BLOCKFROST_PREPROD_PROJECT_ID`
 * carries the project id preprod wants. The devnet endpoint wants none,
 * and its slot configuration follows the chain it created, read from the
 * genesis the harness copied, rather than preprod's.
 */
export const providerConfiguration = (env: NodeJS.ProcessEnv = process.env, genesisPath: string = DEVNET_GENESIS_PATH): ProviderConfiguration => {
  const network = env['CARDANO_NETWORK']?.trim() || PREPROD_NETWORK;
  if (network !== PREPROD_NETWORK && network !== DEVNET_NETWORK) {
    throw new Error(`CARDANO_NETWORK is ${network}, which is neither ${PREPROD_NETWORK} nor ${DEVNET_NETWORK}`);
  }
  const override = env['PROVIDER_BASE_URL']?.trim();
  if (network === DEVNET_NETWORK) {
    return {
      network,
      baseUrl: override || DEVNET_BASE_URL,
      projectId: '',
      networkMagic: DEVNET_NETWORK_MAGIC,
      slotConfig: devnetSlotConfig(genesisPath),
    };
  }
  const projectId = env['BLOCKFROST_PREPROD_PROJECT_ID']?.trim();
  if (!projectId) {
    throw new Error('BLOCKFROST_PREPROD_PROJECT_ID is not set in the environment file');
  }
  return {
    network,
    baseUrl: override || PREPROD_BASE_URL,
    projectId,
    networkMagic: Cometa.NetworkMagic.Preprod,
    slotConfig: Cometa.CARDANO_PREPROD_SLOT_CONFIG,
  };
};
