import type { Address, NetworkId, RewardAddress } from '@biglup/cometa';
import { Cometa } from './cometa.js';
import { stakeCredential } from './stake-script.js';

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
