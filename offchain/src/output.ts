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

import type { AssetAmounts, TxOut } from '@biglup/cometa';
import { Cometa } from './cometa.js';

/* CONSTANTS ******************************************************************/

/** The lovelace per byte the ledger charges for a UTxO on the networks the contract targets. */
export const DEFAULT_ADA_PER_UTXO_BYTE = 4310n;

/** The bytes the ledger adds to an output's serialised size when pricing it. */
const UTXO_SIZE_OVERHEAD = 160n;

/** The keys of the fields of a post Alonzo transaction output. */
const OUTPUT_ADDRESS = 0;
const OUTPUT_VALUE = 1;
const OUTPUT_DATUM = 2;
const OUTPUT_SCRIPT_REFERENCE = 3;

/** The tag of an inline datum within an output's datum option. */
const INLINE_DATUM_OPTION = 1;

/** The tag of a datum hash within an output's datum option. */
const DATUM_HASH_OPTION = 0;

/* FUNCTIONS ******************************************************************/

/** The asset ids of a value grouped by policy id, with the quantities per asset name. */
const groupByPolicy = (assets: AssetAmounts): Map<string, Map<string, bigint>> => {
  const policies = new Map<string, Map<string, bigint>>();
  for (const [assetId, quantity] of Object.entries(assets)) {
    const policyId = assetId.slice(0, 56);
    const names = policies.get(policyId) ?? new Map<string, bigint>();
    names.set(assetId.slice(56), quantity);
    policies.set(policyId, names);
  }
  return policies;
};

/** The bytes of a hex string, which may be empty. */
const bytesOf = (hex: string): Uint8Array => (hex.length === 0 ? new Uint8Array(0) : Cometa.hexToUint8Array(hex));

/**
 * Writes a value: the lovelace alone, or the lovelace alongside the multi
 * asset map. Every container is written with its length, which the
 * writer closes by itself.
 */
const writeValue = (writer: InstanceType<typeof Cometa.CborWriter>, output: TxOut): void => {
  const policies = groupByPolicy(output.value.assets ?? {});
  if (policies.size === 0) {
    writer.writeUnsignedInt(output.value.coins);
    return;
  }
  writer.startArray(2).writeUnsignedInt(output.value.coins).startMap(policies.size);
  for (const [policyId, names] of policies) {
    writer.writeByteString(bytesOf(policyId)).startMap(names.size);
    for (const [name, quantity] of names) {
      writer.writeByteString(bytesOf(name)).writeUnsignedInt(quantity);
    }
  }
};

/**
 * The CBOR of an output as the ledger serialises it in a transaction: a
 * map of the address, the value, the datum option when the output carries
 * a datum, and the reference script when it holds one.
 */
export const serialiseOutput = (output: TxOut): Uint8Array => {
  const writer = new Cometa.CborWriter();
  const fields = 2 + (output.datum !== undefined || output.datumHash !== undefined ? 1 : 0) + (output.scriptReference ? 1 : 0);
  writer.startMap(fields).writeUnsignedInt(OUTPUT_ADDRESS).writeByteString(Cometa.Address.fromString(output.address).toBytes());
  writer.writeUnsignedInt(OUTPUT_VALUE);
  writeValue(writer, output);
  if (output.datum !== undefined) {
    writer
      .writeUnsignedInt(OUTPUT_DATUM)
      .startArray(2)
      .writeUnsignedInt(INLINE_DATUM_OPTION)
      .writeTag(Cometa.CborTag.EncodedCborDataItem)
      .writeByteString(Cometa.hexToUint8Array(Cometa.plutusDataToCbor(output.datum)));
  } else if (output.datumHash !== undefined) {
    writer
      .writeUnsignedInt(OUTPUT_DATUM)
      .startArray(2)
      .writeUnsignedInt(DATUM_HASH_OPTION)
      .writeByteString(Cometa.hexToUint8Array(output.datumHash));
  }
  if (output.scriptReference) {
    writer
      .writeUnsignedInt(OUTPUT_SCRIPT_REFERENCE)
      .writeTag(Cometa.CborTag.EncodedCborDataItem)
      .writeByteString(Cometa.hexToUint8Array(Cometa.scriptToCbor(output.scriptReference)));
  }
  return writer.encode();
};

/** The lovelace the ledger demands of an output of a given serialised size. */
export const minimumLovelaceForSize = (size: number, adaPerUtxoByte: bigint = DEFAULT_ADA_PER_UTXO_BYTE): bigint =>
  adaPerUtxoByte * (UTXO_SIZE_OVERHEAD + BigInt(size));

/**
 * The least lovelace an output of a given shape may hold: the lovelace
 * per byte times the serialised size of the output plus the ledger's
 * fixed overhead. The lovelace is part of what is serialised, so the
 * output is sized with the candidate amount and re-sized until the
 * amount stops growing.
 */
export const minimumUtxoLovelace = (output: TxOut, adaPerUtxoByte: bigint = DEFAULT_ADA_PER_UTXO_BYTE): bigint => {
  let coins = 0n;
  for (;;) {
    const minimum = minimumLovelaceForSize(serialiseOutput({ ...output, value: { ...output.value, coins } }).length, adaPerUtxoByte);
    if (minimum <= coins) {
      return coins;
    }
    coins = minimum;
  }
};
