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

import type { Address, NetworkId, RewardAddress, Value } from '@biglup/cometa';
import { Cometa } from './cometa.js';
import { stakeCredential } from './stake-script.js';

/* CONSTANTS ******************************************************************/

/** The hex length of a state NFT name: the account's 28 byte stake script hash. */
export const STATE_NFT_NAME_HEX_LENGTH = 56;

/** The hex length of the slot suffix a grant token name appends to the stake script hash: four big endian bytes. */
export const GRANT_SLOT_HEX_LENGTH = 8;

/** The hex length of a grant token name: the stake script hash followed by the slot. */
export const GRANT_TOKEN_NAME_HEX_LENGTH = STATE_NFT_NAME_HEX_LENGTH + GRANT_SLOT_HEX_LENGTH;

/** The first slot a grant token name cannot carry, since four bytes hold it. */
const SLOT_LIMIT = 1n << 32n;

/* FUNCTIONS ******************************************************************/

/**
 * The address of a user's account: the account script as the payment
 * credential and the user's own stake script as the stake credential.
 */
export const accountAddress = (
  scriptHash: string,
  stakeScriptHash: string,
  networkId: NetworkId = Cometa.NetworkId.Testnet,
): Address =>
  Cometa.BaseAddress.fromCredentials(
    networkId,
    { hash: scriptHash, type: Cometa.CredentialType.ScriptHash },
    stakeCredential(stakeScriptHash),
  ).toAddress();

/**
 * The reward account of a user's account, which the stake script controls:
 * withdrawals draw from it and certificates register and delegate
 * its credential.
 */
export const rewardAddress = (stakeScriptHash: string, networkId: NetworkId = Cometa.NetworkId.Testnet): RewardAddress =>
  Cometa.RewardAddress.fromCredentials(networkId, stakeCredential(stakeScriptHash));

/**
 * The asset id of an account's state NFT: the account script hash as the
 * policy id and the user's stake script hash as the asset name.
 */
export const stateNftAssetId = (scriptHash: string, stakeScriptHash: string): string => `${scriptHash}${stakeScriptHash}`;

/**
 * The name of the grant token of an account's slot: the stake script hash
 * followed by the slot as four big endian bytes.
 */
export const grantTokenName = (stakeScriptHash: string, slot: bigint): string => {
  if (slot < 0n || slot >= SLOT_LIMIT) {
    throw new Error(`Slot ${slot} does not fit the four bytes of a grant token name`);
  }
  return `${stakeScriptHash}${slot.toString(16).padStart(GRANT_SLOT_HEX_LENGTH, '0')}`;
};

/** The asset id of the grant token of an account's slot under the account policy. */
export const grantAssetId = (scriptHash: string, stakeScriptHash: string, slot: bigint): string =>
  `${scriptHash}${grantTokenName(stakeScriptHash, slot)}`;

/** Whether a token name has the shape of a grant token name. */
export const isGrantTokenName = (name: string): boolean => name.length === GRANT_TOKEN_NAME_HEX_LENGTH;

/** The stake script hash a token name under the account policy belongs to: the name itself for a state NFT, its prefix for a grant token. */
export const accountOfTokenName = (name: string): string => name.slice(0, STATE_NFT_NAME_HEX_LENGTH);

/** The slot a grant token name carries. */
export const slotOfGrantTokenName = (name: string): bigint => {
  if (!isGrantTokenName(name)) {
    throw new Error(`${name} is not a grant token name`);
  }
  return BigInt(`0x${name.slice(STATE_NFT_NAME_HEX_LENGTH)}`);
};

/**
 * The grant token names of an account held by a value: the names under the
 * account policy whose prefix is the account's stake script hash and whose
 * shape is a grant's.
 */
export const grantTokenNamesOf = (value: Value, scriptHash: string, stakeScriptHash: string): string[] =>
  Object.entries(value.assets ?? {})
    .filter(([assetId, quantity]) => quantity > 0n && assetId.startsWith(scriptHash))
    .map(([assetId]) => assetId.slice(scriptHash.length))
    .filter((name) => isGrantTokenName(name) && accountOfTokenName(name) === stakeScriptHash);

/** Parses an address given either as a string or as a cometa address. */
export const toAddress = (address: Address | string): Address =>
  typeof address === 'string' ? Cometa.Address.fromString(address) : address;

/**
 * The verification key hash of an address's payment credential, or
 * undefined when the payment credential is a script.
 */
export const paymentKeyHashOf = (address: Address | string): string | undefined => {
  const parsed = toAddress(address);
  const credential = parsed.asBase()?.getPaymentCredential() ?? parsed.asEnterprise()?.getCredential();
  return credential?.type === Cometa.CredentialType.KeyHash ? credential.hash : undefined;
};

/** Whether an address is the account address of a stake script hash. */
export const isAccountAddress = (address: Address | string, scriptHash: string, stakeScriptHash: string): boolean => {
  const base = toAddress(address).asBase();
  if (!base) {
    return false;
  }
  const payment = base.getPaymentCredential();
  const stake = base.getStakeCredential();
  return (
    payment.type === Cometa.CredentialType.ScriptHash &&
    payment.hash === scriptHash &&
    stake.type === Cometa.CredentialType.ScriptHash &&
    stake.hash === stakeScriptHash
  );
};
