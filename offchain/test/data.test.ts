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
  decodeGrantPrefix,
  decodeLogicHash,
  decodeMintRedeemer,
  decodeScope,
  encodeAccountRedeemer,
  encodeAccountState,
  encodeAddress,
  encodeGrant,
  encodeLogicRedeemer,
  encodeMintRedeemer,
  encodeReserveDatum,
  encodeScope,
  encodeStakeRedeemer,
  withoutCborCache,
} from '../src/data.js';
import { AGENT_PAYMENT_KEY, OWNER_PAYMENT_KEY, address, fixtureGrants, grantedState, logicV1Hash, logicV2Hash, lovelaceScope, recipientAddress } from './support/account.js';

/* FUNCTIONS ******************************************************************/

/** The CBOR hex of a Plutus data value. */
const cbor = (data: Parameters<typeof Cometa.plutusDataToCbor>[0]): string => Cometa.plutusDataToCbor(data);

/* TESTS **********************************************************************/

describe('account state', () => {
  it('encodes a fresh state with constructor 0 and the logic, devices, generation, next slot, revoked list and outstanding count in order', () => {
    const state: AccountState = { logic: logicV1Hash, devices: [OWNER_PAYMENT_KEY], grantGeneration: 0n, nextSlot: 0n, revoked: [], outstanding: 0n };
    expect(cbor(encodeAccountState(state))).toBe(`d8799f581c${logicV1Hash}9f581c${OWNER_PAYMENT_KEY}ff00008000ff`);
  });

  it('round trips a state with counters and revoked slots', () => {
    const state: AccountState = { ...grantedState, grantGeneration: 2n, revoked: [1n, 40n] };
    expect(cbor(encodeAccountState(state))).toBe(`d8799f581c${logicV1Hash}9f581c${OWNER_PAYMENT_KEY}ff02039f011828ff03ff`);
    expect(decodeAccountState(Cometa.cborToPlutusData(cbor(encodeAccountState(state))))).toEqual(state);
  });

  it('reads the logic from the first field of any control datum, as the proxy does, without decoding the rest', () => {
    expect(decodeLogicHash(encodeAccountState(grantedState))).toBe(logicV1Hash);
    expect(decodeLogicHash({ constructor: 0n, fields: { items: [Cometa.hexToUint8Array(logicV2Hash), 7n] } })).toBe(logicV2Hash);
    expect(decodeLogicHash({ constructor: 0n, fields: { items: [Cometa.hexToUint8Array(logicV2Hash), 7n, { items: [] }, Cometa.hexToUint8Array('ab'), 1n, 2n, 3n] } })).toBe(logicV2Hash);
    expect(() => decodeLogicHash({ constructor: 0n, fields: { items: [] } })).toThrow(/control datum/);
    expect(() => decodeLogicHash({ constructor: 0n, fields: { items: [0n] } })).toThrow(/logic hash/);
    expect(() => decodeLogicHash(0n)).toThrow(/control datum/);
  });

  it('refuses data that is not a state', () => {
    expect(() => decodeAccountState(0n)).toThrow(/account state/);
    expect(() => decodeAccountState({ constructor: 1n, fields: { items: [] } })).toThrow(/account state/);
    expect(() => decodeAccountState({ constructor: 0n, fields: { items: [{ items: [] }, 0n, 0n, { items: [] }, 0n] } })).toThrow(/account state/);
    expect(() => decodeAccountState({ constructor: 0n, fields: { items: [{ items: [] }, { items: [] }, 0n, 0n, { items: [] }, 0n] } })).toThrow(/logic hash/);
    expect(() => decodeAccountState({ constructor: 0n, fields: { items: [Cometa.hexToUint8Array(logicV1Hash), { items: [] }, 0n, 0n, { items: [0n, { items: [] }] }, 0n] } })).toThrow(/revoked slot/);
  });
});

describe('grant', () => {
  it('encodes the slot, the grantee key hash, the generation and the scope', () => {
    const grant = fixtureGrants[0]!;
    expect(cbor(encodeGrant(grant)).startsWith(`d8799f00581c${AGENT_PAYMENT_KEY}00d8799f`)).toBe(true);
    expect(cbor(encodeGrant({ ...grant, slot: 7n, generation: 3n })).startsWith(`d8799f07581c${AGENT_PAYMENT_KEY}03d8799f`)).toBe(true);
    expect(() => decodeGrant({ constructor: 0n, fields: { items: [0n, { constructor: 0n, fields: { items: [] } }, 0n, encodeScope(grant.scope)] } })).toThrow(/grantee/);
    expect(() => decodeGrant({ constructor: 0n, fields: { items: [0n, Cometa.hexToUint8Array(AGENT_PAYMENT_KEY), encodeScope(grant.scope)] } })).toThrow(/grant/);
  });

  it('reads the stable prefix of a grant whatever follows it, and refuses a grant of another shape as a whole', () => {
    const grant = fixtureGrants[1]!;
    const prefix = { slot: 1n, grantee: AGENT_PAYMENT_KEY, generation: 0n };
    expect(decodeGrantPrefix(encodeGrant(grant))).toEqual(prefix);
    const extended = { constructor: 0n, fields: { items: [...encodeGrant(grant).fields.items, 99n] } };
    expect(decodeGrantPrefix(extended)).toEqual(prefix);
    expect(() => decodeGrant(extended)).toThrow(/a grant as constructor 0 with 4 fields/);
    const reshaped = { constructor: 0n, fields: { items: [1n, Cometa.hexToUint8Array(AGENT_PAYMENT_KEY), 0n, { items: [1n, 2n] }] } };
    expect(decodeGrantPrefix(reshaped)).toEqual(prefix);
    expect(() => decodeGrant(reshaped)).toThrow(/scope/);
    expect(() => decodeGrantPrefix({ constructor: 0n, fields: { items: [1n, Cometa.hexToUint8Array(AGENT_PAYMENT_KEY)] } })).toThrow(/at least 3 fields/);
    expect(() => decodeGrantPrefix({ constructor: 0n, fields: { items: [1n, 2n, 0n] } })).toThrow(/grantee/);
  });
});

describe('scope and grant', () => {
  it('round trips every field', () => {
    for (const grant of fixtureGrants) {
      expect(decodeGrant(encodeGrant(grant))).toEqual(grant);
      expect(decodeScope(encodeScope(grant.scope))).toEqual(grant.scope);
    }
  });

  it('encodes lovelace as the empty asset class', () => {
    const scope = fixtureGrants[0]?.scope;
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
  it('uses the declaration order of the account redeemer constructors, none with fields', () => {
    expect(cbor(encodeAccountRedeemer({ kind: 'device' }))).toBe('d87980');
    expect(cbor(encodeAccountRedeemer({ kind: 'spendWithGrant' }))).toBe('d87a80');
    expect(cbor(encodeAccountRedeemer({ kind: 'sweepGrant' }))).toBe('d87b80');
    expect(cbor(encodeAccountRedeemer({ kind: 'fund' }))).toBe('d87c80');
  });

  it('round trips the account redeemers', () => {
    const redeemers: AccountRedeemer[] = [{ kind: 'device' }, { kind: 'spendWithGrant' }, { kind: 'sweepGrant' }, { kind: 'fund' }];
    for (const redeemer of redeemers) {
      expect(decodeAccountRedeemer(encodeAccountRedeemer(redeemer))).toEqual(redeemer);
    }
    expect(() => decodeAccountRedeemer({ constructor: 4n, fields: { items: [] } })).toThrow(/redeemer/);
    expect(() => decodeAccountRedeemer({ constructor: 1n, fields: { items: [3n] } })).toThrow(/redeemer/);
  });

  it('uses the declaration order of the mint redeemer constructors, none with fields', () => {
    expect(cbor(encodeMintRedeemer({ kind: 'createAccount' }))).toBe('d87980');
    expect(cbor(encodeMintRedeemer({ kind: 'issueGrants' }))).toBe('d87a80');
    expect(cbor(encodeMintRedeemer({ kind: 'burnGrants' }))).toBe('d87b80');
    const redeemers: MintRedeemer[] = [{ kind: 'createAccount' }, { kind: 'issueGrants' }, { kind: 'burnGrants' }];
    for (const redeemer of redeemers) {
      expect(decodeMintRedeemer(encodeMintRedeemer(redeemer))).toEqual(redeemer);
    }
    expect(() => decodeMintRedeemer({ constructor: 3n, fields: { items: [] } })).toThrow(/redeemer/);
    expect(() => decodeMintRedeemer({ constructor: 0n, fields: { items: [0n] } })).toThrow(/redeemer/);
  });
});

describe('stake redeemer, logic redeemer and reserve datum', () => {
  it('encodes Operate as constructor 0 with no fields', () => {
    expect(cbor(encodeStakeRedeemer())).toBe('d87980');
  });

  it('encodes Run as constructor 0 with no fields', () => {
    expect(cbor(encodeLogicRedeemer())).toBe('d87980');
  });

  it('writes constructor 0 with no fields on a reserve', () => {
    expect(cbor(encodeReserveDatum())).toBe('d87980');
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
