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

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { accountScript, accountScriptHash, loadBlueprint } from '../src/blueprint.js';
import { Cometa } from '../src/cometa.js';
import { bytes } from '../src/data.js';
import { accountByOwner } from '../src/discovery.js';
import { applyParameters, stakeCredential, stakeScript, stakeScriptHash, stakeValidator } from '../src/stake-script.js';
import { OWNER_PAYMENT_KEY } from './support/account.js';

/* CONSTANTS ******************************************************************/

/**
 * The fixture was produced once with the Aiken CLI from the committed
 * blueprint, applying the owner key hash `aa` repeated 28 times and then
 * the account script hash `6f275cca0cc4433e6a798d78a2db2934df60dc4fd989274a2d9bb434`,
 * each given as the CBOR of its bytes:
 *
 *   aiken blueprint apply -m account_stake -o step1.json 581caaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
 *   aiken blueprint apply -i step1.json -m account_stake -o step2.json 581c6f275cca0cc4433e6a798d78a2db2934df60dc4fd989274a2d9bb434
 *   aiken blueprint hash -i step2.json -m account_stake
 *
 * The hash printed for step2.json is `APPLIED_HASH`, the hash step1.json
 * reports is `OWNER_APPLIED_HASH`, and `APPLIED_CODE_DIGEST` is the
 * SHA-256 digest of the compiled code step2.json carries, which pins
 * the applied bytes without embedding them.
 */
const ACCOUNT_HASH = '6f275cca0cc4433e6a798d78a2db2934df60dc4fd989274a2d9bb434';
const OWNER_APPLIED_HASH = '9dd1e39d6530b018cca0f773e46332c35a2b59a060bcb41924772157';
const APPLIED_HASH = '6d3dcfd41caf993158118689d8196c3401eb8244070335d2e3bd6b5d';
const APPLIED_CODE_DIGEST = 'b49c09920f866a051c5414f14d35a9413f20a9b0c9b6db0623daf2c91041b5a0';

/* FUNCTIONS ******************************************************************/

/** The SHA-256 digest of a blueprint's compiled code, hex encoded. */
const digestOf = (compiledCode: string): string => createHash('sha256').update(bytes(compiledCode)).digest('hex');

/* TESTS **********************************************************************/

describe('stake script', () => {
  const blueprint = loadBlueprint();

  it('loads the parameterised stake validator from the blueprint', () => {
    const validator = stakeValidator(blueprint);
    expect(validator.title.startsWith('account_stake.account_stake.')).toBe(true);
    expect(validator.hash).not.toBe(accountScriptHash(accountScript(blueprint)));
    expect(() => stakeValidator({ preamble: { title: 'x', plutusVersion: 'v3' }, validators: [] })).toThrow(/account_stake/);
  });

  it('applies the owner and the account script hash exactly as the Aiken CLI does', () => {
    const compiledCode = stakeValidator(blueprint).compiledCode;
    const ownerApplied = applyParameters(compiledCode, [bytes(OWNER_PAYMENT_KEY)]);
    expect(Cometa.computeScriptHash({ type: Cometa.ScriptType.Plutus, bytes: ownerApplied, version: Cometa.PlutusLanguageVersion.V3 })).toBe(
      OWNER_APPLIED_HASH,
    );
    const applied = applyParameters(compiledCode, [bytes(OWNER_PAYMENT_KEY), bytes(ACCOUNT_HASH)]);
    expect(applyParameters(ownerApplied, [bytes(ACCOUNT_HASH)])).toBe(applied);
    expect(digestOf(applied)).toBe(APPLIED_CODE_DIGEST);
    expect(Cometa.computeScriptHash({ type: Cometa.ScriptType.Plutus, bytes: applied, version: Cometa.PlutusLanguageVersion.V3 })).toBe(APPLIED_HASH);
  });

  it('leaves the unapplied code as the blueprint reports it', () => {
    const validator = stakeValidator(blueprint);
    expect(applyParameters(validator.compiledCode, [])).toBe(validator.compiledCode);
    expect(stakeScriptHash({ type: Cometa.ScriptType.Plutus, bytes: validator.compiledCode, version: Cometa.PlutusLanguageVersion.V3 })).toBe(
      validator.hash,
    );
  });

  it('derives a per owner stake script whose hash is the account stake credential', () => {
    expect(accountScriptHash(accountScript(blueprint))).toBe(ACCOUNT_HASH);
    const script = stakeScript(OWNER_PAYMENT_KEY, ACCOUNT_HASH, blueprint);
    expect(script.version).toBe(Cometa.PlutusLanguageVersion.V3);
    expect(stakeScriptHash(script)).toBe(APPLIED_HASH);
    expect(stakeScriptHash(stakeScript(OWNER_PAYMENT_KEY, ACCOUNT_HASH))).toBe(APPLIED_HASH);
    expect(stakeScriptHash(stakeScript('bb'.repeat(28), ACCOUNT_HASH, blueprint))).not.toBe(APPLIED_HASH);
    expect(stakeScriptHash(stakeScript(ACCOUNT_HASH, OWNER_PAYMENT_KEY, blueprint))).not.toBe(APPLIED_HASH);
    expect(stakeCredential(APPLIED_HASH)).toEqual({ hash: APPLIED_HASH, type: Cometa.CredentialType.ScriptHash });
    expect(accountByOwner(OWNER_PAYMENT_KEY, blueprint).stakeScriptHash).toBe(APPLIED_HASH);
  });
});
