import { describe, expect, it } from 'vitest';
import { Cometa } from '../src/cometa.js';
import { decodeAccountState, encodeAccountState, withoutCborCache } from '../src/data.js';
import { slotToPosixTime, transactionBodyParts } from '../src/body.js';
import { minimumLovelaceForSize, minimumUtxoLovelace, serialiseOutput } from '../src/output.js';
import { stateAfterSpend, stateWithDevice, stateWithGrant, stateWithoutDevice, stateWithoutGrant, stateWithoutGrants } from '../src/state.js';
import {
  DEFAULT_CONTROL_EXECUTION_UNITS,
  DEFAULT_FUND_EXECUTION_UNITS,
  addDevice,
  createAccount,
  delegateStake,
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
  withdrawRewards,
} from '../src/transactions.js';
import { toBalance } from '../src/value.js';
import {
  AGENT_PAYMENT_KEY,
  AGENT_STAKE_KEY,
  AGENT_UTXO_TX,
  CONTROL_LOVELACE,
  OTHER_DEVICE_KEY,
  OWNER_PAYMENT_KEY,
  OWNER_UTXO_TX,
  SPONSOR_UTXO_TX,
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
  ownerRewardAddress,
  ownerStakeScript,
  ownerStakeScriptHash,
  recipientAddress,
  redeemerOf,
  scenario,
  script,
} from './support/account.js';
import { ProviderEvaluatedWallet } from './support/fake.js';

const DEVICE_REDEEMER = 'd87980';
const FUND_REDEEMER = 'd87b80';
const OPERATE_REDEEMER = 'd87980';
const KEY_DEPOSIT = '2000000';
const POOL_ID = 'pool1pu5jlj4q9w9jlxeu370a3c9myx47md5j5m2str0naunn2q3lkdy';
const CONTROL_INPUT = { txId: '11'.repeat(32), index: 0 };

interface InspectedTx {
  body: {
    inputs: { transaction_id: string; index: number }[];
    outputs: { address: string; amount: { coin: string } }[];
    fee: string;
    ttl?: string;
    mint?: { script_hash: string; assets: Record<string, string> }[];
    required_signers?: string[];
    collateral?: unknown[];
    certs?: { tag: string; credential: { tag: string; value: string }; coin?: string; pool_keyhash?: string }[];
    withdrawals?: { key: string; value: string }[];
    reference_inputs?: { transaction_id: string; index: number }[];
  };
  witness_set: {
    plutus_scripts?: { language: string }[];
    redeemers?: { tag: string; index: number; ex_units: { mem: string; steps: string }; data: { tag: string; alternative: string; data: unknown[] } }[];
  };
}

const inspect = (tx: string): InspectedTx => Cometa.inspectTx(tx) as InspectedTx;

const outputsAt = (tx: string, at: string) => transactionBodyParts(tx).outputs.filter((output) => output.address === at);

const controlOutputOf = (tx: string) => {
  const outputs = outputsAt(tx, address).filter((output) => output.value.assets?.[nftAssetId] === 1n);
  expect(outputs).toHaveLength(1);
  return outputs[0]!;
};

const stateOf = (tx: string) => decodeAccountState(withoutCborCache(controlOutputOf(tx).datum!));

/** The flat program bytes a script carries, which the witness set holds without the blueprint's CBOR wrapper. */
const programOf = (bytes: string) => bytes.slice(6);

/** Asserts which of the account script and the stake script the witness set carries. */
const expectScriptsAttached = (tx: string, { account = true, stake = false }: { account?: boolean; stake?: boolean } = {}) => {
  expect(inspect(tx).witness_set.plutus_scripts?.map((entry) => entry.language)).toEqual(Array<string>(Number(account) + Number(stake)).fill('plutus_v3'));
  expect(tx.includes(programOf(script.bytes))).toBe(account);
  expect(tx.includes(programOf(ownerStakeScript.bytes))).toBe(stake);
};

const expectScriptAttached = (tx: string) => expectScriptsAttached(tx);

/** The certificates of a transaction, every one of which the stake script witnesses with the operate redeemer. */
const certificatesOf = (tx: string) => {
  const inspected = inspect(tx);
  const certificateRedeemers = inspected.witness_set.redeemers?.filter((redeemer) => redeemer.tag === 'cert') ?? [];
  expect(certificateRedeemers.map((redeemer) => [Number(redeemer.index), redeemer.data.alternative, redeemer.data.data])).toEqual(
    (inspected.body.certs ?? []).map((_, index) => [index, '0', []]),
  );
  return inspected.body.certs ?? [];
};

/** The lovelace the outputs at an address hold in total. */
const lovelaceAt = (tx: string, at: string) => outputsAt(tx, at).reduce((total, output) => total + output.value.coins, 0n);

/** The lovelace of the plain change outputs a transaction returns to the account. */
const accountChangeOf = (tx: string) => outputsAt(tx, address).filter((output) => output.datum === undefined).map((output) => output.value);

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
  it('registers the stake credential with the deposit and mints the state NFT into a control output signed by the owner device', async () => {
    const { owner } = scenario(undefined, []);
    const tx = await createAccount({ wallet: owner, owner: OWNER_PAYMENT_KEY, state: initialState, script });
    const inspected = inspect(tx);
    expect(inspected.body.mint).toEqual([{ script_hash: Cometa.policyIdFromAssetId(nftAssetId), assets: { [ownerStakeScriptHash]: '1' } }]);
    expect(inspected.body.required_signers).toEqual([OWNER_PAYMENT_KEY]);
    expect(certificatesOf(tx)).toEqual([
      { tag: 'registration', credential: { tag: 'script_hash', value: ownerStakeScriptHash }, coin: KEY_DEPOSIT },
    ]);
    expect(inspected.witness_set.redeemers?.map((redeemer) => redeemer.tag).sort()).toEqual(['cert', 'mint']);
    expect(inspected.body.withdrawals).toBeUndefined();
    expectScriptsAttached(tx, { account: true, stake: true });
    const control = controlOutputOf(tx);
    expect(control.value).toEqual({ coins: 2_000_000n, assets: { [nftAssetId]: 1n } });
    expect(stateOf(tx)).toEqual(initialState);
    expect(Cometa.readRedeemersFromTx(tx).map((redeemer) => Cometa.plutusDataToCbor(redeemer.data))).toEqual([OPERATE_REDEEMER, 'd87980']);
    expect(inspected.body.inputs.map((input) => input.transaction_id)).toEqual([OWNER_UTXO_TX]);
    expect(50_000_000n - lovelaceAt(tx, owner.address.toString()) - transactionBodyParts(tx).fee).toBe(CONTROL_LOVELACE + BigInt(KEY_DEPOSIT));
  });

  it('lets a sponsor fund the creation, the deposit and the collateral while the owner only signs', async () => {
    const { owner, sponsor } = scenario(undefined, []);
    const tx = await createAccount({ wallet: owner, sponsor, owner: OWNER_PAYMENT_KEY, state: initialState, script });
    const inspected = inspect(tx);
    expect(inspected.body.inputs.map((input) => input.transaction_id)).toEqual([SPONSOR_UTXO_TX]);
    expect(JSON.stringify(inspected.body.collateral)).toContain(SPONSOR_UTXO_TX);
    expect(inspected.body.required_signers).toEqual([OWNER_PAYMENT_KEY]);
    expect(certificatesOf(tx)).toEqual([
      { tag: 'registration', credential: { tag: 'script_hash', value: ownerStakeScriptHash }, coin: KEY_DEPOSIT },
    ]);
    expect(outputsAt(tx, owner.address.toString())).toHaveLength(0);
    expect(60_000_000n - lovelaceAt(tx, sponsor.address.toString()) - transactionBodyParts(tx).fee).toBe(CONTROL_LOVELACE + BigInt(KEY_DEPOSIT));
    expect(stateOf(tx)).toEqual(initialState);
    expectScriptsAttached(tx, { account: true, stake: true });
  });

  it('refuses a state that is not well formed', async () => {
    const { owner } = scenario(undefined, []);
    await expect(
      createAccount({ wallet: owner, owner: OWNER_PAYMENT_KEY, state: { ...initialState, devices: [] }, script }),
    ).rejects.toThrow(/not well formed/);
  });

  it('refuses to create an account whose state NFT already exists when it can look', async () => {
    const existing = scenario(initialState, []);
    await expect(
      createAccount({ wallet: existing.owner, provider: existing.provider, owner: OWNER_PAYMENT_KEY, state: initialState, script }),
    ).rejects.toThrow(/already exists/);
    const fresh = scenario(undefined, [fundUtxo(0, { coins: 10_000_000n })]);
    const tx = await createAccount({ wallet: fresh.owner, provider: fresh.provider, owner: OWNER_PAYMENT_KEY, state: initialState, script });
    expect(stateOf(tx)).toEqual(initialState);
  });

  it('gives the control output at least its minimum UTxO value when the state needs more', async () => {
    const { owner, provider } = scenario(undefined, []);
    const tx = await createAccount({ wallet: owner, provider, owner: OWNER_PAYMENT_KEY, state: grantedState, script });
    const coins = expectControlAboveMinimum(tx);
    expect(coins).toBeGreaterThan(CONTROL_LOVELACE);
    expect(coins).toBe(minimumUtxoLovelace(controlOutputOf(tx), 4310n));
  });
});

describe('deposit', () => {
  it('pays the value to the account address with no datum', async () => {
    const { owner } = scenario(initialState, []);
    const tx = await deposit({ wallet: owner, owner: OWNER_PAYMENT_KEY, value: { coins: 10_000_000n }, script });
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
    const found = await findAccountUtxos(provider, { wallet: owner, owner: OWNER_PAYMENT_KEY, script });
    expect(found.control.input).toEqual({ txId: '11'.repeat(32), index: 0 });
    expect(found.funds.map((fund) => fund.input.index)).toEqual([0, 1]);
    expect(found.state).toEqual(grantedState);
  });

  it('demands exactly one control UTxO', async () => {
    const { provider, owner } = scenario(undefined, []);
    const params = { wallet: owner, owner: OWNER_PAYMENT_KEY, script };
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
  it('pays the outputs and the fee from the account, recreates the state and returns the change to the account', async () => {
    const { provider, owner } = scenario(initialState, [fundUtxo(0, { coins: 10_000_000n }), fundUtxo(1, { coins: 4_000_000n })]);
    const payout = { address: recipientAddress, value: { coins: 5_000_000n } };
    const tx = await spendWithDevice({ wallet: owner, provider, owner: OWNER_PAYMENT_KEY, outputs: [payout], script });
    expect(redeemerOf(tx, CONTROL_INPUT)).toBe(DEVICE_REDEEMER);
    expect(redeemerOf(tx, { txId: '22'.repeat(32), index: 0 })).toBe(FUND_REDEEMER);
    expect(spendsInput(tx, { txId: '22'.repeat(32), index: 1 })).toBe(false);
    expect(spendsInput(tx, { txId: OWNER_UTXO_TX, index: 0 })).toBe(false);
    expect(controlOutputOf(tx).value.coins).toBe(CONTROL_LOVELACE);
    expect(stateOf(tx)).toEqual(initialState);
    const fee = transactionBodyParts(tx).fee;
    expect(fee).toBeGreaterThan(0n);
    expect(accountChangeOf(tx)).toEqual([{ coins: 10_000_000n - 5_000_000n - fee }]);
    expect(outputsAt(tx, recipientAddress).map((output) => output.value)).toEqual([{ coins: 5_000_000n }]);
    expect(outputsAt(tx, owner.address.toString())).toHaveLength(0);
    const inspected = inspect(tx);
    expect(inspected.body.required_signers).toEqual([OWNER_PAYMENT_KEY]);
    expect(JSON.stringify(inspected.body.collateral)).toContain(OWNER_UTXO_TX);
    expectScriptAttached(tx);
  });

  it('lets a sponsor pay the fee and take the change while the funds cover the outputs alone', async () => {
    const { provider, owner, sponsor } = scenario(initialState, [fundUtxo(0, { coins: 10_000_000n }), fundUtxo(1, { coins: 4_000_000n })]);
    const payout = { address: recipientAddress, value: { coins: 5_000_000n } };
    const tx = await spendWithDevice({ wallet: owner, sponsor, provider, owner: OWNER_PAYMENT_KEY, outputs: [payout], script });
    expect(redeemerOf(tx, CONTROL_INPUT)).toBe(DEVICE_REDEEMER);
    expect(redeemerOf(tx, { txId: '22'.repeat(32), index: 0 })).toBe(FUND_REDEEMER);
    expect(spendsInput(tx, { txId: '22'.repeat(32), index: 1 })).toBe(false);
    expect(spendsInput(tx, { txId: OWNER_UTXO_TX, index: 0 })).toBe(false);
    expect(spendsInput(tx, { txId: SPONSOR_UTXO_TX, index: 0 })).toBe(true);
    expect(accountChangeOf(tx)).toEqual([{ coins: 5_000_000n }]);
    expect(outputsAt(tx, owner.address.toString())).toHaveLength(0);
    expect(60_000_000n - lovelaceAt(tx, sponsor.address.toString())).toBe(transactionBodyParts(tx).fee);
    const inspected = inspect(tx);
    expect(inspected.body.required_signers).toEqual([OWNER_PAYMENT_KEY]);
    expect(JSON.stringify(inspected.body.collateral)).toContain(SPONSOR_UTXO_TX);
  });

  it('can rewrite the state in the same transaction', async () => {
    const { provider, owner, sponsor } = scenario(initialState, [fundUtxo(0, { coins: 10_000_000n })]);
    const newState = stateWithDevice(initialState, OTHER_DEVICE_KEY);
    const tx = await spendWithDevice({
      wallet: owner,
      sponsor,
      provider,
      owner: OWNER_PAYMENT_KEY,
      outputs: [{ address: recipientAddress, value: { coins: 10_000_000n } }],
      newState,
      script,
    });
    expect(stateOf(tx)).toEqual(newState);
    expect(outputsAt(tx, address)).toHaveLength(1);
  });

  it('refuses a wallet that is not a device', async () => {
    const { provider, agent } = scenario(initialState, [fundUtxo(0, { coins: 10_000_000n })]);
    await expect(spendWithDevice({ wallet: agent, provider, owner: OWNER_PAYMENT_KEY, outputs: [], script })).rejects.toThrow(
      /not a device/,
    );
  });

  it('reserves the most a transaction can cost from the funds and refuses when they cannot cover it', async () => {
    const funds = [fundUtxo(0, { coins: 3_000_000n }), fundUtxo(1, { coins: 2_000_000n })];
    const { provider, owner } = scenario(initialState, funds);
    const payout = { address: recipientAddress, value: { coins: 1_000_000n } };
    const tx = await spendWithDevice({ wallet: owner, provider, owner: OWNER_PAYMENT_KEY, outputs: [payout], script });
    expect(spendsInput(tx, { txId: '22'.repeat(32), index: 0 })).toBe(true);
    expect(spendsInput(tx, { txId: '22'.repeat(32), index: 1 })).toBe(true);
    const fee = transactionBodyParts(tx).fee;
    expect(accountChangeOf(tx)).toEqual([{ coins: 5_000_000n - 1_000_000n - fee }]);
    expect(5_000_000n - 1_000_000n - fee).toBeGreaterThanOrEqual(minimumUtxoLovelace({ address, value: { coins: 0n } }, 4310n));
    const lean = scenario(initialState, [fundUtxo(0, { coins: 2_000_000n })]);
    await expect(
      spendWithDevice({ wallet: lean.owner, provider: lean.provider, owner: OWNER_PAYMENT_KEY, outputs: [payout], script }),
    ).rejects.toThrow(/not hold enough funds/);
  });

  it('derives the change floor from the change output, which needs more lovelace when it carries tokens', async () => {
    const funds = [fundUtxo(0, { coins: 3_000_000n, assets: { [TOKEN_ASSET_ID]: 20n } }), fundUtxo(1, { coins: 2_000_000n })];
    const payout = { address: recipientAddress, value: { coins: 2_000_000n, assets: { [TOKEN_ASSET_ID]: 5n } } };
    const { provider, owner, sponsor } = scenario(initialState, funds);
    const tx = await spendWithDevice({ wallet: owner, sponsor, provider, owner: OWNER_PAYMENT_KEY, outputs: [payout], script });
    expect(spendsInput(tx, { txId: '22'.repeat(32), index: 1 })).toBe(true);
    expect(accountChangeOf(tx)).toEqual([{ coins: 3_000_000n, assets: { [TOKEN_ASSET_ID]: 15n } }]);
    const tokenFloor = minimumUtxoLovelace({ address, value: { coins: 0n, assets: { [TOKEN_ASSET_ID]: 15n } } }, 4310n);
    expect(tokenFloor).toBeGreaterThan(1_000_000n);
    expect(tokenFloor).toBeGreaterThan(minimumUtxoLovelace({ address, value: { coins: 0n } }, 4310n));
    const lovelaceOnly = scenario(initialState, [fundUtxo(0, { coins: 1_500_000n })]);
    const lean = await spendWithDevice({
      wallet: lovelaceOnly.owner,
      sponsor: lovelaceOnly.sponsor,
      provider: lovelaceOnly.provider,
      owner: OWNER_PAYMENT_KEY,
      outputs: [{ address: recipientAddress, value: { coins: 400_000n } }],
      script,
    });
    expect(accountChangeOf(lean)).toEqual([{ coins: 1_100_000n }]);
    expect(1_100_000n).toBeGreaterThanOrEqual(minimumUtxoLovelace({ address, value: { coins: 0n } }, 4310n));
    expect(1_100_000n).toBeLessThan(tokenFloor);
  });

  it('honours a change floor override', async () => {
    const funds = [fundUtxo(0, { coins: 3_000_000n }), fundUtxo(1, { coins: 2_000_000n })];
    const { provider, owner, sponsor } = scenario(initialState, funds);
    const tx = await spendWithDevice({
      wallet: owner,
      sponsor,
      provider,
      owner: OWNER_PAYMENT_KEY,
      outputs: [{ address: recipientAddress, value: { coins: 1_000_000n } }],
      minimumChangeLovelace: 2_500_000n,
      script,
    });
    expect(spendsInput(tx, { txId: '22'.repeat(32), index: 1 })).toBe(true);
    expect(accountChangeOf(tx)).toEqual([{ coins: 4_000_000n }]);
  });
});

describe('state rewrites', () => {
  const params = () => {
    const { provider, owner, sponsor } = scenario(grantedState, [fundUtxo(0, { coins: 10_000_000n })]);
    return { wallet: owner, provider, owner: OWNER_PAYMENT_KEY, script, sponsor };
  };

  it('rewriteState carries the given state, paying from a fund UTxO or from the sponsor', async () => {
    const newState = { ...grantedState, grantGeneration: 7n };
    const { sponsor, ...paid } = params();
    const tx = await rewriteState({ ...paid, newState });
    expect(stateOf(tx)).toEqual(newState);
    expect(spendsInput(tx, { txId: '22'.repeat(32), index: 0 })).toBe(true);
    const growth = controlOutputOf(tx).value.coins - CONTROL_LOVELACE;
    expect(growth).toBeGreaterThan(0n);
    expect(accountChangeOf(tx)).toEqual([{ coins: 10_000_000n - growth - transactionBodyParts(tx).fee }]);
    const sponsored = await rewriteState({ ...paid, sponsor, newState });
    expect(stateOf(sponsored)).toEqual(newState);
    expect(spendsInput(sponsored, { txId: '22'.repeat(32), index: 0 })).toBe(false);
    expect(outputsAt(sponsored, address)).toHaveLength(1);
  });

  it('addDevice and removeDevice edit the devices', async () => {
    expect(stateOf(await addDevice({ ...params(), device: OTHER_DEVICE_KEY }))).toEqual(stateWithDevice(grantedState, OTHER_DEVICE_KEY));
    await expect(addDevice({ ...params(), device: OWNER_PAYMENT_KEY })).rejects.toThrow(/distinct/);
    await expect(removeDevice({ ...params(), device: OWNER_PAYMENT_KEY })).rejects.toThrow(/at least one device/);
    const { provider, owner } = scenario(stateWithDevice(grantedState, OTHER_DEVICE_KEY), [fundUtxo(0, { coins: 10_000_000n })]);
    const tx = await removeDevice({ wallet: owner, provider, owner: OWNER_PAYMENT_KEY, device: OTHER_DEVICE_KEY, script });
    expect(stateOf(tx)).toEqual(stateWithoutDevice(stateWithDevice(grantedState, OTHER_DEVICE_KEY), OTHER_DEVICE_KEY));
  });

  it('raises the control lovelace with the state, paid from the account or by the sponsor', async () => {
    let state = initialState;
    let previous = 0n;
    for (let slot = 0n; slot < 6n; slot += 1n) {
      const { provider, owner, sponsor } = scenario(state, [fundUtxo(0, { coins: 10_000_000n })]);
      const grant = { slot, grantee: AGENT_PAYMENT_KEY, scope: lovelaceScope([recipientAddress]) };
      const tx = await issueGrant({ wallet: owner, provider, owner: OWNER_PAYMENT_KEY, grant, script });
      const coins = expectControlAboveMinimum(tx);
      expect(coins).toBeGreaterThanOrEqual(previous);
      expect(coins).toBeGreaterThanOrEqual(CONTROL_LOVELACE);
      expect(spendsInput(tx, { txId: OWNER_UTXO_TX, index: 0 })).toBe(false);
      expect(accountChangeOf(tx)).toEqual([{ coins: 10_000_000n - (coins - CONTROL_LOVELACE) - transactionBodyParts(tx).fee }]);
      const sponsored = await issueGrant({ wallet: owner, sponsor, provider, owner: OWNER_PAYMENT_KEY, grant, script });
      expect(controlOutputOf(sponsored).value.coins).toBe(coins);
      expect(spendsInput(sponsored, { txId: '22'.repeat(32), index: 0 })).toBe(false);
      expect(60_000_000n - lovelaceAt(sponsored, sponsor.address.toString()) - transactionBodyParts(sponsored).fee).toBe(coins - CONTROL_LOVELACE);
      state = stateWithGrant(state, grant);
      previous = coins;
    }
    expect(previous).toBeGreaterThan(CONTROL_LOVELACE);
  });

  it('issueGrant, revokeGrant and revokeAllGrants edit the grants', async () => {
    const grant = { slot: 3n, grantee: AGENT_PAYMENT_KEY, scope: grantedState.grants[0]!.scope };
    expect(stateOf(await issueGrant({ ...params(), grant }))).toEqual(stateWithGrant(grantedState, grant));
    await expect(issueGrant({ ...params(), grant: { ...grant, slot: 0n } })).rejects.toThrow(/slots must be distinct/);
    expect(stateOf(await revokeGrant({ ...params(), slot: 1n }))).toEqual(stateWithoutGrant(grantedState, 1n));
    expect(stateOf(await revokeAllGrants(params()))).toEqual(stateWithoutGrants(grantedState));
  });
});

describe('stake operations', () => {
  const params = () => {
    const { provider, owner, sponsor } = scenario(initialState, [fundUtxo(0, { coins: 10_000_000n })]);
    return { wallet: owner, provider, owner: OWNER_PAYMENT_KEY, script, sponsor };
  };

  /** Asserts what every stake operation shares: the control UTxO spent and recreated unchanged, a device signing and both scripts attached. */
  const expectDeviceStakeOperation = (tx: string, device: string, state = initialState) => {
    const inspected = inspect(tx);
    expect(redeemerOf(tx, CONTROL_INPUT)).toBe(DEVICE_REDEEMER);
    expect(stateOf(tx)).toEqual(state);
    expect(controlOutputOf(tx).value.coins).toBe(CONTROL_LOVELACE);
    expect(inspected.body.required_signers).toEqual([device]);
    expect(inspected.body.collateral?.length).toBeGreaterThan(0);
    expect(inspected.body.mint).toBeUndefined();
    expect(inspected.body.reference_inputs).toBeUndefined();
    expectScriptsAttached(tx, { account: true, stake: true });
  };

  it('withdrawRewards draws the given amount, zero included, from the reward account with the operate redeemer, paid from the account', async () => {
    const { sponsor, ...owner } = params();
    const tx = await withdrawRewards({ ...owner, amount: 0n });
    expectDeviceStakeOperation(tx, OWNER_PAYMENT_KEY);
    const inspected = inspect(tx);
    expect(inspected.body.withdrawals).toEqual([{ key: ownerRewardAddress, value: '0' }]);
    expect(inspected.body.certs).toBeUndefined();
    expect(inspected.witness_set.redeemers?.filter((redeemer) => redeemer.tag === 'reward').map((redeemer) => [Number(redeemer.index), redeemer.data.alternative])).toEqual([[0, '0']]);
    expect(Cometa.readRedeemersFromTx(tx).map((redeemer) => Cometa.plutusDataToCbor(redeemer.data)).sort()).toEqual([DEVICE_REDEEMER, FUND_REDEEMER, OPERATE_REDEEMER].sort());
    expect(redeemerOf(tx, { txId: '22'.repeat(32), index: 0 })).toBe(FUND_REDEEMER);
    expect(spendsInput(tx, { txId: OWNER_UTXO_TX, index: 0 })).toBe(false);
    expect(accountChangeOf(tx)).toEqual([{ coins: 10_000_000n - transactionBodyParts(tx).fee }]);
    void sponsor;
  });

  it('withdrawRewards takes the whole reward balance from the provider when no amount is given, with a sponsor paying', async () => {
    const { sponsor, ...owner } = params();
    const tx = await withdrawRewards({ ...owner, sponsor });
    expectDeviceStakeOperation(tx, OWNER_PAYMENT_KEY);
    expect(inspect(tx).body.withdrawals).toEqual([{ key: ownerRewardAddress, value: '0' }]);
    expect(spendsInput(tx, { txId: '22'.repeat(32), index: 0 })).toBe(false);
    expect(spendsInput(tx, { txId: SPONSOR_UTXO_TX, index: 0 })).toBe(true);
    expect(outputsAt(tx, address)).toHaveLength(1);
  });

  it('delegateStake publishes a delegation certificate for the stake credential', async () => {
    const { sponsor, ...owner } = params();
    const tx = await delegateStake({ ...owner, poolId: POOL_ID });
    expectDeviceStakeOperation(tx, OWNER_PAYMENT_KEY);
    expect(certificatesOf(tx)).toEqual([{ tag: 'stake_delegation', credential: { tag: 'script_hash', value: ownerStakeScriptHash }, pool_keyhash: POOL_ID }]);
    expect(inspect(tx).body.withdrawals).toBeUndefined();
    expect(redeemerOf(tx, { txId: '22'.repeat(32), index: 0 })).toBe(FUND_REDEEMER);
    void sponsor;
  });

  it('lets any device operate the stake credential and refuses a wallet that is not one', async () => {
    const state = stateWithDevice(initialState, AGENT_PAYMENT_KEY);
    const { provider, agent } = scenario(state, [fundUtxo(0, { coins: 10_000_000n })]);
    const tx = await withdrawRewards({ wallet: agent, provider, owner: OWNER_PAYMENT_KEY, amount: 0n, script });
    expectDeviceStakeOperation(tx, AGENT_PAYMENT_KEY, state);
    expect(spendsInput(tx, { txId: AGENT_UTXO_TX, index: 0 })).toBe(false);
    expect(JSON.stringify(inspect(tx).body.collateral)).toContain(AGENT_UTXO_TX);
    const delegated = await delegateStake({ wallet: agent, provider, owner: OWNER_PAYMENT_KEY, poolId: POOL_ID, script });
    expectDeviceStakeOperation(delegated, AGENT_PAYMENT_KEY, state);
    const stranger = scenario(initialState, [fundUtxo(0, { coins: 10_000_000n })]);
    await expect(withdrawRewards({ wallet: stranger.agent, provider: stranger.provider, owner: OWNER_PAYMENT_KEY, amount: 0n, script })).rejects.toThrow(/not a device/);
    await expect(delegateStake({ wallet: stranger.agent, provider: stranger.provider, owner: OWNER_PAYMENT_KEY, poolId: POOL_ID, script })).rejects.toThrow(/not a device/);
  });

  it('needs the control UTxO to exist and, without a sponsor, funds to pay from', async () => {
    const { provider, owner } = scenario(undefined, []);
    await expect(withdrawRewards({ wallet: owner, provider, owner: OWNER_PAYMENT_KEY, amount: 0n, script })).rejects.toThrow(/exactly one control UTxO/);
    const unfunded = scenario(initialState, []);
    await expect(withdrawRewards({ wallet: unfunded.owner, provider: unfunded.provider, owner: OWNER_PAYMENT_KEY, amount: 0n, script })).rejects.toThrow(/not hold enough funds/);
    const sponsored = await withdrawRewards({ wallet: unfunded.owner, sponsor: unfunded.sponsor, provider: unfunded.provider, owner: OWNER_PAYMENT_KEY, amount: 0n, script });
    expect(inspect(sponsored).body.withdrawals).toEqual([{ key: ownerRewardAddress, value: '0' }]);
  });
});

describe('spendWithGrant', () => {
  const funds = () => [fundUtxo(0, { coins: 10_000_000n }), fundUtxo(1, { coins: 4_000_000n, assets: { [TOKEN_ASSET_ID]: 20n } })];

  it('lets a grantee spend lovelace, paying the fee from the account', async () => {
    const { provider, agent } = scenario(grantedState, funds());
    const payout = { address: recipientAddress, value: { coins: 3_000_000n } };
    const tx = await spendWithGrant({
      wallet: agent,
      provider,
      owner: OWNER_PAYMENT_KEY,
      slot: 0n,
      outputs: [payout],
      grantee: AGENT_PAYMENT_KEY,
      validUntilSlot: VALID_UNTIL_SLOT,
      script,
    });
    const parts = transactionBodyParts(tx);
    expect(redeemerOf(tx, { txId: '11'.repeat(32), index: 0 })).toBe('d87a9f00ff');
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
        owner: OWNER_PAYMENT_KEY,
        slot: 0n,
        outputs: [{ address: recipientAddress, value: { coins: 3_000_000n } }],
        grantee: AGENT_PAYMENT_KEY,
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
      owner: OWNER_PAYMENT_KEY,
      slot: 0n,
      outputs: [{ address: recipientAddress, value: { coins: 1_000_000n } }],
      grantee: AGENT_PAYMENT_KEY,
      validUntilSlot: VALID_UNTIL_SLOT,
      script,
    });
    expect(controlOutputOf(tx).value.coins).toBe(CONTROL_LOVELACE);
  });

  it('lets a grantee spend tokens within the lovelace caps', async () => {
    const { provider, agent } = scenario(grantedState, funds());
    const payout = { address: recipientAddress, value: { coins: 1_500_000n, assets: { [TOKEN_ASSET_ID]: 7n } } };
    const tx = await spendWithGrant({
      wallet: agent,
      provider,
      owner: OWNER_PAYMENT_KEY,
      slot: 1n,
      outputs: [payout],
      grantee: AGENT_PAYMENT_KEY,
      validUntilSlot: VALID_UNTIL_SLOT,
      script,
    });
    const parts = transactionBodyParts(tx);
    expect(redeemerOf(tx, { txId: '11'.repeat(32), index: 0 })).toBe('d87a9f01ff');
    expect(inspect(tx).body.required_signers).toEqual([AGENT_PAYMENT_KEY]);
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
    const base = { wallet: agent, provider, owner: OWNER_PAYMENT_KEY, validUntilSlot: VALID_UNTIL_SLOT, script };
    const grantee = AGENT_PAYMENT_KEY;
    const payout = (coins: bigint) => [{ address: recipientAddress, value: { coins } }];
    await expect(spendWithGrant({ ...base, slot: 9n, outputs: payout(1n), grantee })).rejects.toThrow(/no grant in slot 9/);
    await expect(spendWithGrant({ ...base, slot: 0n, outputs: payout(1n), grantee: OWNER_PAYMENT_KEY })).rejects.toThrow(/not the grantee/);
    await expect(spendWithGrant({ ...base, slot: 2n, outputs: [{ address: enterpriseAddress(OTHER_DEVICE_KEY), value: { coins: 1n } }], grantee })).rejects.toThrow(/not a recipient/);
    await expect(spendWithGrant({ ...base, slot: 0n, outputs: payout(10_000_000n), grantee })).rejects.toThrow(/per call cap/);
    await expect(spendWithGrant({ ...base, slot: 0n, outputs: payout(1n), grantee, validUntilSlot: 300_000_000n })).rejects.toThrow(/expires/);
    await expect(
      spendWithGrant({ ...base, slot: 0n, outputs: [{ address: recipientAddress, value: { coins: 1_000_000n, assets: { [TOKEN_ASSET_ID]: 1n } } }], grantee }),
    ).rejects.toThrow(/does not cover/);
    await expect(
      spendWithGrant({ ...base, slot: 1n, outputs: [{ address: recipientAddress, value: { coins: 2_400_000n, assets: { [TOKEN_ASSET_ID]: 1n } } }], grantee }),
    ).rejects.toThrow(/exceeds the lovelace per call cap of 2500000/);
  });

  it('decrements the cap of a restricted recipient grant by the payout and fee', async () => {
    const { provider, agent } = scenario(grantedState, funds());
    const tx = await spendWithGrant({
      wallet: agent,
      provider,
      owner: OWNER_PAYMENT_KEY,
      slot: 2n,
      outputs: [{ address: recipientAddress, value: { coins: 2_000_000n } }],
      grantee: AGENT_PAYMENT_KEY,
      validUntilSlot: VALID_UNTIL_SLOT,
      script,
    });
    const encoded = Cometa.plutusDataToCbor(encodeAccountState(stateOf(tx)));
    expect(encoded).toBe(Cometa.plutusDataToCbor(withoutCborCache(controlOutputOf(tx).datum!)));
    expect(stateOf(tx).grants[2]!.scope.cap).toBe(15_000_000n - 2_000_000n - transactionBodyParts(tx).fee);
  });

  /**
   * The builder only ever selects fund UTxOs the account already owns, so
   * a transaction it assembles can never carry a net deposit: whatever a
   * grant spend returns to the account is money the account itself put
   * up, and what leaves always equals the payout plus the fee. The clamp
   * that keeps a net deposit from raising a cap is exercised directly
   * against `stateAfterSpend`, the function the validator's own check
   * mirrors, instead.
   */
  it('keeps a cap as it was, rather than raising it, when the net outflow is a deposit', () => {
    const depositOnly = stateAfterSpend(grantedState, 0n, { '': -5_000_000n });
    expect(depositOnly.grants[0]!.scope.cap).toBe(grantedState.grants[0]!.scope.cap);

    const depositExceedingThePayout = stateAfterSpend(grantedState, 2n, { '': -3_000_000n });
    expect(depositExceedingThePayout.grants[2]!.scope.cap).toBe(grantedState.grants[2]!.scope.cap);
  });
});

describe('spendWithGrant unchecked', () => {
  const funds = () => [fundUtxo(0, { coins: 10_000_000n }), fundUtxo(1, { coins: 4_000_000n })];
  const ed25519 = AGENT_PAYMENT_KEY;
  const nearlyUsedState = {
    ...grantedState,
    grants: grantedState.grants.map((grant) => (grant.slot === 0n ? { ...grant, scope: { ...grant.scope, cap: 6_000_000n } } : grant)),
  };

  it('builds a spend beyond the remaining cap whose datum carries the cap the validator computes', async () => {
    const { provider, agent } = scenario(nearlyUsedState, funds());
    const params = { wallet: agent, provider, owner: OWNER_PAYMENT_KEY, slot: 0n, grantee: ed25519, validUntilSlot: VALID_UNTIL_SLOT, script };
    const outputs = [{ address: recipientAddress, value: { coins: 8_000_000n } }];
    await expect(spendWithGrant({ ...params, outputs })).rejects.toThrow(/exceeds the remaining cap of 6000000/);
    const tx = await spendWithGrant({ ...params, outputs, unchecked: true });
    const leaving = 8_000_000n + transactionBodyParts(tx).fee;
    expect(outputsAt(tx, recipientAddress).map((output) => output.value)).toEqual([{ coins: 8_000_000n }]);
    expect(stateOf(tx)).toEqual(stateAfterSpend(nearlyUsedState, 0n, { '': leaving }));
    expect(stateOf(tx).grants[0]!.scope.cap).toBe(6_000_000n - leaving);
    expect(stateOf(tx).grants[0]!.scope.cap).toBeLessThan(0n);
    await expect(provider.evaluateTransaction(tx)).rejects.toThrow(/exceeds the remaining cap of 6000000/);
  });

  it('builds a spend paying an address outside the recipients', async () => {
    const { provider, agent } = scenario(grantedState, funds());
    const stranger = enterpriseAddress(OTHER_DEVICE_KEY);
    const params = { wallet: agent, provider, owner: OWNER_PAYMENT_KEY, slot: 2n, grantee: ed25519, validUntilSlot: VALID_UNTIL_SLOT, script };
    const outputs = [{ address: stranger, value: { coins: 3_000_000n } }];
    await expect(spendWithGrant({ ...params, outputs })).rejects.toThrow(/not a recipient of grant 2/);
    const tx = await spendWithGrant({ ...params, outputs, unchecked: true });
    expect(outputsAt(tx, stranger).map((output) => output.value)).toEqual([{ coins: 3_000_000n }]);
    expect(stateOf(tx)).toEqual(stateAfterSpend(grantedState, 2n, { '': 3_000_000n + transactionBodyParts(tx).fee }));
    await expect(provider.evaluateTransaction(tx)).rejects.toThrow(/not a recipient of grant 2/);
  });

  it('builds a spend whose validity range ends after the grant expires', async () => {
    const { provider, agent } = scenario(grantedState, funds());
    const params = { wallet: agent, provider, owner: OWNER_PAYMENT_KEY, slot: 0n, grantee: ed25519, validUntilSlot: 300_000_000n, script };
    const outputs = [{ address: recipientAddress, value: { coins: 1_000_000n } }];
    await expect(spendWithGrant({ ...params, outputs })).rejects.toThrow(/expires/);
    const tx = await spendWithGrant({ ...params, outputs, unchecked: true });
    expect(inspect(tx).body.ttl).toBe('300000000');
    expect(slotToPosixTime(300_000_000n)).toBeGreaterThan(grantedState.grants[0]!.scope.expiresAt);
    await expect(provider.evaluateTransaction(tx)).rejects.toThrow(/ends after grant 0 expires/);
  });

  it('still needs the grant to exist and the signer to be its grantee', async () => {
    const { provider, agent } = scenario(grantedState, funds());
    const params = { wallet: agent, provider, owner: OWNER_PAYMENT_KEY, validUntilSlot: VALID_UNTIL_SLOT, script, unchecked: true };
    const outputs = [{ address: recipientAddress, value: { coins: 1_000_000n } }];
    await expect(spendWithGrant({ ...params, slot: 9n, outputs, grantee: ed25519 })).rejects.toThrow(/no grant in slot 9/);
    await expect(spendWithGrant({ ...params, slot: 0n, outputs, grantee: OWNER_PAYMENT_KEY })).rejects.toThrow(/not the grantee/);
  });
});
