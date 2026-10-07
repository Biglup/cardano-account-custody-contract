import type { AccountState, Asset, Grant, Scope } from './data.js';
import { type Balance, LOVELACE_ASSET_ID, quantityOf } from './value.js';

/** The asset class of lovelace. */
export const LOVELACE: Asset = { policyId: '', assetName: '' };

/** The maximum number of device keys an account may hold. */
export const MAX_DEVICES = 8;

/** The maximum number of outstanding grants an account may hold. */
export const MAX_GRANTS = 16;

/** The maximum number of recipients a grant's scope may list. */
export const MAX_RECIPIENTS = 8;

/** Whether an asset class stands for lovelace. */
export const isLovelace = (asset: Asset): boolean => asset.policyId === '' && asset.assetName === '';

/** The asset id of an asset class, as cometa values key their assets. */
export const assetIdOf = (asset: Asset): string => `${asset.policyId}${asset.assetName}`;

/** Whether a list holds the same item twice. */
const hasDuplicates = <T>(items: T[]): boolean => new Set(items).size !== items.length;

/** Why a scope is not well formed, or undefined when it is. */
export const scopeDefect = (scope: Scope): string | undefined => {
  if (scope.perCallCap < 0n || scope.cap < 0n || scope.lovelaceCap < 0n) {
    return 'caps must not be negative';
  }
  if (scope.expiresAt <= 0n) {
    return 'the expiry must be a positive POSIX time';
  }
  if (scope.recipients.length > MAX_RECIPIENTS) {
    return `a scope may list at most ${MAX_RECIPIENTS} recipients`;
  }
  if (isLovelace(scope.asset) && scope.lovelaceCap !== 0n) {
    return 'a lovelace scope must have a zero lovelace cap';
  }
  return undefined;
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
  if (state.grants.length > MAX_GRANTS) {
    return `an account may hold at most ${MAX_GRANTS} grants`;
  }
  if (hasDuplicates(state.grants.map((grant) => grant.slot))) {
    return 'grant slots must be distinct';
  }
  for (const grant of state.grants) {
    const defect = scopeDefect(grant.scope);
    if (defect) {
      return `grant ${grant.slot}: ${defect}`;
    }
  }
  if (state.grantGeneration < 0n) {
    return 'the grant generation must not be negative';
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

/** The grant occupying a slot, if any. */
export const findGrant = (state: AccountState, slot: bigint): Grant | undefined =>
  state.grants.find((grant) => grant.slot === slot);

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

/** The state with a grant issued. */
export const stateWithGrant = (state: AccountState, grant: Grant): AccountState => ({
  ...state,
  grants: [...state.grants, grant],
});

/** The state with the grant in a slot revoked. */
export const stateWithoutGrant = (state: AccountState, slot: bigint): AccountState => ({
  ...state,
  grants: state.grants.filter((grant) => grant.slot !== slot),
});

/** The state with every grant revoked and the grant generation bumped. */
export const stateWithoutGrants = (state: AccountState): AccountState => ({
  ...state,
  grants: [],
  grantGeneration: state.grantGeneration + 1n,
});

/** The outflow a quantity stands for: itself when positive, nothing on an inflow. */
const clampedOutflow = (quantity: bigint): bigint => (quantity > 0n ? quantity : 0n);

/**
 * A scope with its remaining caps reduced by a leaving balance: each cap
 * loses the net outflow of its asset, clamped at zero, so a deposit made
 * alongside the spend never raises a cap above what the owner granted.
 */
export const scopeAfterSpend = (scope: Scope, leaving: Balance): Scope => ({
  ...scope,
  cap: scope.cap - clampedOutflow(quantityOf(leaving, assetIdOf(scope.asset))),
  lovelaceCap: isLovelace(scope.asset)
    ? scope.lovelaceCap
    : scope.lovelaceCap - clampedOutflow(quantityOf(leaving, LOVELACE_ASSET_ID)),
});

/**
 * The state the account must carry after a grant spend: the same state
 * with the used grant's remaining caps reduced by what left.
 */
export const stateAfterSpend = (state: AccountState, slot: bigint, leaving: Balance): AccountState => ({
  ...state,
  grants: state.grants.map((grant) =>
    grant.slot === slot ? { ...grant, scope: scopeAfterSpend(grant.scope, leaving) } : grant,
  ),
});

/**
 * Why a leaving balance breaks a scope, or undefined when it stays within
 * it: no more of the scoped asset than the per call cap and the remaining
 * cap, no more lovelace than the remaining lovelace cap when the scoped
 * asset is not lovelace, and nothing of any other asset class.
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
