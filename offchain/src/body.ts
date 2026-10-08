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

import type { AssetAmounts, CborReader, SlotConfig, TxIn, TxOut } from '@biglup/cometa';
import { Cometa } from './cometa.js';

/* CONSTANTS ******************************************************************/

/** A validity range with no bounds, as a transaction without a validity interval gets. */
export const UNBOUNDED_VALIDITY_RANGE: ValidityRange = {
  lowerBound: { bound: { kind: 'negativeInfinity' }, inclusive: true },
  upperBound: { bound: { kind: 'positiveInfinity' }, inclusive: true },
};

/** The keys of the transaction body fields read back. */
const BODY_INPUTS = 0n;
const BODY_OUTPUTS = 1n;
const BODY_FEE = 2n;
const BODY_TTL = 3n;
const BODY_WITHDRAWALS = 5n;
const BODY_VALIDITY_START = 8n;
const BODY_MINT = 9n;
const BODY_REQUIRED_SIGNERS = 14n;
const BODY_REFERENCE_INPUTS = 18n;

/* TYPES **********************************************************************/

/** One end of a validity range: unbounded or a POSIX time in milliseconds. */
export type Bound = { kind: 'negativeInfinity' } | { kind: 'finite'; time: bigint } | { kind: 'positiveInfinity' };

/** A bound together with whether it is included in the range. */
export interface IntervalBound {
  bound: Bound;
  inclusive: boolean;
}

/** A validity range as the Plutus script context presents it. */
export interface ValidityRange {
  lowerBound: IntervalBound;
  upperBound: IntervalBound;
}

/** A withdrawal of a transaction: the hash of the credential it draws from, whether a script's, and the amount. */
export interface Withdrawal {
  credential: string;
  script: boolean;
  amount: bigint;
}

/** The parts of a transaction body the builders and the evidence read back. */
export interface TransactionBodyParts {
  inputs: TxIn[];
  outputs: TxOut[];
  fee: bigint;
  validityRange: ValidityRange;
  mint: AssetAmounts;
  requiredSigners: string[];
  referenceInputs: TxIn[];
  withdrawals: Withdrawal[];
}

/* FUNCTIONS ******************************************************************/

/** The POSIX time in milliseconds at which a slot starts. */
export const slotToPosixTime = (slot: bigint, slotConfig: SlotConfig = Cometa.CARDANO_PREPROD_SLOT_CONFIG): bigint =>
  slotConfig.zeroTime + (slot - slotConfig.zeroSlot) * slotConfig.slotLength;

/** The slot containing a POSIX time in milliseconds. */
export const posixTimeToSlot = (time: bigint, slotConfig: SlotConfig = Cometa.CARDANO_PREPROD_SLOT_CONFIG): bigint =>
  slotConfig.zeroSlot + (time - slotConfig.zeroTime) / slotConfig.slotLength;

/**
 * The validity range the ledger derives from a transaction's validity
 * interval. A lower bound is the start of its slot and is inclusive; an
 * upper bound is the start of its slot and is exclusive, since the
 * transaction is only valid in slots before it. A missing bound is the
 * corresponding infinity.
 */
export const validityRangeFromSlots = (
  { invalidBefore, invalidHereafter }: { invalidBefore?: bigint; invalidHereafter?: bigint },
  slotConfig: SlotConfig = Cometa.CARDANO_PREPROD_SLOT_CONFIG,
): ValidityRange => ({
  lowerBound:
    invalidBefore === undefined
      ? UNBOUNDED_VALIDITY_RANGE.lowerBound
      : { bound: { kind: 'finite', time: slotToPosixTime(invalidBefore, slotConfig) }, inclusive: true },
  upperBound:
    invalidHereafter === undefined
      ? UNBOUNDED_VALIDITY_RANGE.upperBound
      : { bound: { kind: 'finite', time: slotToPosixTime(invalidHereafter, slotConfig) }, inclusive: false },
});

/** The finite time a validity range ends at, or undefined when it is open at the top. */
export const upperBoundTime = (range: ValidityRange): bigint | undefined =>
  range.upperBound.bound.kind === 'finite' ? range.upperBound.bound.time : undefined;

/** Lexicographic order of hex strings, which is the byte order of what they encode. */
const compareHex = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The order the ledger keeps inputs in: by transaction id, then by index. */
export const compareInputs = (a: TxIn, b: TxIn): number => compareHex(a.txId, b.txId) || a.index - b.index;

/** Reads every item of a definite or indefinite length array or map. */
const readItems = <T>(
  reader: CborReader,
  readItem: () => T,
  { map = false }: { map?: boolean } = {},
): T[] => {
  const indefinite = -1;
  const length = map ? reader.readStartMap() : reader.readStartArray();
  const items: T[] = [];
  const endState = map ? Cometa.CborReaderState.EndMap : Cometa.CborReaderState.EndArray;
  while (length === indefinite ? reader.peekState() !== endState : items.length < length) {
    items.push(readItem());
  }
  if (map) {
    reader.readEndMap();
  } else {
    reader.readEndArray();
  }
  return items;
};

/** Reads one input: a transaction id and an output index. */
const readInput = (reader: CborReader): TxIn => {
  const [txId, index] = readItems(reader, () =>
    reader.peekState() === Cometa.CborReaderState.ByteString
      ? Cometa.uint8ArrayToHex(reader.readByteString())
      : Number(reader.readUnsignedInt()),
  );
  return { txId: txId as string, index: index as number };
};

/** Reads an array that may be tagged as a set. */
const readSet = <T>(reader: CborReader, readItem: () => T): T[] => {
  if (reader.peekState() === Cometa.CborReaderState.Tag) {
    reader.readTag();
  }
  return readItems(reader, readItem);
};

/** Reads the input set, which may be tagged as a set. */
const readInputs = (reader: CborReader): TxIn[] => readSet(reader, () => readInput(reader));

/** Reads the required signers, key hashes in an array that may be tagged as a set. */
const readRequiredSigners = (reader: CborReader): string[] => readSet(reader, () => Cometa.uint8ArrayToHex(reader.readByteString()));

/** Reads the mint field as asset ids mapped to their quantities. */
const readMint = (reader: CborReader): AssetAmounts => {
  const mint: AssetAmounts = {};
  readItems(
    reader,
    () => {
      const policyId = Cometa.uint8ArrayToHex(reader.readByteString());
      readItems(
        reader,
        () => {
          const name = Cometa.uint8ArrayToHex(reader.readByteString());
          mint[`${policyId}${name}`] = BigInt(reader.readSignedInt().toString());
        },
        { map: true },
      );
    },
    { map: true },
  );
  return mint;
};

/**
 * Reads the withdrawals as reward account bytes mapped to amounts, in the
 * order the ledger indexes their redeemers: by the bytes of the reward
 * account, whose header byte marks a script credential.
 */
const readWithdrawals = (reader: CborReader): Withdrawal[] => {
  const entries: { account: string; amount: bigint }[] = [];
  readItems(
    reader,
    () => {
      const account = Cometa.uint8ArrayToHex(reader.readByteString());
      entries.push({ account, amount: BigInt(reader.readUnsignedInt().toString()) });
    },
    { map: true },
  );
  return entries
    .sort((a, b) => compareHex(a.account, b.account))
    .map(({ account, amount }) => ({ credential: account.slice(2), script: (parseInt(account.slice(0, 2), 16) & 0xf0) === 0xf0, amount }));
};

/**
 * The inputs, outputs, fee, validity interval, mint, required signers,
 * reference inputs and withdrawals of a transaction, read from its CBOR.
 * Inputs, reference inputs and withdrawals are returned in the order the
 * ledger presents them, by transaction id and index or by reward account,
 * and the validity interval is converted to the POSIX time range the
 * script context shows.
 */
export const transactionBodyParts = (
  txCbor: string,
  slotConfig: SlotConfig = Cometa.CARDANO_PREPROD_SLOT_CONFIG,
): TransactionBodyParts => {
  const reader = Cometa.CborReader.fromHex(txCbor);
  reader.readStartArray();
  const parts: TransactionBodyParts = {
    inputs: [],
    outputs: [],
    fee: 0n,
    validityRange: UNBOUNDED_VALIDITY_RANGE,
    mint: {},
    requiredSigners: [],
    referenceInputs: [],
    withdrawals: [],
  };
  let invalidBefore: bigint | undefined;
  let invalidHereafter: bigint | undefined;
  readItems(
    reader,
    () => {
      const key = BigInt(reader.readUnsignedInt().toString());
      switch (key) {
        case BODY_INPUTS:
          parts.inputs = readInputs(reader).sort(compareInputs);
          break;
        case BODY_OUTPUTS:
          parts.outputs = readItems(reader, () => Cometa.readTxOutFromCbor(Cometa.uint8ArrayToHex(reader.readEncodedValue())));
          break;
        case BODY_FEE:
          parts.fee = BigInt(reader.readUnsignedInt().toString());
          break;
        case BODY_TTL:
          invalidHereafter = BigInt(reader.readUnsignedInt().toString());
          break;
        case BODY_WITHDRAWALS:
          parts.withdrawals = readWithdrawals(reader);
          break;
        case BODY_VALIDITY_START:
          invalidBefore = BigInt(reader.readUnsignedInt().toString());
          break;
        case BODY_MINT:
          parts.mint = readMint(reader);
          break;
        case BODY_REQUIRED_SIGNERS:
          parts.requiredSigners = readRequiredSigners(reader);
          break;
        case BODY_REFERENCE_INPUTS:
          parts.referenceInputs = readInputs(reader).sort(compareInputs);
          break;
        default:
          reader.skipValue();
      }
    },
    { map: true },
  );
  const bounds: { invalidBefore?: bigint; invalidHereafter?: bigint } = {};
  if (invalidBefore !== undefined) {
    bounds.invalidBefore = invalidBefore;
  }
  if (invalidHereafter !== undefined) {
    bounds.invalidHereafter = invalidHereafter;
  }
  parts.validityRange = validityRangeFromSlots(bounds, slotConfig);
  return parts;
};
