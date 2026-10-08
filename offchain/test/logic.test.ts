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
import { accountScript, accountScriptHash, loadBlueprint, logicValidator } from '../src/blueprint.js';
import { Cometa } from '../src/cometa.js';
import { bytes } from '../src/data.js';
import { blueprintLogicScripts, currentLogicHash, currentLogicScript, logicCatalog, logicScript, logicScriptHash } from '../src/logic.js';
import { applyParameters } from '../src/stake-script.js';
import { LOGIC_V2_PARAMETER, logicV1, logicV1Hash, logicV2, logicV2Hash } from './support/account.js';

/* CONSTANTS ******************************************************************/

/**
 * The fixture was produced once with the Aiken CLI from the committed
 * blueprint, applying the proxy hash and, for the second version of the
 * tests, `LOGIC_V2_PARAMETER`, each given as the CBOR of its bytes:
 *
 *   aiken blueprint apply -m logic_v1 -o applied.json 581ced61963ac94d12c0b320be5a336c36af66bc02c380e0aa3001899253
 *   aiken blueprint apply -m logic_v1 -o second.json 581c02020202020202020202020202020202020202020202020202020202
 *
 * `UNAPPLIED_HASH` is the hash the committed blueprint reports for the
 * logic, `APPLIED_HASH` and `SECOND_HASH` are the hashes the two applied
 * blueprints report, and the digests are the SHA-256 of the compiled code
 * each carries, which pin the applied bytes without embedding them.
 */
const PROXY_HASH = 'ed61963ac94d12c0b320be5a336c36af66bc02c380e0aa3001899253';
const UNAPPLIED_HASH = '7cf7daa6c0a5825e23a9dadece990d5a602fa1508d01f061eacaed52';
const APPLIED_HASH = '2cd68e398bdf9fbc8d257614b54403451ee722520ec785fe14f8df5a';
const APPLIED_CODE_DIGEST = '467631d56f1c7ba59adc931ca24953be2f2abb0ac4f2bdbf17a2ac9a2a847a48';
const SECOND_HASH = 'eca396abf77a650eccc852252e0d7c001dd3d63a57fc2a9c75665f6b';
const SECOND_CODE_DIGEST = 'cddf41f55aae557ff72e7e6705c093433d5e98ac22601c84732acd046ccd835e';

/* FUNCTIONS ******************************************************************/

/** The SHA-256 digest of a script's compiled code, hex encoded. */
const digestOf = (compiledCode: string): string => createHash('sha256').update(bytes(compiledCode)).digest('hex');

/* TESTS **********************************************************************/

describe('logic script', () => {
  const blueprint = loadBlueprint();

  it('applies the proxy hash exactly as the Aiken CLI does', () => {
    expect(accountScriptHash(accountScript(blueprint))).toBe(PROXY_HASH);
    expect(logicValidator(blueprint).hash).toBe(UNAPPLIED_HASH);
    const script = logicScript(logicValidator(blueprint), PROXY_HASH);
    expect(script.version).toBe(Cometa.PlutusLanguageVersion.V3);
    expect(logicScriptHash(script)).toBe(APPLIED_HASH);
    expect(digestOf(script.bytes)).toBe(APPLIED_CODE_DIGEST);
    expect(script.bytes).toBe(applyParameters(logicValidator(blueprint).compiledCode, [bytes(PROXY_HASH)]));
  });

  it('pins the current version as what a new account runs', () => {
    expect(currentLogicHash(PROXY_HASH)).toBe(APPLIED_HASH);
    expect(currentLogicHash(PROXY_HASH, blueprint)).toBe(APPLIED_HASH);
    expect(logicScriptHash(currentLogicScript(PROXY_HASH))).toBe(APPLIED_HASH);
    expect(logicV1Hash).toBe(APPLIED_HASH);
    expect(blueprintLogicScripts(PROXY_HASH).map(logicScriptHash)).toEqual([APPLIED_HASH]);
  });

  it('gives another parameter another credential, which the second version of the tests is', () => {
    expect(LOGIC_V2_PARAMETER).toBe('02'.repeat(28));
    expect(logicV2Hash).toBe(SECOND_HASH);
    expect(digestOf(logicV2.bytes)).toBe(SECOND_CODE_DIGEST);
    expect(logicV2Hash).not.toBe(logicV1Hash);
    expect(logicScriptHash(logicScript(logicValidator(blueprint), 'bb'.repeat(28)))).not.toBe(APPLIED_HASH);
  });

  it('catalogues the blueprint versions applied to the proxy hash and any extra version by hash', () => {
    const catalog = logicCatalog(PROXY_HASH);
    expect([...catalog.keys()]).toEqual([APPLIED_HASH]);
    expect(catalog.get(APPLIED_HASH)?.bytes).toBe(logicV1.bytes);
    const extended = logicCatalog(PROXY_HASH, [logicV2], blueprint);
    expect([...extended.keys()]).toEqual([APPLIED_HASH, SECOND_HASH]);
    expect(extended.get(SECOND_HASH)).toBe(logicV2);
    expect([...logicCatalog(PROXY_HASH, [logicV1]).keys()]).toEqual([APPLIED_HASH]);
  });
});
