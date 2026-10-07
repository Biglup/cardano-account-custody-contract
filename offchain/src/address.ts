import type { Address, NetworkId } from '@biglup/cometa';
import { Cometa } from './cometa.js';

/**
 * The address of a user's account: the account script as the payment
 * credential and the user's own stake key as the stake credential.
 */
export const accountAddress = (
  scriptHash: string,
  stakeKeyHash: string,
  networkId: NetworkId = Cometa.NetworkId.Testnet,
): Address =>
  Cometa.BaseAddress.fromCredentials(
    networkId,
    { hash: scriptHash, type: Cometa.CredentialType.ScriptHash },
    { hash: stakeKeyHash, type: Cometa.CredentialType.KeyHash },
  ).toAddress();

/**
 * The asset id of an account's state NFT: the account script hash as the
 * policy id and the user's stake key hash as the asset name.
 */
export const stateNftAssetId = (scriptHash: string, stakeKeyHash: string): string => `${scriptHash}${stakeKeyHash}`;

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

/**
 * The verification key hash of an address's stake credential, or undefined
 * when the address has no inline key stake credential.
 */
export const stakeKeyHashOf = (address: Address | string): string | undefined => {
  const credential = toAddress(address).asBase()?.getStakeCredential();
  return credential?.type === Cometa.CredentialType.KeyHash ? credential.hash : undefined;
};

/** Whether an address is the account address of a stake key hash. */
export const isAccountAddress = (address: Address | string, scriptHash: string, stakeKeyHash: string): boolean => {
  const base = toAddress(address).asBase();
  if (!base) {
    return false;
  }
  const payment = base.getPaymentCredential();
  const stake = base.getStakeCredential();
  return (
    payment.type === Cometa.CredentialType.ScriptHash &&
    payment.hash === scriptHash &&
    stake.type === Cometa.CredentialType.KeyHash &&
    stake.hash === stakeKeyHash
  );
};
