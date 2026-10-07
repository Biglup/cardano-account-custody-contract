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
  decodeMintRedeemer,
  decodeScope,
  encodeAccountRedeemer,
  encodeAccountState,
  encodeAddress,
  encodeGrant,
  encodeMintRedeemer,
  encodeScope,
  encodeStakeRedeemer,
  withoutCborCache,
} from '../src/data.js';
import { AGENT_PAYMENT_KEY, OWNER_PAYMENT_KEY, address, grantedState, lovelaceScope, recipientAddress } from './support/account.js';

const cbor = (data: Parameters<typeof Cometa.plutusDataToCbor>[0]): string => Cometa.plutusDataToCbor(data);

describe('account state', () => {
  it('encodes a minimal state with constructor 0 and fields in declaration order', () => {
    const state: AccountState = { devices: [OWNER_PAYMENT_KEY], grants: [], grantGeneration: 0n };
    expect(cbor(encodeAccountState(state))).toBe(`d8799f9f581c${OWNER_PAYMENT_KEY}ff8000ff`);
  });

  it('round trips a state with grants and recipients', () => {
    const encoded = encodeAccountState(grantedState);
    expect(decodeAccountState(Cometa.cborToPlutusData(cbor(encoded)))).toEqual(grantedState);
  });

  it('refuses data that is not a state', () => {
    expect(() => decodeAccountState(0n)).toThrow(/account state/);
    expect(() => decodeAccountState({ constructor: 1n, fields: { items: [] } })).toThrow(/account state/);
  });
});

describe('grant', () => {
  it('encodes the slot, the grantee key hash and the scope', () => {
    const grant = grantedState.grants[0]!;
    expect(cbor(encodeGrant(grant)).startsWith(`d8799f00581c${AGENT_PAYMENT_KEY}d8799f`)).toBe(true);
    expect(() => decodeGrant({ constructor: 0n, fields: { items: [0n, { constructor: 0n, fields: { items: [] } }, encodeScope(grant.scope)] } })).toThrow(/grantee/);
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

  it('encodes the seven scope fields in declaration order, the lovelace per call cap before the lovelace cap', () => {
    const scope = { ...lovelaceScope(), lovelacePerCallCap: 1n, lovelaceCap: 2n };
    expect(cbor(encodeScope(scope))).toBe('d8799fd8799f4040ff1a009896801a00e4e1c001021b000001a3185c500080ff');
    expect(() => decodeScope(Cometa.cborToPlutusData('d8799fd8799f4040ff1a009896801a00e4e1c0021b000001a3185c500080ff'))).toThrow(/scope/);
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
    expect(cbor(encodeAccountRedeemer({ kind: 'spendWithGrant', slot: 1n }))).toBe('d87a9f01ff');
    expect(cbor(encodeAccountRedeemer({ kind: 'fund' }))).toBe('d87b80');
  });

  it('round trips the account redeemers', () => {
    const redeemers: AccountRedeemer[] = [
      { kind: 'device' },
      { kind: 'spendWithGrant', slot: 3n },
      { kind: 'fund' },
    ];
    for (const redeemer of redeemers) {
      expect(decodeAccountRedeemer(encodeAccountRedeemer(redeemer))).toEqual(redeemer);
    }
    expect(() => decodeAccountRedeemer({ constructor: 3n, fields: { items: [] } })).toThrow(/redeemer/);
    expect(() => decodeAccountRedeemer({ constructor: 1n, fields: { items: [3n, { constructor: 1n, fields: { items: [] } }] } })).toThrow(/redeemer/);
  });

  it('uses constructor 0 for CreateAccount, the only mint action', () => {
    expect(cbor(encodeMintRedeemer({ kind: 'createAccount' }))).toBe('d87980');
    const redeemer: MintRedeemer = { kind: 'createAccount' };
    expect(decodeMintRedeemer(encodeMintRedeemer(redeemer))).toEqual(redeemer);
    expect(() => decodeMintRedeemer({ constructor: 1n, fields: { items: [] } })).toThrow(/redeemer/);
  });
});

describe('stake redeemer', () => {
  it('encodes Operate as constructor 0 with no fields', () => {
    expect(cbor(encodeStakeRedeemer())).toBe('d87980');
  });
});

describe('withoutCborCache', () => {
  it('drops the serialisation cache before re-encoding', () => {
    const cached = Cometa.cborToPlutusData('d8799f9f0102ffa14000ff');
    const stripped = withoutCborCache(cached);
    expect(JSON.stringify(stripped, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain('cbor');
    expect(Cometa.plutusDataToCbor(stripped)).toBe('d8799f9f0102ffa14000ff');
  });
});
