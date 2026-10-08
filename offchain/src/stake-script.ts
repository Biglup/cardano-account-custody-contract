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

import { DataB } from '@harmoniclabs/plutus-data';
import { Application, UPLCConst, UPLCProgram, compileUPLC, parseUPLC } from '@harmoniclabs/uplc';
import type { Credential, PlutusScript } from '@biglup/cometa';
import { type Blueprint, type BlueprintValidator, loadBlueprint } from './blueprint.js';
import { Cometa } from './cometa.js';
import { bytes } from './data.js';

/* CONSTANTS ******************************************************************/

/** The title every handler of the account stake validator shares. */
const STAKE_VALIDATOR_TITLE = 'account_stake.account_stake';

/* FUNCTIONS ******************************************************************/

/**
 * The account stake validator entry of a blueprint, still parameterised by
 * the owner key hash and the account script hash. Every handler carries the
 * same compiled code and hash, so the first entry is representative.
 */
export const stakeValidator = (blueprint: Blueprint): BlueprintValidator => {
  const validator = blueprint.validators.find((entry) => entry.title.startsWith(`${STAKE_VALIDATOR_TITLE}.`));
  if (!validator) {
    throw new Error(`The blueprint has no validator titled ${STAKE_VALIDATOR_TITLE}`);
  }
  return validator;
};

/** The flat encoded program a blueprint's compiled code wraps in a CBOR byte string. */
const unwrapCompiledCode = (compiledCode: string): Uint8Array => Cometa.CborReader.fromHex(compiledCode).readByteString();

/** A flat encoded program wrapped in a CBOR byte string, as a blueprint carries it. */
const wrapCompiledCode = (program: Uint8Array): string => Cometa.uint8ArrayToHex(new Cometa.CborWriter().writeByteString(program).encode());

/**
 * Applies parameters to the compiled code of a parameterised validator the
 * way `aiken blueprint apply` does: the program's body is applied to each
 * parameter in turn, every parameter given as a Plutus data constant
 * holding its bytes, and the program is encoded again. The result is the
 * compiled code of the validator with those parameters fixed, byte for
 * byte what the Aiken CLI produces.
 */
export const applyParameters = (compiledCode: string, parameters: Uint8Array[]): string => {
  const program = parseUPLC(unwrapCompiledCode(compiledCode), 'flat');
  const body = parameters.reduce(
    (applied, parameter) => new Application(applied, UPLCConst.data(new DataB(parameter))),
    program.body,
  );
  return wrapCompiledCode(compileUPLC(new UPLCProgram(program.version, body)));
};

/**
 * The stake script of an account: the account stake validator applied to
 * the account's initial device key as `owner` and to the account script
 * hash. Its hash is the account's stake credential, which the account
 * address carries as its stake part and which names the account's state
 * NFT. The script must be attached as a witness to every transaction that
 * registers, delegates or withdraws from that credential.
 */
export const stakeScript = (owner: string, accountScriptHash: string, blueprint: Blueprint = loadBlueprint()): PlutusScript => ({
  type: Cometa.ScriptType.Plutus,
  bytes: applyParameters(stakeValidator(blueprint).compiledCode, [bytes(owner), bytes(accountScriptHash)]),
  version: Cometa.PlutusLanguageVersion.V3,
});

/** The hash of an account's stake script, which is the account's stake credential. */
export const stakeScriptHash = (script: PlutusScript): string => Cometa.computeScriptHash(script);

/** The stake credential of an account, as a script credential of its stake script hash. */
export const stakeCredential = (stakeScriptHash: string): Credential => ({
  hash: stakeScriptHash,
  type: Cometa.CredentialType.ScriptHash,
});
