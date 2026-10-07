import { secp256k1 } from '@noble/curves/secp256k1';
import { blake2b } from '@noble/hashes/blake2';
import type { AssetAmounts, CborReader, PlutusData, SlotConfig, TxIn, TxOut, Value } from '@biglup/cometa';
import { Cometa } from './cometa.js';
import { bytes, constr, encodeAddress, encodeOption } from './data.js';

/** The domain separation prefix of the message a secp256k1 grantee signs. */
export const MESSAGE_DOMAIN = 'cardano_account_custody:grant:v1';

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

/** The parts of a transaction a grantee signs over. */
export interface GrantMessageParts {
  controlReference: TxIn;
  inputs: TxIn[];
  outputs: TxOut[];
  fee: bigint;
  validityRange: ValidityRange;
  mint: AssetAmounts;
}

/** A validity range with no bounds, as a transaction without a validity interval gets. */
export const UNBOUNDED_VALIDITY_RANGE: ValidityRange = {
  lowerBound: { bound: { kind: 'negativeInfinity' }, inclusive: true },
  upperBound: { bound: { kind: 'positiveInfinity' }, inclusive: true },
};

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

/** A bound as Plutus data: negative infinity is 0, a finite time 1 and positive infinity 2. */
const encodeBound = (bound: Bound): PlutusData => {
  switch (bound.kind) {
    case 'negativeInfinity':
      return constr(0);
    case 'finite':
      return constr(1, [bound.time]);
    case 'positiveInfinity':
      return constr(2);
  }
};

/** A boolean as Plutus data: false is constructor 0 and true constructor 1. */
const encodeBool = (value: boolean): PlutusData => constr(value ? 1 : 0);

/** An interval bound as Plutus data: the bound and whether it is inclusive. */
const encodeIntervalBound = (bound: IntervalBound): PlutusData =>
  constr(0, [encodeBound(bound.bound), encodeBool(bound.inclusive)]);

/** A validity range as Plutus data. */
export const encodeValidityRange = (range: ValidityRange): PlutusData =>
  constr(0, [encodeIntervalBound(range.lowerBound), encodeIntervalBound(range.upperBound)]);

/** An output reference as Plutus data: the transaction id bytes and the output index. */
export const encodeOutputReference = (reference: TxIn): PlutusData =>
  constr(0, [bytes(reference.txId), BigInt(reference.index)]);

/** Lexicographic order of hex strings, which is the byte order of what they encode. */
const compareHex = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The entries of a multi asset map, sorted by policy id and asset name as the ledger orders them. */
const encodeMultiAsset = (assets: AssetAmounts): { key: PlutusData; value: PlutusData }[] => {
  const byPolicy = new Map<string, { name: string; quantity: bigint }[]>();
  for (const [assetId, quantity] of Object.entries(assets)) {
    if (quantity === 0n) {
      continue;
    }
    const policyId = assetId.slice(0, 56);
    const name = assetId.slice(56);
    const names = byPolicy.get(policyId) ?? [];
    names.push({ name, quantity });
    byPolicy.set(policyId, names);
  }
  return [...byPolicy.entries()]
    .sort(([a], [b]) => compareHex(a, b))
    .map(([policyId, names]) => ({
      key: bytes(policyId),
      value: {
        entries: names
          .sort((a, b) => compareHex(a.name, b.name))
          .map(({ name, quantity }) => ({ key: bytes(name), value: quantity })),
      },
    }));
};

/** An output value as Plutus data: the lovelace entry first, then every policy in order. */
export const encodeValue = (value: Value): PlutusData => ({
  entries: [
    { key: bytes(''), value: { entries: [{ key: bytes(''), value: value.coins }] } },
    ...encodeMultiAsset(value.assets ?? {}),
  ],
});

/** A mint as Plutus data: a multi asset map with no lovelace entry. */
export const encodeMint = (mint: AssetAmounts): PlutusData => ({ entries: encodeMultiAsset(mint) });

/**
 * Plutus data without the serialisation cache cometa keeps on decoded
 * values, so that it is re-serialised with the ledger's canonical encoding
 * the way the script context presents it.
 */
export const withoutCborCache = (data: PlutusData): PlutusData => {
  if (Cometa.isPlutusDataConstr(data)) {
    return constr(Number(data.constructor), data.fields.items.map(withoutCborCache));
  }
  if (Cometa.isPlutusDataList(data)) {
    return { items: data.items.map(withoutCborCache) };
  }
  if (Cometa.isPlutusDataMap(data)) {
    return { entries: data.entries.map(({ key, value }) => ({ key: withoutCborCache(key), value: withoutCborCache(value) })) };
  }
  return data;
};

/** An output datum as Plutus data: none is 0, a hash is 1 and an inline datum is 2. */
const encodeDatum = (output: TxOut): PlutusData => {
  if (output.datum !== undefined) {
    return constr(2, [withoutCborCache(output.datum)]);
  }
  if (output.datumHash !== undefined) {
    return constr(1, [bytes(output.datumHash)]);
  }
  return constr(0);
};

/** An output as Plutus data: address, value, datum and optional reference script hash. */
export const encodeOutput = (output: TxOut): PlutusData =>
  constr(0, [
    encodeAddress(output.address),
    encodeValue(output.value),
    encodeDatum(output),
    encodeOption(output.scriptReference === undefined ? undefined : bytes(Cometa.computeScriptHash(output.scriptReference))),
  ]);

/** The seven element tuple a grantee signs over, as Plutus data. */
export const granteeMessageData = (parts: GrantMessageParts): PlutusData => ({
  items: [
    Cometa.utf8ToUint8Array(MESSAGE_DOMAIN),
    encodeOutputReference(parts.controlReference),
    { items: parts.inputs.map(encodeOutputReference) },
    { items: parts.outputs.map(encodeOutput) },
    parts.fee,
    encodeValidityRange(parts.validityRange),
    encodeMint(parts.mint),
  ],
});

/**
 * The message a secp256k1 grantee signs: the blake2b-256 digest of the
 * ledger's serialisation of the message tuple. Cometa serialises Plutus
 * data exactly as the ledger does, with indefinite length arrays and the
 * constructor tags, so the digest matches the one the validator computes.
 */
export const granteeMessage = (parts: GrantMessageParts): Uint8Array =>
  blake2b(Cometa.hexToUint8Array(Cometa.plutusDataToCbor(granteeMessageData(parts))), { dkLen: 32 });

/** Bytes given either directly or as hex. */
const toBytes = (value: Uint8Array | string): Uint8Array => (typeof value === 'string' ? bytes(value) : value);

/** The 33 byte compressed public key of a secp256k1 private key, as hex. */
export const granteePublicKey = (privateKey: Uint8Array | string): string =>
  Cometa.uint8ArrayToHex(secp256k1.getPublicKey(toBytes(privateKey), true));

/**
 * Signs a grantee message with a secp256k1 private key: a 64 byte r||s
 * ECDSA signature over the 32 byte digest as is, in low s form, which is
 * the only form the verification builtin accepts.
 */
export const signGrantMessage = (privateKey: Uint8Array | string, message: Uint8Array): Uint8Array => {
  if (message.length !== 32) {
    throw new Error('A grantee message is a 32 byte digest');
  }
  return secp256k1.sign(message, toBytes(privateKey), { lowS: true, prehash: false }).toCompactRawBytes();
};

/** Whether a 64 byte r||s signature over a grantee message is valid for a compressed public key. */
export const verifyGrantSignature = (
  publicKey: Uint8Array | string,
  message: Uint8Array,
  signature: Uint8Array | string,
): boolean => secp256k1.verify(toBytes(signature), message, toBytes(publicKey), { lowS: true, prehash: false });

/** The parts of a transaction body the grantee message covers. */
export interface TransactionBodyParts {
  inputs: TxIn[];
  outputs: TxOut[];
  fee: bigint;
  validityRange: ValidityRange;
  mint: AssetAmounts;
}

/** The keys of the transaction body fields the message covers. */
const BODY_INPUTS = 0n;
const BODY_OUTPUTS = 1n;
const BODY_FEE = 2n;
const BODY_TTL = 3n;
const BODY_MINT = 9n;
const BODY_VALIDITY_START = 8n;

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

/** Reads the input set, which may be tagged as a set. */
const readInputs = (reader: CborReader): TxIn[] => {
  if (reader.peekState() === Cometa.CborReaderState.Tag) {
    reader.readTag();
  }
  return readItems(reader, () => readInput(reader));
};

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
 * The parts of a transaction body the grantee message covers, read from
 * the transaction's CBOR. Inputs are returned in the order the ledger
 * presents them, sorted by transaction id and index, and the validity
 * interval is converted to the POSIX time range the script context shows.
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
        case BODY_VALIDITY_START:
          invalidBefore = BigInt(reader.readUnsignedInt().toString());
          break;
        case BODY_MINT:
          parts.mint = readMint(reader);
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

/** The grantee message parts of a built transaction spending the given control UTxO. */
export const grantMessagePartsOf = (
  txCbor: string,
  controlReference: TxIn,
  slotConfig: SlotConfig = Cometa.CARDANO_PREPROD_SLOT_CONFIG,
): GrantMessageParts => ({ controlReference, ...transactionBodyParts(txCbor, slotConfig) });
