import { describe, expect, it } from 'vitest';
import { Cometa } from '../src/cometa.js';
import { decodeAccountState, encodeAccountState } from '../src/data.js';
import { granteeMessage, grantMessagePartsOf, slotToPosixTime, transactionBodyParts, verifyGrantSignature, withoutCborCache } from '../src/message.js';
import { minimumLovelaceForSize, minimumUtxoLovelace, serialiseOutput } from '../src/output.js';
import { stateAfterSpend, stateWithDevice, stateWithGrant, stateWithoutDevice, stateWithoutGrant, stateWithoutGrants } from '../src/state.js';
import {
  DEFAULT_CONTROL_EXECUTION_UNITS,
  DEFAULT_FUND_EXECUTION_UNITS,
  addDevice,
  createAccount,
  deleteAccount,
  deposit,
  findAccountUtxos,
  issueGrant,
  removeDevice,
  revokeAllGrants,
  revokeGrant,
  rewriteState,
  selectFundUtxos,
  spendWithDevice,
  spendWithGrant,
} from '../src/transactions.js';
import { toBalance } from '../src/value.js';
import {
  AGENT_PAYMENT_KEY,
  AGENT_STAKE_KEY,
  CONTROL_LOVELACE,
  GRANTEE_PRIVATE_KEY,
  GRANTEE_PUBLIC_KEY,
  OTHER_DEVICE_KEY,
  OWNER_PAYMENT_KEY,
  OWNER_STAKE_KEY,
  TOKEN_ASSET_ID,
  VALID_UNTIL_SLOT,
  address,
  controlUtxo,
  enterpriseAddress,
  fundUtxo,
  grantedState,
  initialState,
  lovelaceScope,
  nftAssetId,
  recipientAddress,
  redeemerOf,
  scenario,
  script,
} from './support/account.js';
import { ProviderEvaluatedWallet } from './support/fake.js';

const DEVICE_REDEEMER = 'd87980';
const FUND_REDEEMER = 'd87b80';

interface InspectedTx {
  body: {
    inputs: { transaction_id: string; index: number }[];
    outputs: { address: string; amount: { coin: string } }[];
    fee: string;
    ttl?: string;
    mint?: { script_hash: string; assets: Record<string, string> }[];
    required_signers?: string[];
    collateral?: unknown[];
  };
  witness_set: { plutus_scripts?: { language: string }[]; redeemers?: { tag: string; index: number; ex_units: { mem: string; steps: string } }[] };
}

const inspect = (tx: string): InspectedTx => Cometa.inspectTx(tx) as InspectedTx;

const outputsAt = (tx: string, at: string) => transactionBodyParts(tx).outputs.filter((output) => output.address === at);

const controlOutputOf = (tx: string) => {
  const outputs = outputsAt(tx, address).filter((output) => output.value.assets?.[nftAssetId] === 1n);
  expect(outputs).toHaveLength(1);
  return outputs[0]!;
};

const stateOf = (tx: string) => decodeAccountState(withoutCborCache(controlOutputOf(tx).datum!));

const expectScriptAttached = (tx: string) => {
  expect(inspect(tx).witness_set.plutus_scripts?.map((entry) => entry.language)).toEqual(['plutus_v3']);
};

const spendsInput = (tx: string, input: { txId: string; index: number }) =>
  transactionBodyParts(tx).inputs.some((candidate) => candidate.txId === input.txId && candidate.index === input.index);

const expectControlAboveMinimum = (tx: string) => {
  const control = controlOutputOf(tx);
  const serialised = serialiseOutput(control);
  expect(tx).toContain(Cometa.uint8ArrayToHex(serialised));
  expect(control.value.coins).toBeGreaterThanOrEqual(minimumLovelaceForSize(serialised.length, 4310n));
  return control.value.coins;
};

const expectFixedBudgets = (tx: string) => {
  const inputs = transactionBodyParts(tx).inputs;
  const units = inspect(tx).witness_set.redeemers?.map((entry) => [Number(entry.index), entry.ex_units.mem]);
  expect(units).toContainEqual([inputs.findIndex((input) => input.txId === '11'.repeat(32)), DEFAULT_CONTROL_EXECUTION_UNITS.memory.toString()]);
  expect(units).toContainEqual([inputs.findIndex((input) => input.txId === '22'.repeat(32)), DEFAULT_FUND_EXECUTION_UNITS.memory.toString()]);
};

describe('createAccount', () => {
  it('mints the state NFT into a control output signed by the stake key', async () => {
    const { owner } = scenario(undefined, []);
    const tx = await createAccount({ wallet: owner, stakeKeyHash: OWNER_STAKE_KEY, state: initialState, script });
    const inspected = inspect(tx);
    expect(inspected.body.mint).toEqual([{ script_hash: Cometa.policyIdFromAssetId(nftAssetId), assets: { [OWNER_STAKE_KEY]: '1' } }]);
    expect(inspected.body.required_signers).toEqual([OWNER_STAKE_KEY]);
    expect(inspected.witness_set.redeemers?.map((redeemer) => redeemer.tag)).toEqual(['mint']);
    expectScriptAttached(tx);
    const control = controlOutputOf(tx);
    expect(control.value).toEqual({ coins: 2_000_000n, assets: { [nftAssetId]: 1n } });
    expect(stateOf(tx)).toEqual(initialState);
    expect(Cometa.readRedeemersFromTx(tx).map((redeemer) => Cometa.plutusDataToCbor(redeemer.data))).toEqual(['d87980']);
  });

  it('refuses a state that is not well formed', async () => {
    const { owner } = scenario(undefined, []);
    await expect(
      createAccount({ wallet: owner, stakeKeyHash: OWNER_STAKE_KEY, state: { ...initialState, devices: [] }, script }),
    ).rejects.toThrow(/not well formed/);
  });

  it('refuses to create an account whose state NFT already exists when it can look', async () => {
    const existing = scenario(initialState, []);
    await expect(
      createAccount({ wallet: existing.owner, provider: existing.provider, stakeKeyHash: OWNER_STAKE_KEY, state: initialState, script }),
    ).rejects.toThrow(/already exists/);
    const fresh = scenario(undefined, [fundUtxo(0, { coins: 10_000_000n })]);
    const tx = await createAccount({ wallet: fresh.owner, provider: fresh.provider, stakeKeyHash: OWNER_STAKE_KEY, state: initialState, script });
    expect(stateOf(tx)).toEqual(initialState);
  });

  it('gives the control output at least its minimum UTxO value when the state needs more', async () => {
    const { owner, provider } = scenario(undefined, []);
    const tx = await createAccount({ wallet: owner, provider, stakeKeyHash: OWNER_STAKE_KEY, state: grantedState, script });
    const coins = expectControlAboveMinimum(tx);
    expect(coins).toBeGreaterThan(CONTROL_LOVELACE);
    expect(coins).toBe(minimumUtxoLovelace(controlOutputOf(tx), 4310n));
  });
});

describe('deposit', () => {
  it('pays the value to the account address with no datum', async () => {
    const { owner } = scenario(initialState, []);
    const tx = await deposit({ wallet: owner, stakeKeyHash: OWNER_STAKE_KEY, value: { coins: 10_000_000n }, script });
    const outputs = outputsAt(tx, address);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.value).toEqual({ coins: 10_000_000n });
    expect(outputs[0]!.datum).toBeUndefined();
    expect(inspect(tx).witness_set.redeemers).toBeUndefined();
  });
});

describe('findAccountUtxos', () => {
  it('separates the control UTxO from the funds and decodes the state', async () => {
    const { provider, owner } = scenario(grantedState, [fundUtxo(0, { coins: 10_000_000n }), fundUtxo(1, { coins: 4_000_000n })]);
    const found = await findAccountUtxos(provider, { wallet: owner, stakeKeyHash: OWNER_STAKE_KEY, script });
    expect(found.control.input).toEqual({ txId: '11'.repeat(32), index: 0 });
    expect(found.funds.map((fund) => fund.input.index)).toEqual([0, 1]);
    expect(found.state).toEqual(grantedState);
  });

  it('demands exactly one control UTxO', async () => {
    const { provider, owner } = scenario(undefined, []);
    const params = { wallet: owner, stakeKeyHash: OWNER_STAKE_KEY, script };
    await expect(findAccountUtxos(provider, params)).rejects.toThrow(/exactly one control UTxO/);
    provider.addUtxo(controlUtxo(initialState, 0));
    provider.addUtxo(controlUtxo(initialState, 1));
    await expect(findAccountUtxos(provider, params)).rejects.toThrow(/found 2/);
  });
});

describe('selectFundUtxos', () => {
  const funds = [
    fundUtxo(0, { coins: 3_000_000n }),
    fundUtxo(1, { coins: 10_000_000n }),
    fundUtxo(2, { coins: 2_000_000n, assets: { [TOKEN_ASSET_ID]: 20n } }),
  ];

  it('prefers funds holding a needed asset, then the largest lovelace', () => {
    const { selected, remainder } = selectFundUtxos(funds, { [TOKEN_ASSET_ID]: 5n, '': 1_000_000n }, 2_000_000n);
    expect(selected.map((utxo) => utxo.input.index)).toEqual([2, 1]);
    expect(remainder).toEqual({ '': 11_000_000n, [TOKEN_ASSET_ID]: 15n });
  });

  it('selects nothing when nothing is required', () => {
    expect(selectFundUtxos(funds, {}, 2_000_000n)).toEqual({ selected: [], remainder: {} });
  });

  it('accepts an exact match and refuses dust change', () => {
    expect(selectFundUtxos(funds, { '': 10_000_000n }, 2_000_000n).remainder).toEqual({});
    expect(() => selectFundUtxos([funds[1]!], { '': 9_000_000n }, 2_000_000n)).toThrow(/at least 2000000 lovelace/);
    expect(() => selectFundUtxos(funds, { '': 20_000_000n }, 2_000_000n)).toThrow(/not hold enough funds/);
  });
});

describe('spendWithDevice', () => {
  it('spends the control and fund UTxOs, recreates the state and returns the change to the account', async () => {
    const { provider, owner } = scenario(initialState, [fundUtxo(0, { coins: 10_000_000n }), fundUtxo(1, { coins: 4_000_000n })]);
    const payout = { address: recipientAddress, value: { coins: 5_000_000n } };
    const tx = await spendWithDevice({ wallet: owner, provider, stakeKeyHash: OWNER_STAKE_KEY, outputs: [payout], script });
    expect(redeemerOf(tx, { txId: '11'.repeat(32), index: 0 })).toBe(DEVICE_REDEEMER);
    expect(redeemerOf(tx, { txId: '22'.repeat(32), index: 0 })).toBe(FUND_REDEEMER);
    expect(spendsInput(tx, { txId: '22'.repeat(32), index: 1 })).toBe(false);
    expect(controlOutputOf(tx).value.coins).toBe(CONTROL_LOVELACE);
    expect(stateOf(tx)).toEqual(initialState);
    const change = outputsAt(tx, address).filter((output) => output.datum === undefined);
    expect(change.map((output) => output.value)).toEqual([{ coins: 5_000_000n }]);
    expect(outputsAt(tx, recipientAddress).map((output) => output.value)).toEqual([{ coins: 5_000_000n }]);
    const inspected = inspect(tx);
    expect(inspected.body.required_signers).toEqual([OWNER_PAYMENT_KEY]);
    expect(inspected.body.inputs.some((input) => input.transaction_id === '33'.repeat(32))).toBe(true);
    expectScriptAttached(tx);
  });

  it('can rewrite the state in the same transaction', async () => {
    const { provider, owner } = scenario(initialState, [fundUtxo(0, { coins: 10_000_000n })]);
    const newState = stateWithDevice(initialState, OTHER_DEVICE_KEY);
    const tx = await spendWithDevice({
      wallet: owner,
      provider,
      stakeKeyHash: OWNER_STAKE_KEY,
      outputs: [{ address: recipientAddress, value: { coins: 10_000_000n } }],
      newState,
      script,
    });
    expect(stateOf(tx)).toEqual(newState);
    expect(outputsAt(tx, address)).toHaveLength(1);
  });

  it('refuses a wallet that is not a device', async () => {
    const { provider, agent } = scenario(initialState, []);
    await expect(spendWithDevice({ wallet: agent, provider, stakeKeyHash: OWNER_STAKE_KEY, outputs: [], script })).rejects.toThrow(
      /not a device/,
    );
  });

  it('derives the change floor from the change output, which needs more lovelace when it carries tokens', async () => {
    const funds = [fundUtxo(0, { coins: 3_000_000n, assets: { [TOKEN_ASSET_ID]: 20n } }), fundUtxo(1, { coins: 2_000_000n })];
    const payout = { address: recipientAddress, value: { coins: 2_000_000n, assets: { [TOKEN_ASSET_ID]: 5n } } };
    const { provider, owner } = scenario(initialState, funds);
    const tx = await spendWithDevice({ wallet: owner, provider, stakeKeyHash: OWNER_STAKE_KEY, outputs: [payout], script });
    expect(spendsInput(tx, { txId: '22'.repeat(32), index: 1 })).toBe(true);
    const change = outputsAt(tx, address).filter((output) => output.datum === undefined);
    expect(change.map((output) => output.value)).toEqual([{ coins: 3_000_000n, assets: { [TOKEN_ASSET_ID]: 15n } }]);
    const tokenFloor = minimumUtxoLovelace({ address, value: { coins: 0n, assets: { [TOKEN_ASSET_ID]: 15n } } }, 4310n);
    expect(tokenFloor).toBeGreaterThan(1_000_000n);
    expect(tokenFloor).toBeGreaterThan(minimumUtxoLovelace({ address, value: { coins: 0n } }, 4310n));
    const lovelaceOnly = scenario(initialState, [fundUtxo(0, { coins: 1_500_000n })]);
    const lean = await spendWithDevice({
      wallet: lovelaceOnly.owner,
      provider: lovelaceOnly.provider,
      stakeKeyHash: OWNER_STAKE_KEY,
      outputs: [{ address: recipientAddress, value: { coins: 400_000n } }],
      script,
    });
    const leanChange = outputsAt(lean, address).filter((output) => output.datum === undefined).map((output) => output.value);
    expect(leanChange).toEqual([{ coins: 1_100_000n }]);
    expect(1_100_000n).toBeGreaterThanOrEqual(minimumUtxoLovelace({ address, value: { coins: 0n } }, 4310n));
    expect(1_100_000n).toBeLessThan(tokenFloor);
  });

  it('honours a change floor override', async () => {
    const funds = [fundUtxo(0, { coins: 3_000_000n }), fundUtxo(1, { coins: 2_000_000n })];
    const { provider, owner } = scenario(initialState, funds);
    const tx = await spendWithDevice({
      wallet: owner,
      provider,
      stakeKeyHash: OWNER_STAKE_KEY,
      outputs: [{ address: recipientAddress, value: { coins: 1_000_000n } }],
      minimumChangeLovelace: 2_500_000n,
      script,
    });
    expect(spendsInput(tx, { txId: '22'.repeat(32), index: 1 })).toBe(true);
    expect(outputsAt(tx, address).filter((output) => output.datum === undefined).map((output) => output.value)).toEqual([{ coins: 4_000_000n }]);
  });
});

describe('state rewrites', () => {
  const params = () => {
    const { provider, owner } = scenario(grantedState, [fundUtxo(0, { coins: 10_000_000n })]);
    return { wallet: owner, provider, stakeKeyHash: OWNER_STAKE_KEY, script };
  };

  it('rewriteState carries the given state and spends no funds', async () => {
    const newState = { ...grantedState, grantGeneration: 7n };
    const tx = await rewriteState({ ...params(), newState });
    expect(stateOf(tx)).toEqual(newState);
    expect(spendsInput(tx, { txId: '22'.repeat(32), index: 0 })).toBe(false);
    expect(outputsAt(tx, address)).toHaveLength(1);
  });

  it('addDevice and removeDevice edit the devices', async () => {
    expect(stateOf(await addDevice({ ...params(), device: OTHER_DEVICE_KEY }))).toEqual(stateWithDevice(grantedState, OTHER_DEVICE_KEY));
    await expect(addDevice({ ...params(), device: OWNER_PAYMENT_KEY })).rejects.toThrow(/distinct/);
    await expect(removeDevice({ ...params(), device: OWNER_PAYMENT_KEY })).rejects.toThrow(/at least one device/);
    const { provider, owner } = scenario(stateWithDevice(grantedState, OTHER_DEVICE_KEY), []);
    const tx = await removeDevice({ wallet: owner, provider, stakeKeyHash: OWNER_STAKE_KEY, device: OTHER_DEVICE_KEY, script });
    expect(stateOf(tx)).toEqual(stateWithoutDevice(stateWithDevice(grantedState, OTHER_DEVICE_KEY), OTHER_DEVICE_KEY));
  });

  it('raises the control lovelace with the state, funded by the wallet', async () => {
    let state = initialState;
    let previous = 0n;
    for (let slot = 0n; slot < 6n; slot += 1n) {
      const { provider, owner } = scenario(state, []);
      const grant = { slot, grantee: { kind: 'ed25519' as const, keyHash: AGENT_PAYMENT_KEY }, scope: lovelaceScope([recipientAddress]) };
      const tx = await issueGrant({ wallet: owner, provider, stakeKeyHash: OWNER_STAKE_KEY, grant, script });
      const coins = expectControlAboveMinimum(tx);
      expect(coins).toBeGreaterThanOrEqual(previous);
      expect(coins).toBeGreaterThanOrEqual(CONTROL_LOVELACE);
      expect(spendsInput(tx, { txId: '33'.repeat(32), index: 0 })).toBe(true);
      state = stateWithGrant(state, grant);
      previous = coins;
    }
    expect(previous).toBeGreaterThan(CONTROL_LOVELACE);
  });

  it('issueGrant, revokeGrant and revokeAllGrants edit the grants', async () => {
    const grant = { slot: 3n, grantee: { kind: 'ed25519' as const, keyHash: AGENT_PAYMENT_KEY }, scope: grantedState.grants[0]!.scope };
    expect(stateOf(await issueGrant({ ...params(), grant }))).toEqual(stateWithGrant(grantedState, grant));
    await expect(issueGrant({ ...params(), grant: { ...grant, slot: 0n } })).rejects.toThrow(/slots must be distinct/);
    expect(stateOf(await revokeGrant({ ...params(), slot: 1n }))).toEqual(stateWithoutGrant(grantedState, 1n));
    expect(stateOf(await revokeAllGrants(params()))).toEqual(stateWithoutGrants(grantedState));
  });
});

describe('deleteAccount', () => {
  it('burns the state NFT and releases every fund UTxO to the wallet', async () => {
    const { provider, owner } = scenario(grantedState, [fundUtxo(0, { coins: 10_000_000n }), fundUtxo(1, { coins: 4_000_000n })]);
    const tx = await deleteAccount({ wallet: owner, provider, stakeKeyHash: OWNER_STAKE_KEY, script });
    const inspected = inspect(tx);
    expect(inspected.body.mint).toEqual([{ script_hash: Cometa.policyIdFromAssetId(nftAssetId), assets: { [OWNER_STAKE_KEY]: '-1' } }]);
    expect(inspected.body.required_signers).toEqual([OWNER_PAYMENT_KEY]);
    expect(redeemerOf(tx, { txId: '11'.repeat(32), index: 0 })).toBe(DEVICE_REDEEMER);
    expect(redeemerOf(tx, { txId: '22'.repeat(32), index: 0 })).toBe(FUND_REDEEMER);
    expect(redeemerOf(tx, { txId: '22'.repeat(32), index: 1 })).toBe(FUND_REDEEMER);
    const mintRedeemer = Cometa.readRedeemersFromTx(tx).find((redeemer) => redeemer.purpose === Cometa.RedeemerPurpose.mint);
    expect(Cometa.plutusDataToCbor(mintRedeemer!.data)).toBe('d87a80');
    expect(outputsAt(tx, address)).toHaveLength(0);
    const released = outputsAt(tx, owner.address.toString()).reduce((total, output) => total + output.value.coins, 0n);
    expect(released + transactionBodyParts(tx).fee).toBe(CONTROL_LOVELACE + 14_000_000n);
    expect(spendsInput(tx, { txId: '33'.repeat(32), index: 0 })).toBe(false);
  });
});

describe('spendWithGrant', () => {
  const funds = () => [fundUtxo(0, { coins: 10_000_000n }), fundUtxo(1, { coins: 4_000_000n, assets: { [TOKEN_ASSET_ID]: 20n } })];

  it('lets an Ed25519 grantee spend lovelace, paying the fee from the account', async () => {
    const { provider, agent } = scenario(grantedState, funds());
    const payout = { address: recipientAddress, value: { coins: 3_000_000n } };
    const tx = await spendWithGrant({
      wallet: agent,
      provider,
      stakeKeyHash: OWNER_STAKE_KEY,
      slot: 0n,
      outputs: [payout],
      grantee: { kind: 'ed25519', keyHash: AGENT_PAYMENT_KEY },
      validUntilSlot: VALID_UNTIL_SLOT,
      script,
    });
    const parts = transactionBodyParts(tx);
    expect(redeemerOf(tx, { txId: '11'.repeat(32), index: 0 })).toBe('d87a9f00d87a80ff');
    expect(redeemerOf(tx, { txId: '22'.repeat(32), index: 0 })).toBe(FUND_REDEEMER);
    expect(spendsInput(tx, { txId: '22'.repeat(32), index: 1 })).toBe(false);
    expect(spendsInput(tx, { txId: '44'.repeat(32), index: 0 })).toBe(false);
    const inspected = inspect(tx);
    expect(inspected.body.required_signers).toEqual([AGENT_PAYMENT_KEY]);
    expect(inspected.body.ttl).toBe(VALID_UNTIL_SLOT.toString());
    expect(inspected.body.collateral?.length).toBeGreaterThan(0);
    expect(parts.validityRange.upperBound).toEqual({ bound: { kind: 'finite', time: slotToPosixTime(VALID_UNTIL_SLOT) }, inclusive: false });
    expect(outputsAt(tx, recipientAddress).map((output) => output.value)).toEqual([payout.value]);
    expect(outputsAt(tx, agent.address.toString())).toHaveLength(0);
    const leaving = 3_000_000n + parts.fee;
    const change = outputsAt(tx, address).filter((output) => output.datum === undefined);
    expect(change.map((output) => output.value)).toEqual([{ coins: 10_000_000n - leaving }]);
    expect(controlOutputOf(tx).value.coins).toBe(CONTROL_LOVELACE);
    expect(stateOf(tx)).toEqual(stateAfterSpend(grantedState, 0n, { '': leaving }));
    expect(stateOf(tx).grants[0]!.scope.cap).toBe(15_000_000n - leaving);
    expectFixedBudgets(tx);
    expect(provider.phaseTwoFailures).toEqual([]);
    expectScriptAttached(tx);
  });

  it('cannot be evaluated by a provider, which refuses every draft whose fee the state was not computed against', async () => {
    const { provider } = scenario(grantedState, funds());
    const agent = new ProviderEvaluatedWallet(provider, AGENT_PAYMENT_KEY, AGENT_STAKE_KEY);
    await expect(
      spendWithGrant({
        wallet: agent,
        provider,
        stakeKeyHash: OWNER_STAKE_KEY,
        slot: 0n,
        outputs: [{ address: recipientAddress, value: { coins: 3_000_000n } }],
        grantee: { kind: 'ed25519', keyHash: AGENT_PAYMENT_KEY },
        validUntilSlot: VALID_UNTIL_SLOT,
        script,
      }),
    ).rejects.toThrow(/build failed/);
    expect(provider.phaseTwoFailures.length).toBeGreaterThan(0);
    expect(provider.phaseTwoFailures.every((failure) => /control output datum/.test(failure))).toBe(true);
  });

  it('keeps the lovelace of the control UTxO as it was', async () => {
    const { provider, agent } = scenario(grantedState, funds());
    const tx = await spendWithGrant({
      wallet: agent,
      provider,
      stakeKeyHash: OWNER_STAKE_KEY,
      slot: 0n,
      outputs: [{ address: recipientAddress, value: { coins: 1_000_000n } }],
      grantee: { kind: 'ed25519', keyHash: AGENT_PAYMENT_KEY },
      validUntilSlot: VALID_UNTIL_SLOT,
      script,
    });
    expect(controlOutputOf(tx).value.coins).toBe(CONTROL_LOVELACE);
  });

  it('lets a secp256k1 grantee spend tokens with a signature over the settled body', async () => {
    const { provider, agent } = scenario(grantedState, funds());
    const payout = { address: recipientAddress, value: { coins: 1_500_000n, assets: { [TOKEN_ASSET_ID]: 7n } } };
    const tx = await spendWithGrant({
      wallet: agent,
      provider,
      stakeKeyHash: OWNER_STAKE_KEY,
      slot: 1n,
      outputs: [payout],
      grantee: { kind: 'secp256k1', privateKey: GRANTEE_PRIVATE_KEY },
      validUntilSlot: VALID_UNTIL_SLOT,
      script,
    });
    const parts = transactionBodyParts(tx);
    const redeemer = redeemerOf(tx, { txId: '11'.repeat(32), index: 0 });
    expect(redeemer?.startsWith('d87a9f01d8799f5840')).toBe(true);
    const signature = redeemer!.slice('d87a9f01d8799f5840'.length, -'ffff'.length);
    expect(signature).toHaveLength(128);
    const message = granteeMessage(grantMessagePartsOf(tx, { txId: '11'.repeat(32), index: 0 }));
    expect(verifyGrantSignature(GRANTEE_PUBLIC_KEY, message, signature)).toBe(true);
    expect(inspect(tx).body.required_signers).toBeUndefined();
    expect(redeemerOf(tx, { txId: '22'.repeat(32), index: 1 })).toBe(FUND_REDEEMER);
    const leaving = { [TOKEN_ASSET_ID]: 7n, '': 1_500_000n + parts.fee };
    expect(stateOf(tx)).toEqual(stateAfterSpend(grantedState, 1n, leaving));
    expect(stateOf(tx).grants[1]!.scope.lovelaceCap).toBe(3_000_000n - 1_500_000n - parts.fee);
    const inputsBalance = toBalance({ coins: CONTROL_LOVELACE + 4_000_000n, assets: { [nftAssetId]: 1n, [TOKEN_ASSET_ID]: 20n } });
    const returned = outputsAt(tx, address).map((output) => toBalance(output.value));
    expect(returned.reduce((total, balance) => total + (balance[TOKEN_ASSET_ID] ?? 0n), 0n)).toBe(inputsBalance[TOKEN_ASSET_ID]! - 7n);
    expectFixedBudgets(tx);
  });

  it('refuses spends the validator would refuse', async () => {
    const { provider, agent } = scenario(grantedState, funds());
    const base = { wallet: agent, provider, stakeKeyHash: OWNER_STAKE_KEY, validUntilSlot: VALID_UNTIL_SLOT, script };
    const ed25519 = { kind: 'ed25519' as const, keyHash: AGENT_PAYMENT_KEY };
    const payout = (coins: bigint) => [{ address: recipientAddress, value: { coins } }];
    await expect(spendWithGrant({ ...base, slot: 9n, outputs: payout(1n), grantee: ed25519 })).rejects.toThrow(/no grant in slot 9/);
    await expect(spendWithGrant({ ...base, slot: 0n, outputs: payout(1n), grantee: { kind: 'ed25519', keyHash: OWNER_PAYMENT_KEY } })).rejects.toThrow(/not the grantee/);
    await expect(spendWithGrant({ ...base, slot: 1n, outputs: payout(1n), grantee: ed25519 })).rejects.toThrow(/not the grantee/);
    await expect(spendWithGrant({ ...base, slot: 2n, outputs: [{ address: enterpriseAddress(OTHER_DEVICE_KEY), value: { coins: 1n } }], grantee: ed25519 })).rejects.toThrow(/not a recipient/);
    await expect(spendWithGrant({ ...base, slot: 0n, outputs: payout(10_000_000n), grantee: ed25519 })).rejects.toThrow(/per call cap/);
    await expect(spendWithGrant({ ...base, slot: 0n, outputs: payout(1n), grantee: ed25519, validUntilSlot: 300_000_000n })).rejects.toThrow(/expires/);
    await expect(
      spendWithGrant({ ...base, slot: 0n, outputs: [{ address: recipientAddress, value: { coins: 1_000_000n, assets: { [TOKEN_ASSET_ID]: 1n } } }], grantee: ed25519 }),
    ).rejects.toThrow(/does not cover/);
  });

  it('counts a deposit made alongside the spend against what leaves', async () => {
    const { provider, agent } = scenario(grantedState, funds());
    const tx = await spendWithGrant({
      wallet: agent,
      provider,
      stakeKeyHash: OWNER_STAKE_KEY,
      slot: 2n,
      outputs: [{ address: recipientAddress, value: { coins: 2_000_000n } }],
      grantee: { kind: 'ed25519', keyHash: AGENT_PAYMENT_KEY },
      validUntilSlot: VALID_UNTIL_SLOT,
      script,
    });
    const encoded = Cometa.plutusDataToCbor(encodeAccountState(stateOf(tx)));
    expect(encoded).toBe(Cometa.plutusDataToCbor(withoutCborCache(controlOutputOf(tx).datum!)));
    expect(stateOf(tx).grants[2]!.scope.cap).toBe(15_000_000n - 2_000_000n - transactionBodyParts(tx).fee);
  });
});
