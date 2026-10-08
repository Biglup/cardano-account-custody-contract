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

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PlutusScript } from '@biglup/cometa';
import { Cometa } from './cometa.js';

/* CONSTANTS ******************************************************************/

/** The title every handler of the account validator shares. */
const ACCOUNT_VALIDATOR_TITLE = 'account.account';

/** The blueprint `aiken build` writes at the repository root. */
export const DEFAULT_BLUEPRINT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plutus.json');

/* TYPES **********************************************************************/

/** One validator entry of an Aiken blueprint. */
export interface BlueprintValidator {
  title: string;
  compiledCode: string;
  hash: string;
}

/** The parts of an Aiken blueprint the off-chain code relies on. */
export interface Blueprint {
  preamble: { title: string; plutusVersion: string };
  validators: BlueprintValidator[];
}

/* FUNCTIONS ******************************************************************/

/**
 * Reads a blueprint from disk. The blueprint is read on every call so that a
 * rebuilt validator is picked up without restarting the process.
 */
export const loadBlueprint = (path: string = DEFAULT_BLUEPRINT_PATH): Blueprint =>
  JSON.parse(readFileSync(path, 'utf8')) as Blueprint;

/**
 * The account validator entry of a blueprint. Every handler of a multi
 * purpose validator carries the same compiled code and hash, so the first
 * entry titled after the account validator is representative.
 */
export const accountValidator = (blueprint: Blueprint): BlueprintValidator => {
  const validator = blueprint.validators.find((entry) => entry.title.startsWith(`${ACCOUNT_VALIDATOR_TITLE}.`));
  if (!validator) {
    throw new Error(`The blueprint has no validator titled ${ACCOUNT_VALIDATOR_TITLE}`);
  }
  return validator;
};

/** The account validator as a Plutus V3 script cometa can attach to a transaction. */
export const accountScript = (blueprint: Blueprint = loadBlueprint()): PlutusScript => ({
  type: Cometa.ScriptType.Plutus,
  bytes: accountValidator(blueprint).compiledCode,
  version: Cometa.PlutusLanguageVersion.V3,
});

/**
 * The hash of the account script, which is both the payment credential of
 * every account address and the policy id of every state NFT.
 */
export const accountScriptHash = (script: PlutusScript): string => Cometa.computeScriptHash(script);
