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

import type { Address, ConstrPlutusData, Credential, NetworkId, PlutusData } from '@biglup/cometa';
import { Cometa } from './cometa.js';

/* TYPES **********************************************************************/

/** An asset class as hex policy id and hex asset name; lovelace is the empty pair. */
export interface Asset {
  policyId: string;
  assetName: string;
}

/**
 * The bounds of a grant. Times are POSIX milliseconds and recipients are
 * bech32 addresses. The lovelace caps bound the lovelace that leaves
 * alongside a scoped token, per call and in total, and must both be zero
 * when the scoped asset is lovelace itself.
 */
export interface Scope {
  asset: Asset;
  perCallCap: bigint;
  cap: bigint;
  lovelacePerCallCap: bigint;
  lovelaceCap: bigint;
  expiresAt: bigint;
  recipients: string[];
}

/**
 * The stable prefix of a grant: its slot, its grantee and the generation it
 * was issued under, the first three fields of every grant datum whatever
 * logic version issued it. A sweep of a dead grant reads nothing else, so
 * the owner can sweep a grant issued under a logic this library does not
 * know the scope shape of once it is dead by generation or revocation;
 * the expiry lives in the scope, so a grant known by its prefix alone is
 * never swept by expiry.
 */
export interface GrantPrefix {
  slot: bigint;
  grantee: string;
  generation: bigint;
}

/**
 * A revocable permission living in its own grant UTxO under the grant
 * token of its slot. The grantee is the hash of the Ed25519 key that must
 * sign to use it; the generation is the account's grant generation at
 * issuance, and the grant dies when the account moves past it or revokes
 * its slot.
 */
export interface Grant extends GrantPrefix {
  scope: Scope;
}

/**
 * The account's on-chain state in the control UTxO: the logic that governs
 * the account, its devices and the grant bookkeeping. The logic is the
 * hash of the logic script whose rules apply to the account; a device
 * rewrite that changes it is an upgrade and needs both the old and the new
 * logic to run. The generation only ever grows and kills every grant
 * issued under an older value; the next slot is the one the next issued
 * grant takes; the revoked list names the slots of the current generation
 * revoked one by one; outstanding counts grant tokens minted and not yet
 * burned. The logic, the devices and the generation are the stable prefix
 * every logic version keeps first.
 */
export interface AccountState {
  logic: string;
  devices: string[];
  grantGeneration: bigint;
  nextSlot: bigint;
  revoked: bigint[];
  outstanding: bigint;
}

/** The redeemer of the account proxy's spend handler. */
export type AccountRedeemer = { kind: 'device' } | { kind: 'spendWithGrant' } | { kind: 'sweepGrant' } | { kind: 'fund' };

/** The redeemer of the account proxy's mint handler. */
export type MintRedeemer = { kind: 'createAccount' } | { kind: 'issueGrants' } | { kind: 'burnGrants' };

/* FUNCTIONS ******************************************************************/

/** A constructor with the given index and fields. */
export const constr = (index: number, fields: PlutusData[] = []): ConstrPlutusData => ({
  constructor: BigInt(index),
  fields: { items: fields },
});

/** A byte string from its hex form. */
export const bytes = (hex: string): Uint8Array => (hex.length === 0 ? new Uint8Array(0) : Cometa.hexToUint8Array(hex));

/** The optional value encoding: `Some` is constructor 0 and `None` is constructor 1. */
export const encodeOption = (value: PlutusData | undefined): ConstrPlutusData =>
  value === undefined ? constr(1) : constr(0, [value]);

/** The fields of a constructor, after checking its index and arity. */
export const expectConstr = (data: PlutusData, index: number, arity: number, what: string): PlutusData[] => {
  if (!Cometa.isPlutusDataConstr(data) || Number(data.constructor) !== index || data.fields.items.length !== arity) {
    throw new Error(`Expected ${what} as constructor ${index} with ${arity} fields`);
  }
  return data.fields.items;
};

/** The constructor index of a data value, after checking it is a constructor. */
export const constructorIndex = (data: PlutusData, what: string): number => {
  if (!Cometa.isPlutusDataConstr(data)) {
    throw new Error(`Expected ${what} as a constructor`);
  }
  return Number(data.constructor);
};

/** A byte string field as hex. */
export const expectBytes = (data: PlutusData, what: string): string => {
  if (!Cometa.isPlutusDataByteArray(data)) {
    throw new Error(`Expected ${what} as bytes`);
  }
  return Cometa.uint8ArrayToHex(data);
};

/** An integer field. */
export const expectInt = (data: PlutusData, what: string): bigint => {
  if (!Cometa.isPlutusDataBigInt(data)) {
    throw new Error(`Expected ${what} as an integer`);
  }
  return data;
};

/** The items of a list field. */
export const expectList = (data: PlutusData, what: string): PlutusData[] => {
  if (!Cometa.isPlutusDataList(data)) {
    throw new Error(`Expected ${what} as a list`);
  }
  return data.items;
};

/** The field at an index, which the arity check guarantees to exist. */
const field = (fields: PlutusData[], index: number): PlutusData => fields[index] as PlutusData;

/** A credential as Plutus data: a key hash is constructor 0 and a script hash constructor 1. */
const encodeCredential = (credential: Credential): ConstrPlutusData =>
  constr(credential.type === Cometa.CredentialType.KeyHash ? 0 : 1, [bytes(credential.hash)]);

/** The credential a Plutus data value stands for. */
const decodeCredential = (data: PlutusData): Credential => {
  const index = constructorIndex(data, 'a credential');
  const [hash] = expectConstr(data, index, 1, 'a credential');
  return {
    hash: expectBytes(hash as PlutusData, 'a credential hash'),
    type: index === 0 ? Cometa.CredentialType.KeyHash : Cometa.CredentialType.ScriptHash,
  };
};

/**
 * An address as the Plutus V3 script context presents it: the payment
 * credential and an optional stake credential, with no network id.
 */
export const encodeAddress = (address: Address | string): ConstrPlutusData => {
  const parsed = typeof address === 'string' ? Cometa.Address.fromString(address) : address;
  const base = parsed.asBase();
  if (base) {
    return constr(0, [
      encodeCredential(base.getPaymentCredential()),
      encodeOption(constr(0, [encodeCredential(base.getStakeCredential())])),
    ]);
  }
  const enterprise = parsed.asEnterprise();
  if (enterprise) {
    return constr(0, [encodeCredential(enterprise.getCredential()), encodeOption(undefined)]);
  }
  const pointer = parsed.asPointer();
  if (pointer) {
    const stakePointer = pointer.getStakePointer();
    return constr(0, [
      encodeCredential(pointer.getPaymentCredential()),
      encodeOption(constr(1, [stakePointer.slot, BigInt(stakePointer.txIndex), BigInt(stakePointer.certIndex)])),
    ]);
  }
  throw new Error('Only base, enterprise and pointer addresses can be represented as Plutus data');
};

/** The address a Plutus data value stands for, on the given network. */
export const decodeAddress = (data: PlutusData, networkId: NetworkId = Cometa.NetworkId.Testnet): string => {
  const [paymentData, stakeData] = expectConstr(data, 0, 2, 'an address');
  const payment = decodeCredential(paymentData as PlutusData);
  const stake = stakeData as PlutusData;
  if (constructorIndex(stake, 'a stake credential option') === 1) {
    expectConstr(stake, 1, 0, 'a stake credential option');
    return Cometa.EnterpriseAddress.fromCredentials(networkId, payment).toAddress().toString();
  }
  const [reference] = expectConstr(stake, 0, 1, 'a stake credential option');
  const referenced = reference as PlutusData;
  if (constructorIndex(referenced, 'a stake credential') === 0) {
    const [credential] = expectConstr(referenced, 0, 1, 'an inline stake credential');
    return Cometa.BaseAddress.fromCredentials(networkId, payment, decodeCredential(credential as PlutusData))
      .toAddress()
      .toString();
  }
  const [slot, txIndex, certIndex] = expectConstr(referenced, 1, 3, 'a stake pointer');
  return Cometa.PointerAddress.fromCredentials(networkId, payment, {
    slot: expectInt(slot as PlutusData, 'a pointer slot'),
    txIndex: Number(expectInt(txIndex as PlutusData, 'a pointer transaction index')),
    certIndex: Number(expectInt(certIndex as PlutusData, 'a pointer certificate index')),
  })
    .toAddress()
    .toString();
};

/** An asset class as Plutus data. */
export const encodeAsset = (asset: Asset): ConstrPlutusData =>
  constr(0, [bytes(asset.policyId), bytes(asset.assetName)]);

/** The asset class a Plutus data value stands for. */
export const decodeAsset = (data: PlutusData): Asset => {
  const fields = expectConstr(data, 0, 2, 'an asset');
  return {
    policyId: expectBytes(field(fields, 0), 'a policy id'),
    assetName: expectBytes(field(fields, 1), 'an asset name'),
  };
};

/** A scope as Plutus data, with its fields in declaration order. */
export const encodeScope = (scope: Scope): ConstrPlutusData =>
  constr(0, [
    encodeAsset(scope.asset),
    scope.perCallCap,
    scope.cap,
    scope.lovelacePerCallCap,
    scope.lovelaceCap,
    scope.expiresAt,
    { items: scope.recipients.map((recipient) => encodeAddress(recipient)) },
  ]);

/** The scope a Plutus data value stands for. */
export const decodeScope = (data: PlutusData, networkId?: NetworkId): Scope => {
  const fields = expectConstr(data, 0, 7, 'a scope');
  return {
    asset: decodeAsset(field(fields, 0)),
    perCallCap: expectInt(field(fields, 1), 'a per call cap'),
    cap: expectInt(field(fields, 2), 'a cap'),
    lovelacePerCallCap: expectInt(field(fields, 3), 'a lovelace per call cap'),
    lovelaceCap: expectInt(field(fields, 4), 'a lovelace cap'),
    expiresAt: expectInt(field(fields, 5), 'an expiry'),
    recipients: expectList(field(fields, 6), 'recipients').map((recipient) => decodeAddress(recipient, networkId)),
  };
};

/** The fields of constructor 0 holding at least a stable prefix of the given length. */
const expectPrefix = (data: PlutusData, length: number, what: string): PlutusData[] => {
  if (!Cometa.isPlutusDataConstr(data) || Number(data.constructor) !== 0 || data.fields.items.length < length) {
    throw new Error(`Expected ${what} as constructor 0 with at least ${length} fields`);
  }
  return data.fields.items;
};

/** A grant as Plutus data: the slot, the grantee key hash, the generation and the scope. */
export const encodeGrant = (grant: Grant): ConstrPlutusData =>
  constr(0, [grant.slot, bytes(grant.grantee), grant.generation, encodeScope(grant.scope)]);

/**
 * The stable prefix a grant datum carries in its first three fields, read
 * without decoding the rest: the slot, the grantee and the generation, as
 * a sweep needs them whatever logic issued the grant.
 */
export const decodeGrantPrefix = (data: PlutusData): GrantPrefix => {
  const fields = expectPrefix(data, 3, 'a grant');
  return {
    slot: expectInt(field(fields, 0), 'a slot'),
    grantee: expectBytes(field(fields, 1), 'a grantee key hash'),
    generation: expectInt(field(fields, 2), 'a generation'),
  };
};

/** The grant a Plutus data value stands for, in the shape the current logic issues. */
export const decodeGrant = (data: PlutusData, networkId?: NetworkId): Grant => {
  const fields = expectConstr(data, 0, 4, 'a grant');
  return { ...decodeGrantPrefix(data), scope: decodeScope(field(fields, 3), networkId) };
};

/** An account state as the inline datum of the control UTxO, with its fields in declaration order, the logic first. */
export const encodeAccountState = (state: AccountState): ConstrPlutusData =>
  constr(0, [
    bytes(state.logic),
    { items: state.devices.map((device) => bytes(device)) },
    state.grantGeneration,
    state.nextSlot,
    { items: [...state.revoked] },
    state.outstanding,
  ]);

/**
 * The logic hash a control datum names in its first field, read without
 * decoding the rest of the state, as the proxy reads it: the field that
 * every logic version keeps first.
 */
export const decodeLogicHash = (data: PlutusData): string => expectBytes(field(expectPrefix(data, 1, 'a control datum'), 0), 'a logic hash');

/** The account state a Plutus data value stands for, in the shape the current logic keeps. */
export const decodeAccountState = (data: PlutusData): AccountState => {
  const fields = expectConstr(data, 0, 6, 'an account state');
  return {
    logic: expectBytes(field(fields, 0), 'a logic hash'),
    devices: expectList(field(fields, 1), 'devices').map((device) => expectBytes(device, 'a device key hash')),
    grantGeneration: expectInt(field(fields, 2), 'a grant generation'),
    nextSlot: expectInt(field(fields, 3), 'a next slot'),
    revoked: expectList(field(fields, 4), 'revoked slots').map((slot) => expectInt(slot, 'a revoked slot')),
    outstanding: expectInt(field(fields, 5), 'an outstanding count'),
  };
};

/** The kinds of the spend redeemer in constructor order. */
const ACCOUNT_REDEEMER_KINDS: AccountRedeemer['kind'][] = ['device', 'spendWithGrant', 'sweepGrant', 'fund'];

/** The kinds of the mint redeemer in constructor order. */
const MINT_REDEEMER_KINDS: MintRedeemer['kind'][] = ['createAccount', 'issueGrants', 'burnGrants'];

/** A spend redeemer as Plutus data: `Device` is 0, `SpendWithGrant` 1, `SweepGrant` 2 and `Fund` 3, none with fields. */
export const encodeAccountRedeemer = (redeemer: AccountRedeemer): ConstrPlutusData => constr(ACCOUNT_REDEEMER_KINDS.indexOf(redeemer.kind));

/** The spend redeemer a Plutus data value stands for. */
export const decodeAccountRedeemer = (data: PlutusData): AccountRedeemer => {
  const index = constructorIndex(data, 'an account redeemer');
  const kind = ACCOUNT_REDEEMER_KINDS[index];
  if (kind === undefined) {
    throw new Error(`Unknown account redeemer constructor ${index}`);
  }
  expectConstr(data, index, 0, `the ${kind} redeemer`);
  return { kind };
};

/** A mint redeemer as Plutus data: `CreateAccount` is 0, `IssueGrants` 1 and `BurnGrants` 2, none with fields. */
export const encodeMintRedeemer = (redeemer: MintRedeemer): ConstrPlutusData => constr(MINT_REDEEMER_KINDS.indexOf(redeemer.kind));

/** The mint redeemer a Plutus data value stands for. */
export const decodeMintRedeemer = (data: PlutusData): MintRedeemer => {
  const index = constructorIndex(data, 'a mint redeemer');
  const kind = MINT_REDEEMER_KINDS[index];
  if (kind === undefined) {
    throw new Error(`Unknown mint redeemer constructor ${index}`);
  }
  expectConstr(data, index, 0, `the ${kind} redeemer`);
  return { kind };
};

/**
 * The datum the library writes on a reserve UTxO: constructor 0 with no
 * fields. The validator treats a deposit under any datum as a reserve the
 * owner alone can spend, so the datum carries no information and other
 * reserves may carry any other.
 */
export const encodeReserveDatum = (): ConstrPlutusData => constr(0);

/**
 * Plutus data without the serialisation cache cometa keeps on decoded
 * values, so that it is re-serialised with the ledger's canonical encoding
 * and compares equal to freshly built data.
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

/**
 * The redeemer of the account stake validator's withdraw and publish
 * handlers as Plutus data. Both handlers learn what they authorise from the
 * script context, so the redeemer carries no choice: `Operate` is its only
 * value, constructor 0 with no fields.
 */
export const encodeStakeRedeemer = (): ConstrPlutusData => constr(0);

/**
 * The redeemer of a logic script's withdraw and publish handlers as Plutus
 * data. The logic learns what it validates from the control UTxO naming it
 * and the proxy redeemers beside its own, so the redeemer carries no
 * choice: `Run` is its only value, constructor 0 with no fields.
 */
export const encodeLogicRedeemer = (): ConstrPlutusData => constr(0);
