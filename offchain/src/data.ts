import type { Address, ConstrPlutusData, Credential, NetworkId, PlutusData } from '@biglup/cometa';
import { Cometa } from './cometa.js';

/** A key that can authorise a grant: an Ed25519 key hash or a 33 byte compressed secp256k1 public key. */
export type Grantee = { kind: 'ed25519'; keyHash: string } | { kind: 'secp256k1'; publicKey: string };

/** An asset class as hex policy id and hex asset name; lovelace is the empty pair. */
export interface Asset {
  policyId: string;
  assetName: string;
}

/** The bounds of a grant. Times are POSIX milliseconds and recipients are bech32 addresses. */
export interface Scope {
  asset: Asset;
  perCallCap: bigint;
  cap: bigint;
  lovelaceCap: bigint;
  expiresAt: bigint;
  recipients: string[];
}

/** A revocable permission held by a grantee, identified by its slot. */
export interface Grant {
  slot: bigint;
  grantee: Grantee;
  scope: Scope;
}

/** The account's on-chain state. */
export interface AccountState {
  devices: string[];
  grants: Grant[];
  grantGeneration: bigint;
}

/** The redeemer of the account validator's spend handler. */
export type AccountRedeemer =
  | { kind: 'device' }
  | { kind: 'spendWithGrant'; slot: bigint; signature?: string }
  | { kind: 'fund' };

/** The redeemer of the account validator's mint handler. */
export type MintRedeemer = { kind: 'createAccount' } | { kind: 'deleteAccount' };

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

/** A grantee as Plutus data: `Ed25519` is constructor 0 and `Secp256k1` is constructor 1. */
export const encodeGrantee = (grantee: Grantee): ConstrPlutusData =>
  grantee.kind === 'ed25519' ? constr(0, [bytes(grantee.keyHash)]) : constr(1, [bytes(grantee.publicKey)]);

/** The grantee a Plutus data value stands for. */
export const decodeGrantee = (data: PlutusData): Grantee => {
  const index = constructorIndex(data, 'a grantee');
  const [key] = expectConstr(data, index, 1, 'a grantee');
  if (index === 0) {
    return { kind: 'ed25519', keyHash: expectBytes(key as PlutusData, 'an Ed25519 key hash') };
  }
  if (index === 1) {
    return { kind: 'secp256k1', publicKey: expectBytes(key as PlutusData, 'a secp256k1 public key') };
  }
  throw new Error(`Unknown grantee constructor ${index}`);
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
    scope.lovelaceCap,
    scope.expiresAt,
    { items: scope.recipients.map((recipient) => encodeAddress(recipient)) },
  ]);

/** The scope a Plutus data value stands for. */
export const decodeScope = (data: PlutusData, networkId?: NetworkId): Scope => {
  const fields = expectConstr(data, 0, 6, 'a scope');
  return {
    asset: decodeAsset(field(fields, 0)),
    perCallCap: expectInt(field(fields, 1), 'a per call cap'),
    cap: expectInt(field(fields, 2), 'a cap'),
    lovelaceCap: expectInt(field(fields, 3), 'a lovelace cap'),
    expiresAt: expectInt(field(fields, 4), 'an expiry'),
    recipients: expectList(field(fields, 5), 'recipients').map((recipient) => decodeAddress(recipient, networkId)),
  };
};

/** A grant as Plutus data. */
export const encodeGrant = (grant: Grant): ConstrPlutusData =>
  constr(0, [grant.slot, encodeGrantee(grant.grantee), encodeScope(grant.scope)]);

/** The grant a Plutus data value stands for. */
export const decodeGrant = (data: PlutusData, networkId?: NetworkId): Grant => {
  const fields = expectConstr(data, 0, 3, 'a grant');
  return {
    slot: expectInt(field(fields, 0), 'a slot'),
    grantee: decodeGrantee(field(fields, 1)),
    scope: decodeScope(field(fields, 2), networkId),
  };
};

/** An account state as the inline datum of the control UTxO. */
export const encodeAccountState = (state: AccountState): ConstrPlutusData =>
  constr(0, [
    { items: state.devices.map((device) => bytes(device)) },
    { items: state.grants.map((grant) => encodeGrant(grant)) },
    state.grantGeneration,
  ]);

/** The account state a Plutus data value stands for. */
export const decodeAccountState = (data: PlutusData, networkId?: NetworkId): AccountState => {
  const fields = expectConstr(data, 0, 3, 'an account state');
  return {
    devices: expectList(field(fields, 0), 'devices').map((device) => expectBytes(device, 'a device key hash')),
    grants: expectList(field(fields, 1), 'grants').map((grant) => decodeGrant(grant, networkId)),
    grantGeneration: expectInt(field(fields, 2), 'a grant generation'),
  };
};

/** A spend redeemer as Plutus data: `Device` is 0, `SpendWithGrant` is 1 and `Fund` is 2. */
export const encodeAccountRedeemer = (redeemer: AccountRedeemer): ConstrPlutusData => {
  switch (redeemer.kind) {
    case 'device':
      return constr(0);
    case 'spendWithGrant':
      return constr(1, [
        redeemer.slot,
        encodeOption(redeemer.signature === undefined ? undefined : bytes(redeemer.signature)),
      ]);
    case 'fund':
      return constr(2);
  }
};

/** The spend redeemer a Plutus data value stands for. */
export const decodeAccountRedeemer = (data: PlutusData): AccountRedeemer => {
  const index = constructorIndex(data, 'an account redeemer');
  if (index === 0) {
    expectConstr(data, 0, 0, 'the device redeemer');
    return { kind: 'device' };
  }
  if (index === 2) {
    expectConstr(data, 2, 0, 'the fund redeemer');
    return { kind: 'fund' };
  }
  if (index !== 1) {
    throw new Error(`Unknown account redeemer constructor ${index}`);
  }
  const fields = expectConstr(data, 1, 2, 'the spend with grant redeemer');
  const slot = expectInt(field(fields, 0), 'a slot');
  const option = field(fields, 1);
  if (constructorIndex(option, 'a signature option') === 1) {
    expectConstr(option, 1, 0, 'a signature option');
    return { kind: 'spendWithGrant', slot };
  }
  const [signature] = expectConstr(option, 0, 1, 'a signature option');
  return { kind: 'spendWithGrant', slot, signature: expectBytes(signature as PlutusData, 'a signature') };
};

/** A mint redeemer as Plutus data: `CreateAccount` is 0 and `DeleteAccount` is 1. */
export const encodeMintRedeemer = (redeemer: MintRedeemer): ConstrPlutusData =>
  constr(redeemer.kind === 'createAccount' ? 0 : 1);

/** The mint redeemer a Plutus data value stands for. */
export const decodeMintRedeemer = (data: PlutusData): MintRedeemer => {
  const index = constructorIndex(data, 'a mint redeemer');
  if (index === 0) {
    expectConstr(data, 0, 0, 'the create account redeemer');
    return { kind: 'createAccount' };
  }
  if (index === 1) {
    expectConstr(data, 1, 0, 'the delete account redeemer');
    return { kind: 'deleteAccount' };
  }
  throw new Error(`Unknown mint redeemer constructor ${index}`);
};
