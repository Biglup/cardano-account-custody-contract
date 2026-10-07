import { describe, expect, it } from 'vitest';
import { accountAddress, isAccountAddress, paymentKeyHashOf, stakeKeyHashOf, stateNftAssetId } from '../src/address.js';
import { accountScript, accountScriptHash, accountValidator, loadBlueprint } from '../src/blueprint.js';
import { Cometa } from '../src/cometa.js';
import { OWNER_PAYMENT_KEY, OWNER_STAKE_KEY, enterpriseAddress } from './support/account.js';

describe('blueprint', () => {
  it('loads the account validator as a Plutus V3 script', () => {
    const blueprint = loadBlueprint();
    const script = accountScript(blueprint);
    expect(blueprint.preamble.plutusVersion).toBe('v3');
    expect(script.version).toBe(Cometa.PlutusLanguageVersion.V3);
    expect(script.bytes).toBe(accountValidator(blueprint).compiledCode);
  });

  it('computes the script hash the blueprint reports', () => {
    const blueprint = loadBlueprint();
    const hash = accountScriptHash(accountScript(blueprint));
    expect(hash).toBe(accountValidator(blueprint).hash);
    for (const validator of blueprint.validators) {
      expect(validator.hash).toBe(hash);
    }
  });

  it('refuses a blueprint without the account validator', () => {
    expect(() => accountValidator({ preamble: { title: 'x', plutusVersion: 'v3' }, validators: [] })).toThrow(/account\.account/);
  });
});

describe('account address', () => {
  const scriptHash = accountScriptHash(accountScript());

  it('pays to the script and stakes with the user key', () => {
    const address = accountAddress(scriptHash, OWNER_STAKE_KEY);
    const base = address.asBase();
    expect(address.getType()).toBe(Cometa.AddressType.BasePaymentScriptStakeKey);
    expect(address.getNetworkId()).toBe(Cometa.NetworkId.Testnet);
    expect(base?.getPaymentCredential()).toEqual({ hash: scriptHash, type: Cometa.CredentialType.ScriptHash });
    expect(base?.getStakeCredential()).toEqual({ hash: OWNER_STAKE_KEY, type: Cometa.CredentialType.KeyHash });
    expect(address.toString().startsWith('addr_test1')).toBe(true);
    expect(stakeKeyHashOf(address)).toBe(OWNER_STAKE_KEY);
    expect(paymentKeyHashOf(address)).toBeUndefined();
    expect(isAccountAddress(address.toString(), scriptHash, OWNER_STAKE_KEY)).toBe(true);
    expect(isAccountAddress(address, scriptHash, OWNER_PAYMENT_KEY)).toBe(false);
  });

  it('names the state NFT after the script hash and the stake key hash', () => {
    const assetId = stateNftAssetId(scriptHash, OWNER_STAKE_KEY);
    expect(assetId).toBe(`${scriptHash}${OWNER_STAKE_KEY}`);
    expect(Cometa.policyIdFromAssetId(assetId)).toBe(scriptHash);
    expect(Cometa.assetNameFromAssetId(assetId)).toBe(OWNER_STAKE_KEY);
  });

  it('reads the keys of a wallet address', () => {
    const wallet = Cometa.BaseAddress.fromCredentials(
      Cometa.NetworkId.Testnet,
      { hash: OWNER_PAYMENT_KEY, type: Cometa.CredentialType.KeyHash },
      { hash: OWNER_STAKE_KEY, type: Cometa.CredentialType.KeyHash },
    ).toAddress();
    expect(paymentKeyHashOf(wallet)).toBe(OWNER_PAYMENT_KEY);
    expect(stakeKeyHashOf(wallet)).toBe(OWNER_STAKE_KEY);
    expect(paymentKeyHashOf(enterpriseAddress(OWNER_PAYMENT_KEY))).toBe(OWNER_PAYMENT_KEY);
    expect(stakeKeyHashOf(enterpriseAddress(OWNER_PAYMENT_KEY))).toBeUndefined();
    expect(isAccountAddress(wallet, scriptHash, OWNER_STAKE_KEY)).toBe(false);
  });
});
