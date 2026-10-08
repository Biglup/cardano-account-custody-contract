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
import {
  MAX_DEVICES,
  MAX_GRANTS,
  MAX_REVOKED,
  assertScopeWellFormed,
  assertWellFormed,
  grantAfterSpend,
  grantDeathReason,
  grantOutputViolation,
  hasZeroCounters,
  isGrantCurrent,
  isRevokedListFull,
  isWellFormed,
  scopeAfterSpend,
  scopeViolation,
  stateAfterIssue,
  stateAfterSweep,
  stateDefect,
  stateWithDevice,
  stateWithLogic,
  stateWithNextGeneration,
  stateWithRevokedSlot,
  stateWithoutDevice,
} from '../src/state.js';
import {
  EXPIRY,
  OTHER_DEVICE_KEY,
  OWNER_PAYMENT_KEY,
  TOKEN_ASSET_ID,
  fixtureGrants,
  grantedState,
  initialState,
  logicV2Hash,
  lovelaceScope,
  recipientAddress,
  tokenScope,
} from './support/account.js';

/* TESTS **********************************************************************/

describe('well formedness', () => {
  it('accepts the fixture states', () => {
    expect(isWellFormed(initialState)).toBe(true);
    expect(isWellFormed(grantedState)).toBe(true);
    expect(assertWellFormed(grantedState)).toBe(grantedState);
    expect(hasZeroCounters(initialState)).toBe(true);
    expect(hasZeroCounters(grantedState)).toBe(false);
    expect(hasZeroCounters({ ...initialState, revoked: [0n] })).toBe(false);
  });

  it('names each defect', () => {
    expect(stateDefect({ ...initialState, logic: '' })).toMatch(/logic must be a script hash/);
    expect(stateDefect({ ...initialState, logic: `${logicV2Hash}00` })).toMatch(/logic must be a script hash/);
    expect(stateDefect({ ...initialState, logic: 'zz'.repeat(28) })).toMatch(/logic must be a script hash/);
    expect(stateDefect({ ...initialState, devices: [] })).toMatch(/at least one device/);
    expect(stateDefect({ ...initialState, devices: Array.from({ length: MAX_DEVICES + 1 }, (_, i) => `${i}`.padStart(56, '0')) })).toMatch(/at most/);
    expect(stateDefect({ ...initialState, devices: [OWNER_PAYMENT_KEY, OWNER_PAYMENT_KEY] })).toMatch(/distinct/);
    expect(stateDefect({ ...initialState, grantGeneration: -1n })).toMatch(/generation/);
    expect(stateDefect({ ...initialState, nextSlot: -1n })).toMatch(/next slot/);
    expect(stateDefect({ ...initialState, outstanding: -1n })).toMatch(/outstanding count must not be negative/);
    expect(stateDefect({ ...initialState, nextSlot: 17n, outstanding: BigInt(MAX_GRANTS + 1) })).toMatch(/at most 16 outstanding/);
    expect(stateDefect({ ...initialState, nextSlot: 40n, revoked: Array.from({ length: MAX_REVOKED + 1 }, (_, i) => BigInt(i)) })).toMatch(/at most 32 revoked/);
    expect(() => assertWellFormed({ ...initialState, devices: [] })).toThrow(/not well formed/);
  });

  it('names each scope defect', () => {
    const scope = lovelaceScope();
    expect(assertScopeWellFormed(scope)).toBe(scope);
    expect(() => assertScopeWellFormed({ ...scope, cap: -1n })).toThrow(/caps must not be negative/);
    expect(() => assertScopeWellFormed({ ...scope, expiresAt: 0n })).toThrow(/expiry/);
    expect(() => assertScopeWellFormed({ ...scope, recipients: Array<string>(9).fill(recipientAddress) })).toThrow(/at most 8 recipients/);
    expect(() => assertScopeWellFormed({ ...scope, lovelaceCap: 1n })).toThrow(/zero lovelace caps/);
    expect(() => assertScopeWellFormed({ ...scope, lovelacePerCallCap: 1n })).toThrow(/zero lovelace caps/);
    expect(() => assertScopeWellFormed({ ...tokenScope(), lovelacePerCallCap: 1n })).not.toThrow();
  });
});

describe('transitions', () => {
  it('adds and removes devices', () => {
    const added = stateWithDevice(initialState, OTHER_DEVICE_KEY);
    expect(added.devices).toEqual([OWNER_PAYMENT_KEY, OTHER_DEVICE_KEY]);
    expect(stateWithoutDevice(added, OWNER_PAYMENT_KEY).devices).toEqual([OTHER_DEVICE_KEY]);
  });

  it('moves the counters on issue and sweep', () => {
    const issued = stateAfterIssue(initialState, 3);
    expect(issued).toEqual(grantedState);
    expect(stateAfterIssue(grantedState, 2)).toEqual({ ...grantedState, nextSlot: 5n, outstanding: 5n });
    expect(stateAfterSweep(grantedState, 2)).toEqual({ ...grantedState, outstanding: 1n });
  });

  it('points the state at another logic with the generation bumped and the revoked list cleared', () => {
    const upgraded = stateWithLogic({ ...grantedState, revoked: [1n] }, logicV2Hash);
    expect(upgraded).toEqual({ ...grantedState, logic: logicV2Hash, grantGeneration: 1n, revoked: [] });
    expect(upgraded.nextSlot).toBe(grantedState.nextSlot);
    expect(upgraded.outstanding).toBe(grantedState.outstanding);
    expect(isWellFormed(upgraded)).toBe(true);
  });

  it('appends revoked slots until the list is full, then bumps the generation', () => {
    const revoked = stateWithRevokedSlot(grantedState, 1n);
    expect(revoked.revoked).toEqual([1n]);
    expect(isRevokedListFull(revoked)).toBe(false);
    const full = { ...grantedState, revoked: Array.from({ length: MAX_REVOKED }, (_, i) => BigInt(i)) };
    expect(isRevokedListFull(full)).toBe(true);
    const bumped = stateWithNextGeneration(full);
    expect(bumped).toEqual({ ...full, grantGeneration: 1n, revoked: [] });
    expect(bumped.outstanding).toBe(full.outstanding);
  });
});

describe('grant liveness', () => {
  const grant = fixtureGrants[0]!;

  it('is current under the same generation while its slot is not revoked', () => {
    expect(isGrantCurrent(grant, grantedState)).toBe(true);
    expect(grantDeathReason(grant, grantedState)).toBeUndefined();
    expect(isGrantCurrent(grant, stateWithRevokedSlot(grantedState, 0n))).toBe(false);
    expect(isGrantCurrent(grant, stateWithNextGeneration(grantedState))).toBe(false);
    expect(isGrantCurrent({ ...grant, generation: 1n }, grantedState)).toBe(false);
  });

  it('names why a grant is dead', () => {
    expect(grantDeathReason(grant, stateWithNextGeneration(grantedState))).toMatch(/issued under generation 0 and the account is at 1/);
    expect(grantDeathReason(grant, stateWithRevokedSlot(grantedState, 0n))).toMatch(/slot 0 is revoked/);
    expect(grantDeathReason(grant, grantedState, EXPIRY)).toBeUndefined();
    expect(grantDeathReason(grant, grantedState, EXPIRY + 1n)).toMatch(/expired at/);
  });

  it('judges a grant known by its prefix alone by generation and slot, never by expiry', () => {
    const prefix = { slot: 0n, grantee: grant.grantee, generation: 0n };
    expect(isGrantCurrent(prefix, grantedState)).toBe(true);
    expect(grantDeathReason(prefix, grantedState, EXPIRY + 1n)).toBeUndefined();
    expect(grantDeathReason(prefix, stateWithLogic(grantedState, logicV2Hash))).toMatch(/issued under generation 0 and the account is at 1/);
    expect(grantDeathReason(prefix, stateWithRevokedSlot(grantedState, 0n))).toMatch(/slot 0 is revoked/);
  });
});

describe('caps after a spend', () => {
  it('reduces only the remaining caps by the outflow of their assets', () => {
    const after = scopeAfterSpend(tokenScope(), { [TOKEN_ASSET_ID]: 7n, '': 1_000_000n });
    expect(after.cap).toBe(43n);
    expect(after.lovelaceCap).toBe(2_000_000n);
    expect(after.perCallCap).toBe(10n);
    expect(after.lovelacePerCallCap).toBe(2_500_000n);
    const grant = fixtureGrants[1]!;
    expect(grantAfterSpend(grant, { [TOKEN_ASSET_ID]: 7n, '': 1_000_000n })).toEqual({ ...grant, scope: { ...after, recipients: grant.scope.recipients } });
  });

  it('never raises a cap on a net inflow', () => {
    expect(scopeAfterSpend(lovelaceScope(), { '': -5_000_000n }).cap).toBe(15_000_000n);
    expect(scopeAfterSpend(tokenScope(), { [TOKEN_ASSET_ID]: -3n, '': -10n })).toEqual(tokenScope());
  });

  it('leaves the lovelace cap of a lovelace grant untouched', () => {
    const after = scopeAfterSpend(lovelaceScope(), { '': 4_000_000n });
    expect(after.cap).toBe(11_000_000n);
    expect(after.lovelaceCap).toBe(0n);
  });
});

describe('scope violations', () => {
  it('bounds the scoped asset, the lovelace and everything else', () => {
    expect(scopeViolation(lovelaceScope(), { '': 10_000_000n })).toBeUndefined();
    expect(scopeViolation(lovelaceScope(), { '': 10_000_001n })).toMatch(/per call cap/);
    expect(scopeViolation({ ...lovelaceScope(), cap: 1n }, { '': 2n })).toMatch(/remaining cap/);
    expect(scopeViolation(tokenScope(), { [TOKEN_ASSET_ID]: 10n, '': 2_500_000n })).toBeUndefined();
    expect(scopeViolation(tokenScope(), { [TOKEN_ASSET_ID]: 1n, '': 2_500_001n })).toMatch(/lovelace per call cap of 2500000/);
    expect(scopeViolation({ ...tokenScope(), lovelaceCap: 1_000_000n }, { [TOKEN_ASSET_ID]: 1n, '': 1_000_001n })).toMatch(/remaining lovelace cap of 1000000/);
    expect(scopeViolation({ ...tokenScope(), lovelacePerCallCap: 0n }, { [TOKEN_ASSET_ID]: 1n })).toBeUndefined();
    expect(scopeViolation(lovelaceScope(), { '': 1n, [TOKEN_ASSET_ID]: 1n })).toMatch(/does not cover/);
    expect(scopeViolation(lovelaceScope(), { [TOKEN_ASSET_ID]: -1n })).toBeUndefined();
  });
});

describe('grant output violations', () => {
  const expected = grantAfterSpend(fixtureGrants[1]!, { [TOKEN_ASSET_ID]: 7n, '': 1_000_000n });

  it('accepts remaining caps anywhere between zero and the reduced value', () => {
    expect(grantOutputViolation(expected, expected)).toBeUndefined();
    expect(grantOutputViolation(expected, { ...expected, scope: { ...expected.scope, cap: 0n, lovelaceCap: 0n } })).toBeUndefined();
    expect(grantOutputViolation(expected, { ...expected, scope: { ...expected.scope, cap: 10n, lovelaceCap: 1n } })).toBeUndefined();
  });

  it('refuses caps above the reduced value or below zero', () => {
    expect(grantOutputViolation(expected, { ...expected, scope: { ...expected.scope, cap: 44n } })).toMatch(/remaining cap 44 exceeds the 43/);
    expect(grantOutputViolation(expected, { ...expected, scope: { ...expected.scope, lovelaceCap: 2_000_001n } })).toMatch(/remaining lovelace cap 2000001 exceeds/);
    expect(grantOutputViolation(expected, { ...expected, scope: { ...expected.scope, cap: -1n } })).toMatch(/below zero/);
  });

  it('refuses any change to the other fields', () => {
    expect(grantOutputViolation(expected, { ...expected, scope: { ...expected.scope, perCallCap: 9n } })).toMatch(/other than the remaining caps/);
    expect(grantOutputViolation(expected, { ...expected, scope: { ...expected.scope, recipients: [] } })).toMatch(/other than the remaining caps/);
    expect(grantOutputViolation(expected, { ...expected, scope: { ...expected.scope, expiresAt: EXPIRY + 1n } })).toMatch(/other than the remaining caps/);
    expect(grantOutputViolation(expected, { ...expected, generation: 1n })).toMatch(/other than the remaining caps/);
    expect(grantOutputViolation(expected, { ...expected, grantee: OWNER_PAYMENT_KEY })).toMatch(/other than the remaining caps/);
    expect(grantOutputViolation(expected, { ...expected, slot: 5n })).toMatch(/other than the remaining caps/);
  });
});
