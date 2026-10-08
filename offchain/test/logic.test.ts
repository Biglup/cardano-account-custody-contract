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
import { LOGIC_V1_TITLE, LOGIC_V2_TITLE, accountScript, accountScriptHash, loadBlueprint, logicValidator } from '../src/blueprint.js';
import { Cometa } from '../src/cometa.js';
import { bytes } from '../src/data.js';
import { blueprintLogicScripts, currentLogicHash, currentLogicScript, logicCatalog, logicScript, logicScriptHash, logicVersionHash, logicVersionScript } from '../src/logic.js';
import { applyParameters } from '../src/stake-script.js';
import { FOREIGN_LOGIC_PARAMETER, foreignLogic, foreignLogicHash, logicV1, logicV1Hash, logicV2, logicV2Hash } from './support/account.js';

/* CONSTANTS ******************************************************************/

/**
 * The fixtures were produced once with the Aiken CLI from the committed
 * blueprint, applying the proxy hash to each logic version and, for the
 * logic outside the blueprint, `FOREIGN_LOGIC_PARAMETER` to the first,
 * each given as the CBOR of its bytes:
 *
 *   aiken blueprint apply -m logic_v1 -o applied.json 581ced61963ac94d12c0b320be5a336c36af66bc02c380e0aa3001899253
 *   aiken blueprint apply -m logic_v2 -o second.json 581ced61963ac94d12c0b320be5a336c36af66bc02c380e0aa3001899253
 *   aiken blueprint apply -m logic_v1 -o foreign.json 581c02020202020202020202020202020202020202020202020202020202
 *
 * The unapplied hashes are what the committed blueprint reports for each
 * version, the applied hashes what the applied blueprints report, and the
 * digests are the SHA-256 of the compiled code each carries, which pin
 * the applied bytes without embedding them.
 */
const PROXY_HASH = 'ed61963ac94d12c0b320be5a336c36af66bc02c380e0aa3001899253';
const UNAPPLIED_HASH = '7cf7daa6c0a5825e23a9dadece990d5a602fa1508d01f061eacaed52';
const APPLIED_HASH = '2cd68e398bdf9fbc8d257614b54403451ee722520ec785fe14f8df5a';
const APPLIED_CODE_DIGEST = '467631d56f1c7ba59adc931ca24953be2f2abb0ac4f2bdbf17a2ac9a2a847a48';
const V2_UNAPPLIED_HASH = '03489f90cbd00ec38d8669cb582fa7014becd1122b9ba3a03c7b7dc1';
const V2_APPLIED_HASH = '69baa8a8c877247028c56c8130449e186e3658d541536d168f92db3d';
const V2_APPLIED_CODE_DIGEST = '9a109bc665e3fa23b34029f37f3640409eb5758a43570f12bf9105b7b8f2806e';
const FOREIGN_HASH = 'eca396abf77a650eccc852252e0d7c001dd3d63a57fc2a9c75665f6b';
const FOREIGN_CODE_DIGEST = 'cddf41f55aae557ff72e7e6705c093433d5e98ac22601c84732acd046ccd835e';

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
    expect(logicVersionHash(LOGIC_V1_TITLE, PROXY_HASH)).toBe(APPLIED_HASH);
    expect(logicV1Hash).toBe(APPLIED_HASH);
    expect(blueprintLogicScripts(PROXY_HASH).map(logicScriptHash)).toEqual([APPLIED_HASH, V2_APPLIED_HASH]);
  });

  it('applies the proxy hash to the second version exactly as the Aiken CLI does', () => {
    expect(logicValidator(blueprint, LOGIC_V2_TITLE).hash).toBe(V2_UNAPPLIED_HASH);
    const script = logicVersionScript(LOGIC_V2_TITLE, PROXY_HASH, blueprint);
    expect(logicScriptHash(script)).toBe(V2_APPLIED_HASH);
    expect(logicVersionHash(LOGIC_V2_TITLE, PROXY_HASH)).toBe(V2_APPLIED_HASH);
    expect(digestOf(script.bytes)).toBe(V2_APPLIED_CODE_DIGEST);
    expect(logicV2Hash).toBe(V2_APPLIED_HASH);
    expect(logicV2.bytes).toBe(script.bytes);
    expect(logicV2Hash).not.toBe(logicV1Hash);
    expect(() => logicVersionScript('logic_v9.logic_v9', PROXY_HASH, blueprint)).toThrow(/no logic validator titled logic_v9/);
  });

  it('gives another parameter another credential, which the logic outside the blueprint is', () => {
    expect(FOREIGN_LOGIC_PARAMETER).toBe('02'.repeat(28));
    expect(foreignLogicHash).toBe(FOREIGN_HASH);
    expect(digestOf(foreignLogic.bytes)).toBe(FOREIGN_CODE_DIGEST);
    expect([logicV1Hash, logicV2Hash]).not.toContain(foreignLogicHash);
    expect(logicScriptHash(logicScript(logicValidator(blueprint), 'bb'.repeat(28)))).not.toBe(APPLIED_HASH);
  });

  it('catalogues the blueprint versions applied to the proxy hash and any extra version by hash', () => {
    const catalog = logicCatalog(PROXY_HASH);
    expect([...catalog.keys()]).toEqual([APPLIED_HASH, V2_APPLIED_HASH]);
    expect(catalog.get(APPLIED_HASH)?.bytes).toBe(logicV1.bytes);
    expect(catalog.get(V2_APPLIED_HASH)?.bytes).toBe(logicV2.bytes);
    const extended = logicCatalog(PROXY_HASH, [foreignLogic], blueprint);
    expect([...extended.keys()]).toEqual([APPLIED_HASH, V2_APPLIED_HASH, FOREIGN_HASH]);
    expect(extended.get(FOREIGN_HASH)).toBe(foreignLogic);
    expect([...logicCatalog(PROXY_HASH, [logicV1, logicV2]).keys()]).toEqual([APPLIED_HASH, V2_APPLIED_HASH]);
  });
});
