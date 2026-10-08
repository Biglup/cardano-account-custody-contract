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

import type { NetworkId, Provider, UTxO } from '@biglup/cometa';
import {
  accountAddress,
  grantTokenNamesOf,
  rewardAddress,
  slotOfGrantTokenName,
  stateNftAssetId,
  toAddress,
} from './address.js';
import { type Blueprint, accountScript, accountScriptHash, loadBlueprint } from './blueprint.js';
import { Cometa } from './cometa.js';
import { type AccountState, type Grant, decodeAccountState, decodeGrant } from './data.js';
import { stakeScript, stakeScriptHash } from './stake-script.js';
import { grantDeathReason } from './state.js';

/* TYPES **********************************************************************/

/**
 * What a client persists to find an account again: the owner device key
 * hash the account's stake script is applied to, the resulting stake
 * credential and the account address. The owner device derives all of it
 * from its key alone, so a passkey synced to another machine finds the
 * same account; a second device added with its own key cannot derive the
 * address and keeps the record it learns when it is added.
 */
export interface AccountRecord {
  owner: string;
  stakeScriptHash: string;
  address: string;
}

/** An account record together with the reward account and the state NFT asset id derived from it. */
export interface DiscoveredAccount extends AccountRecord {
  rewardAddress: string;
  stateNftAssetId: string;
}

/** The control UTxO of a live account and the state it carries. */
export interface LiveAccount {
  control: UTxO;
  state: AccountState;
}

/** A grant UTxO of an account: the UTxO, the grant it carries and the asset id of its grant token. */
export interface GrantUtxo {
  utxo: UTxO;
  grant: Grant;
  assetId: string;
}

/**
 * The UTxOs at an account address by kind: the control UTxO holding the
 * state NFT, the grant UTxOs holding a grant token each, the reserves,
 * which carry a datum and are the owner's alone to spend, and the funds,
 * plain deposits any path may spend. A reserve carrying only a datum
 * hash is listed with the reserves but is inert: the builders never
 * spend it, since the ledger needs the datum itself to spend it.
 */
export interface AccountUtxoKinds {
  control: UTxO | undefined;
  grants: GrantUtxo[];
  reserves: UTxO[];
  funds: UTxO[];
}

/** The credentials an account record resolves to, with the network its address lives on. */
interface AccountCredentials {
  scriptHash: string;
  stakeScriptHash: string;
  networkId: NetworkId;
}

/* FUNCTIONS ******************************************************************/

/**
 * The account an owner device key hash identifies, computed from the key
 * and the blueprint alone: the stake script applied to the key and the
 * account script hash gives the stake credential, which fixes the address,
 * the reward account and the name of the state NFT.
 */
export const accountByOwner = (
  owner: string,
  blueprint: Blueprint = loadBlueprint(),
  networkId = Cometa.NetworkId.Testnet,
): DiscoveredAccount => {
  const scriptHash = accountScriptHash(accountScript(blueprint));
  const stakeHash = stakeScriptHash(stakeScript(owner, scriptHash, blueprint));
  return {
    owner,
    stakeScriptHash: stakeHash,
    address: accountAddress(scriptHash, stakeHash, networkId).toString(),
    rewardAddress: rewardAddress(stakeHash, networkId).toBech32(),
    stateNftAssetId: stateNftAssetId(scriptHash, stakeHash),
  };
};

/** The account script hash, stake script hash and network of a record, read from its address. */
const credentialsOf = (record: AccountRecord): AccountCredentials => {
  const address = toAddress(record.address);
  const payment = address.asBase()?.getPaymentCredential();
  if (payment?.type !== Cometa.CredentialType.ScriptHash) {
    throw new Error(`${record.address} is not an account address`);
  }
  return { scriptHash: payment.hash, stakeScriptHash: record.stakeScriptHash, networkId: address.getNetworkId() };
};

/** The asset id of the state NFT an account record's control UTxO holds. */
export const stateNftOf = (record: AccountRecord): string => {
  const { scriptHash, stakeScriptHash } = credentialsOf(record);
  return stateNftAssetId(scriptHash, stakeScriptHash);
};

/** Whether a UTxO holds exactly one state NFT of the account. */
const holdsStateNft = (utxo: UTxO, nftAssetId: string): boolean => (utxo.output.value.assets?.[nftAssetId] ?? 0n) === 1n;

/** The grant a grant UTxO carries, decoded from its inline datum and checked against its token's slot. */
const grantOf = (utxo: UTxO, name: string, networkId: NetworkId): Grant => {
  if (utxo.output.datum === undefined) {
    throw new Error(`The grant UTxO ${utxo.input.txId}#${utxo.input.index} carries no inline datum`);
  }
  const grant = decodeGrant(utxo.output.datum, networkId);
  const slot = slotOfGrantTokenName(name);
  if (grant.slot !== slot) {
    throw new Error(`The grant UTxO of slot ${slot} carries a grant of slot ${grant.slot}`);
  }
  return grant;
};

/**
 * Sorts the UTxOs at an account address by kind. A UTxO holding the state
 * NFT is the control UTxO, one holding a grant token of the account is a
 * grant UTxO, one carrying any datum without an account token is a
 * reserve, and the rest are funds. Fails when the address holds more than
 * one control UTxO or a grant UTxO whose datum is not the grant of its
 * token.
 */
export const classifyAccountUtxos = (
  utxos: UTxO[],
  scriptHash: string,
  stakeScriptHash: string,
  networkId: NetworkId = Cometa.NetworkId.Testnet,
): AccountUtxoKinds => {
  const nftAssetId = stateNftAssetId(scriptHash, stakeScriptHash);
  const kinds: AccountUtxoKinds = { control: undefined, grants: [], reserves: [], funds: [] };
  for (const utxo of utxos) {
    const names = grantTokenNamesOf(utxo.output.value, scriptHash, stakeScriptHash);
    const [name] = names;
    if (holdsStateNft(utxo, nftAssetId)) {
      if (kinds.control) {
        throw new Error(`Expected at most one control UTxO at ${utxo.output.address}, found several`);
      }
      kinds.control = utxo;
    } else if (name !== undefined) {
      if (names.length > 1) {
        throw new Error(`The UTxO ${utxo.input.txId}#${utxo.input.index} holds several grant tokens`);
      }
      kinds.grants.push({ utxo, grant: grantOf(utxo, name, networkId), assetId: `${scriptHash}${name}` });
    } else if (utxo.output.datum !== undefined || utxo.output.datumHash !== undefined) {
      kinds.reserves.push(utxo);
    } else {
      kinds.funds.push(utxo);
    }
  }
  return kinds;
};

/** The UTxOs at a record's address sorted by kind. */
const accountUtxosOf = async (provider: Provider, record: AccountRecord): Promise<AccountUtxoKinds> => {
  const { scriptHash, stakeScriptHash, networkId } = credentialsOf(record);
  return classifyAccountUtxos(await provider.getUnspentOutputs(record.address), scriptHash, stakeScriptHash, networkId);
};

/** The state a control UTxO carries; fails when it carries no inline datum. */
const stateOf = (control: UTxO): AccountState => {
  if (control.output.datum === undefined) {
    throw new Error('The control UTxO carries no inline datum');
  }
  return decodeAccountState(control.output.datum);
};

/**
 * Whether an account is live on chain: its control UTxO, the one holding
 * the state NFT at the account address, with the state it carries
 * decoded, or null when no such UTxO exists. Fails when the address holds
 * more than one such UTxO or the control UTxO carries no inline state.
 */
export const accountExists = async (provider: Provider, record: AccountRecord): Promise<LiveAccount | null> => {
  const { control } = await accountUtxosOf(provider, record);
  return control ? { control, state: stateOf(control) } : null;
};

/** The grant UTxOs of an account, live or dead, in slot order. */
export const grantsOf = async (provider: Provider, record: AccountRecord): Promise<GrantUtxo[]> => {
  const { grants } = await accountUtxosOf(provider, record);
  return grants.sort((a, b) => Number(a.grant.slot - b.grant.slot));
};

/**
 * The grant UTxOs of an account that the owner can sweep: issued under an
 * older generation, revoked by slot, or expired at the given time, which
 * defaults to now. Fails when the account has no control UTxO.
 */
export const deadGrantsOf = async (provider: Provider, record: AccountRecord, now: bigint = BigInt(Date.now())): Promise<GrantUtxo[]> => {
  const { control, grants } = await accountUtxosOf(provider, record);
  if (!control) {
    throw new Error(`No control UTxO at ${record.address}`);
  }
  const state = stateOf(control);
  return grants.filter(({ grant }) => grantDeathReason(grant, state, now) !== undefined).sort((a, b) => Number(a.grant.slot - b.grant.slot));
};
