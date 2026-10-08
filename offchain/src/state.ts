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

import { Cometa } from './cometa.js';
import { type AccountState, type Asset, type Grant, type Scope, encodeScope } from './data.js';
import { type Balance, LOVELACE_ASSET_ID, quantityOf } from './value.js';

/* CONSTANTS ******************************************************************/

/** The asset class of lovelace. */
export const LOVELACE: Asset = { policyId: '', assetName: '' };

/** The maximum number of device keys an account may hold. */
export const MAX_DEVICES = 8;

/** The maximum number of outstanding grants an account may hold. */
export const MAX_GRANTS = 16;

/**
 * The maximum number of revoked slots the state may list. Once the list
 * is full the owner revokes by bumping the grant generation instead, which
 * clears the list and kills every outstanding grant.
 */
export const MAX_REVOKED = 32;

/** The maximum number of recipients a grant's scope may list. */
export const MAX_RECIPIENTS = 8;

/* FUNCTIONS ******************************************************************/

/** Whether an asset class stands for lovelace. */
export const isLovelace = (asset: Asset): boolean => asset.policyId === '' && asset.assetName === '';

/** The asset id of an asset class, as cometa values key their assets. */
export const assetIdOf = (asset: Asset): string => `${asset.policyId}${asset.assetName}`;

/** Whether a list holds the same item twice. */
const hasDuplicates = <T>(items: T[]): boolean => new Set(items).size !== items.length;

/** Why a scope is not well formed, or undefined when it is. */
export const scopeDefect = (scope: Scope): string | undefined => {
  if (scope.perCallCap < 0n || scope.cap < 0n || scope.lovelacePerCallCap < 0n || scope.lovelaceCap < 0n) {
    return 'caps must not be negative';
  }
  if (scope.expiresAt <= 0n) {
    return 'the expiry must be a positive POSIX time';
  }
  if (scope.recipients.length > MAX_RECIPIENTS) {
    return `a scope may list at most ${MAX_RECIPIENTS} recipients`;
  }
  if (isLovelace(scope.asset) && (scope.lovelacePerCallCap !== 0n || scope.lovelaceCap !== 0n)) {
    return 'a lovelace scope must have zero lovelace caps';
  }
  return undefined;
};

/** Throws when a scope is not well formed, naming the defect. */
export const assertScopeWellFormed = (scope: Scope): Scope => {
  const defect = scopeDefect(scope);
  if (defect) {
    throw new Error(`The scope is not well formed: ${defect}`);
  }
  return scope;
};

/**
 * Why an account state is not well formed, or undefined when it is. The
 * validator refuses to create an account with, or rewrite the state to, a
 * state with a defect, so builders check this before building.
 */
export const stateDefect = (state: AccountState): string | undefined => {
  if (state.devices.length === 0) {
    return 'an account needs at least one device';
  }
  if (state.devices.length > MAX_DEVICES) {
    return `an account may hold at most ${MAX_DEVICES} devices`;
  }
  if (hasDuplicates(state.devices)) {
    return 'devices must be distinct';
  }
  if (state.grantGeneration < 0n) {
    return 'the grant generation must not be negative';
  }
  if (state.nextSlot < 0n) {
    return 'the next slot must not be negative';
  }
  if (state.outstanding < 0n) {
    return 'the outstanding count must not be negative';
  }
  if (state.outstanding > MAX_GRANTS) {
    return `an account may hold at most ${MAX_GRANTS} outstanding grants`;
  }
  if (state.revoked.length > MAX_REVOKED) {
    return `the state may list at most ${MAX_REVOKED} revoked slots`;
  }
  return undefined;
};

/** Whether an account state obeys every bound the validator relies on. */
export const isWellFormed = (state: AccountState): boolean => stateDefect(state) === undefined;

/** Throws when a state is not well formed, naming the defect. */
export const assertWellFormed = (state: AccountState): AccountState => {
  const defect = stateDefect(state);
  if (defect) {
    throw new Error(`The account state is not well formed: ${defect}`);
  }
  return state;
};

/** Whether a state has issued nothing yet: zero counters and no revoked slot, as every account starts. */
export const hasZeroCounters = (state: AccountState): boolean =>
  state.nextSlot === 0n && state.revoked.length === 0 && state.outstanding === 0n;

/** Whether the revoked list is full, so that the next revoke must bump the generation. */
export const isRevokedListFull = (state: AccountState): boolean => state.revoked.length >= MAX_REVOKED;

/** The state with a device added. */
export const stateWithDevice = (state: AccountState, device: string): AccountState => ({
  ...state,
  devices: [...state.devices, device],
});

/** The state with a device removed. */
export const stateWithoutDevice = (state: AccountState, device: string): AccountState => ({
  ...state,
  devices: state.devices.filter((existing) => existing !== device),
});

/** The state after issuing a number of grants: the next slot and the outstanding count move by that many. */
export const stateAfterIssue = (state: AccountState, count: number): AccountState => ({
  ...state,
  nextSlot: state.nextSlot + BigInt(count),
  outstanding: state.outstanding + BigInt(count),
});

/** The state after sweeping a number of dead grants: the outstanding count drops by that many. */
export const stateAfterSweep = (state: AccountState, count: number): AccountState => ({
  ...state,
  outstanding: state.outstanding - BigInt(count),
});

/** The state with a slot appended to the revoked list. */
export const stateWithRevokedSlot = (state: AccountState, slot: bigint): AccountState => ({
  ...state,
  revoked: [...state.revoked, slot],
});

/** The state with the grant generation bumped and the revoked list cleared, which kills every outstanding grant. */
export const stateWithNextGeneration = (state: AccountState): AccountState => ({
  ...state,
  grantGeneration: state.grantGeneration + 1n,
  revoked: [],
});

/** Whether a grant is current against a state: issued under its generation and not revoked by slot. */
export const isGrantCurrent = (grant: Grant, state: AccountState): boolean =>
  grant.generation === state.grantGeneration && !state.revoked.includes(grant.slot);

/**
 * Why a grant can no longer be spent against a state, or undefined while
 * it is live: issued under an older generation, revoked by slot, or
 * expired before the time a validity range starts at, when one is given.
 */
export const grantDeathReason = (grant: Grant, state: AccountState, validityStart?: bigint): string | undefined => {
  if (grant.generation < state.grantGeneration) {
    return `grant ${grant.slot} was issued under generation ${grant.generation} and the account is at ${state.grantGeneration}`;
  }
  if (state.revoked.includes(grant.slot)) {
    return `slot ${grant.slot} is revoked`;
  }
  if (validityStart !== undefined && validityStart > grant.scope.expiresAt) {
    return `grant ${grant.slot} expired at ${grant.scope.expiresAt}, before the validity range starts`;
  }
  return undefined;
};

/** The outflow a quantity stands for: itself when positive, nothing on an inflow. */
const clampedOutflow = (quantity: bigint): bigint => (quantity > 0n ? quantity : 0n);

/**
 * A scope with its remaining caps reduced by a leaving balance: each
 * cumulative cap loses the net outflow of its asset, clamped at zero, so a
 * deposit made alongside the spend never raises a cap above what the owner
 * granted. The per call caps bound every spend alike and never change.
 */
export const scopeAfterSpend = (scope: Scope, leaving: Balance): Scope => ({
  ...scope,
  cap: scope.cap - clampedOutflow(quantityOf(leaving, assetIdOf(scope.asset))),
  lovelaceCap: isLovelace(scope.asset)
    ? scope.lovelaceCap
    : scope.lovelaceCap - clampedOutflow(quantityOf(leaving, LOVELACE_ASSET_ID)),
});

/** The grant a spend must write back: the same grant with its remaining caps reduced by what left. */
export const grantAfterSpend = (grant: Grant, leaving: Balance): Grant => ({
  ...grant,
  scope: scopeAfterSpend(grant.scope, leaving),
});

/**
 * Why a leaving balance breaks a scope, or undefined when it stays within
 * it: no more of the scoped asset than the per call cap and the remaining
 * cap, no more lovelace than the lovelace per call cap and the remaining
 * lovelace cap when the scoped asset is not lovelace, and nothing of any
 * other asset class.
 */
export const scopeViolation = (scope: Scope, leaving: Balance): string | undefined => {
  const assetId = assetIdOf(scope.asset);
  const assetLeaving = quantityOf(leaving, assetId);
  if (assetLeaving > scope.perCallCap) {
    return `${assetLeaving} of the scoped asset exceeds the per call cap of ${scope.perCallCap}`;
  }
  if (assetLeaving > scope.cap) {
    return `${assetLeaving} of the scoped asset exceeds the remaining cap of ${scope.cap}`;
  }
  const lovelaceLeaving = quantityOf(leaving, LOVELACE_ASSET_ID);
  if (!isLovelace(scope.asset) && lovelaceLeaving > scope.lovelacePerCallCap) {
    return `${lovelaceLeaving} lovelace exceeds the lovelace per call cap of ${scope.lovelacePerCallCap}`;
  }
  if (!isLovelace(scope.asset) && lovelaceLeaving > scope.lovelaceCap) {
    return `${lovelaceLeaving} lovelace exceeds the remaining lovelace cap of ${scope.lovelaceCap}`;
  }
  for (const [leavingAssetId, quantity] of Object.entries(leaving)) {
    if (leavingAssetId !== assetId && leavingAssetId !== LOVELACE_ASSET_ID && quantity > 0n) {
      return `${quantity} of ${leavingAssetId} would leave, which the scope does not cover`;
    }
  }
  return undefined;
};

/**
 * Why the grant a spend writes back is not an accepted reduction of the
 * grant expected after that spend, or undefined when it is: the remaining
 * caps may sit anywhere between zero and the expected value, since the
 * spender reduces them ahead of a fee it only bounds, while the per call
 * caps and every other field must stay as they were.
 */
export const grantOutputViolation = (expected: Grant, actual: Grant): string | undefined => {
  if (actual.scope.cap < 0n || actual.scope.lovelaceCap < 0n) {
    return 'a remaining cap is below zero';
  }
  if (actual.scope.cap > expected.scope.cap) {
    return `the remaining cap ${actual.scope.cap} exceeds the ${expected.scope.cap} the spend leaves`;
  }
  if (actual.scope.lovelaceCap > expected.scope.lovelaceCap) {
    return `the remaining lovelace cap ${actual.scope.lovelaceCap} exceeds the ${expected.scope.lovelaceCap} the spend leaves`;
  }
  const aligned: Scope = { ...actual.scope, cap: expected.scope.cap, lovelaceCap: expected.scope.lovelaceCap };
  if (
    actual.slot !== expected.slot ||
    actual.grantee !== expected.grantee ||
    actual.generation !== expected.generation ||
    !Cometa.deepEqualsPlutusData(encodeScope(aligned), encodeScope(expected.scope))
  ) {
    return 'a field other than the remaining caps changed';
  }
  return undefined;
};
