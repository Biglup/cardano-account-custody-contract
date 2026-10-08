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

/** The title every handler of the account proxy validator shares. */
const ACCOUNT_VALIDATOR_TITLE = 'account.account';

/** The prefix of the module title of every logic version: `logic_v1`, `logic_v2` and so on. */
const LOGIC_MODULE_PREFIX = 'logic_';

/** The module titles of the logic versions the blueprint carries, each applied to the proxy hash to become a logic credential. */
export const LOGIC_V1_TITLE = 'logic_v1.logic_v1';
export const LOGIC_V2_TITLE = 'logic_v2.logic_v2';

/**
 * The title of the logic version this library pins: the one a new account
 * runs unless its creator names another, and the one the builders apply to
 * the proxy hash to attach the logic.
 */
export const CURRENT_LOGIC_TITLE = LOGIC_V1_TITLE;

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

/** The module title of a validator entry: everything before its handler name. */
const moduleTitleOf = (validator: BlueprintValidator): string => validator.title.slice(0, validator.title.lastIndexOf('.'));

/**
 * The account proxy validator entry of a blueprint. Every handler of a
 * multi purpose validator carries the same compiled code and hash, so the
 * first entry titled after the proxy is representative.
 */
export const accountValidator = (blueprint: Blueprint): BlueprintValidator => {
  const validator = blueprint.validators.find((entry) => entry.title.startsWith(`${ACCOUNT_VALIDATOR_TITLE}.`));
  if (!validator) {
    throw new Error(`The blueprint has no validator titled ${ACCOUNT_VALIDATOR_TITLE}`);
  }
  return validator;
};

/** The account proxy as a Plutus V3 script cometa can attach to a transaction. */
export const accountScript = (blueprint: Blueprint = loadBlueprint()): PlutusScript => ({
  type: Cometa.ScriptType.Plutus,
  bytes: accountValidator(blueprint).compiledCode,
  version: Cometa.PlutusLanguageVersion.V3,
});

/**
 * The hash of the account proxy, which is both the payment credential of
 * every account address and the policy id of every account token.
 */
export const accountScriptHash = (script: PlutusScript): string => Cometa.computeScriptHash(script);

/**
 * The logic validator entries of a blueprint, one per logic version in
 * module order, each still parameterised by the proxy hash. Every handler
 * of a version carries the same compiled code, so the first entry of each
 * module is representative.
 */
export const logicValidators = (blueprint: Blueprint): BlueprintValidator[] => {
  const versions = new Map<string, BlueprintValidator>();
  for (const validator of blueprint.validators) {
    const title = moduleTitleOf(validator);
    if (title.startsWith(LOGIC_MODULE_PREFIX) && !versions.has(title)) {
      versions.set(title, validator);
    }
  }
  return [...versions.values()];
};

/** The logic validator entry of a blueprint with the given module title, the current version's when none is given. */
export const logicValidator = (blueprint: Blueprint, title: string = CURRENT_LOGIC_TITLE): BlueprintValidator => {
  const validator = logicValidators(blueprint).find((entry) => moduleTitleOf(entry) === title);
  if (!validator) {
    throw new Error(`The blueprint has no logic validator titled ${title}`);
  }
  return validator;
};
