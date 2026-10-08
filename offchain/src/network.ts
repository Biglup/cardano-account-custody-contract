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

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PlutusScript, Provider, TransactionBuilder, UTxO } from '@biglup/cometa';
import { toAddress } from './address.js';
import { Cometa } from './cometa.js';

/* CONSTANTS ******************************************************************/

/** The directory holding one file per network with the reference scripts parked on it. */
export const DEFAULT_NETWORKS_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'networks');

/** The hex length of a script hash and of a transaction id. */
const SCRIPT_HASH_HEX_LENGTH = 56;
const TX_ID_HEX_LENGTH = 64;

/* TYPES **********************************************************************/

/**
 * Where a script is parked on a network as a reference script: the output
 * reference of the UTxO holding it, the address it sits at, an always fail
 * script address nobody can spend from, and the lovelace it holds. The
 * script itself is not recorded; the builder rebuilds the UTxO from the
 * script it knows under that hash, since the ledger only runs a script a
 * reference input carries.
 */
export interface ReferenceScriptRecord {
  scriptHash: string;
  txId: string;
  index: number;
  address: string;
  lovelace: string;
}

/**
 * The reference scripts of a network: the proxy and every logic version
 * parked on it, as the network setup records them in
 * `networks/<network>.json`. A network with no file has no reference
 * scripts recorded and the builders embed the scripts instead.
 */
export interface NetworkScripts {
  network: string;
  references: ReferenceScriptRecord[];
}

/**
 * How a builder makes a script available to the ledger: through the UTxO
 * holding it as a reference script, when the network records one, or
 * embedded in the witness set otherwise.
 */
export type ScriptSource = { kind: 'reference'; utxo: UTxO } | { kind: 'embedded'; script: PlutusScript };

/* FUNCTIONS ******************************************************************/

/** The file recording the reference scripts of a network. */
export const networkFilePath = (network: string, directory: string = DEFAULT_NETWORKS_DIRECTORY): string => resolve(directory, `${network}.json`);

/** Whether a string is lowercase hex of a given length. */
const isHex = (value: unknown, length: number): value is string => typeof value === 'string' && value.length === length && /^[0-9a-f]*$/.test(value);

/** Throws unless a parsed record has every field in the shape the builders rely on. */
const assertRecord = (record: unknown, path: string): ReferenceScriptRecord => {
  const candidate = record as Partial<ReferenceScriptRecord> | null;
  if (
    candidate === null ||
    typeof candidate !== 'object' ||
    !isHex(candidate.scriptHash, SCRIPT_HASH_HEX_LENGTH) ||
    !isHex(candidate.txId, TX_ID_HEX_LENGTH) ||
    !Number.isInteger(candidate.index) ||
    (candidate.index as number) < 0 ||
    typeof candidate.address !== 'string' ||
    typeof candidate.lovelace !== 'string' ||
    !/^[0-9]+$/.test(candidate.lovelace)
  ) {
    throw new Error(`${path} holds a reference script record without a script hash, an output reference, an address and a lovelace amount`);
  }
  toAddress(candidate.address);
  return { scriptHash: candidate.scriptHash, txId: candidate.txId, index: candidate.index as number, address: candidate.address, lovelace: candidate.lovelace };
};

/**
 * Reads the reference scripts recorded for a network. A network without a
 * file has none recorded, so the builders embed the scripts; a file that
 * exists must name the network and list well formed records, one per
 * script hash, or it is refused rather than silently ignored.
 */
export const loadNetworkScripts = (network: string, directory: string = DEFAULT_NETWORKS_DIRECTORY): NetworkScripts => {
  const path = networkFilePath(network, directory);
  if (!existsSync(path)) {
    return { network, references: [] };
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<NetworkScripts>;
  if (parsed.network !== network || !Array.isArray(parsed.references)) {
    throw new Error(`${path} does not record the reference scripts of ${network}`);
  }
  const references = parsed.references.map((record) => assertRecord(record, path));
  if (new Set(references.map((record) => record.scriptHash)).size !== references.length) {
    throw new Error(`${path} records a script hash twice`);
  }
  return { network, references };
};

/** The record of a script's reference UTxO on a network, or undefined when the network records none for it. */
export const referenceOf = (network: NetworkScripts, scriptHash: string): ReferenceScriptRecord | undefined =>
  network.references.find((record) => record.scriptHash === scriptHash);

/**
 * The UTxO a record stands for, carrying the script as its reference
 * script, as a builder adds it among the reference inputs. The script must
 * hash to the record's script hash, since the builder prices the reference
 * bytes and the ledger runs what the UTxO holds.
 */
export const referenceScriptUtxo = (record: ReferenceScriptRecord, script: PlutusScript): UTxO => {
  const hash = Cometa.computeScriptHash(script);
  if (hash !== record.scriptHash) {
    throw new Error(`The reference script record of ${record.scriptHash} was given a script hashing to ${hash}`);
  }
  return {
    input: { txId: record.txId, index: record.index },
    output: { address: record.address, value: { coins: BigInt(record.lovelace) }, scriptReference: script },
  };
};

/**
 * The UTxO a record stands for, after checking through the provider that
 * the chain still holds it and that it carries a script hashing to the
 * record. A record is looked up by the hash of the script the builder
 * knows, so a stale file would otherwise embed a UTxO the chain spent or
 * parked another script in, and the ledger would refuse the transaction
 * only at submission. The same check belongs in a setup before it
 * records a UTxO.
 */
export const resolveReferenceScript = async (provider: Provider, record: ReferenceScriptRecord, script: PlutusScript): Promise<UTxO> => {
  const expected = referenceScriptUtxo(record, script);
  const where = `${record.txId}#${record.index}`;
  const [found] = await provider.resolveUnspentOutputs([expected.input]);
  if (!found) {
    throw new Error(`The reference script record of ${record.scriptHash} points at ${where}, which the provider does not find; the network file is stale`);
  }
  if (!found.output.scriptReference) {
    throw new Error(`The reference script record of ${record.scriptHash} points at ${where}, which carries no reference script; the network file is stale`);
  }
  const carried = Cometa.computeScriptHash(found.output.scriptReference);
  if (carried !== record.scriptHash) {
    throw new Error(`The reference script record of ${record.scriptHash} points at ${where}, which carries a script hashing to ${carried}; the network file is stale`);
  }
  return expected;
};

/**
 * Where a builder takes a script from, with the reference UTxO the
 * network records resolved through the provider when one is given, so
 * that a stale record is refused before anything is built. Without a
 * provider the UTxO is rebuilt from the record alone.
 */
export const resolveScriptSource = async (provider: Provider | undefined, network: NetworkScripts | undefined, script: PlutusScript): Promise<ScriptSource> => {
  const record = network && referenceOf(network, Cometa.computeScriptHash(script));
  if (!record) {
    return { kind: 'embedded', script };
  }
  return { kind: 'reference', utxo: provider ? await resolveReferenceScript(provider, record, script) : referenceScriptUtxo(record, script) };
};

/** Makes a script available to a transaction: as a reference input or in the witness set. */
export const attachScript = (builder: TransactionBuilder, source: ScriptSource): TransactionBuilder =>
  source.kind === 'reference' ? builder.addReferenceInput(source.utxo) : builder.addScript(source.script);
