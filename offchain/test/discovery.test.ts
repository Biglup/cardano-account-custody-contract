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
import { loadBlueprint } from '../src/blueprint.js';
import { Cometa } from '../src/cometa.js';
import { encodeGrant } from '../src/data.js';
import { accountByOwner, accountExists, classifyAccountUtxos, deadGrantsOf, grantsOf, logicOf, stateNftOf } from '../src/discovery.js';
import { createAccount, spendWithDevice, withdrawRewards } from '../src/transactions.js';
import { stateWithLogic, stateWithNextGeneration, stateWithRevokedSlot } from '../src/state.js';
import {
  EXPIRY,
  GRANT_LOVELACE,
  GRANT_UTXO_TX,
  OWNER_PAYMENT_KEY,
  address,
  controlUtxo,
  fixtureGrants,
  fundUtxo,
  grantAssetIdOf,
  grantUtxo,
  grantedState,
  grantedUtxos,
  initialState,
  logicV1Hash,
  logicV1RewardAddress,
  logicV2Hash,
  nftAssetId,
  ownerRewardAddress,
  ownerStakeScriptHash,
  recipientAddress,
  reserveUtxo,
  scenario,
  script,
  scriptHash,
} from './support/account.js';
import { utxo } from './support/fake.js';

/* CONSTANTS ******************************************************************/

const record = { owner: OWNER_PAYMENT_KEY, stakeScriptHash: ownerStakeScriptHash, address };

/* FUNCTIONS ******************************************************************/

/** The key hash of the fixture's second device, used as a stand-in agent device key. */
const agentKey = (): string => 'cc'.repeat(28);

/** The grant UTxO of a slot whose datum appends a field after the scope, as a later logic version may issue it. */
const extendedGrantUtxo = (slot: bigint) => {
  const grant = { ...fixtureGrants[0]!, slot };
  const datum = encodeGrant(grant);
  return utxo(GRANT_UTXO_TX, Number(slot), address, { coins: GRANT_LOVELACE, assets: { [grantAssetIdOf(slot)]: 1n } }, { ...datum, fields: { items: [...datum.fields.items, 99n] } });
};

/* TESTS **********************************************************************/

describe('accountByOwner', () => {
  it('derives the whole account from the owner key hash', () => {
    const account = accountByOwner(OWNER_PAYMENT_KEY);
    expect(account).toEqual({
      owner: OWNER_PAYMENT_KEY,
      stakeScriptHash: ownerStakeScriptHash,
      address,
      rewardAddress: ownerRewardAddress,
      stateNftAssetId: nftAssetId,
    });
    expect(accountByOwner(OWNER_PAYMENT_KEY, loadBlueprint())).toEqual(account);
    expect(stateNftOf(account)).toBe(nftAssetId);
  });

  it('gives another owner another account and another network another address', () => {
    const other = accountByOwner('bb'.repeat(28));
    expect(other.stakeScriptHash).not.toBe(ownerStakeScriptHash);
    expect(other.address).not.toBe(address);
    const mainnet = accountByOwner(OWNER_PAYMENT_KEY, loadBlueprint(), Cometa.NetworkId.Mainnet);
    expect(mainnet.stakeScriptHash).toBe(ownerStakeScriptHash);
    expect(mainnet.address.startsWith('addr1')).toBe(true);
    expect(mainnet.rewardAddress.startsWith('stake1')).toBe(true);
    expect(() => stateNftOf({ ...other, address: recipientAddress })).toThrow(/not an account address/);
  });
});

describe('classifyAccountUtxos', () => {
  it('sorts the control UTxO, the grant UTxOs, the reserves and the funds', () => {
    const utxos = [fundUtxo(0, { coins: 10_000_000n }), controlUtxo(grantedState), ...grantedUtxos(), reserveUtxo(0, { coins: 5_000_000n })];
    const kinds = classifyAccountUtxos(utxos, scriptHash, ownerStakeScriptHash);
    expect(kinds.control?.input).toEqual({ txId: '11'.repeat(32), index: 0 });
    expect(kinds.grants.map(({ grant }) => grant)).toEqual(fixtureGrants);
    expect(kinds.grants.map(({ prefix }) => prefix)).toEqual(fixtureGrants.map(({ slot, grantee, generation }) => ({ slot, grantee, generation })));
    expect(kinds.grants.map(({ assetId }) => assetId)).toEqual([grantAssetIdOf(0n), grantAssetIdOf(1n), grantAssetIdOf(2n)]);
    expect(kinds.reserves.map((reserve) => reserve.input.index)).toEqual([0]);
    expect(kinds.funds.map((fund) => fund.input.index)).toEqual([0]);
  });

  it('lists a grant of another shape by its stable prefix alone', () => {
    const kinds = classifyAccountUtxos([extendedGrantUtxo(5n), grantUtxo(fixtureGrants[0]!)], scriptHash, ownerStakeScriptHash);
    expect(kinds.grants.map(({ prefix, grant }) => [prefix.slot, grant === undefined])).toEqual([
      [5n, true],
      [0n, false],
    ]);
    expect(kinds.grants[0]!.prefix).toEqual({ slot: 5n, grantee: fixtureGrants[0]!.grantee, generation: 0n });
  });

  it('treats any UTxO with a datum and no account token as a reserve', () => {
    const marked = utxo('77'.repeat(32), 3, address, { coins: 3_000_000n }, { items: [1n] });
    const hashed = { input: { txId: '77'.repeat(32), index: 4 }, output: { address, value: { coins: 3_000_000n }, datumHash: 'ab'.repeat(32) } };
    const kinds = classifyAccountUtxos([marked, hashed, fundUtxo(1, { coins: 1_000_000n })], scriptHash, ownerStakeScriptHash);
    expect(kinds.reserves.map((reserve) => reserve.input.index)).toEqual([3, 4]);
    expect(kinds.funds.map((fund) => fund.input.index)).toEqual([1]);
    expect(kinds.control).toBeUndefined();
  });

  it('refuses two control UTxOs and a grant UTxO whose datum is not the grant of its token', () => {
    expect(() => classifyAccountUtxos([controlUtxo(initialState, 0), controlUtxo(initialState, 1)], scriptHash, ownerStakeScriptHash)).toThrow(/at most one control UTxO/);
    const mislabelled = grantUtxo({ ...fixtureGrants[0]!, slot: 2n });
    expect(() => classifyAccountUtxos([{ ...mislabelled, output: { ...mislabelled.output, value: { coins: 2_000_000n, assets: { [grantAssetIdOf(0n)]: 1n } } } }], scriptHash, ownerStakeScriptHash)).toThrow(/slot 0 carries a grant of slot 2/);
    expect(() => classifyAccountUtxos([utxo('66'.repeat(32), 9, address, { coins: 2_000_000n, assets: { [grantAssetIdOf(0n)]: 1n } })], scriptHash, ownerStakeScriptHash)).toThrow(/no inline datum/);
    expect(() => classifyAccountUtxos([utxo('66'.repeat(32), 9, address, { coins: 2_000_000n, assets: { [grantAssetIdOf(0n)]: 1n } }, { items: [] })], scriptHash, ownerStakeScriptHash)).toThrow(/at least 3 fields/);
  });
});

describe('accountExists', () => {
  it('resolves the control UTxO, the state and the logic of a live account', async () => {
    const { provider } = scenario(grantedState, [fundUtxo(0, { coins: 10_000_000n }), ...grantedUtxos()]);
    const live = await accountExists(provider, record);
    expect(live?.control.input).toEqual({ txId: '11'.repeat(32), index: 0 });
    expect(live?.state).toEqual(grantedState);
    expect(live?.logic).toBe(logicV1Hash);
    const upgraded = scenario(stateWithLogic(grantedState, logicV2Hash), []);
    expect((await accountExists(upgraded.provider, record))?.logic).toBe(logicV2Hash);
    expect(logicOf(controlUtxo(stateWithLogic(grantedState, logicV2Hash)))).toBe(logicV2Hash);
    expect(() => logicOf(fundUtxo(0, { coins: 1n }))).toThrow(/no inline datum/);
  });

  it('is null before the account exists and refuses two control UTxOs', async () => {
    const { provider } = scenario(undefined, [fundUtxo(0, { coins: 10_000_000n })]);
    expect(await accountExists(provider, record)).toBeNull();
    provider.addUtxo(controlUtxo(initialState, 0));
    provider.addUtxo(controlUtxo(initialState, 1));
    await expect(accountExists(provider, record)).rejects.toThrow(/at most one control UTxO/);
  });
});

describe('grants of an account', () => {
  it('lists the grant UTxOs in slot order', async () => {
    const { provider } = scenario(grantedState, [...grantedUtxos().reverse(), fundUtxo(0, { coins: 10_000_000n })]);
    const grants = await grantsOf(provider, record);
    expect(grants.map(({ prefix }) => prefix.slot)).toEqual([0n, 1n, 2n]);
    expect(grants.map(({ utxo: each }) => each.input.index)).toEqual([0, 1, 2]);
    expect(await grantsOf(scenario(initialState, []).provider, record)).toEqual([]);
  });

  it('lists the dead grants: older generation, revoked slot or expired', async () => {
    const revoked = scenario(stateWithRevokedSlot(grantedState, 1n), grantedUtxos());
    expect((await deadGrantsOf(revoked.provider, record, EXPIRY)).map(({ prefix }) => prefix.slot)).toEqual([1n]);
    expect((await deadGrantsOf(revoked.provider, record, EXPIRY + 1n)).map(({ prefix }) => prefix.slot)).toEqual([0n, 1n, 2n]);
    const bumped = scenario(stateWithNextGeneration(grantedState), [...grantedUtxos(), grantUtxo({ ...fixtureGrants[0]!, slot: 3n, generation: 1n })]);
    expect((await deadGrantsOf(bumped.provider, record, EXPIRY)).map(({ prefix }) => prefix.slot)).toEqual([0n, 1n, 2n]);
    await expect(deadGrantsOf(scenario(undefined, grantedUtxos()).provider, record)).rejects.toThrow(/No control UTxO/);
  });

  it('lists a grant of another shape as dead once the generation moved past it, and never by expiry', async () => {
    const live = scenario(grantedState, [extendedGrantUtxo(5n)]);
    expect(await deadGrantsOf(live.provider, record, EXPIRY + 1n)).toEqual([]);
    const upgraded = scenario(stateWithLogic(grantedState, logicV2Hash), [extendedGrantUtxo(5n)]);
    expect((await deadGrantsOf(upgraded.provider, record, EXPIRY)).map(({ prefix, grant }) => [prefix.slot, grant])).toEqual([[5n, undefined]]);
  });
});

describe('builders given a record', () => {
  it('build the same transactions as from the owner key', async () => {
    const { owner, sponsor } = scenario(undefined, []);
    const created = await createAccount({ wallet: owner, sponsor, record, state: initialState, script });
    expect(Cometa.inspectTx(created)).toEqual(Cometa.inspectTx(await createAccount({ wallet: owner, sponsor, owner: OWNER_PAYMENT_KEY, state: initialState, script })));
    const { provider, agent } = scenario({ ...initialState, devices: [OWNER_PAYMENT_KEY, agentKey()] }, [fundUtxo(0, { coins: 10_000_000n })]);
    const spent = await spendWithDevice({ wallet: agent, provider, record, outputs: [{ address: recipientAddress, value: { coins: 1_000_000n } }], script });
    expect((Cometa.inspectTx(spent) as { body: { required_signers?: string[] } }).body.required_signers).toEqual([agentKey()]);
    const withdrawn = await withdrawRewards({ wallet: agent, provider, record, amount: 0n, script });
    expect((Cometa.inspectTx(withdrawn) as { body: { withdrawals?: { key: string }[] } }).body.withdrawals?.map((withdrawal) => withdrawal.key).sort()).toEqual(
      [ownerRewardAddress, logicV1RewardAddress].sort(),
    );
  });

  it('refuse a record whose stake credential does not belong to its owner', async () => {
    const { provider, owner } = scenario(initialState, [fundUtxo(0, { coins: 10_000_000n })]);
    await expect(
      withdrawRewards({ wallet: owner, provider, record: { ...record, stakeScriptHash: 'cc'.repeat(28) }, amount: 0n, script }),
    ).rejects.toThrow(/does not match the owner/);
  });
});
