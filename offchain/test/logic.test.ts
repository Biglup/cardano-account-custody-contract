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
import { currentLogicHash, currentLogicScript, logicCatalog, logicScript, logicScriptHash } from '../src/logic.js';
import { applyParameters } from '../src/stake-script.js';
import { FIXTURE_BLUEPRINT_PATH, fixtureLogicScript, loadFixtureBlueprint } from '../scripts/fixture-logic.js';
import { FOREIGN_LOGIC_PARAMETER, foreignLogic, foreignLogicHash, logicV1, logicV1Hash, secondLogic, secondLogicHash } from './support/account.js';

/* CONSTANTS ******************************************************************/

/**
 * The fixtures were produced once with the Aiken CLI, applying the proxy
 * hash to the logic of the committed blueprint and to the second logic of
 * the upgrade fixture project's blueprint and, for the logic of another
 * proxy, `FOREIGN_LOGIC_PARAMETER` to the first, each given as the CBOR
 * of its bytes:
 *
 *   aiken blueprint apply -m logic_v1 -o applied.json 581ced61963ac94d12c0b320be5a336c36af66bc02c380e0aa3001899253
 *   aiken blueprint apply -m logic_v2 -o second.json 581ced61963ac94d12c0b320be5a336c36af66bc02c380e0aa3001899253
 *   aiken blueprint apply -m logic_v1 -o foreign.json 581c02020202020202020202020202020202020202020202020202020202
 *
 * The unapplied hashes are what each committed blueprint reports, the
 * applied hashes what the applied blueprints report, and the digests are
 * the SHA-256 of the compiled code each carries, which pin the applied
 * bytes without embedding them. The applied hashes are named by the
 * devnet evidence and by the accounts on the chain, so they are fixed.
 */
const PROXY_HASH = 'ed61963ac94d12c0b320be5a336c36af66bc02c380e0aa3001899253';
const UNAPPLIED_HASH = 'd559533a6da4754bf575b018632bea3b338c1ef423d68051c1f9e682';
const APPLIED_HASH = 'e3300250c57cdb110ddbf42611c9f4c8049c0c1fd6a18c90f1de043e';
const APPLIED_CODE_DIGEST = '45a38e3d4c254820394368a1176e987c279168da3ecb736c5d4f6e88d438dee9';
const SECOND_UNAPPLIED_HASH = '9b5fe4fa454a683d707457378b3b7ae9c29721f774463b3752fe8958';
const SECOND_APPLIED_HASH = '8dae8b73b06cb841acbc46aa0ec356cf4285f6d59974b92509f900cd';
const SECOND_APPLIED_CODE_DIGEST = '9df4e3587ecbe25d715c66a78d6742637d884076ab812368301cd6253539e459';
const FOREIGN_HASH = '29223ba0a063f659c43d9987041b08b534c19e0effa2b8f069b9b5fc';
const FOREIGN_CODE_DIGEST = '348f59fe84928f8f8e165f021163a58f8e47d9c43f5ef2f21014d55ea09e0e46';

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

  it('pins the logic of the blueprint as what every account runs', () => {
    expect(currentLogicHash(PROXY_HASH)).toBe(APPLIED_HASH);
    expect(currentLogicHash(PROXY_HASH, blueprint)).toBe(APPLIED_HASH);
    expect(logicScriptHash(currentLogicScript(PROXY_HASH))).toBe(APPLIED_HASH);
    expect(logicV1Hash).toBe(APPLIED_HASH);
  });

  it('gives another parameter another credential, which the logic of another proxy is', () => {
    expect(FOREIGN_LOGIC_PARAMETER).toBe('02'.repeat(28));
    expect(foreignLogicHash).toBe(FOREIGN_HASH);
    expect(digestOf(foreignLogic.bytes)).toBe(FOREIGN_CODE_DIGEST);
    expect([logicV1Hash, secondLogicHash]).not.toContain(foreignLogicHash);
    expect(logicScriptHash(logicScript(logicValidator(blueprint), 'bb'.repeat(28)))).not.toBe(APPLIED_HASH);
  });

  it('catalogues the blueprint logic applied to the proxy hash and any script given alongside, by hash', () => {
    const catalog = logicCatalog(PROXY_HASH);
    expect([...catalog.keys()]).toEqual([APPLIED_HASH]);
    expect(catalog.get(APPLIED_HASH)?.bytes).toBe(logicV1.bytes);
    const extended = logicCatalog(PROXY_HASH, [secondLogic, foreignLogic], blueprint);
    expect([...extended.keys()]).toEqual([APPLIED_HASH, SECOND_APPLIED_HASH, FOREIGN_HASH]);
    expect(extended.get(SECOND_APPLIED_HASH)).toBe(secondLogic);
    expect(extended.get(FOREIGN_HASH)).toBe(foreignLogic);
    expect([...logicCatalog(PROXY_HASH, [logicV1]).keys()]).toEqual([APPLIED_HASH]);
  });
});

describe('upgrade fixture logic', () => {
  it('reads the second logic from the fixture project blueprint, not the shipped one', () => {
    expect(FIXTURE_BLUEPRINT_PATH.endsWith('/fixtures/upgrade-logic/plutus.json')).toBe(true);
    const fixture = loadFixtureBlueprint();
    expect(fixture.preamble.title).toBe('biglup/upgrade_logic_fixture');
    expect(fixture.validators.map((validator) => validator.title)).toEqual(['logic_v2.logic_v2.withdraw', 'logic_v2.logic_v2.publish', 'logic_v2.logic_v2.else']);
    expect(logicValidator(fixture).hash).toBe(SECOND_UNAPPLIED_HASH);
    expect(loadBlueprint().validators.some((validator) => validator.hash === SECOND_UNAPPLIED_HASH)).toBe(false);
  });

  it('applies the proxy hash to the second logic exactly as the Aiken CLI does', () => {
    const script = fixtureLogicScript(PROXY_HASH);
    expect(script.version).toBe(Cometa.PlutusLanguageVersion.V3);
    expect(logicScriptHash(script)).toBe(SECOND_APPLIED_HASH);
    expect(digestOf(script.bytes)).toBe(SECOND_APPLIED_CODE_DIGEST);
    expect(secondLogicHash).toBe(SECOND_APPLIED_HASH);
    expect(secondLogic.bytes).toBe(script.bytes);
    expect(secondLogicHash).not.toBe(logicV1Hash);
  });
});
