import { describe, expect, it } from 'vitest';
import { loadBlueprint } from '../src/blueprint.js';
import { Cometa } from '../src/cometa.js';
import { accountByOwner, accountExists, stateNftOf } from '../src/discovery.js';
import { createAccount, spendWithDevice, withdrawRewards } from '../src/transactions.js';
import {
  OWNER_PAYMENT_KEY,
  address,
  controlUtxo,
  fundUtxo,
  grantedState,
  initialState,
  nftAssetId,
  ownerRewardAddress,
  ownerStakeScriptHash,
  recipientAddress,
  scenario,
  script,
} from './support/account.js';

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

describe('accountExists', () => {
  const record = { owner: OWNER_PAYMENT_KEY, stakeScriptHash: ownerStakeScriptHash, address };

  it('resolves the control UTxO and the state of a live account', async () => {
    const { provider } = scenario(grantedState, [fundUtxo(0, { coins: 10_000_000n })]);
    const live = await accountExists(provider, record);
    expect(live?.control.input).toEqual({ txId: '11'.repeat(32), index: 0 });
    expect(live?.state).toEqual(grantedState);
  });

  it('is null before the account exists and refuses two control UTxOs', async () => {
    const { provider } = scenario(undefined, [fundUtxo(0, { coins: 10_000_000n })]);
    expect(await accountExists(provider, record)).toBeNull();
    provider.addUtxo(controlUtxo(initialState, 0));
    provider.addUtxo(controlUtxo(initialState, 1));
    await expect(accountExists(provider, record)).rejects.toThrow(/found 2/);
  });
});

describe('builders given a record', () => {
  const record = { owner: OWNER_PAYMENT_KEY, stakeScriptHash: ownerStakeScriptHash, address };

  it('build the same transactions as from the owner key', async () => {
    const { owner, sponsor } = scenario(undefined, []);
    const created = await createAccount({ wallet: owner, sponsor, record, state: initialState, script });
    expect(Cometa.inspectTx(created)).toEqual(Cometa.inspectTx(await createAccount({ wallet: owner, sponsor, owner: OWNER_PAYMENT_KEY, state: initialState, script })));
    const { provider, agent } = scenario({ ...initialState, devices: [OWNER_PAYMENT_KEY, agentKey()] }, [fundUtxo(0, { coins: 10_000_000n })]);
    const spent = await spendWithDevice({ wallet: agent, provider, record, outputs: [{ address: recipientAddress, value: { coins: 1_000_000n } }], script });
    expect((Cometa.inspectTx(spent) as { body: { required_signers?: string[] } }).body.required_signers).toEqual([agentKey()]);
    const withdrawn = await withdrawRewards({ wallet: agent, provider, record, amount: 0n, script });
    expect((Cometa.inspectTx(withdrawn) as { body: { withdrawals?: { key: string }[] } }).body.withdrawals).toEqual([{ key: ownerRewardAddress, value: '0' }]);
  });

  it('refuse a record whose stake credential does not belong to its owner', async () => {
    const { provider, owner } = scenario(initialState, [fundUtxo(0, { coins: 10_000_000n })]);
    await expect(
      withdrawRewards({ wallet: owner, provider, record: { ...record, stakeScriptHash: 'cc'.repeat(28) }, amount: 0n, script }),
    ).rejects.toThrow(/does not match the owner/);
  });
});

const agentKey = (): string => 'cc'.repeat(28);
