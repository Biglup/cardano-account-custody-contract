import type { Value } from '@biglup/cometa';

/**
 * Quantities per asset class, keyed by asset id (policy id followed by
 * asset name as hex). Lovelace is the empty asset id. Unlike a cometa value
 * a balance may hold negative quantities, which lets it express the net
 * value leaving an address.
 */
export type Balance = Record<string, bigint>;

/** The asset id of lovelace: an empty policy id and an empty asset name. */
export const LOVELACE_ASSET_ID = '';

/** The balance of a value. */
export const toBalance = (value: Value): Balance => {
  const balance: Balance = {};
  if (value.coins !== 0n) {
    balance[LOVELACE_ASSET_ID] = value.coins;
  }
  for (const [assetId, quantity] of Object.entries(value.assets ?? {})) {
    if (quantity !== 0n) {
      balance[assetId] = quantity;
    }
  }
  return balance;
};

/** The value of a balance, which must hold no negative quantity. */
export const toValue = (balance: Balance): Value => {
  const assets: Record<string, bigint> = {};
  for (const [assetId, quantity] of Object.entries(balance)) {
    if (quantity < 0n) {
      throw new Error(`A value cannot hold a negative quantity of ${assetId || 'lovelace'}`);
    }
    if (assetId !== LOVELACE_ASSET_ID && quantity > 0n) {
      assets[assetId] = quantity;
    }
  }
  const value: Value = { coins: balance[LOVELACE_ASSET_ID] ?? 0n };
  if (Object.keys(assets).length > 0) {
    value.assets = assets;
  }
  return value;
};

/** The sum of balances, with zero quantities dropped. */
export const addBalances = (...balances: Balance[]): Balance => {
  const total: Balance = {};
  for (const balance of balances) {
    for (const [assetId, quantity] of Object.entries(balance)) {
      const sum = (total[assetId] ?? 0n) + quantity;
      if (sum === 0n) {
        delete total[assetId];
      } else {
        total[assetId] = sum;
      }
    }
  }
  return total;
};

/** A balance with every quantity negated. */
export const negateBalance = (balance: Balance): Balance =>
  Object.fromEntries(Object.entries(balance).map(([assetId, quantity]) => [assetId, -quantity]));

/** The first balance minus the second. */
export const subtractBalances = (minuend: Balance, subtrahend: Balance): Balance =>
  addBalances(minuend, negateBalance(subtrahend));

/** Whether a balance holds no asset at all. */
export const isZeroBalance = (balance: Balance): boolean => Object.keys(balance).length === 0;

/** Whether a balance holds at least as much of every asset as another. */
export const coversBalance = (balance: Balance, required: Balance): boolean =>
  Object.entries(required).every(([assetId, quantity]) => (balance[assetId] ?? 0n) >= quantity);

/** The quantity of one asset in a balance. */
export const quantityOf = (balance: Balance, assetId: string): bigint => balance[assetId] ?? 0n;
