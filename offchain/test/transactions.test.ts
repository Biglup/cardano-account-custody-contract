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
import { Cometa } from '../src/cometa.js';
import {
  type AccountState,
  type Grant,
  decodeAccountState,
  decodeGrant,
  encodeAccountState,
  encodeGrant,
  encodeMintRedeemer,
  encodeStakeRedeemer,
  withoutCborCache,
} from '../src/data.js';
import { posixTimeToSlot, slotToPosixTime, transactionBodyParts } from '../src/body.js';
import { minimumLovelaceForSize, minimumUtxoLovelace, serialiseOutput } from '../src/output.js';
import {
  MAX_REVOKED,
  grantAfterSpend,
  stateAfterIssue,
  stateAfterSweep,
  stateWithDevice,
  stateWithNextGeneration,
  stateWithRevokedSlot,
  stateWithoutDevice,
} from '../src/state.js';
import {
  DEFAULT_GRANT_FEE_BOUND,
  MAX_GRANT_BATCH,
  UNCHECKED_EXECUTION_UNITS,
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
  survivingGrantRequests,
  sweepGrant,
  withdrawRewards,
} from '../src/transactions.js';
import { toBalance } from '../src/value.js';
import {
  AGENT_PAYMENT_KEY,
  AGENT_UTXO_TX,
  CONTROL_LOVELACE,
  CONTROL_UTXO_TX,
  EXPIRY,
  FUND_UTXO_TX,
  GRANT_LOVELACE,
  GRANT_UTXO_TX,
  OTHER_DEVICE_KEY,
  OWNER_PAYMENT_KEY,
  OWNER_UTXO_TX,
  RESERVE_UTXO_TX,
  SPONSOR_UTXO_TX,
  TOKEN_ASSET_ID,
  VALID_UNTIL_SLOT,
  address,
  controlUtxo,
  datumHashUtxo,
  enterpriseAddress,
  fixtureGrants,
  fundUtxo,
  grantAssetIdOf,
  grantUtxo,
  grantedState,
  grantedUtxos,
  initialState,
  lovelaceScope,
  nftAssetId,
  ownerRewardAddress,
  ownerStakeScript,
  ownerStakeScriptHash,
  recipientAddress,
  redeemerOf,
  reserveUtxo,
  scenario,
  script,
  tokenScope,
} from './support/account.js';
import { FAKE_EXECUTION_UNITS, type FakeWallet } from './support/fake.js';

/* CONSTANTS ******************************************************************/

const DEVICE_REDEEMER = 'd87980';
const SPEND_WITH_GRANT_REDEEMER = 'd87a80';
const SWEEP_GRANT_REDEEMER = 'd87b80';
const FUND_REDEEMER = 'd87c80';
const OPERATE_REDEEMER = 'd87980';
const CREATE_ACCOUNT_REDEEMER = 'd87980';
const ISSUE_GRANTS_REDEEMER = 'd87a80';
const BURN_GRANTS_REDEEMER = 'd87b80';
const RESERVE_DATUM = 'd87980';
const KEY_DEPOSIT = '2000000';
const POOL_ID = 'pool1pu5jlj4q9w9jlxeu370a3c9myx47md5j5m2str0naunn2q3lkdy';
const CONTROL_INPUT = { txId: CONTROL_UTXO_TX, index: 0 };
const ADA_PER_UTXO_BYTE = 4310n;

/** A state whose revoked list is full, so that the next revoke bumps the generation. */
const FULL_REVOKED_STATE = { ...grantedState, nextSlot: 40n, revoked: Array.from({ length: MAX_REVOKED }, (_, index) => BigInt(index + 3)) };

/* TYPES **********************************************************************/

interface InspectedTx {
  body: {
    inputs: { transaction_id: string; index: number }[];
    outputs: { address: string; amount: { coin: string } }[];
    fee: string;
    ttl?: string;
    validity_start_interval?: string;
    mint?: { script_hash: string; assets: Record<string, string> }[];
    required_signers?: string[];
    collateral?: { transaction_id: string; index: number }[];
    collateral_return?: { address: string; amount: { coin: string } };
    total_collateral?: string;
    certs?: { tag: string; credential: { tag: string; value: string }; coin?: string; pool_keyhash?: string }[];
    withdrawals?: { key: string; value: string }[];
    reference_inputs?: { transaction_id: string; index: number }[];
  };
  witness_set: {
    plutus_scripts?: { language: string }[];
    redeemers?: { tag: string; index: number; ex_units: { mem: string; steps: string }; data: { tag: string; alternative: string; data: unknown[] } }[];
  };
}

/* FUNCTIONS ******************************************************************/

/** The decoded body and witness set of a built transaction. */
const inspect = (tx: string): InspectedTx => Cometa.inspectTx(tx) as InspectedTx;

/** The input of a fund UTxO of the fixture. */
const fundInput = (index: number) => ({ txId: FUND_UTXO_TX, index });

/** The input of the grant UTxO of a slot of the fixture. */
const grantInput = (slot: bigint) => ({ txId: GRANT_UTXO_TX, index: Number(slot) });

/** The input of a reserve UTxO of the fixture. */
const reserveInput = (index: number) => ({ txId: RESERVE_UTXO_TX, index });

/** The outputs of a transaction at a given address. */
const outputsAt = (tx: string, at: string) => transactionBodyParts(tx).outputs.filter((output) => output.address === at);

/** The one output of a transaction that carries the account's state NFT at the account address. */
const controlOutputOf = (tx: string) => {
  const outputs = outputsAt(tx, address).filter((output) => output.value.assets?.[nftAssetId] === 1n);
  expect(outputs).toHaveLength(1);
  return outputs[0]!;
};

/** The account state a transaction's control output carries. */
const stateOf = (tx: string) => decodeAccountState(withoutCborCache(controlOutputOf(tx).datum!));

/** The one output of a transaction that carries the grant token of a slot. */
const grantOutputOf = (tx: string, slot: bigint) => {
  const outputs = transactionBodyParts(tx).outputs.filter((output) => output.value.assets?.[grantAssetIdOf(slot)] === 1n);
  expect(outputs).toHaveLength(1);
  return outputs[0]!;
};

/** The grant a transaction's grant output of a slot carries. */
const grantOf = (tx: string, slot: bigint) => decodeGrant(withoutCborCache(grantOutputOf(tx, slot).datum!));

/** Whether an output holds a token of the account policy. */
const holdsAccountToken = (output: { value: { assets?: Record<string, bigint> } }) =>
  Object.keys(output.value.assets ?? {}).some((assetId) => assetId.startsWith(Cometa.policyIdFromAssetId(nftAssetId)));

/** The reserve outputs a transaction returns to the account: outputs with a datum and no account token. */
const reserveOutputsOf = (tx: string) => outputsAt(tx, address).filter((output) => output.datum !== undefined && !holdsAccountToken(output));

/** The flat program bytes a script carries, which the witness set holds without the blueprint's CBOR wrapper. */
const programOf = (bytes: string) => bytes.slice(6);

/** Asserts which of the account script and the stake script the witness set carries. */
const expectScriptsAttached = (tx: string, { account = true, stake = false }: { account?: boolean; stake?: boolean } = {}) => {
  expect(inspect(tx).witness_set.plutus_scripts?.map((entry) => entry.language)).toEqual(Array<string>(Number(account) + Number(stake)).fill('plutus_v3'));
  expect(tx.includes(programOf(script.bytes))).toBe(account);
  expect(tx.includes(programOf(ownerStakeScript.bytes))).toBe(stake);
};

/** Asserts that the account script alone is attached to a transaction. */
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

/** The values of the plain change outputs a transaction returns to the account. */
const accountChangeOf = (tx: string) => outputsAt(tx, address).filter((output) => output.datum === undefined).map((output) => output.value);

/** Whether a transaction spends a given input. */
const spendsInput = (tx: string, input: { txId: string; index: number }) =>
  transactionBodyParts(tx).inputs.some((candidate) => candidate.txId === input.txId && candidate.index === input.index);

/** The mint of a transaction as asset ids mapped to quantities, with the CBOR of the one mint redeemer. */
const mintOf = (tx: string) => {
  const redeemers = Cometa.readRedeemersFromTx(tx).filter((redeemer) => redeemer.purpose === Cometa.RedeemerPurpose.mint);
  expect(redeemers.length).toBeLessThanOrEqual(1);
  return { mint: transactionBodyParts(tx).mint, redeemer: redeemers[0] === undefined ? undefined : Cometa.plutusDataToCbor(redeemers[0].data) };
};

/** Asserts that a transaction's control output holds at least its minimum UTxO value, and returns its lovelace. */
const expectControlAboveMinimum = (tx: string) => {
  const control = controlOutputOf(tx);
  const serialised = serialiseOutput(control);
  expect(tx).toContain(Cometa.uint8ArrayToHex(serialised));
  expect(control.value.coins).toBeGreaterThanOrEqual(minimumLovelaceForSize(serialised.length, ADA_PER_UTXO_BYTE));
  return control.value.coins;
};

/** Asserts that a transaction spends the control UTxO and nothing else of the account besides the given inputs. */
const expectAccountInputs = (tx: string, inputs: { txId: string; index: number }[]) => {
  const spent = transactionBodyParts(tx).inputs.filter((input) => [CONTROL_UTXO_TX, FUND_UTXO_TX, GRANT_UTXO_TX, RESERVE_UTXO_TX].includes(input.txId));
  expect(spent).toEqual([CONTROL_INPUT, ...inputs].sort((a, b) => (a.txId < b.txId ? -1 : a.txId > b.txId ? 1 : a.index - b.index)));
};

/**
 * A creation transaction assembled on the wallet's builder without
 * `createAccount`, so that the fake can be shown refusing what the
 * builder would never produce: the registration, the state NFT mint and
 * the control output carrying the given state, signed by the given key.
 */
const rawCreation = (wallet: FakeWallet, state: AccountState, signer: string) =>
  wallet.createTransactionBuilder().then((builder) =>
    builder
      .registerStakeAddress({ rewardAddress: ownerRewardAddress, redeemer: encodeStakeRedeemer() })
      .mintToken({ assetIdHex: nftAssetId, amount: 1n, redeemer: encodeMintRedeemer({ kind: 'createAccount' }) })
      .lockValue({
        scriptAddress: address,
        value: { coins: CONTROL_LOVELACE, assets: { [nftAssetId]: 1n } },
        datum: { type: Cometa.DatumType.InlineData, inlineDatum: encodeAccountState(state) },
      })
      .addSigner(signer)
      .addScript(script)
      .addScript(ownerStakeScript)
      .build(),
  );

/** The parameters of an owner builder over a fresh scenario, with the sponsor available alongside. */
const ownerParams = (state = grantedState, utxos = [fundUtxo(0, { coins: 10_000_000n }), ...grantedUtxos()]) => {
  const { provider, owner, sponsor } = scenario(state, utxos);
  return { wallet: owner, provider, owner: OWNER_PAYMENT_KEY, script, sponsor };
};

/** The parameters of an agent spend over a fresh scenario holding the fixture grants and funds. */
const agentParams = (state = grantedState, utxos = [fundUtxo(0, { coins: 10_000_000n }), fundUtxo(1, { coins: 4_000_000n, assets: { [TOKEN_ASSET_ID]: 20n } }), ...grantedUtxos()]) => {
  const { provider, agent } = scenario(state, utxos);
  return { wallet: agent, provider, owner: OWNER_PAYMENT_KEY, grantee: AGENT_PAYMENT_KEY, validUntilSlot: VALID_UNTIL_SLOT, script };
};

/* TESTS **********************************************************************/

describe('createAccount', () => {
  it('registers the stake credential with the deposit and mints the state NFT into a control output signed by the owner device', async () => {
    const { owner } = scenario(undefined, []);
    const tx = await createAccount({ wallet: owner, owner: OWNER_PAYMENT_KEY, state: initialState, script });
    const inspected = inspect(tx);
    expect(inspected.body.mint).toEqual([{ script_hash: Cometa.policyIdFromAssetId(nftAssetId), assets: { [ownerStakeScriptHash]: '1' } }]);
    expect(mintOf(tx).redeemer).toBe(CREATE_ACCOUNT_REDEEMER);
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
    expect(Cometa.readRedeemersFromTx(tx).map((redeemer) => Cometa.plutusDataToCbor(redeemer.data))).toEqual([OPERATE_REDEEMER, CREATE_ACCOUNT_REDEEMER]);
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

  it('refuses a state that is not well formed or whose counters are not zero', async () => {
    const { owner } = scenario(undefined, []);
    await expect(createAccount({ wallet: owner, owner: OWNER_PAYMENT_KEY, state: { ...initialState, devices: [] }, script })).rejects.toThrow(/not well formed/);
    await expect(createAccount({ wallet: owner, owner: OWNER_PAYMENT_KEY, state: grantedState, script })).rejects.toThrow(/zero counters/);
    await expect(createAccount({ wallet: owner, owner: OWNER_PAYMENT_KEY, state: { ...initialState, revoked: [0n] }, script })).rejects.toThrow(/zero counters/);
  });

  it('refuses a state that leaves the owner out of the devices, as the stake script refuses the registration', async () => {
    const { owner, provider } = scenario(undefined, []);
    const ownerless = { ...initialState, devices: [OTHER_DEVICE_KEY] };
    await expect(createAccount({ wallet: owner, owner: OWNER_PAYMENT_KEY, state: ownerless, script })).rejects.toThrow(/must list the owner .* among its devices/);
    await expect(rawCreation(owner, ownerless, OWNER_PAYMENT_KEY)).rejects.toThrow(/build failed/);
    await expect(rawCreation(owner, initialState, OTHER_DEVICE_KEY)).rejects.toThrow(/build failed/);
    expect(provider.phaseTwoFailures).toEqual([
      `The control output does not list the owner ${OWNER_PAYMENT_KEY} among its devices`,
      `The owner of the stake credential ${ownerStakeScriptHash} does not sign its registration`,
    ]);
    const tx = await rawCreation(owner, initialState, OWNER_PAYMENT_KEY);
    expect(stateOf(tx)).toEqual(initialState);
    expect(provider.phaseTwoFailures).toHaveLength(2);
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
    const state = { ...initialState, devices: [OWNER_PAYMENT_KEY, ...Array.from({ length: 7 }, (_, index) => `0${index}`.repeat(28))] };
    const tx = await createAccount({ wallet: owner, provider, owner: OWNER_PAYMENT_KEY, state, script });
    const coins = expectControlAboveMinimum(tx);
    expect(coins).toBeGreaterThan(CONTROL_LOVELACE);
    expect(coins).toBe(minimumUtxoLovelace(controlOutputOf(tx), ADA_PER_UTXO_BYTE));
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

  it('writes the reserve datum on a reserve deposit, which the builders then keep apart from the funds', async () => {
    const { owner, provider } = scenario(initialState, []);
    const tx = await deposit({ wallet: owner, owner: OWNER_PAYMENT_KEY, value: { coins: 5_000_000n }, reserve: true, script });
    const outputs = outputsAt(tx, address);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.value).toEqual({ coins: 5_000_000n });
    expect(Cometa.plutusDataToCbor(withoutCborCache(outputs[0]!.datum!))).toBe(RESERVE_DATUM);
    provider.addUtxo({ input: { txId: 'ab'.repeat(32), index: 0 }, output: outputs[0]! });
    const found = await findAccountUtxos(provider, { wallet: owner, owner: OWNER_PAYMENT_KEY, script });
    expect(found.reserves.map((reserve) => reserve.input.txId)).toEqual(['ab'.repeat(32)]);
    expect(found.funds).toEqual([]);
  });
});

describe('findAccountUtxos', () => {
  it('separates the control UTxO, the grant UTxOs, the reserves and the funds, and decodes the state', async () => {
    const { provider, owner } = scenario(grantedState, [fundUtxo(0, { coins: 10_000_000n }), reserveUtxo(0, { coins: 5_000_000n }), ...grantedUtxos()]);
    const found = await findAccountUtxos(provider, { wallet: owner, owner: OWNER_PAYMENT_KEY, script });
    expect(found.control.input).toEqual(CONTROL_INPUT);
    expect(found.state).toEqual(grantedState);
    expect(found.grants.map(({ grant }) => grant)).toEqual(fixtureGrants);
    expect(found.reserves.map((reserve) => reserve.input)).toEqual([reserveInput(0)]);
    expect(found.funds.map((fund) => fund.input)).toEqual([fundInput(0)]);
  });

  it('demands exactly one control UTxO', async () => {
    const { provider, owner } = scenario(undefined, []);
    const params = { wallet: owner, owner: OWNER_PAYMENT_KEY, script };
    await expect(findAccountUtxos(provider, params)).rejects.toThrow(/exactly one control UTxO/);
    provider.addUtxo(controlUtxo(initialState, 0));
    provider.addUtxo(controlUtxo(initialState, 1));
    await expect(findAccountUtxos(provider, params)).rejects.toThrow(/at most one control UTxO/);
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

  it('draws reserves only after the funds, whatever they hold', () => {
    const reserves = [reserveUtxo(0, { coins: 50_000_000n })];
    expect(selectFundUtxos(funds, { '': 10_000_000n }, 2_000_000n, reserves).selected.map((utxo) => utxo.input)).toEqual([fundInput(1)]);
    expect(selectFundUtxos(funds, { '': 20_000_000n }, 2_000_000n, reserves).selected.map((utxo) => utxo.input)).toEqual([
      fundInput(1),
      fundInput(0),
      fundInput(2),
      reserveInput(0),
    ]);
  });
});

describe('spendWithDevice', () => {
  it('pays the outputs and the fee from the account, recreates the state and returns the change to the account', async () => {
    const { provider, owner } = scenario(initialState, [fundUtxo(0, { coins: 10_000_000n }), fundUtxo(1, { coins: 4_000_000n })]);
    const payout = { address: recipientAddress, value: { coins: 5_000_000n } };
    const tx = await spendWithDevice({ wallet: owner, provider, owner: OWNER_PAYMENT_KEY, outputs: [payout], script });
    expect(redeemerOf(tx, CONTROL_INPUT)).toBe(DEVICE_REDEEMER);
    expect(redeemerOf(tx, fundInput(0))).toBe(FUND_REDEEMER);
    expect(spendsInput(tx, fundInput(1))).toBe(false);
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
    expect(inspected.body.reference_inputs).toBeUndefined();
    expect(inspected.body.ttl).toBeUndefined();
    expect(JSON.stringify(inspected.body.collateral)).toContain(OWNER_UTXO_TX);
    expect(provider.phaseTwoFailures).toEqual([]);
    expectScriptAttached(tx);
  });

  it('lets a sponsor pay the fee and take the change while the funds cover the outputs alone', async () => {
    const { provider, owner, sponsor } = scenario(initialState, [fundUtxo(0, { coins: 10_000_000n }), fundUtxo(1, { coins: 4_000_000n })]);
    const payout = { address: recipientAddress, value: { coins: 5_000_000n } };
    const tx = await spendWithDevice({ wallet: owner, sponsor, provider, owner: OWNER_PAYMENT_KEY, outputs: [payout], script });
    expect(redeemerOf(tx, CONTROL_INPUT)).toBe(DEVICE_REDEEMER);
    expect(redeemerOf(tx, fundInput(0))).toBe(FUND_REDEEMER);
    expect(spendsInput(tx, fundInput(1))).toBe(false);
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
    expect(spendsInput(tx, fundInput(0))).toBe(true);
    expect(spendsInput(tx, fundInput(1))).toBe(true);
    const fee = transactionBodyParts(tx).fee;
    expect(accountChangeOf(tx)).toEqual([{ coins: 5_000_000n - 1_000_000n - fee }]);
    expect(5_000_000n - 1_000_000n - fee).toBeGreaterThanOrEqual(minimumUtxoLovelace({ address, value: { coins: 0n } }, ADA_PER_UTXO_BYTE));
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
    expect(spendsInput(tx, fundInput(1))).toBe(true);
    expect(accountChangeOf(tx)).toEqual([{ coins: 3_000_000n, assets: { [TOKEN_ASSET_ID]: 15n } }]);
    const tokenFloor = minimumUtxoLovelace({ address, value: { coins: 0n, assets: { [TOKEN_ASSET_ID]: 15n } } }, ADA_PER_UTXO_BYTE);
    expect(tokenFloor).toBeGreaterThan(1_000_000n);
    expect(tokenFloor).toBeGreaterThan(minimumUtxoLovelace({ address, value: { coins: 0n } }, ADA_PER_UTXO_BYTE));
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
    expect(1_100_000n).toBeGreaterThanOrEqual(minimumUtxoLovelace({ address, value: { coins: 0n } }, ADA_PER_UTXO_BYTE));
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
    expect(spendsInput(tx, fundInput(1))).toBe(true);
    expect(accountChangeOf(tx)).toEqual([{ coins: 4_000_000n }]);
  });

  it('bounds the transaction at the given slot', async () => {
    const { provider, owner } = scenario(initialState, [fundUtxo(0, { coins: 10_000_000n })]);
    const tx = await spendWithDevice({ wallet: owner, provider, owner: OWNER_PAYMENT_KEY, outputs: [], validUntilSlot: VALID_UNTIL_SLOT, script });
    expect(inspect(tx).body.ttl).toBe(VALID_UNTIL_SLOT.toString());
    expect(transactionBodyParts(tx).validityRange.upperBound).toEqual({ bound: { kind: 'finite', time: slotToPosixTime(VALID_UNTIL_SLOT) }, inclusive: false });
  });
});

describe('reserves', () => {
  it('draws the fee from a reserve and recreates it with the fee taken out, leaving the funds for the outputs', async () => {
    const { provider, owner } = scenario(initialState, [fundUtxo(0, { coins: 10_000_000n }), reserveUtxo(0, { coins: 5_000_000n })]);
    const payout = { address: recipientAddress, value: { coins: 5_000_000n } };
    const tx = await spendWithDevice({ wallet: owner, provider, owner: OWNER_PAYMENT_KEY, outputs: [payout], script });
    expectAccountInputs(tx, [fundInput(0), reserveInput(0)]);
    expect(redeemerOf(tx, reserveInput(0))).toBe(FUND_REDEEMER);
    const fee = transactionBodyParts(tx).fee;
    const reserves = reserveOutputsOf(tx);
    expect(reserves).toHaveLength(1);
    expect(reserves[0]!.value).toEqual({ coins: 5_000_000n - fee });
    expect(Cometa.plutusDataToCbor(withoutCborCache(reserves[0]!.datum!))).toBe(RESERVE_DATUM);
    expect(accountChangeOf(tx)).toEqual([{ coins: 5_000_000n }]);
    expect(outputsAt(tx, recipientAddress).map((output) => output.value)).toEqual([payout.value]);
    expect(provider.phaseTwoFailures).toEqual([]);
  });

  it('lets an owner operation with no outputs touch nothing but the control UTxO and the reserve', async () => {
    const { provider, owner } = scenario(grantedState, [fundUtxo(0, { coins: 10_000_000n }), reserveUtxo(0, { coins: 5_000_000n }), ...grantedUtxos()]);
    const tx = await revokeGrant({ wallet: owner, provider, owner: OWNER_PAYMENT_KEY, slot: 0n, script });
    expectAccountInputs(tx, [reserveInput(0)]);
    expect(outputsAt(tx, address)).toHaveLength(2);
    expect(accountChangeOf(tx)).toEqual([]);
    const fee = transactionBodyParts(tx).fee;
    expect(reserveOutputsOf(tx)[0]!.value).toEqual({ coins: 5_000_000n - fee });
    expect(stateOf(tx)).toEqual(stateWithRevokedSlot(grantedState, 0n));
  });

  it('keeps the reserve whole and carries its datum when the collateral wallet backs the operation', async () => {
    const { provider, owner, sponsor } = scenario(initialState, [reserveUtxo(0, { coins: 5_000_000n, assets: { [TOKEN_ASSET_ID]: 2n } })]);
    const tx = await addDevice({ wallet: owner, collateral: sponsor, provider, owner: OWNER_PAYMENT_KEY, device: OTHER_DEVICE_KEY, script });
    expectAccountInputs(tx, [reserveInput(0)]);
    const fee = transactionBodyParts(tx).fee;
    expect(reserveOutputsOf(tx)[0]!.value).toEqual({ coins: 5_000_000n - fee, assets: { [TOKEN_ASSET_ID]: 2n } });
    expect(inspect(tx).body.collateral).toEqual([{ transaction_id: SPONSOR_UTXO_TX, index: 0 }]);
    expect(stateOf(tx)).toEqual(stateWithDevice(initialState, OTHER_DEVICE_KEY));
  });

  it('leaves a reserve that cannot pay the most a transaction can cost and pays from the funds instead', async () => {
    const { provider, owner } = scenario(initialState, [fundUtxo(0, { coins: 10_000_000n }), reserveUtxo(0, { coins: 2_000_000n })]);
    const tx = await spendWithDevice({ wallet: owner, provider, owner: OWNER_PAYMENT_KEY, outputs: [], script });
    expectAccountInputs(tx, [fundInput(0)]);
    expect(reserveOutputsOf(tx)).toHaveLength(0);
    expect(accountChangeOf(tx)).toEqual([{ coins: 10_000_000n - transactionBodyParts(tx).fee }]);
  });

  it('picks the largest reserve for the fee and draws the others only for what the funds cannot cover', async () => {
    const reserves = [reserveUtxo(0, { coins: 5_000_000n }), reserveUtxo(1, { coins: 8_000_000n })];
    const { provider, owner } = scenario(initialState, [fundUtxo(0, { coins: 3_000_000n }), ...reserves]);
    const small = await spendWithDevice({ wallet: owner, provider, owner: OWNER_PAYMENT_KEY, outputs: [{ address: recipientAddress, value: { coins: 2_000_000n } }], script });
    expectAccountInputs(small, [fundInput(0), reserveInput(1)]);
    expect(reserveOutputsOf(small)[0]!.value.coins).toBe(8_000_000n - transactionBodyParts(small).fee);
    const large = await spendWithDevice({ wallet: owner, provider, owner: OWNER_PAYMENT_KEY, outputs: [{ address: recipientAddress, value: { coins: 6_000_000n } }], script });
    expectAccountInputs(large, [fundInput(0), reserveInput(0), reserveInput(1)]);
    expect(reserveOutputsOf(large)).toHaveLength(1);
    expect(accountChangeOf(large)).toEqual([{ coins: 2_000_000n }]);
  });

  it('never spends a UTxO carrying only a datum hash, neither for the fee nor for the outputs', async () => {
    const parked = datumHashUtxo(5, { coins: 10_000_000n });
    const { provider, owner, sponsor } = scenario(initialState, [fundUtxo(0, { coins: 10_000_000n }), parked]);
    const found = await findAccountUtxos(provider, { wallet: owner, owner: OWNER_PAYMENT_KEY, script });
    expect(found.reserves.map((reserve) => reserve.input)).toEqual([reserveInput(5)]);
    const tx = await spendWithDevice({ wallet: owner, provider, owner: OWNER_PAYMENT_KEY, outputs: [{ address: recipientAddress, value: { coins: 1_000_000n } }], script });
    expectAccountInputs(tx, [fundInput(0)]);
    expect(reserveOutputsOf(tx)).toHaveLength(0);
    expect(accountChangeOf(tx)).toEqual([{ coins: 10_000_000n - 1_000_000n - transactionBodyParts(tx).fee }]);
    const beyondTheFund = [{ address: recipientAddress, value: { coins: 9_000_000n } }];
    await expect(spendWithDevice({ wallet: owner, provider, owner: OWNER_PAYMENT_KEY, outputs: beyondTheFund, script })).rejects.toThrow(/not hold enough funds/);
    await expect(spendWithDevice({ wallet: owner, sponsor, provider, owner: OWNER_PAYMENT_KEY, outputs: [{ address: recipientAddress, value: { coins: 12_000_000n } }], script })).rejects.toThrow(
      /not hold enough funds/,
    );
    const inline = scenario(initialState, [fundUtxo(0, { coins: 10_000_000n }), parked, reserveUtxo(0, { coins: 5_000_000n })]);
    const fromReserve = await spendWithDevice({ wallet: inline.owner, provider: inline.provider, owner: OWNER_PAYMENT_KEY, outputs: [], script });
    expectAccountInputs(fromReserve, [reserveInput(0)]);
  });

  it('spends reserves for the outputs when a sponsor pays and the funds run short', async () => {
    const { provider, owner, sponsor } = scenario(initialState, [fundUtxo(0, { coins: 3_000_000n }), reserveUtxo(0, { coins: 5_000_000n })]);
    const tx = await spendWithDevice({ wallet: owner, sponsor, provider, owner: OWNER_PAYMENT_KEY, outputs: [{ address: recipientAddress, value: { coins: 8_000_000n } }], script });
    expectAccountInputs(tx, [fundInput(0), reserveInput(0)]);
    expect(outputsAt(tx, address)).toHaveLength(1);
    expect(reserveOutputsOf(tx)).toHaveLength(0);
  });
});

describe('state rewrites', () => {
  it('rewriteState carries the given state, paying from a fund UTxO or from the sponsor', async () => {
    const newState = { ...grantedState, grantGeneration: 7n };
    const { sponsor, ...paid } = ownerParams();
    const tx = await rewriteState({ ...paid, newState });
    expect(stateOf(tx)).toEqual(newState);
    expect(spendsInput(tx, fundInput(0))).toBe(true);
    expect(accountChangeOf(tx)).toEqual([{ coins: 10_000_000n - transactionBodyParts(tx).fee }]);
    const sponsored = await rewriteState({ ...paid, sponsor, newState });
    expect(stateOf(sponsored)).toEqual(newState);
    expect(spendsInput(sponsored, fundInput(0))).toBe(false);
    expect(outputsAt(sponsored, address)).toHaveLength(1);
  });

  it('refuses a rewrite whose counters do not follow the mint or whose generation goes back', async () => {
    await expect(rewriteState({ ...ownerParams(), newState: { ...grantedState, nextSlot: 4n } })).rejects.toThrow(/next slot must move by the 0 grants issued/);
    await expect(rewriteState({ ...ownerParams(), newState: { ...grantedState, outstanding: 2n } })).rejects.toThrow(/outstanding count must move by the 0 grants issued and the 0 swept/);
    await expect(rewriteState({ ...ownerParams({ ...grantedState, grantGeneration: 2n }), newState: grantedState })).rejects.toThrow(/cannot decrease/);
    await expect(rewriteState({ ...ownerParams(), newState: { ...grantedState, devices: [] } })).rejects.toThrow(/at least one device/);
  });

  it('addDevice and removeDevice edit the devices', async () => {
    expect(stateOf(await addDevice({ ...ownerParams(), device: OTHER_DEVICE_KEY }))).toEqual(stateWithDevice(grantedState, OTHER_DEVICE_KEY));
    await expect(addDevice({ ...ownerParams(), device: OWNER_PAYMENT_KEY })).rejects.toThrow(/distinct/);
    await expect(removeDevice({ ...ownerParams(), device: OWNER_PAYMENT_KEY })).rejects.toThrow(/at least one device/);
    const { provider, owner } = scenario(stateWithDevice(grantedState, OTHER_DEVICE_KEY), [fundUtxo(0, { coins: 10_000_000n })]);
    const tx = await removeDevice({ wallet: owner, provider, owner: OWNER_PAYMENT_KEY, device: OTHER_DEVICE_KEY, script });
    expect(stateOf(tx)).toEqual(stateWithoutDevice(stateWithDevice(grantedState, OTHER_DEVICE_KEY), OTHER_DEVICE_KEY));
  });

  it('raises the control lovelace with the state, paid from the account or by the sponsor', async () => {
    let state = initialState;
    let previous = 0n;
    for (let index = 1; index < 8; index += 1) {
      const device = `0${index}`.repeat(28);
      const { provider, owner, sponsor } = scenario(state, [fundUtxo(0, { coins: 10_000_000n })]);
      const tx = await addDevice({ wallet: owner, provider, owner: OWNER_PAYMENT_KEY, device, script });
      const coins = expectControlAboveMinimum(tx);
      expect(coins).toBeGreaterThanOrEqual(previous);
      expect(coins).toBeGreaterThanOrEqual(CONTROL_LOVELACE);
      expect(spendsInput(tx, { txId: OWNER_UTXO_TX, index: 0 })).toBe(false);
      expect(accountChangeOf(tx)).toEqual([{ coins: 10_000_000n - (coins - CONTROL_LOVELACE) - transactionBodyParts(tx).fee }]);
      const sponsored = await addDevice({ wallet: owner, sponsor, provider, owner: OWNER_PAYMENT_KEY, device, script });
      expect(controlOutputOf(sponsored).value.coins).toBe(coins);
      expect(spendsInput(sponsored, fundInput(0))).toBe(false);
      expect(60_000_000n - lovelaceAt(sponsored, sponsor.address.toString()) - transactionBodyParts(sponsored).fee).toBe(coins - CONTROL_LOVELACE);
      state = stateWithDevice(state, device);
      previous = coins;
    }
    expect(previous).toBeGreaterThan(CONTROL_LOVELACE);
  });
});

describe('issueGrant', () => {
  const requests = [
    { grantee: AGENT_PAYMENT_KEY, scope: lovelaceScope() },
    { grantee: OTHER_DEVICE_KEY, scope: tokenScope([recipientAddress]) },
  ];

  it('mints the tokens of the next slots in order into grant UTxOs at their minimum lovelace paid by the account, and moves the counters', async () => {
    const { sponsor, ...params } = ownerParams();
    const tx = await issueGrant({ ...params, grants: requests });
    expect(mintOf(tx)).toEqual({ mint: { [grantAssetIdOf(3n)]: 1n, [grantAssetIdOf(4n)]: 1n }, redeemer: ISSUE_GRANTS_REDEEMER });
    expect(redeemerOf(tx, CONTROL_INPUT)).toBe(DEVICE_REDEEMER);
    expect(stateOf(tx)).toEqual(stateAfterIssue(grantedState, 2));
    let locked = 0n;
    for (const [index, request] of requests.entries()) {
      const slot = 3n + BigInt(index);
      const output = grantOutputOf(tx, slot);
      expect(output.address).toBe(address);
      expect(output.value.assets).toEqual({ [grantAssetIdOf(slot)]: 1n });
      expect(output.value.coins).toBe(minimumUtxoLovelace(output, ADA_PER_UTXO_BYTE));
      expect(output.scriptReference).toBeUndefined();
      expect(grantOf(tx, slot)).toEqual({ slot, grantee: request.grantee, generation: 0n, scope: request.scope });
      locked += output.value.coins;
    }
    expect(accountChangeOf(tx)).toEqual([{ coins: 10_000_000n - locked - transactionBodyParts(tx).fee }]);
    expect(inspect(tx).body.required_signers).toEqual([OWNER_PAYMENT_KEY]);
    expect(params.provider.phaseTwoFailures).toEqual([]);
    expectScriptAttached(tx);
    void sponsor;
  });

  it('lets a sponsor pay the fee while the account pays the grant lovelace', async () => {
    const { provider, owner, sponsor } = scenario(grantedState, [fundUtxo(0, { coins: 10_000_000n })]);
    const tx = await issueGrant({ wallet: owner, sponsor, provider, owner: OWNER_PAYMENT_KEY, grants: [requests[0]!], script });
    const locked = grantOutputOf(tx, 3n).value.coins;
    expect(accountChangeOf(tx)).toEqual([{ coins: 10_000_000n - locked }]);
    expect(60_000_000n - lovelaceAt(tx, sponsor.address.toString())).toBe(transactionBodyParts(tx).fee);
    expect(stateOf(tx)).toEqual(stateAfterIssue(grantedState, 1));
  });

  it("issues under the account's current generation and after its revoked slots", async () => {
    const state = { ...grantedState, grantGeneration: 3n, revoked: [1n] };
    const { sponsor, ...params } = ownerParams(state);
    const tx = await issueGrant({ ...params, grants: [requests[0]!] });
    expect(grantOf(tx, 3n).generation).toBe(3n);
    expect(stateOf(tx)).toEqual({ ...state, nextSlot: 4n, outstanding: 4n });
    void sponsor;
  });

  it('issues eight grants in one transaction and refuses more, none, too many outstanding or a scope with a defect', async () => {
    const eight = Array.from({ length: MAX_GRANT_BATCH }, () => requests[0]!);
    const { sponsor, ...params } = ownerParams(grantedState, [fundUtxo(0, { coins: 30_000_000n }), ...grantedUtxos()]);
    const tx = await issueGrant({ ...params, grants: eight });
    expect(Object.keys(mintOf(tx).mint)).toHaveLength(8);
    expect(stateOf(tx)).toEqual(stateAfterIssue(grantedState, 8));
    expect(grantOf(tx, 10n).slot).toBe(10n);
    await expect(issueGrant({ ...params, grants: [...eight, requests[0]!] })).rejects.toThrow(/At most 8 grants can be issued in one transaction, not 9/);
    await expect(issueGrant({ ...params, grants: [] })).rejects.toThrow(/At least one grant/);
    await expect(issueGrant({ ...ownerParams({ ...grantedState, outstanding: 15n }), grants: requests })).rejects.toThrow(/at most 16 outstanding/);
    await expect(issueGrant({ ...params, grants: [{ ...requests[0]!, scope: { ...lovelaceScope(), cap: -1n } }] })).rejects.toThrow(/caps must not be negative/);
    void sponsor;
  });

  it('needs funds for the grant lovelace even with a sponsor', async () => {
    const { provider, owner, sponsor } = scenario(grantedState, []);
    await expect(issueGrant({ wallet: owner, sponsor, provider, owner: OWNER_PAYMENT_KEY, grants: [requests[0]!], script })).rejects.toThrow(/not hold enough funds/);
  });
});

describe('revokeGrant', () => {
  it('appends the slot to the revoked list and mints nothing', async () => {
    const { sponsor, ...params } = ownerParams();
    const tx = await revokeGrant({ ...params, slot: 1n });
    expect(stateOf(tx)).toEqual(stateWithRevokedSlot(grantedState, 1n));
    expect(mintOf(tx)).toEqual({ mint: {}, redeemer: undefined });
    expect(spendsInput(tx, grantInput(1n))).toBe(false);
    expect(params.provider.phaseTwoFailures).toEqual([]);
    void sponsor;
  });

  it('bumps the generation and clears the list once the revoked list is full', async () => {
    const { sponsor, ...params } = ownerParams(FULL_REVOKED_STATE);
    const tx = await revokeGrant({ ...params, slot: 0n });
    expect(stateOf(tx)).toEqual({ ...FULL_REVOKED_STATE, grantGeneration: 1n, revoked: [] });
    expect(stateOf(tx).outstanding).toBe(FULL_REVOKED_STATE.outstanding);
    void sponsor;
  });

  it('refuses a slot not issued or revoked already', async () => {
    await expect(revokeGrant({ ...ownerParams(), slot: 3n })).rejects.toThrow(/not issued slot 3/);
    await expect(revokeGrant({ ...ownerParams(stateWithRevokedSlot(grantedState, 1n)), slot: 1n })).rejects.toThrow(/revoked already/);
  });

  it('revokeAllGrants bumps the generation and clears the revoked list', async () => {
    const tx = await revokeAllGrants(ownerParams(stateWithRevokedSlot(grantedState, 2n)));
    expect(stateOf(tx)).toEqual(stateWithNextGeneration(grantedState));
    expect(mintOf(tx).mint).toEqual({});
  });

  it('survivingGrantRequests lists the grants to issue again after a bump, other than the revoked slot, the dead and the expired', async () => {
    const { provider, owner } = scenario(stateWithRevokedSlot(grantedState, 2n), grantedUtxos());
    const { grants, state } = await findAccountUtxos(provider, { wallet: owner, owner: OWNER_PAYMENT_KEY, script });
    expect(survivingGrantRequests(grants, state, 1n, EXPIRY - 1n)).toEqual([{ grantee: AGENT_PAYMENT_KEY, scope: lovelaceScope() }]);
    expect(survivingGrantRequests(grants, state, 0n, EXPIRY - 1n)).toEqual([{ grantee: AGENT_PAYMENT_KEY, scope: tokenScope([recipientAddress]) }]);
    expect(survivingGrantRequests(grants, state, 0n, EXPIRY)).toEqual([]);
    expect(survivingGrantRequests(grants, stateWithNextGeneration(state), 0n, EXPIRY - 1n)).toEqual([]);
  });
});

describe('sweepGrant', () => {
  it('spends a revoked grant UTxO with the sweep redeemer, burns its token, frees its lovelace and lowers the outstanding count', async () => {
    const state = stateWithRevokedSlot(grantedState, 1n);
    const { sponsor, ...params } = ownerParams(state);
    const tx = await sweepGrant({ ...params, slots: [1n] });
    expectAccountInputs(tx, [fundInput(0), grantInput(1n)]);
    expect(redeemerOf(tx, grantInput(1n))).toBe(SWEEP_GRANT_REDEEMER);
    expect(redeemerOf(tx, CONTROL_INPUT)).toBe(DEVICE_REDEEMER);
    expect(mintOf(tx)).toEqual({ mint: { [grantAssetIdOf(1n)]: -1n }, redeemer: BURN_GRANTS_REDEEMER });
    expect(stateOf(tx)).toEqual(stateAfterSweep(state, 1));
    expect(accountChangeOf(tx)).toEqual([{ coins: 10_000_000n + GRANT_LOVELACE - transactionBodyParts(tx).fee }]);
    expect(transactionBodyParts(tx).outputs.filter((output) => output.value.assets?.[grantAssetIdOf(1n)] !== undefined)).toHaveLength(0);
    expect(inspect(tx).body.validity_start_interval).toBeUndefined();
    expect(params.provider.phaseTwoFailures).toEqual([]);
    expectScriptAttached(tx);
    void sponsor;
  });

  it('sweeps the grants of an older generation in one batch', async () => {
    const state = stateWithNextGeneration(grantedState);
    const { sponsor, ...params } = ownerParams(state);
    const tx = await sweepGrant({ ...params, slots: [0n, 1n, 2n] });
    expectAccountInputs(tx, [fundInput(0), grantInput(0n), grantInput(1n), grantInput(2n)]);
    expect(mintOf(tx).mint).toEqual({ [grantAssetIdOf(0n)]: -1n, [grantAssetIdOf(1n)]: -1n, [grantAssetIdOf(2n)]: -1n });
    expect(stateOf(tx)).toEqual({ ...state, outstanding: 0n });
    expect(accountChangeOf(tx)).toEqual([{ coins: 10_000_000n + 3n * GRANT_LOVELACE - transactionBodyParts(tx).fee }]);
    void sponsor;
  });

  it('sweeps an expired grant with a validity range starting after its expiry', async () => {
    const validFromSlot = posixTimeToSlot(EXPIRY) + 1n;
    const { sponsor, ...params } = ownerParams();
    await expect(sweepGrant({ ...params, slots: [0n] })).rejects.toThrow(/is live.*needs validFromSlot past its expiry/);
    await expect(sweepGrant({ ...params, slots: [0n], validFromSlot: posixTimeToSlot(EXPIRY) - 1n })).rejects.toThrow(/validity range starts before it expires/);
    const tx = await sweepGrant({ ...params, slots: [0n], validFromSlot });
    expect(inspect(tx).body.validity_start_interval).toBe(validFromSlot.toString());
    expect(transactionBodyParts(tx).validityRange.lowerBound).toEqual({ bound: { kind: 'finite', time: slotToPosixTime(validFromSlot) }, inclusive: true });
    expect(stateOf(tx)).toEqual(stateAfterSweep(grantedState, 1));
    expect(params.provider.phaseTwoFailures).toEqual([]);
    void sponsor;
  });

  it('refuses an unknown slot and batches beyond the limit', async () => {
    const { sponsor, ...params } = ownerParams(stateWithNextGeneration(grantedState));
    await expect(sweepGrant({ ...params, slots: [7n] })).rejects.toThrow(/no grant UTxO in slot 7/);
    await expect(sweepGrant({ ...params, slots: [] })).rejects.toThrow(/At least one grant must be swept/);
    await expect(sweepGrant({ ...params, slots: Array.from({ length: MAX_GRANT_BATCH + 1 }, (_, index) => BigInt(index)) })).rejects.toThrow(/At most 8 grants can be swept/);
    void sponsor;
  });

  it('returns the freed lovelace to the account as a plain deposit when a sponsor pays', async () => {
    const { provider, owner, sponsor } = scenario(stateWithRevokedSlot(grantedState, 0n), grantedUtxos());
    const tx = await sweepGrant({ wallet: owner, sponsor, provider, owner: OWNER_PAYMENT_KEY, slots: [0n], script });
    expectAccountInputs(tx, [grantInput(0n)]);
    expect(accountChangeOf(tx)).toEqual([{ coins: GRANT_LOVELACE }]);
    expect(60_000_000n - lovelaceAt(tx, sponsor.address.toString())).toBe(transactionBodyParts(tx).fee);
  });

  it('sweeps eight dead grants in one transaction', async () => {
    const grants = Array.from({ length: MAX_GRANT_BATCH }, (_, index): Grant => ({ ...fixtureGrants[0]!, slot: BigInt(index) }));
    const state = { ...stateWithNextGeneration(initialState), nextSlot: 8n, outstanding: 8n };
    const { sponsor, ...params } = ownerParams(state, [fundUtxo(0, { coins: 10_000_000n }), ...grants.map((grant) => grantUtxo(grant))]);
    const tx = await sweepGrant({ ...params, slots: grants.map((grant) => grant.slot) });
    expect(Object.values(mintOf(tx).mint)).toEqual(Array<bigint>(8).fill(-1n));
    expect(stateOf(tx).outstanding).toBe(0n);
    void sponsor;
  });
});

describe('stake operations', () => {
  /** A fresh scenario funded account with a sponsor available, ready for a stake operation builder. */
  const params = () => ownerParams(initialState, [fundUtxo(0, { coins: 10_000_000n })]);

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
    expect(redeemerOf(tx, fundInput(0))).toBe(FUND_REDEEMER);
    expect(spendsInput(tx, { txId: OWNER_UTXO_TX, index: 0 })).toBe(false);
    expect(accountChangeOf(tx)).toEqual([{ coins: 10_000_000n - transactionBodyParts(tx).fee }]);
    void sponsor;
  });

  it('withdrawRewards takes the whole reward balance from the provider when no amount is given, with a sponsor paying', async () => {
    const { sponsor, ...owner } = params();
    const tx = await withdrawRewards({ ...owner, sponsor });
    expectDeviceStakeOperation(tx, OWNER_PAYMENT_KEY);
    expect(inspect(tx).body.withdrawals).toEqual([{ key: ownerRewardAddress, value: '0' }]);
    expect(spendsInput(tx, fundInput(0))).toBe(false);
    expect(spendsInput(tx, { txId: SPONSOR_UTXO_TX, index: 0 })).toBe(true);
    expect(outputsAt(tx, address)).toHaveLength(1);
  });

  it('delegateStake publishes a delegation certificate for the stake credential', async () => {
    const { sponsor, ...owner } = params();
    const tx = await delegateStake({ ...owner, poolId: POOL_ID });
    expectDeviceStakeOperation(tx, OWNER_PAYMENT_KEY);
    expect(certificatesOf(tx)).toEqual([{ tag: 'stake_delegation', credential: { tag: 'script_hash', value: ownerStakeScriptHash }, pool_keyhash: POOL_ID }]);
    expect(inspect(tx).body.withdrawals).toBeUndefined();
    expect(redeemerOf(tx, fundInput(0))).toBe(FUND_REDEEMER);
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

describe('collateral wallet', () => {
  /** Two fresh fund UTxOs and the fixture grant UTxOs for a scenario under test. */
  const utxos = () => [fundUtxo(0, { coins: 10_000_000n }), fundUtxo(1, { coins: 4_000_000n }), ...grantedUtxos()];
  const request = { grantee: AGENT_PAYMENT_KEY, scope: lovelaceScope([recipientAddress]) };
  const payout = { address: recipientAddress, value: { coins: 3_000_000n } };

  /** Every builder that takes a collateral wallet, with the state it starts from, the wallet that signs and the lovelace the operation locks away from or frees to the account beyond the outputs. */
  const builders: { name: string; state: typeof grantedState; signer: 'owner' | 'agent'; paid: bigint; locked: (tx: string) => bigint; build: (params: ReturnType<typeof paramsOf>) => Promise<string> }[] = [
    { name: 'spendWithDevice', state: grantedState, signer: 'owner', paid: 3_000_000n, locked: () => 0n, build: (params) => spendWithDevice({ ...params, outputs: [payout] }) },
    { name: 'rewriteState', state: grantedState, signer: 'owner', paid: 0n, locked: () => 0n, build: (params) => rewriteState({ ...params, newState: { ...grantedState, grantGeneration: 7n } }) },
    { name: 'addDevice', state: grantedState, signer: 'owner', paid: 0n, locked: () => 0n, build: (params) => addDevice({ ...params, device: OTHER_DEVICE_KEY }) },
    { name: 'removeDevice', state: stateWithDevice(grantedState, OTHER_DEVICE_KEY), signer: 'owner', paid: 0n, locked: () => 0n, build: (params) => removeDevice({ ...params, device: OTHER_DEVICE_KEY }) },
    { name: 'issueGrant', state: grantedState, signer: 'owner', paid: 0n, locked: (tx) => grantOutputOf(tx, 3n).value.coins, build: (params) => issueGrant({ ...params, grants: [request] }) },
    { name: 'revokeGrant', state: grantedState, signer: 'owner', paid: 0n, locked: () => 0n, build: (params) => revokeGrant({ ...params, slot: 0n }) },
    { name: 'revokeAllGrants', state: grantedState, signer: 'owner', paid: 0n, locked: () => 0n, build: (params) => revokeAllGrants(params) },
    { name: 'sweepGrant', state: stateWithRevokedSlot(grantedState, 0n), signer: 'owner', paid: 0n, locked: () => -GRANT_LOVELACE, build: (params) => sweepGrant({ ...params, slots: [0n] }) },
    { name: 'withdrawRewards', state: grantedState, signer: 'owner', paid: 0n, locked: () => 0n, build: (params) => withdrawRewards({ ...params, amount: 0n }) },
    { name: 'delegateStake', state: grantedState, signer: 'owner', paid: 0n, locked: () => 0n, build: (params) => delegateStake({ ...params, poolId: POOL_ID }) },
    {
      name: 'spendWithGrant',
      state: grantedState,
      signer: 'agent',
      paid: 3_000_000n,
      locked: () => 0n,
      build: (params) => spendWithGrant({ ...params, slot: 0n, outputs: [payout], grantee: AGENT_PAYMENT_KEY, validUntilSlot: VALID_UNTIL_SLOT }),
    },
  ];

  /** The parameters of a builder over a fresh scenario: the signing wallet, the sponsor wallet as the collateral wallet and the account by its owner. */
  const paramsOf = (state: typeof grantedState, signer: 'owner' | 'agent') => {
    const scene = scenario(state, utxos());
    return { wallet: scene[signer], collateral: scene.sponsor, provider: scene.provider, owner: OWNER_PAYMENT_KEY, script, scene };
  };

  it.each(builders)('$name spends no UTxO of the collateral wallet, declares its collateral and return, and pays the fee from the account', async ({ state, signer, paid, locked, build }) => {
    const params = paramsOf(state, signer);
    const { sponsor, owner, agent } = params.scene;
    const tx = await build(params);
    const inspected = inspect(tx);
    expect(inspected.body.inputs.map((input) => input.transaction_id)).not.toContain(SPONSOR_UTXO_TX);
    expect(inspected.body.inputs.map((input) => input.transaction_id)).not.toContain(OWNER_UTXO_TX);
    expect(inspected.body.inputs.map((input) => input.transaction_id)).not.toContain(AGENT_UTXO_TX);
    expect(inspected.body.inputs.map((input) => input.transaction_id)).toContain(FUND_UTXO_TX);
    expect(inspected.body.collateral).toEqual([{ transaction_id: SPONSOR_UTXO_TX, index: 0 }]);
    expect(inspected.body.collateral_return?.address).toBe(sponsor.address.toString());
    expect(BigInt(inspected.body.collateral_return?.amount.coin ?? 0) + BigInt(inspected.body.total_collateral ?? 0)).toBe(60_000_000n);
    for (const wallet of [sponsor, owner, agent]) {
      expect(outputsAt(tx, wallet.address.toString())).toHaveLength(0);
    }
    const fee = transactionBodyParts(tx).fee;
    const control = outputsAt(tx, address).find((output) => output.value.assets?.[nftAssetId] === 1n);
    const growth = control ? control.value.coins - CONTROL_LOVELACE : 0n;
    const spent = transactionBodyParts(tx).inputs.filter((input) => input.txId === FUND_UTXO_TX).length;
    const funded = spent === 1 ? 10_000_000n : 14_000_000n;
    expect(accountChangeOf(tx)).toEqual([{ coins: funded - paid - growth - locked(tx) - fee }]);
    expect(inspected.body.required_signers).toEqual([signer === 'owner' ? OWNER_PAYMENT_KEY : AGENT_PAYMENT_KEY]);
    expect(params.scene.provider.phaseTwoFailures).toEqual([]);
  });

  it('refuses a sponsor and a collateral wallet together on the device path', async () => {
    const { provider, owner, sponsor } = scenario(grantedState, utxos());
    const params = { wallet: owner, provider, owner: OWNER_PAYMENT_KEY, script, sponsor, collateral: sponsor };
    await expect(spendWithDevice({ ...params, outputs: [payout] })).rejects.toThrow(/not both/);
  });

  it('refuses a sponsor on the grant path, which takes a collateral wallet only', async () => {
    const { provider, sponsor, agent } = scenario(grantedState, utxos());
    const params = { wallet: agent, provider, owner: OWNER_PAYMENT_KEY, script, slot: 0n, outputs: [payout], grantee: AGENT_PAYMENT_KEY, validUntilSlot: VALID_UNTIL_SLOT };
    await expect(spendWithGrant({ ...params, sponsor })).rejects.toThrow(/takes a collateral wallet only/);
    await expect(spendWithGrant({ ...params, sponsor, collateral: sponsor })).rejects.toThrow(/takes a collateral wallet only/);
  });

  it('fails when the account cannot cover the spend instead of reaching into the collateral wallet', async () => {
    const { provider, owner, agent, sponsor } = scenario(grantedState, utxos());
    const beyondTheFunds = { address: recipientAddress, value: { coins: 20_000_000n } };
    await expect(spendWithDevice({ wallet: owner, collateral: sponsor, provider, owner: OWNER_PAYMENT_KEY, outputs: [beyondTheFunds], script })).rejects.toThrow(
      /not hold enough funds/,
    );
    await expect(
      spendWithGrant({ wallet: agent, collateral: sponsor, provider, owner: OWNER_PAYMENT_KEY, slot: 0n, outputs: [beyondTheFunds], grantee: AGENT_PAYMENT_KEY, validUntilSlot: VALID_UNTIL_SLOT, unchecked: true, script }),
    ).rejects.toThrow(/not hold enough funds/);
  });

  it('leaves the collateral to the signing wallet without one', async () => {
    const { provider, owner, agent } = scenario(grantedState, utxos());
    const ownerTx = await spendWithDevice({ wallet: owner, provider, owner: OWNER_PAYMENT_KEY, outputs: [payout], script });
    expect(inspect(ownerTx).body.collateral).toEqual([{ transaction_id: OWNER_UTXO_TX, index: 0 }]);
    expect(inspect(ownerTx).body.collateral_return?.address).toBe(owner.address.toString());
    const agentTx = await spendWithGrant({ wallet: agent, provider, owner: OWNER_PAYMENT_KEY, slot: 0n, outputs: [payout], grantee: AGENT_PAYMENT_KEY, validUntilSlot: VALID_UNTIL_SLOT, script });
    expect(inspect(agentTx).body.collateral).toEqual([{ transaction_id: AGENT_UTXO_TX, index: 0 }]);
    expect(inspect(agentTx).body.collateral_return?.address).toBe(agent.address.toString());
  });
});

describe('spendWithGrant', () => {
  it('lets a grantee spend lovelace, referencing the control UTxO and paying the fee from the account', async () => {
    const params = agentParams();
    const payout = { address: recipientAddress, value: { coins: 3_000_000n } };
    const tx = await spendWithGrant({ ...params, slot: 0n, outputs: [payout] });
    const parts = transactionBodyParts(tx);
    expect(parts.referenceInputs).toEqual([CONTROL_INPUT]);
    expect(spendsInput(tx, CONTROL_INPUT)).toBe(false);
    expect(redeemerOf(tx, grantInput(0n))).toBe(SPEND_WITH_GRANT_REDEEMER);
    expect(redeemerOf(tx, fundInput(0))).toBe(FUND_REDEEMER);
    expect(spendsInput(tx, fundInput(1))).toBe(false);
    expect(spendsInput(tx, { txId: AGENT_UTXO_TX, index: 0 })).toBe(false);
    const inspected = inspect(tx);
    expect(inspected.body.required_signers).toEqual([AGENT_PAYMENT_KEY]);
    expect(inspected.body.ttl).toBe(VALID_UNTIL_SLOT.toString());
    expect(inspected.body.collateral?.length).toBeGreaterThan(0);
    expect(inspected.body.mint).toBeUndefined();
    expect(parts.validityRange.upperBound).toEqual({ bound: { kind: 'finite', time: slotToPosixTime(VALID_UNTIL_SLOT) }, inclusive: false });
    expect(outputsAt(tx, recipientAddress).map((output) => output.value)).toEqual([payout.value]);
    expect(outputsAt(tx, params.wallet.address.toString())).toHaveLength(0);
    expect(outputsAt(tx, address).filter((output) => output.value.assets?.[nftAssetId] !== undefined)).toHaveLength(0);
    const grantOutput = grantOutputOf(tx, 0n);
    expect(grantOutput.address).toBe(address);
    expect(grantOutput.value).toEqual({ coins: GRANT_LOVELACE, assets: { [grantAssetIdOf(0n)]: 1n } });
    expect(grantOutput.scriptReference).toBeUndefined();
    const bounded = { '': 3_000_000n + DEFAULT_GRANT_FEE_BOUND };
    expect(grantOf(tx, 0n)).toEqual(grantAfterSpend(fixtureGrants[0]!, bounded));
    expect(grantOf(tx, 0n).scope.cap).toBe(15_000_000n - 3_000_000n - DEFAULT_GRANT_FEE_BOUND);
    expect(parts.fee).toBeLessThanOrEqual(DEFAULT_GRANT_FEE_BOUND);
    expect(accountChangeOf(tx)).toEqual([{ coins: 10_000_000n - 3_000_000n - parts.fee }]);
    expect(inspected.witness_set.redeemers?.every((redeemer) => redeemer.ex_units.mem === '1500000')).toBe(true);
    expect(params.provider.phaseTwoFailures).toEqual([]);
    expectScriptAttached(tx);
  });

  it('keeps the value of the grant UTxO as it was', async () => {
    const params = agentParams(grantedState, [fundUtxo(0, { coins: 10_000_000n }), grantUtxo(fixtureGrants[0]!, 3_500_000n)]);
    const tx = await spendWithGrant({ ...params, slot: 0n, outputs: [{ address: recipientAddress, value: { coins: 1_000_000n } }] });
    expect(grantOutputOf(tx, 0n).value).toEqual({ coins: 3_500_000n, assets: { [grantAssetIdOf(0n)]: 1n } });
    expect(accountChangeOf(tx)).toEqual([{ coins: 10_000_000n - 1_000_000n - transactionBodyParts(tx).fee }]);
  });

  it('lets a grantee spend tokens within the lovelace caps', async () => {
    const params = agentParams();
    const payout = { address: recipientAddress, value: { coins: 1_000_000n, assets: { [TOKEN_ASSET_ID]: 7n } } };
    const tx = await spendWithGrant({ ...params, slot: 1n, outputs: [payout] });
    const parts = transactionBodyParts(tx);
    expect(redeemerOf(tx, grantInput(1n))).toBe(SPEND_WITH_GRANT_REDEEMER);
    expect(redeemerOf(tx, fundInput(1))).toBe(FUND_REDEEMER);
    expect(inspect(tx).body.required_signers).toEqual([AGENT_PAYMENT_KEY]);
    const bounded = { [TOKEN_ASSET_ID]: 7n, '': 1_000_000n + DEFAULT_GRANT_FEE_BOUND };
    expect(grantOf(tx, 1n)).toEqual(grantAfterSpend(fixtureGrants[1]!, bounded));
    expect(grantOf(tx, 1n).scope.lovelaceCap).toBe(3_000_000n - 1_000_000n - DEFAULT_GRANT_FEE_BOUND);
    expect(grantOf(tx, 1n).scope.cap).toBe(43n);
    const inputsBalance = toBalance({ coins: GRANT_LOVELACE + 4_000_000n, assets: { [grantAssetIdOf(1n)]: 1n, [TOKEN_ASSET_ID]: 20n } });
    const returned = outputsAt(tx, address).map((output) => toBalance(output.value));
    expect(returned.reduce((total, balance) => total + (balance[TOKEN_ASSET_ID] ?? 0n), 0n)).toBe(inputsBalance[TOKEN_ASSET_ID]! - 7n);
    expect(parts.fee).toBeLessThanOrEqual(DEFAULT_GRANT_FEE_BOUND);
    expect(params.provider.phaseTwoFailures).toEqual([]);
  });

  it('honours a fee bound override, which the scope check and the fund selection both count', async () => {
    const params = agentParams();
    const outputs = [{ address: recipientAddress, value: { coins: 3_000_000n } }];
    const tx = await spendWithGrant({ ...params, slot: 0n, outputs, feeBound: 2_000_000n });
    expect(grantOf(tx, 0n).scope.cap).toBe(15_000_000n - 3_000_000n - 2_000_000n);
    await expect(spendWithGrant({ ...params, slot: 0n, outputs: [{ address: recipientAddress, value: { coins: 9_500_000n } }], feeBound: 500_001n })).rejects.toThrow(/per call cap/);
    const lean = agentParams(grantedState, [fundUtxo(0, { coins: 5_000_000n }), ...grantedUtxos()]);
    await expect(spendWithGrant({ ...lean, slot: 0n, outputs })).rejects.toThrow(/not hold enough funds/);
    const tx2 = await spendWithGrant({ ...lean, slot: 0n, outputs, feeBound: 900_000n });
    expect(transactionBodyParts(tx2).fee).toBeLessThanOrEqual(900_000n);
    expect(accountChangeOf(tx2)).toEqual([{ coins: 5_000_000n - 3_000_000n - transactionBodyParts(tx2).fee }]);
  });

  it('refuses a fee above the bound, which the validator refuses too since the caps were not reduced by enough', async () => {
    const outputs = [{ address: recipientAddress, value: { coins: 3_000_000n } }];
    const params = agentParams();
    const tx = await spendWithGrant({ ...params, slot: 0n, outputs, feeBound: 1n, unchecked: true });
    await expect(params.provider.evaluateTransaction(tx)).rejects.toThrow(/remaining cap 11999999 exceeds the 11[0-9]+ the spend leaves/);
    const lenient = agentParams();
    lenient.provider.evaluateTransaction = (tx) => Promise.resolve(Cometa.readRedeemersFromTx(tx).map((redeemer) => ({ ...redeemer, executionUnits: FAKE_EXECUTION_UNITS })));
    await expect(spendWithGrant({ ...lenient, slot: 0n, outputs, feeBound: 1n })).rejects.toThrow(/fee of \d+ lovelace exceeds the fee bound of 1 /);
  });

  it('refuses spends the validator would refuse', async () => {
    const params = agentParams();
    const payout = (coins: bigint) => [{ address: recipientAddress, value: { coins } }];
    await expect(spendWithGrant({ ...params, slot: 9n, outputs: payout(1n) })).rejects.toThrow(/no grant UTxO in slot 9/);
    await expect(spendWithGrant({ ...params, slot: 0n, outputs: payout(1n), grantee: OWNER_PAYMENT_KEY })).rejects.toThrow(/not the grantee/);
    await expect(spendWithGrant({ ...params, slot: 2n, outputs: [{ address: enterpriseAddress(OTHER_DEVICE_KEY), value: { coins: 1n } }] })).rejects.toThrow(/not a recipient/);
    await expect(spendWithGrant({ ...params, slot: 0n, outputs: payout(9_000_001n) })).rejects.toThrow(/per call cap/);
    await expect(spendWithGrant({ ...params, slot: 0n, outputs: payout(1n), validUntilSlot: 300_000_000n })).rejects.toThrow(/expires/);
    await expect(
      spendWithGrant({ ...params, slot: 0n, outputs: [{ address: recipientAddress, value: { coins: 1_000_000n, assets: { [TOKEN_ASSET_ID]: 1n } } }] }),
    ).rejects.toThrow(/does not cover/);
    await expect(
      spendWithGrant({ ...params, slot: 1n, outputs: [{ address: recipientAddress, value: { coins: 1_600_000n, assets: { [TOKEN_ASSET_ID]: 1n } } }] }),
    ).rejects.toThrow(/exceeds the lovelace per call cap of 2500000/);
    const revoked = agentParams(stateWithRevokedSlot(grantedState, 0n));
    await expect(spendWithGrant({ ...revoked, slot: 0n, outputs: payout(1n) })).rejects.toThrow(/dead: slot 0 is revoked/);
    const bumped = agentParams(stateWithNextGeneration(grantedState));
    await expect(spendWithGrant({ ...bumped, slot: 0n, outputs: payout(1n) })).rejects.toThrow(/dead: grant 0 was issued under generation 0 and the account is at 1/);
  });

  it('reduces the cap of a restricted recipient grant by the payout and the fee bound, as the grant output datum encodes it', async () => {
    const params = agentParams();
    const tx = await spendWithGrant({ ...params, slot: 2n, outputs: [{ address: recipientAddress, value: { coins: 2_000_000n } }] });
    expect(grantOf(tx, 2n).scope.cap).toBe(15_000_000n - 2_000_000n - DEFAULT_GRANT_FEE_BOUND);
    const expected = grantAfterSpend(fixtureGrants[2]!, { '': 2_000_000n + DEFAULT_GRANT_FEE_BOUND });
    expect(Cometa.plutusDataToCbor(withoutCborCache(grantOutputOf(tx, 2n).datum!))).toBe(Cometa.plutusDataToCbor(encodeGrant(expected)));
  });
});

describe('spendWithGrant unchecked', () => {
  const nearlyUsed = { ...fixtureGrants[0]!, scope: { ...fixtureGrants[0]!.scope, cap: 6_000_000n } };

  /** The parameters of an unchecked spend over a scenario holding the fixture grants, with the slot zero grant nearly used. */
  const params = (state = grantedState, grants = [grantUtxo(nearlyUsed), ...grantedUtxos().slice(1)]) =>
    agentParams(state, [fundUtxo(0, { coins: 10_000_000n }), fundUtxo(1, { coins: 4_000_000n }), ...grants]);

  it('builds a spend beyond the remaining cap whose datum carries a cap below zero, with fixed budgets instead of an evaluation', async () => {
    const checked = params();
    const outputs = [{ address: recipientAddress, value: { coins: 8_000_000n } }];
    await expect(spendWithGrant({ ...checked, slot: 0n, outputs })).rejects.toThrow(/exceeds the remaining cap of 6000000/);
    const unchecked = params();
    const tx = await spendWithGrant({ ...unchecked, slot: 0n, outputs, unchecked: true });
    expect(outputsAt(tx, recipientAddress).map((output) => output.value)).toEqual([{ coins: 8_000_000n }]);
    expect(grantOf(tx, 0n).scope.cap).toBe(6_000_000n - 8_000_000n - DEFAULT_GRANT_FEE_BOUND);
    const inputs = transactionBodyParts(tx).inputs;
    const units = inspect(tx).witness_set.redeemers?.map((entry) => [Number(entry.index), entry.ex_units.mem]);
    expect(units).toContainEqual([inputs.findIndex((input) => input.txId === GRANT_UTXO_TX), UNCHECKED_EXECUTION_UNITS.grant.memory.toString()]);
    expect(units).toContainEqual([inputs.findIndex((input) => input.txId === FUND_UTXO_TX), UNCHECKED_EXECUTION_UNITS.fund.memory.toString()]);
    await expect(unchecked.provider.evaluateTransaction(tx)).rejects.toThrow(/exceeds the remaining cap of 6000000/);
  });

  it('builds a spend paying an address outside the recipients', async () => {
    const stranger = enterpriseAddress(OTHER_DEVICE_KEY);
    const outputs = [{ address: stranger, value: { coins: 3_000_000n } }];
    await expect(spendWithGrant({ ...params(), slot: 2n, outputs })).rejects.toThrow(/not a recipient of grant 2/);
    const unchecked = params();
    const tx = await spendWithGrant({ ...unchecked, slot: 2n, outputs, unchecked: true });
    expect(outputsAt(tx, stranger).map((output) => output.value)).toEqual([{ coins: 3_000_000n }]);
    expect(grantOf(tx, 2n)).toEqual(grantAfterSpend(fixtureGrants[2]!, { '': 3_000_000n + DEFAULT_GRANT_FEE_BOUND }));
    await expect(unchecked.provider.evaluateTransaction(tx)).rejects.toThrow(/not a recipient of grant 2/);
  });

  it('builds a spend whose validity range ends after the grant expires', async () => {
    const outputs = [{ address: recipientAddress, value: { coins: 1_000_000n } }];
    await expect(spendWithGrant({ ...params(), slot: 0n, outputs, validUntilSlot: 300_000_000n })).rejects.toThrow(/expires/);
    const unchecked = params();
    const tx = await spendWithGrant({ ...unchecked, slot: 0n, outputs, validUntilSlot: 300_000_000n, unchecked: true });
    expect(inspect(tx).body.ttl).toBe('300000000');
    expect(slotToPosixTime(300_000_000n)).toBeGreaterThan(EXPIRY);
    await expect(unchecked.provider.evaluateTransaction(tx)).rejects.toThrow(/ends after grant 0 expires/);
  });

  it('builds a spend with a revoked grant and with a grant of an older generation', async () => {
    const outputs = [{ address: recipientAddress, value: { coins: 1_000_000n } }];
    const revoked = params(stateWithRevokedSlot(grantedState, 0n));
    const revokedTx = await spendWithGrant({ ...revoked, slot: 0n, outputs, unchecked: true });
    await expect(revoked.provider.evaluateTransaction(revokedTx)).rejects.toThrow(/not current: slot 0 is revoked/);
    const bumped = params(stateWithNextGeneration(grantedState));
    const bumpedTx = await spendWithGrant({ ...bumped, slot: 0n, outputs, unchecked: true });
    await expect(bumped.provider.evaluateTransaction(bumpedTx)).rejects.toThrow(/not current: grant 0 was issued under generation 0/);
  });

  it('still needs the grant UTxO to exist and the signer to be its grantee', async () => {
    const outputs = [{ address: recipientAddress, value: { coins: 1_000_000n } }];
    await expect(spendWithGrant({ ...params(), slot: 9n, outputs, unchecked: true })).rejects.toThrow(/no grant UTxO in slot 9/);
    await expect(spendWithGrant({ ...params(), slot: 0n, outputs, grantee: OWNER_PAYMENT_KEY, unchecked: true })).rejects.toThrow(/not the grantee/);
  });
});
