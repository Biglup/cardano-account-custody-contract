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

import type { PlutusScript } from '@biglup/cometa';
import { type Blueprint, type BlueprintValidator, CURRENT_LOGIC_TITLE, loadBlueprint, logicValidator, logicValidators } from './blueprint.js';
import { Cometa } from './cometa.js';
import { bytes } from './data.js';
import { applyParameters } from './stake-script.js';

/* TYPES **********************************************************************/

/**
 * The logic scripts a builder can attach, by hash: every version the
 * blueprint carries applied to the proxy hash, plus any version given
 * alongside. A control UTxO names its logic by hash, so the builder looks
 * the script up here to run it, embedded or through its reference script.
 */
export type LogicCatalog = Map<string, PlutusScript>;

/* FUNCTIONS ******************************************************************/

/**
 * A logic version applied to the proxy hash, as the Aiken CLI would apply
 * it. Its hash is the stake credential the proxy requires a withdrawal
 * from whenever a control UTxO naming it is spent or referenced.
 */
export const logicScript = (validator: BlueprintValidator, proxyHash: string): PlutusScript => ({
  type: Cometa.ScriptType.Plutus,
  bytes: applyParameters(validator.compiledCode, [bytes(proxyHash)]),
  version: Cometa.PlutusLanguageVersion.V3,
});

/** The hash of a logic script, which is the credential its zero withdrawal draws from and the pointer a control datum names. */
export const logicScriptHash = (script: PlutusScript): string => Cometa.computeScriptHash(script);

/** The logic version this library pins, applied to the proxy hash. */
export const currentLogicScript = (proxyHash: string, blueprint: Blueprint = loadBlueprint()): PlutusScript =>
  logicScript(logicValidator(blueprint, CURRENT_LOGIC_TITLE), proxyHash);

/** The hash of the logic version this library pins, applied to the proxy hash: what a new account runs unless its creator names another. */
export const currentLogicHash = (proxyHash: string, blueprint: Blueprint = loadBlueprint()): string =>
  logicScriptHash(currentLogicScript(proxyHash, blueprint));

/** Every logic version the blueprint carries, applied to the proxy hash, in module order. */
export const blueprintLogicScripts = (proxyHash: string, blueprint: Blueprint = loadBlueprint()): PlutusScript[] =>
  logicValidators(blueprint).map((validator) => logicScript(validator, proxyHash));

/**
 * The catalog of logic scripts a builder can attach for accounts under a
 * proxy: the blueprint's versions applied to the proxy hash and the extra
 * scripts given, each keyed by its hash.
 */
export const logicCatalog = (proxyHash: string, extra: PlutusScript[] = [], blueprint: Blueprint = loadBlueprint()): LogicCatalog =>
  new Map([...blueprintLogicScripts(proxyHash, blueprint), ...extra].map((script) => [logicScriptHash(script), script]));
