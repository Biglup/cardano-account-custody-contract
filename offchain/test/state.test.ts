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
  assertWellFormed,
  findGrant,
  isWellFormed,
  scopeViolation,
  stateAfterSpend,
  stateDefect,
  stateWithDevice,
  stateWithGrant,
  stateWithoutDevice,
  stateWithoutGrant,
  stateWithoutGrants,
} from '../src/state.js';
import {
  OTHER_DEVICE_KEY,
  OWNER_PAYMENT_KEY,
  TOKEN_ASSET_ID,
  grantedState,
  initialState,
  lovelaceScope,
  tokenScope,
} from './support/account.js';

/* TESTS **********************************************************************/

describe('well formedness', () => {
  it('accepts the fixture states', () => {
    expect(isWellFormed(initialState)).toBe(true);
    expect(isWellFormed(grantedState)).toBe(true);
    expect(assertWellFormed(grantedState)).toBe(grantedState);
  });

  it('names each defect', () => {
    expect(stateDefect({ ...initialState, devices: [] })).toMatch(/at least one device/);
    expect(stateDefect({ ...initialState, devices: Array.from({ length: MAX_DEVICES + 1 }, (_, i) => `${i}`.padStart(56, '0')) })).toMatch(/at most/);
    expect(stateDefect({ ...initialState, devices: [OWNER_PAYMENT_KEY, OWNER_PAYMENT_KEY] })).toMatch(/distinct/);
    expect(stateDefect({ ...initialState, grantGeneration: -1n })).toMatch(/generation/);
    const grant = grantedState.grants[0]!;
    expect(stateDefect({ ...initialState, grants: [grant, grant] })).toMatch(/slots must be distinct/);
    expect(stateDefect({ ...initialState, grants: Array.from({ length: MAX_GRANTS + 1 }, (_, i) => ({ ...grant, slot: BigInt(i) })) })).toMatch(/at most/);
    expect(stateDefect({ ...initialState, grants: [{ ...grant, scope: { ...grant.scope, cap: -1n } }] })).toMatch(/caps/);
    expect(stateDefect({ ...initialState, grants: [{ ...grant, scope: { ...grant.scope, expiresAt: 0n } }] })).toMatch(/expiry/);
    expect(stateDefect({ ...initialState, grants: [{ ...grant, scope: { ...grant.scope, lovelaceCap: 1n } }] })).toMatch(/zero lovelace caps/);
    expect(stateDefect({ ...initialState, grants: [{ ...grant, scope: { ...grant.scope, lovelacePerCallCap: 1n } }] })).toMatch(/zero lovelace caps/);
    expect(stateDefect({ ...initialState, grants: [{ ...grant, scope: { ...grant.scope, lovelacePerCallCap: -1n } }] })).toMatch(/caps must not be negative/);
    expect(stateDefect({ ...initialState, grants: [{ ...grantedState.grants[1]!, scope: { ...tokenScope(), lovelacePerCallCap: 1n } }] })).toBeUndefined();
    expect(() => assertWellFormed({ ...initialState, devices: [] })).toThrow(/not well formed/);
  });
});

describe('transitions', () => {
  it('adds and removes devices', () => {
    const added = stateWithDevice(initialState, OTHER_DEVICE_KEY);
    expect(added.devices).toEqual([OWNER_PAYMENT_KEY, OTHER_DEVICE_KEY]);
    expect(stateWithoutDevice(added, OWNER_PAYMENT_KEY).devices).toEqual([OTHER_DEVICE_KEY]);
  });

  it('issues and revokes grants and bumps the generation on revoke all', () => {
    const grant = grantedState.grants[1]!;
    const issued = stateWithGrant(initialState, grant);
    expect(findGrant(issued, 1n)).toEqual(grant);
    expect(findGrant(issued, 5n)).toBeUndefined();
    expect(stateWithoutGrant(grantedState, 1n).grants.map((g) => g.slot)).toEqual([0n, 2n]);
    const cleared = stateWithoutGrants(grantedState);
    expect(cleared.grants).toEqual([]);
    expect(cleared.grantGeneration).toBe(1n);
  });
});

describe('state after spend', () => {
  it('reduces only the used grant caps by the outflow of their assets', () => {
    const after = stateAfterSpend(grantedState, 1n, { [TOKEN_ASSET_ID]: 7n, '': 1_000_000n });
    expect(after.grants[1]!.scope.cap).toBe(43n);
    expect(after.grants[1]!.scope.lovelaceCap).toBe(2_000_000n);
    expect(after.grants[1]!.scope.perCallCap).toBe(10n);
    expect(after.grants[1]!.scope.lovelacePerCallCap).toBe(2_500_000n);
    expect(after.grants[0]).toEqual(grantedState.grants[0]);
    expect(after.grants[2]).toEqual(grantedState.grants[2]);
  });

  it('never raises a cap on a net inflow', () => {
    const after = stateAfterSpend(grantedState, 0n, { '': -5_000_000n });
    expect(after.grants[0]!.scope.cap).toBe(15_000_000n);
    const tokenInflow = stateAfterSpend(grantedState, 1n, { [TOKEN_ASSET_ID]: -3n, '': -10n });
    expect(tokenInflow.grants[1]!.scope).toEqual(grantedState.grants[1]!.scope);
  });

  it('leaves the lovelace cap of a lovelace grant untouched', () => {
    const after = stateAfterSpend(grantedState, 0n, { '': 4_000_000n });
    expect(after.grants[0]!.scope.cap).toBe(11_000_000n);
    expect(after.grants[0]!.scope.lovelaceCap).toBe(0n);
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
