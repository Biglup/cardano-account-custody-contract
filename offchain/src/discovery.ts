import type { Provider, UTxO } from '@biglup/cometa';
import { accountAddress, rewardAddress, stateNftAssetId, toAddress } from './address.js';
import { type Blueprint, accountScript, accountScriptHash, loadBlueprint } from './blueprint.js';
import { Cometa } from './cometa.js';
import { type AccountState, decodeAccountState } from './data.js';
import { stakeScript, stakeScriptHash } from './stake-script.js';

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

/** The asset id of the state NFT an account record's control UTxO holds. */
export const stateNftOf = (record: AccountRecord): string => {
  const payment = toAddress(record.address).asBase()?.getPaymentCredential();
  if (payment?.type !== Cometa.CredentialType.ScriptHash) {
    throw new Error(`${record.address} is not an account address`);
  }
  return stateNftAssetId(payment.hash, record.stakeScriptHash);
};

/**
 * Whether an account is live on chain: its control UTxO, the one holding
 * the state NFT at the account address, with the state it carries
 * decoded, or null when no such UTxO exists. Fails when the address holds
 * more than one such UTxO or the control UTxO carries no inline state.
 */
export const accountExists = async (provider: Provider, record: AccountRecord): Promise<LiveAccount | null> => {
  const nftAssetId = stateNftOf(record);
  const controls = (await provider.getUnspentOutputs(record.address)).filter(
    (utxo) => (utxo.output.value.assets?.[nftAssetId] ?? 0n) === 1n,
  );
  const control = controls[0];
  if (!control) {
    return null;
  }
  if (controls.length > 1) {
    throw new Error(`Expected at most one control UTxO at ${record.address}, found ${controls.length}`);
  }
  if (control.output.datum === undefined) {
    throw new Error('The control UTxO carries no inline datum');
  }
  return { control, state: decodeAccountState(control.output.datum, toAddress(record.address).getNetworkId()) };
};
