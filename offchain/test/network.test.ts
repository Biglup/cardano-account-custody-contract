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

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Cometa } from '../src/cometa.js';
import { DEFAULT_NETWORKS_DIRECTORY, loadNetworkScripts, networkFilePath, referenceOf, referenceScriptUtxo, resolveReferenceScript, resolveScriptSource } from '../src/network.js';
import { PARKED_LOVELACE, REFERENCE_UTXO_TX, logicV1, logicV1Hash, secondLogic, secondLogicHash, networkScripts, parkingAddress, referenceRecord, script, scenario, scriptHash } from './support/account.js';
import { utxo } from './support/fake.js';

/* CONSTANTS ******************************************************************/

const directories: string[] = [];

/* FUNCTIONS ******************************************************************/

/** A fresh directory holding the given network file, removed after the test. */
const directoryWith = (network: string, content: unknown): string => {
  const directory = mkdtempSync(join(tmpdir(), 'custody-networks-'));
  directories.push(directory);
  writeFileSync(networkFilePath(network, directory), typeof content === 'string' ? content : JSON.stringify(content));
  return directory;
};

/* TESTS **********************************************************************/

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('loadNetworkScripts', () => {
  it('reads the records of a network file', () => {
    const directory = directoryWith('fake', networkScripts());
    const loaded = loadNetworkScripts('fake', directory);
    expect(loaded).toEqual(networkScripts());
    expect(referenceOf(loaded, scriptHash)).toEqual(referenceRecord(script));
    expect(referenceOf(loaded, logicV1Hash)?.index).toBe(1);
    expect(referenceOf(loaded, 'ab'.repeat(28))).toBeUndefined();
  });

  it('records nothing for a network without a file, so the scripts are embedded', async () => {
    const directory = directoryWith('other', networkScripts());
    expect(loadNetworkScripts('fake', directory)).toEqual({ network: 'fake', references: [] });
    expect(loadNetworkScripts('nowhere', join(directory, 'missing'))).toEqual({ network: 'nowhere', references: [] });
    expect(await resolveScriptSource(undefined, loadNetworkScripts('fake', directory), script)).toEqual({ kind: 'embedded', script });
    expect(networkFilePath('preprod')).toBe(join(DEFAULT_NETWORKS_DIRECTORY, 'preprod.json'));
    expect(DEFAULT_NETWORKS_DIRECTORY.endsWith('networks')).toBe(true);
  });

  it('refuses a file that names another network or holds a malformed record', () => {
    expect(() => loadNetworkScripts('fake', directoryWith('fake', { ...networkScripts(), network: 'other' }))).toThrow(/does not record the reference scripts of fake/);
    expect(() => loadNetworkScripts('fake', directoryWith('fake', { network: 'fake' }))).toThrow(/does not record/);
    expect(() => loadNetworkScripts('fake', directoryWith('fake', { network: 'fake', references: [{ ...referenceRecord(script), txId: 'ab' }] }))).toThrow(/without a script hash, an output reference/);
    expect(() => loadNetworkScripts('fake', directoryWith('fake', { network: 'fake', references: [{ ...referenceRecord(script), lovelace: 1 }] }))).toThrow(/without a script hash/);
    expect(() => loadNetworkScripts('fake', directoryWith('fake', { network: 'fake', references: [{ ...referenceRecord(script), index: -1 }] }))).toThrow(/without a script hash/);
    expect(() => loadNetworkScripts('fake', directoryWith('fake', { network: 'fake', references: [{ ...referenceRecord(script), address: 'addr_test1nothing' }] }))).toThrow();
    expect(() => loadNetworkScripts('fake', directoryWith('fake', { network: 'fake', references: [referenceRecord(script), referenceRecord(script)] }))).toThrow(/script hash twice/);
    expect(() => loadNetworkScripts('fake', directoryWith('fake', 'not json'))).toThrow();
  });
});

describe('reference script UTxOs', () => {
  it('rebuilds the UTxO of a record with the script it names as its reference script', () => {
    const utxo = referenceScriptUtxo(referenceRecord(logicV1), logicV1);
    expect(utxo.input).toEqual({ txId: REFERENCE_UTXO_TX, index: 1 });
    expect(utxo.output.address).toBe(parkingAddress);
    expect(utxo.output.value).toEqual({ coins: PARKED_LOVELACE });
    expect(utxo.output.scriptReference).toBe(logicV1);
    expect(utxo.output.datum).toBeUndefined();
    expect(Cometa.computeScriptHash(utxo.output.scriptReference!)).toBe(logicV1Hash);
  });

  it('refuses a script that does not hash to the record', () => {
    expect(() => referenceScriptUtxo(referenceRecord(logicV1), secondLogic)).toThrow(/was given a script hashing to/);
  });

  it('takes a script from its reference UTxO when the network records one and embeds it otherwise', async () => {
    const network = networkScripts([script, logicV1]);
    expect(await resolveScriptSource(undefined, network, script)).toEqual({ kind: 'reference', utxo: referenceScriptUtxo(referenceRecord(script), script) });
    expect((await resolveScriptSource(undefined, network, logicV1)).kind).toBe('reference');
    expect(await resolveScriptSource(undefined, network, secondLogic)).toEqual({ kind: 'embedded', script: secondLogic });
    expect(await resolveScriptSource(undefined, undefined, script)).toEqual({ kind: 'embedded', script });
  });

  it('resolves a record through the provider and confirms the UTxO still carries the script', async () => {
    const { provider } = scenario(undefined, []);
    const resolved = await resolveReferenceScript(provider, referenceRecord(logicV1), logicV1);
    expect(resolved).toEqual(referenceScriptUtxo(referenceRecord(logicV1), logicV1));
    expect(await resolveScriptSource(provider, networkScripts(), logicV1)).toEqual({ kind: 'reference', utxo: resolved });
    expect(await resolveScriptSource(provider, networkScripts([script]), logicV1)).toEqual({ kind: 'embedded', script: logicV1 });
    expect(await resolveScriptSource(provider, undefined, logicV1)).toEqual({ kind: 'embedded', script: logicV1 });
    expect(await resolveScriptSource(undefined, networkScripts(), logicV1)).toEqual({ kind: 'reference', utxo: resolved });
  });

  it('refuses a stale record: a UTxO the provider does not find, one carrying another script, or one carrying none', async () => {
    const { provider } = scenario(undefined, []);
    const spent = { ...referenceRecord(logicV1), index: 7 };
    await expect(resolveReferenceScript(provider, spent, logicV1)).rejects.toThrow(new RegExp(`record of ${logicV1Hash} points at ${REFERENCE_UTXO_TX}#7, which the provider does not find; the network file is stale`));
    const swapped = { ...referenceRecord(logicV1), index: 2 };
    await expect(resolveReferenceScript(provider, swapped, logicV1)).rejects.toThrow(new RegExp(`points at ${REFERENCE_UTXO_TX}#2, which carries a script hashing to ${secondLogicHash}; the network file is stale`));
    provider.addUtxo(utxo(REFERENCE_UTXO_TX, 9, parkingAddress, { coins: PARKED_LOVELACE }));
    await expect(resolveReferenceScript(provider, { ...referenceRecord(logicV1), index: 9 }, logicV1)).rejects.toThrow(/#9, which carries no reference script; the network file is stale/);
    await expect(resolveReferenceScript(provider, referenceRecord(logicV1), secondLogic)).rejects.toThrow(/was given a script hashing to/);
    await expect(resolveScriptSource(provider, { network: 'fake', references: [swapped] }, logicV1)).rejects.toThrow(/the network file is stale/);
    expect(await resolveScriptSource(undefined, { network: 'fake', references: [swapped] }, logicV1)).toEqual({ kind: 'reference', utxo: referenceScriptUtxo(swapped, logicV1) });
  });
});
