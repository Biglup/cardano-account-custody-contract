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

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { DEVNET_DIRECTORY, ENV_PATH, PREPROD_BASE_URL } from '../src/config.js';

/* CONSTANTS ******************************************************************/

/** What this script writes: the parameters preprod reported and the devnet genesis properties. */
const PARAMETERS_PATH = resolve(DEVNET_DIRECTORY, 'preprod-parameters.json');
const NODE_PROPERTIES_PATH = resolve(DEVNET_DIRECTORY, 'node.properties');

/**
 * The parameters of the devnet genesis copied from what preprod reports,
 * as the genesis property name and the field of the parameters endpoint
 * that holds it: the fee, size, deposit, pool, collateral, execution unit
 * limit, protocol version and reference script parameters, with the
 * minimum UTxO cost and the execution unit prices converted below. The
 * cost models are not among them: the devnet image takes them from its
 * own Conway genesis, which the README, Running the devnet, sets against
 * preprod's. The governance and reward parameters stay as the devnet sets
 * them.
 */
const COPIED_PARAMETERS: [string, string][] = [
  ['minFeeA', 'min_fee_a'],
  ['minFeeB', 'min_fee_b'],
  ['maxBlockBodySize', 'max_block_size'],
  ['maxTxSize', 'max_tx_size'],
  ['maxBlockHeaderSize', 'max_block_header_size'],
  ['keyDeposit', 'key_deposit'],
  ['poolDeposit', 'pool_deposit'],
  ['eMax', 'e_max'],
  ['nOpt', 'n_opt'],
  ['minPoolCost', 'min_pool_cost'],
  ['maxValueSize', 'max_val_size'],
  ['collateralPercentage', 'collateral_percent'],
  ['maxCollateralInputs', 'max_collateral_inputs'],
  ['maxTxExUnitsMem', 'max_tx_ex_mem'],
  ['maxTxExUnitsSteps', 'max_tx_ex_steps'],
  ['maxBlockExUnitsMem', 'max_block_ex_mem'],
  ['maxBlockExUnitsSteps', 'max_block_ex_steps'],
  ['protocolMajorVer', 'protocol_major_ver'],
  ['protocolMinorVer', 'protocol_minor_ver'],
  ['minFeeRefScriptCostPerByte', 'min_fee_ref_script_cost_per_byte'],
];

/**
 * The minimum UTxO value is a cost per byte in Babbage and later, which
 * the devnet genesis only takes as the Alonzo cost per word the hard fork
 * divides by this many bytes.
 */
const BYTES_PER_UTXO_WORD = 8;

/** The denominator the devnet genesis takes the execution unit prices as a fraction over. */
const PRICE_DENOMINATOR = 10_000_000;

/**
 * The devnet settings that are the devnet's own rather than preprod's.
 * The network magic is not among them: the devnet image creates its
 * cluster with magic 42 and testnet addresses whatever the properties
 * say, and the library only needs the network id of the addresses and
 * the slot configuration of the chain, which it reads from the genesis
 * the harness copies. Decentralisation is zero, as it is on preprod, and
 * one genesis key is enough to update a chain with a single block
 * producer. The security parameter is small so that the stability window
 * stays well inside the short epoch the devnet runs.
 */
const DEVNET_PARAMETERS: [string, string | number][] = [
  ['decentralisationParam', 0],
  ['updateQuorum', 1],
  ['securityParam', 50],
  ['yaci.store.enabled', 'true'],
];

/* TYPES **********************************************************************/

/** The fields of the preprod parameters this script reads beyond the copied ones. */
interface PreprodParameters extends Record<string, unknown> {
  coins_per_utxo_size: string;
  price_mem: string;
  price_step: string;
}

/* FUNCTIONS ******************************************************************/

/** The parameters of the latest preprod epoch, read with the Blockfrost project id of the environment file. */
const preprodParameters = async (): Promise<PreprodParameters> => {
  loadEnv({ path: ENV_PATH });
  const projectId = process.env['BLOCKFROST_PREPROD_PROJECT_ID'];
  if (!projectId) {
    throw new Error('BLOCKFROST_PREPROD_PROJECT_ID is not set in the environment file');
  }
  const response = await fetch(`${PREPROD_BASE_URL}/epochs/latest/parameters`, { headers: { project_id: projectId } });
  if (!response.ok) {
    throw new Error(`Blockfrost answered the preprod parameters with status ${response.status}`);
  }
  return (await response.json()) as PreprodParameters;
};

/** A decimal price as the numerator over `PRICE_DENOMINATOR` the devnet genesis takes. */
const priceNumerator = (price: string): number => Math.round(Number(price) * PRICE_DENOMINATOR);

/** The value of a copied parameter, or a refusal when preprod reports none. */
const copied = (parameters: PreprodParameters, field: string): string => {
  const value = parameters[field];
  if (value === undefined || value === null) {
    throw new Error(`The preprod parameters report no ${field}`);
  }
  return String(value);
};

/** The properties the devnet genesis is built from: preprod's parameters and the devnet's own settings. */
const nodeProperties = (parameters: PreprodParameters): string =>
  [
    '# The genesis properties of the devnet. Written by scripts/devnet-parameters.ts',
    '# from the preprod parameters endpoint, which preprod-parameters.json records.',
    '# The slot length, the epoch length and the block time are set on the command',
    '# line in docker-compose.yml, since they are the devnet\'s own.',
    '',
    ...DEVNET_PARAMETERS.map(([property, value]) => `${property}=${value}`),
    '',
    ...COPIED_PARAMETERS.map(([property, field]) => `${property}=${copied(parameters, field)}`),
    `lovelacePerUTxOWord=${BigInt(parameters.coins_per_utxo_size) * BigInt(BYTES_PER_UTXO_WORD)}`,
    `prMemNumerator=${priceNumerator(parameters.price_mem)}`,
    `prMemDenominator=${PRICE_DENOMINATOR}`,
    `prStepsNumerator=${priceNumerator(parameters.price_step)}`,
    `prStepsDenominator=${PRICE_DENOMINATOR}`,
    '',
  ].join('\n');

/* MAIN ***********************************************************************/

const main = async (): Promise<void> => {
  const parameters = await preprodParameters();
  writeFileSync(PARAMETERS_PATH, `${JSON.stringify(parameters, null, 2)}\n`);
  writeFileSync(NODE_PROPERTIES_PATH, nodeProperties(parameters));
  console.log(`Preprod parameters written to ${PARAMETERS_PATH}`);
  console.log(`Devnet genesis properties written to ${NODE_PROPERTIES_PATH}`);
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
