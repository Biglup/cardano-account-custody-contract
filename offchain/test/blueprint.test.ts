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
import { accountAddress, isAccountAddress, paymentKeyHashOf, rewardAddress, stateNftAssetId } from '../src/address.js';
import { accountScript, accountScriptHash, accountValidator, loadBlueprint } from '../src/blueprint.js';
import { Cometa } from '../src/cometa.js';
import { OWNER_PAYMENT_KEY, OWNER_STAKE_KEY, enterpriseAddress, ownerStakeScriptHash } from './support/account.js';

/* TESTS **********************************************************************/

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
    for (const validator of blueprint.validators.filter((entry) => entry.title.startsWith('account.account.'))) {
      expect(validator.hash).toBe(hash);
    }
  });

  it('refuses a blueprint without the account validator', () => {
    expect(() => accountValidator({ preamble: { title: 'x', plutusVersion: 'v3' }, validators: [] })).toThrow(/account\.account/);
  });
});

describe('account address', () => {
  const scriptHash = accountScriptHash(accountScript());

  it('pays to the script and stakes with the user stake script', () => {
    const address = accountAddress(scriptHash, ownerStakeScriptHash);
    const base = address.asBase();
    expect(address.getType()).toBe(Cometa.AddressType.BasePaymentScriptStakeScript);
    expect(address.getNetworkId()).toBe(Cometa.NetworkId.Testnet);
    expect(base?.getPaymentCredential()).toEqual({ hash: scriptHash, type: Cometa.CredentialType.ScriptHash });
    expect(base?.getStakeCredential()).toEqual({ hash: ownerStakeScriptHash, type: Cometa.CredentialType.ScriptHash });
    expect(address.toString().startsWith('addr_test1')).toBe(true);
    expect(paymentKeyHashOf(address)).toBeUndefined();
    expect(isAccountAddress(address.toString(), scriptHash, ownerStakeScriptHash)).toBe(true);
    expect(isAccountAddress(address, scriptHash, OWNER_PAYMENT_KEY)).toBe(false);
    expect(isAccountAddress(address, OWNER_PAYMENT_KEY, ownerStakeScriptHash)).toBe(false);
  });

  it('derives the reward account from the stake script', () => {
    const reward = rewardAddress(ownerStakeScriptHash);
    expect(reward.getCredential()).toEqual({ hash: ownerStakeScriptHash, type: Cometa.CredentialType.ScriptHash });
    expect(reward.getNetworkId()).toBe(Cometa.NetworkId.Testnet);
    expect(reward.toBech32().startsWith('stake_test17')).toBe(true);
    expect(Cometa.RewardAddress.fromBech32(reward.toBech32()).getCredential()).toEqual(reward.getCredential());
  });

  it('names the state NFT after the script hash and the stake script hash', () => {
    const assetId = stateNftAssetId(scriptHash, ownerStakeScriptHash);
    expect(assetId).toBe(`${scriptHash}${ownerStakeScriptHash}`);
    expect(Cometa.policyIdFromAssetId(assetId)).toBe(scriptHash);
    expect(Cometa.assetNameFromAssetId(assetId)).toBe(ownerStakeScriptHash);
  });

  it('reads the keys of a wallet address', () => {
    const wallet = Cometa.BaseAddress.fromCredentials(
      Cometa.NetworkId.Testnet,
      { hash: OWNER_PAYMENT_KEY, type: Cometa.CredentialType.KeyHash },
      { hash: OWNER_STAKE_KEY, type: Cometa.CredentialType.KeyHash },
    ).toAddress();
    expect(paymentKeyHashOf(wallet)).toBe(OWNER_PAYMENT_KEY);
    expect(paymentKeyHashOf(enterpriseAddress(OWNER_PAYMENT_KEY))).toBe(OWNER_PAYMENT_KEY);
    expect(isAccountAddress(wallet, scriptHash, ownerStakeScriptHash)).toBe(false);
    expect(isAccountAddress(enterpriseAddress(OWNER_PAYMENT_KEY), scriptHash, ownerStakeScriptHash)).toBe(false);
  });
});
