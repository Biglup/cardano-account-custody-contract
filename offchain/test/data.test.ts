import { describe, expect, it } from 'vitest';
import { Cometa } from '../src/cometa.js';
import {
  type AccountRedeemer,
  type AccountState,
  type MintRedeemer,
  decodeAccountRedeemer,
  decodeAccountState,
  decodeAddress,
  decodeGrant,
  decodeGrantee,
  decodeMintRedeemer,
  decodeScope,
  encodeAccountRedeemer,
  encodeAccountState,
  encodeAddress,
  encodeGrant,
  encodeGrantee,
  encodeMintRedeemer,
  encodeScope,
} from '../src/data.js';
import { GRANTEE_PUBLIC_KEY, OWNER_PAYMENT_KEY, address, grantedState, recipientAddress } from './support/account.js';

const cbor = (data: Parameters<typeof Cometa.plutusDataToCbor>[0]): string => Cometa.plutusDataToCbor(data);

describe('account state', () => {
  it('encodes a minimal state with constructor 0 and fields in declaration order', () => {
    const state: AccountState = { devices: [OWNER_PAYMENT_KEY], grants: [], grantGeneration: 0n };
    expect(cbor(encodeAccountState(state))).toBe(`d8799f9f581c${OWNER_PAYMENT_KEY}ff8000ff`);
  });

  it('round trips a state with both grantee kinds and recipients', () => {
    const encoded = encodeAccountState(grantedState);
    expect(decodeAccountState(Cometa.cborToPlutusData(cbor(encoded)))).toEqual(grantedState);
  });

  it('refuses data that is not a state', () => {
    expect(() => decodeAccountState(0n)).toThrow(/account state/);
    expect(() => decodeAccountState({ constructor: 1n, fields: { items: [] } })).toThrow(/account state/);
  });
});

describe('grantee', () => {
  it('uses constructor 0 for Ed25519 and 1 for secp256k1', () => {
    expect(cbor(encodeGrantee({ kind: 'ed25519', keyHash: OWNER_PAYMENT_KEY }))).toBe(`d8799f581c${OWNER_PAYMENT_KEY}ff`);
    expect(cbor(encodeGrantee({ kind: 'secp256k1', publicKey: GRANTEE_PUBLIC_KEY }))).toBe(`d87a9f5821${GRANTEE_PUBLIC_KEY}ff`);
  });

  it('round trips and rejects other constructors', () => {
    for (const grantee of [
      { kind: 'ed25519', keyHash: OWNER_PAYMENT_KEY } as const,
      { kind: 'secp256k1', publicKey: GRANTEE_PUBLIC_KEY } as const,
    ]) {
      expect(decodeGrantee(encodeGrantee(grantee))).toEqual(grantee);
    }
    expect(() => decodeGrantee({ constructor: 2n, fields: { items: [new Uint8Array(1)] } })).toThrow(/grantee/);
  });
});

describe('scope and grant', () => {
  it('round trips every field', () => {
    for (const grant of grantedState.grants) {
      expect(decodeGrant(encodeGrant(grant))).toEqual(grant);
      expect(decodeScope(encodeScope(grant.scope))).toEqual(grant.scope);
    }
  });

  it('encodes lovelace as the empty asset class', () => {
    const scope = grantedState.grants[0]?.scope;
    expect(scope).toBeDefined();
    expect(cbor(encodeScope(scope!)).startsWith('d8799fd8799f4040ff')).toBe(true);
  });
});

describe('address', () => {
  it('encodes base and enterprise addresses without a network id', () => {
    const accountData = encodeAddress(address);
    expect(cbor(accountData).startsWith('d8799fd87a9f581c')).toBe(true);
    expect(decodeAddress(accountData)).toBe(address);
    const recipientData = encodeAddress(recipientAddress);
    expect(cbor(recipientData).endsWith('d87a80ff')).toBe(true);
    expect(decodeAddress(recipientData)).toBe(recipientAddress);
  });

  it('round trips a pointer address', () => {
    const pointer = Cometa.PointerAddress.fromCredentials(
      Cometa.NetworkId.Testnet,
      { hash: OWNER_PAYMENT_KEY, type: Cometa.CredentialType.KeyHash },
      { slot: 12345n, txIndex: 6, certIndex: 7 },
    )
      .toAddress()
      .toString();
    expect(decodeAddress(encodeAddress(pointer))).toBe(pointer);
  });

  it('decodes onto the requested network', () => {
    const mainnet = decodeAddress(encodeAddress(address), Cometa.NetworkId.Mainnet);
    expect(mainnet.startsWith('addr1')).toBe(true);
    expect(cbor(encodeAddress(mainnet))).toBe(cbor(encodeAddress(address)));
  });
});

describe('redeemers', () => {
  it('uses the declaration order of the account redeemer constructors', () => {
    expect(cbor(encodeAccountRedeemer({ kind: 'device' }))).toBe('d87980');
    expect(cbor(encodeAccountRedeemer({ kind: 'spendWithGrant', slot: 1n }))).toBe('d87a9f01d87a80ff');
    expect(cbor(encodeAccountRedeemer({ kind: 'spendWithGrant', slot: 1n, signature: 'ab' }))).toBe('d87a9f01d8799f41abffff');
    expect(cbor(encodeAccountRedeemer({ kind: 'fund' }))).toBe('d87b80');
  });

  it('round trips the account redeemers', () => {
    const redeemers: AccountRedeemer[] = [
      { kind: 'device' },
      { kind: 'spendWithGrant', slot: 3n },
      { kind: 'spendWithGrant', slot: 3n, signature: '00'.repeat(64) },
      { kind: 'fund' },
    ];
    for (const redeemer of redeemers) {
      expect(decodeAccountRedeemer(encodeAccountRedeemer(redeemer))).toEqual(redeemer);
    }
    expect(() => decodeAccountRedeemer({ constructor: 3n, fields: { items: [] } })).toThrow(/redeemer/);
  });

  it('uses constructor 0 for CreateAccount and 1 for DeleteAccount', () => {
    expect(cbor(encodeMintRedeemer({ kind: 'createAccount' }))).toBe('d87980');
    expect(cbor(encodeMintRedeemer({ kind: 'deleteAccount' }))).toBe('d87a80');
    const redeemers: MintRedeemer[] = [{ kind: 'createAccount' }, { kind: 'deleteAccount' }];
    for (const redeemer of redeemers) {
      expect(decodeMintRedeemer(encodeMintRedeemer(redeemer))).toEqual(redeemer);
    }
    expect(() => decodeMintRedeemer({ constructor: 2n, fields: { items: [] } })).toThrow(/redeemer/);
  });
});
