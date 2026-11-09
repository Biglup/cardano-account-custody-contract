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

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PlutusData, PlutusScript, Provider, UTxO, Wallet } from '@biglup/cometa';
import { config as loadEnv } from 'dotenv';
import { paymentKeyHashOf, rewardAddress } from '../src/address.js';
import { accountScript, accountScriptHash, loadBlueprint } from '../src/blueprint.js';
import { Cometa } from '../src/cometa.js';
import { posixTimeToSlot, transactionBodyParts } from '../src/body.js';
import { DEVNET_NETWORK, type ProviderConfiguration, loadRunEnvironment, providerConfiguration } from '../src/config.js';
import { type AccountState, type GrantPolicy, type Recipient, type Scope, bytes, constr, encodeAddress, encodeOption } from '../src/data.js';
import { type NetworkScripts, type ReferenceScriptRecord, networkFilePath } from '../src/network.js';
import { accountByOwner } from '../src/discovery.js';
import { currentLogicHash, currentLogicScript, logicScriptHash } from '../src/logic.js';
import { minimumUtxoLovelace } from '../src/output.js';
import { applyParameters } from '../src/stake-script.js';
import { LOVELACE } from '../src/state.js';
import { type AccountOutput, DEFAULT_GRANT_FEE_BOUND, MAX_FUND_INPUTS, type SpendWithGrantParams, createAccount, issueGrant, spendWithGrant } from '../src/transactions.js';
import { encodeLogicRedeemer } from '../src/data.js';
import { isNodeScriptRefusal, nodeRefusalSummary } from './flow-plan.js';

/* CONSTANTS ******************************************************************/

/** The package root, under which the example blueprints live one level up. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The lovelace of one ADA. */
const ADA = 1_000_000n;

/** How long a transaction waits to confirm, and the poll interval. */
const CONFIRMATION_TIMEOUT_MS = 180_000;
const POLL_MS = 250;
const REDEEMER_WAIT_MS = 30_000;

/** How many slots a grant spend stays valid for on the devnet. */
const VALIDITY_WINDOW_SLOTS = 90n;

/** The grant lifetime. */
const GRANT_LIFETIME_MS = 2n * 60n * 60n * 1000n;

/** The caps of the grants, large enough for every step of a run. */
const PER_CALL_CAP = 500n * ADA;
const CAP = 100_000n * ADA;

/** What a run needs from the funding wallet and what it deposits into account A. */
const MINIMUM_FUNDING = 460n * ADA;
const ACCOUNT_A_DEPOSIT = 200n * ADA;

/** The lovelace of one small order, and the price bound of the examples. */
const ORDER_LOVELACE = 3n * ADA;
const SOLD_LOVELACE = 2n * ADA;
const PRICE_NUMERATOR = 3n;
const PRICE_DENOMINATOR = 1n;

/** The bounds the example settings carry. */
const MAX_BATCHER_FEE = 2n * ADA;
const MAX_TIP = ADA;
const MAX_PROTOCOL_FEE = 2n * ADA;

/** The script hashes standing in for the order addresses; nothing is ever spent from them. */
const MINSWAP_ORDER_SCRIPT = 'aa'.repeat(28);
const SUNDAE_ORDER_SCRIPT = 'bb'.repeat(28);

/** The dummy pool and assets the examples name. */
const MINSWAP_LP_POLICY = 'cc'.repeat(28);
const MINSWAP_LP_NAME = 'dd'.repeat(32);
const SUNDAE_POOL = 'ee'.repeat(28);
const SUNDAE_TOKEN_POLICY = 'ab'.repeat(28);
const SUNDAE_TOKEN_NAME = 'cd'.repeat(4);

/** The account indexes the run derives keys from; owners are the first unregistered candidates. */
const FIRST_OWNER_ACCOUNT = 2000;
const OWNER_ACCOUNT_STRIDE = 3;
const OWNER_ACCOUNT_CANDIDATES = 400;
const AGENT_OFFSET = 1;
const RECIPIENT_OFFSET = 2;

/** The lovelace the agent holds as collateral and the owner holds to pay creation. */
const AGENT_WALLET_LOVELACE = 30n * ADA;
const OWNER_WALLET_LOVELACE = 40n * ADA;

/** The limits the worst case is compared against. */
const LIMIT_MEMORY = 17_500_000n;
const LIMIT_STEPS = 10_000_000_000n;
const LIMIT_SIZE = 16_384;

/** The change the 12 deposit spend leaves, above its minimum so the change output stays sound. */
const TWELVE_CHANGE_FLOOR = 1_300_000n;

/** The password cometa encrypts derived keys with, fresh per process. */
const password = randomBytes(32);

/* TYPES **********************************************************************/

/** What a step may change about a spend: the unchecked build and its mutations. */
type SpendExtra = Pick<SpendWithGrantParams, 'unchecked' | 'runPolicies' | 'recreatedGrantDatum'>;

/** A confirmed or refused step of the run, as the table prints it. */
interface Row {
  step: string;
  result: string;
  txId: string;
  memory: string;
  steps: string;
  fee: string;
  size: string;
  note: string;
}

/** A wallet of one account index with its address and key hash. */
interface Keyed {
  wallet: Wallet;
  address: string;
  keyHash: string;
}

/** An account a run created. */
interface AccountContext {
  owner: Keyed;
  record: { owner: string; stakeScriptHash: string; address: string };
}

/** Everything a spend of the run needs. */
interface SpendContext {
  account: AccountContext;
  slot: bigint;
  policies: PlutusScript[];
  network: NetworkScripts;
}

/** The scripts of the deployment and their parked reference records. */
interface Deployment {
  proxyHash: string;
  logic: PlutusScript;
  logicHash: string;
  minswap: PlutusScript;
  minswapHash: string;
  sundae: PlutusScript;
  sundaeHash: string;
  network: NetworkScripts;
}

/* FUNCTIONS ******************************************************************/

let target: ProviderConfiguration;
let provider: Provider;
let funding: Keyed;
let agent: Keyed;
let recipient: Keyed;
let projectId = '';
let mnemonics: string[];
const rows: Row[] = [];
const scriptNames = new Map<string, string>();
let unexpectedRefusals = 0;

/** Hands cometa a copy of the password, since it wipes what it is given. */
const getPassword = (): Promise<Uint8Array> => Promise.resolve(new Uint8Array(password));

/** Sleeps for a number of milliseconds. */
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** A keyed wallet of one account index of the funding mnemonic. */
const keyed = async (account: number): Promise<Keyed> => {
  const wallet = await Cometa.SingleAddressWallet.createFromMnemonics({ mnemonics, provider, getPassword, credentialsConfig: { account, paymentIndex: 0, stakingIndex: 0 } });
  const address = (await wallet.getChangeAddress()).toString();
  const keyHash = paymentKeyHashOf(address);
  if (!keyHash) {
    throw new Error(`The account ${account} did not derive a key address`);
  }
  return { wallet, address, keyHash };
};

/** The slot the wall clock falls in. */
const currentSlot = (): bigint => posixTimeToSlot(BigInt(Date.now()), target.slotConfig);

/** Blockfrost's answer to a path, or undefined on 404. */
const blockfrost = async <T>(path: string): Promise<T | undefined> => {
  const response = await fetch(`${target.baseUrl}${path}`, { headers: { project_id: projectId } });
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`Blockfrost answered ${path} with status ${response.status}`);
  }
  return (await response.json()) as T;
};

/** The transaction with the signatures of every wallet applied. */
const signed = async (signers: Wallet[], tx: string): Promise<string> => {
  const witnesses = [];
  for (const wallet of signers) {
    witnesses.push(...(await wallet.signTransaction(tx, true)));
  }
  return Cometa.applyVkeyWitnessSet(tx, witnesses);
};

/** Waits until the chain holds a transaction and an output of it is listed. */
const confirmed = async (tx: string, txId: string): Promise<void> => {
  const deadline = Date.now() + CONFIRMATION_TIMEOUT_MS;
  while ((await blockfrost(`/txs/${txId}`)) === undefined) {
    if (Date.now() > deadline) {
      throw new Error(`The devnet never held ${txId}`);
    }
    await sleep(POLL_MS);
  }
  const addresses = new Set(transactionBodyParts(tx).outputs.map((output) => output.address));
  for (const address of addresses) {
    for (;;) {
      if ((await provider.getUnspentOutputs(address)).some((utxo) => utxo.input.txId === txId)) {
        break;
      }
      if (Date.now() > deadline) {
        throw new Error(`The provider never listed an output of ${txId} at ${address}`);
      }
      await sleep(POLL_MS);
    }
  }
};

/** Builds, signs, submits and confirms a transaction that must succeed. */
const submitAndConfirm = async (signers: Wallet[], build: () => Promise<string>): Promise<{ txId: string; tx: string; signedTx: string }> => {
  const tx = await build();
  const signedTx = await signed(signers, tx);
  const [first] = signers as [Wallet, ...Wallet[]];
  const txId = await first.submitTransaction(signedTx);
  await confirmed(tx, txId);
  return { txId, tx, signedTx };
};

/** Pays from the funding wallet and waits. */
const fund = (address: string, lovelace: bigint): Promise<unknown> =>
  submitAndConfirm([funding.wallet], async () => (await funding.wallet.createTransactionBuilder()).sendLovelace({ address, amount: lovelace }).build());

/** The total memory and steps the chain recorded for a transaction, polled. */
const executionUnits = async (txId: string, expected: number): Promise<{ memory: bigint; steps: bigint; count: number }> => {
  const deadline = Date.now() + REDEEMER_WAIT_MS;
  for (;;) {
    const redeemers = (await blockfrost<{ unit_mem: string; unit_steps: string }[]>(`/txs/${txId}/redeemers`)) ?? [];
    if (redeemers.length >= expected || Date.now() > deadline) {
      return {
        memory: redeemers.reduce((sum, redeemer) => sum + BigInt(redeemer.unit_mem), 0n),
        steps: redeemers.reduce((sum, redeemer) => sum + BigInt(redeemer.unit_steps), 0n),
        count: redeemers.length,
      };
    }
    await sleep(POLL_MS);
  }
};

/** The percentage one value is of a limit, to one decimal. */
const percent = (value: bigint, limit: bigint): string => `${(Number((value * 10000n) / limit) / 100).toFixed(2)}%`;

/** Prints the result table. */
const printTable = (): void => {
  const heads = ['step', 'result', 'tx hash', 'memory', 'steps', 'fee', 'size', 'note'];
  const widths = heads.map((head, index) => Math.max(head.length, ...rows.map((row) => Object.values(row)[index]!.length)));
  const line = (cells: string[]): string => `| ${cells.map((cell, index) => cell.padEnd(widths[index]!)).join(' | ')} |`;
  console.log(line(heads));
  console.log(`|${widths.map((width) => '-'.repeat(width + 2)).join('|')}|`);
  for (const row of rows) {
    console.log(line(Object.values(row)));
  }
};

/** Whether a credential is registered. */
const isRegistered = async (reward: string): Promise<boolean> => (await blockfrost<{ active: boolean }>(`/accounts/${reward}`))?.active === true;

/** The first owner account index whose stake credential is not registered. */
const freshOwner = async (): Promise<Keyed & { index: number }> => {
  for (let candidate = 0; candidate < OWNER_ACCOUNT_CANDIDATES; candidate += 1) {
    const index = FIRST_OWNER_ACCOUNT + candidate * OWNER_ACCOUNT_STRIDE;
    const key = await keyed(index);
    const { rewardAddress: reward, address } = accountByOwner(key.keyHash);
    if (!(await isRegistered(reward)) && (await provider.getUnspentOutputs(address)).length === 0) {
      return { ...key, index };
    }
  }
  throw new Error(`No unregistered owner among ${OWNER_ACCOUNT_CANDIDATES} candidates`);
};

/** A blueprint at a repository path, its first validator applied to the proxy hash. */
const exampleScript = (project: string, proxyHash: string): PlutusScript => {
  const path = resolve(REPO_ROOT, 'examples', project, 'plutus.json');
  if (!existsSync(path)) {
    throw new Error(`${path} is missing: run aiken build in examples/${project}`);
  }
  const blueprint = loadBlueprint(path);
  const validator = blueprint.validators.find((entry) => entry.title.endsWith('.withdraw'));
  if (!validator) {
    throw new Error(`${path} has no withdraw handler`);
  }
  return { type: Cometa.ScriptType.Plutus, bytes: applyParameters(validator.compiledCode, [bytes(proxyHash)]), version: Cometa.PlutusLanguageVersion.V3 };
};

/** The always fail enterprise address the scripts are parked at: the logic script as a payment credential. */
const parkAddress = (logicHash: string): string =>
  Cometa.EnterpriseAddress.fromCredentials(Cometa.NetworkId.Testnet, { hash: logicHash, type: Cometa.CredentialType.ScriptHash }).toAddress().toString();

/** A row for a setup step. */
const setupRow = (step: string, txId: string, note = ''): void => {
  rows.push({ step, result: 'ok', txId, memory: '', steps: '', fee: '', size: '', note });
  console.log(`setup: ${step} ${txId}`);
};

/** Registers a credential through its publish handler when it is not registered. */
const ensureRegistered = async (name: string, script: PlutusScript): Promise<void> => {
  const reward = rewardAddress(logicScriptHash(script)).toBech32();
  if (await isRegistered(reward)) {
    console.log(`setup: ${name} credential already registered`);
    return;
  }
  try {
    const { txId } = await submitAndConfirm([funding.wallet], async () =>
      (await funding.wallet.createTransactionBuilder()).registerStakeAddress({ rewardAddress: rewardAddress(logicScriptHash(script)), redeemer: encodeLogicRedeemer() }).addScript(script).build(),
    );
    setupRow(`register ${name}`, txId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('StakeKeyRegisteredDELEG')) {
      throw error;
    }
    console.log(`setup: ${name} already registered, the indexer did not report it`);
  }
};

/** Parks a script at the always fail address, returning its record. */
const park = async (name: string, script: PlutusScript, address: string): Promise<ReferenceScriptRecord> => {
  const adaPerUtxoByte = BigInt((await provider.getParameters()).adaPerUtxoByte);
  const output = { address, value: { coins: 0n }, scriptReference: script };
  const coins = minimumUtxoLovelace(output, adaPerUtxoByte);
  const { txId } = await submitAndConfirm([funding.wallet], async () => (await funding.wallet.createTransactionBuilder()).addOutput({ ...output, value: { coins } }).build());
  const utxo = (await provider.getUnspentOutputs(address)).find((candidate) => candidate.input.txId === txId && candidate.output.scriptReference !== undefined);
  if (!utxo) {
    throw new Error(`The parked ${name} is not at ${address}`);
  }
  setupRow(`park ${name}`, txId, `${Math.round(script.bytes.length / 2)} bytes`);
  return { scriptHash: Cometa.computeScriptHash(script), txId, index: utxo.input.index, address, lovelace: coins.toString() };
};

/** Deploys every script of the spike: registered credentials and parked reference scripts. */
const deploy = async (): Promise<Deployment> => {
  const proxy = accountScript();
  const proxyHash = accountScriptHash(proxy);
  const logic = currentLogicScript(proxyHash);
  const logicHash = logicScriptHash(logic);
  if (logicHash !== currentLogicHash(proxyHash)) {
    throw new Error('The blueprint logic disagrees with the applied logic');
  }
  const minswap = exampleScript('minswap-v2-policy', proxyHash);
  const minswapHash = logicScriptHash(minswap);
  const sundae = exampleScript('sundaeswap-v3-policy', proxyHash);
  const sundaeHash = logicScriptHash(sundae);
  await ensureRegistered('spike logic', logic);
  await ensureRegistered('Minswap policy', minswap);
  await ensureRegistered('Sundae policy', sundae);
  const address = parkAddress(logicHash);
  const path = networkFilePath(DEVNET_NETWORK);
  const scripts: [string, PlutusScript][] = [
    ['proxy', proxy],
    ['logic', logic],
    ['minswap policy', minswap],
    ['sundae policy', sundae],
  ];
  const stored = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as NetworkScripts) : { network: DEVNET_NETWORK, references: [] };
  const references: ReferenceScriptRecord[] = [];
  for (const [name, script] of scripts) {
    const hash = Cometa.computeScriptHash(script);
    const existing = stored.references.find((record) => record.scriptHash === hash);
    if (existing && (await provider.resolveUnspentOutputs([{ txId: existing.txId, index: existing.index }])).length === 1) {
      references.push(existing);
      console.log(`setup: ${name} already parked`);
    } else {
      references.push(await park(name, script, address));
    }
  }
  const network: NetworkScripts = { network: DEVNET_NETWORK, references };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(network, null, 2)}\n`);
  return { proxyHash, logic, logicHash, minswap, minswapHash, sundae, sundaeHash, network };
};

/** Creates a fresh account paying into a list of fund UTxOs, as one deposit transaction. */
const createFundedAccount = async (deployment: Deployment, label: string, deposits: bigint[]): Promise<AccountContext> => {
  const owner = await freshOwner();
  await fund(owner.address, OWNER_WALLET_LOVELACE);
  const initial: Omit<AccountState, 'logic'> & { logic?: string } = { devices: [owner.keyHash], grantGeneration: 0n, nextSlot: 0n, revoked: [], outstanding: 0n };
  const created = await submitAndConfirm([owner.wallet], () => createAccount({ owner: owner.keyHash, wallet: owner.wallet, state: initial, provider, network: deployment.network }));
  setupRow(`create account ${label}`, created.txId);
  const discovered = accountByOwner(owner.keyHash);
  const record = { owner: discovered.owner, stakeScriptHash: discovered.stakeScriptHash, address: discovered.address };
  const paid = await submitAndConfirm([funding.wallet], async () => {
    const builder = await funding.wallet.createTransactionBuilder();
    for (const lovelace of deposits) {
      builder.sendValue({ address: record.address, value: { coins: lovelace } });
    }
    return builder.build();
  });
  setupRow(`fund account ${label} with ${deposits.length} deposit(s)`, paid.txId);
  return { owner, record };
};

/** A recipient at an address, optionally under a policy. */
const entry = (address: string, policy?: GrantPolicy): Recipient => (policy ? { address, policy } : { address });

/** A lovelace scope listing the recipients. */
const scopeOf = (recipients: Recipient[]): Scope => ({
  asset: LOVELACE,
  perCallCap: PER_CALL_CAP,
  cap: CAP,
  lovelacePerCallCap: 0n,
  lovelaceCap: 0n,
  expiresAt: BigInt(Date.now()) + GRANT_LIFETIME_MS,
  recipients,
});

/** The parameters every owner transaction shares. */
const ownerParams = (context: AccountContext, network: NetworkScripts) => ({ wallet: context.owner.wallet, provider, owner: context.owner.keyHash, network, slotConfig: target.slotConfig });

/** Issues a grant and returns its slot, read from the account. */
const issue = async (context: AccountContext, network: NetworkScripts, grantee: string, recipients: Recipient[]): Promise<bigint> => {
  const utxos = await provider.getUnspentOutputs(context.record.address);
  const state = stateNextSlot(utxos, context);
  const { txId } = await submitAndConfirm([context.owner.wallet], () => issueGrant({ ...ownerParams(context, network), grants: [{ grantee, scope: scopeOf(recipients) }] }));
  setupRow('issue grant', txId, `slot ${state}, ${recipients.length} recipients`);
  return state;
};

/** The next grant slot of an account, read from its control datum. */
const stateNextSlot = (utxos: UTxO[], context: AccountContext): bigint => {
  const control = utxos.find((utxo) => Object.keys(utxo.output.value.assets ?? {}).some((assetId) => assetId.endsWith(context.record.stakeScriptHash)));
  if (control?.output.datum === undefined || !Cometa.isPlutusDataConstr(control.output.datum)) {
    throw new Error('The account has no control datum');
  }
  return control.output.datum.fields.items[3] as bigint;
};

/** A Plutus list of the items. */
const dataList = (items: PlutusData[]): PlutusData => ({ items });

/** The Bool data value. */
const bool = (value: boolean): PlutusData => constr(value ? 1 : 0);

/** The Minswap canceller of an order or settings: a key canceller. */
const minswapCanceller = (key: string): PlutusData => constr(0, [bytes(key)]);

/** The Minswap LP asset data. */
const minswapLp = (name: string = MINSWAP_LP_NAME): PlutusData => constr(0, [bytes(MINSWAP_LP_POLICY), bytes(name)]);

/** The settings of a Minswap recipient. */
const minswapSettings = (canceller: string): PlutusData =>
  constr(0, [minswapCanceller(canceller), minswapLp(), bool(true), PRICE_NUMERATOR, PRICE_DENOMINATOR, MAX_BATCHER_FEE, MAX_TIP]);

/** The fields of a Minswap order, with defaults that the settings allow. */
interface MinswapOrderFields {
  canceller?: string;
  refundReceiver?: string;
  refundReceiverDatum?: PlutusData;
  successReceiver?: string;
  successReceiverDatum?: PlutusData;
  lpName?: string;
  step?: PlutusData;
  maxBatcherFee?: bigint;
  tip?: bigint;
}

/** The default swap step: exactly the sold amount in the settings' direction, at the price. */
const minswapStep = (minimum: bigint = SOLD_LOVELACE * PRICE_NUMERATOR): PlutusData => constr(0, [bool(true), constr(0, [SOLD_LOVELACE]), minimum, bool(false)]);

/** A Minswap order datum for the account. */
const minswapOrder = (canceller: string, receiver: string, fields: MinswapOrderFields = {}): PlutusData =>
  constr(0, [
    minswapCanceller(fields.canceller ?? canceller),
    encodeAddress(fields.refundReceiver ?? receiver),
    fields.refundReceiverDatum ?? constr(0),
    encodeAddress(fields.successReceiver ?? receiver),
    fields.successReceiverDatum ?? constr(0),
    minswapLp(fields.lpName),
    fields.step ?? minswapStep(),
    fields.maxBatcherFee ?? 2n * ADA,
    encodeOption(dataList([BigInt(Date.now() + 3600 * 1000), fields.tip ?? 0n])),
  ]);

/** An output paying an order at an address with a datum. */
const orderOutput = (address: string, datum: PlutusData | undefined, kind: 'inline' | 'hash' | 'none' = 'inline'): AccountOutput => {
  if (kind === 'none') {
    return { address, value: { coins: ORDER_LOVELACE } };
  }
  if (kind === 'hash') {
    return { address, value: { coins: ORDER_LOVELACE }, datum: { type: Cometa.DatumType.DataHash, datumHash: 'aa'.repeat(32) } };
  }
  return { address, value: { coins: ORDER_LOVELACE }, datum: { type: Cometa.DatumType.InlineData, inlineDatum: datum as PlutusData } };
};

/** The Sundae owner value used by the example. */
const sundaeOwner = (key: string): PlutusData => constr(0, [bytes(key)]);

/** The Sundae offer asset data. */
const sundaeSettings = (ownerKey: string): PlutusData =>
  constr(0, [
    bytes(SUNDAE_POOL),
    sundaeOwner(ownerKey),
    dataList([bytes(''), bytes('')]),
    dataList([bytes(SUNDAE_TOKEN_POLICY), bytes(SUNDAE_TOKEN_NAME)]),
    PRICE_NUMERATOR,
    PRICE_DENOMINATOR,
    MAX_PROTOCOL_FEE,
    constr(0),
  ]);

/** The fields of a Sundae order. */
interface SundaeOrderFields {
  pool?: PlutusData;
  owner?: PlutusData;
  maxFee?: bigint;
  destination?: PlutusData;
  details?: PlutusData;
}

/** The Sundae swap details: the sold amount at the price. */
const sundaeSwap = (received: bigint = SOLD_LOVELACE * PRICE_NUMERATOR): PlutusData =>
  constr(1, [
    dataList([bytes(''), bytes(''), SOLD_LOVELACE]),
    dataList([bytes(SUNDAE_TOKEN_POLICY), bytes(SUNDAE_TOKEN_NAME), received]),
  ]);

/** A Sundae order datum for the account. */
const sundaeOrder = (owner: string, receiver: string, fields: SundaeOrderFields = {}): PlutusData =>
  constr(0, [
    fields.pool ?? encodeOption(bytes(SUNDAE_POOL)),
    fields.owner ?? sundaeOwner(owner),
    fields.maxFee ?? MAX_PROTOCOL_FEE,
    fields.destination ?? constr(0, [encodeAddress(receiver), constr(0)]),
    fields.details ?? sundaeSwap(),
    constr(0),
  ]);

/** The parameters of a spend under a slot. */
const spend = (context: SpendContext, slot: bigint, outputs: AccountOutput[], extra: SpendExtra = {}): Promise<string> =>
  spendWithGrant({
    wallet: agent.wallet,
    provider,
    record: context.account.record,
    network: context.network,
    policies: context.policies,
    slotConfig: target.slotConfig,
    slot,
    grantee: agent.keyHash,
    outputs,
    validUntilSlot: currentSlot() + VALIDITY_WINDOW_SLOTS,
    ...extra,
  });

/** Records a confirmed spend as a row and prints it. */
const confirmedRow = async (step: string, built: { txId: string; tx: string; signedTx: string }, note = ''): Promise<{ memory: bigint; steps: bigint; size: number; fee: bigint }> => {
  const expected = Cometa.readRedeemersFromTx(built.tx).length;
  const { memory, steps, count } = await executionUnits(built.txId, expected);
  const fee = transactionBodyParts(built.tx).fee;
  const size = built.signedTx.length / 2;
  const parts = transactionBodyParts(built.tx);
  const withdrawals = parts.withdrawals.length;
  rows.push({
    step,
    result: 'accepted',
    txId: built.txId,
    memory: memory.toString(),
    steps: steps.toString(),
    fee: fee.toString(),
    size: String(size),
    note: `${note}${note ? ', ' : ''}redeemers ${count}, withdrawals ${withdrawals}`,
  });
  console.log(`ACCEPT ${step}: ${built.txId} mem=${memory} steps=${steps} fee=${fee} size=${size}`);
  return { memory, steps, size, fee };
};

/** Submits a confirmed spend under a checked build and records it. */
const accept = (step: string, build: () => Promise<string>, note = ''): Promise<{ memory: bigint; steps: bigint; size: number; fee: bigint }> =>
  submitAndConfirm([agent.wallet], build).then((built) => confirmedRow(step, built, note));

/** The name of the script a node error reports as failing, or the hash when it is not one of the run's scripts. */
const failingScript = (message: string): string => {
  const hash = /ScriptHash\W+([0-9a-f]{56})/.exec(message)?.[1] ?? 'unknown';
  return scriptNames.get(hash) ?? hash;
};

/** Records a transaction the node must refuse and the reason it shows. */
const refuseAtNode = async (step: string, expected: string, build: () => Promise<string>): Promise<void> => {
  const tx = await build();
  const signedTx = await signed([agent.wallet], tx);
  try {
    const txId = await agent.wallet.submitTransaction(signedTx);
    throw new Error(`NOT REFUSED: ${step} was accepted as ${txId}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('NOT REFUSED')) {
      throw error;
    }
    if (!isNodeScriptRefusal(error)) {
      throw new Error(`${step} failed with a non-script error: ${message.slice(0, 400)}`);
    }
    const script = failingScript(message);
    const matches = script === expected;
    if (!matches) {
      unexpectedRefusals += 1;
    }
    rows.push({ step, result: matches ? 'refused' : 'refused by another script', txId: '-', memory: '', steps: '', fee: '', size: '', note: `node names failing script: ${script}, expected ${expected}` });
    console.log(`REFUSE ${step}: failing script ${script}${matches ? '' : ` (expected ${expected})`} - ${nodeRefusalSummary(message).slice(0, 160)}`);
  }
};

/* MAIN ***********************************************************************/

/** The steps of the spike for a Minswap policied grant whose control and mutation share a shape. */
const minswapCases = async (context: SpendContext, slot: bigint, deployment: Deployment, orderAddress: string, canceller: string, receiver: string): Promise<void> => {
  /** A valid order output. */
  const valid = (): AccountOutput[] => [orderOutput(orderAddress, minswapOrder(canceller, receiver))];
  const cases: [string, string, () => AccountOutput[], SpendExtra][] = [
    ['omit the policy withdrawal', 'logic', valid, { runPolicies: [] }],
    ['run a different policy script', 'logic', valid, { runPolicies: [deployment.sundaeHash] }],
    ['redirected success receiver', 'minswap', () => [orderOutput(orderAddress, minswapOrder(canceller, receiver, { successReceiver: recipient.address }))], {}],
    ['wrong canceller', 'minswap', () => [orderOutput(orderAddress, minswapOrder(canceller, receiver, { canceller: agent.keyHash }))], {}],
    ['wrong pool', 'minswap', () => [orderOutput(orderAddress, minswapOrder(canceller, receiver, { lpName: 'ff'.repeat(32) }))], {}],
    ['minimum receive below the price', 'minswap', () => [orderOutput(orderAddress, minswapOrder(canceller, receiver, { step: minswapStep(SOLD_LOVELACE * PRICE_NUMERATOR - 1n) }))], {}],
    ['order datum given by hash', 'minswap', () => [orderOutput(orderAddress, undefined, 'hash')], {}],
    ['order datum missing', 'minswap', () => [orderOutput(orderAddress, undefined, 'none')], {}],
    ['excessive max_batcher_fee', 'minswap', () => [orderOutput(orderAddress, minswapOrder(canceller, receiver, { maxBatcherFee: MAX_BATCHER_FEE + 1n }))], {}],
    ['excessive tip', 'minswap', () => [orderOutput(orderAddress, minswapOrder(canceller, receiver, { tip: MAX_TIP + 1n }))], {}],
    ['a step that is not SwapExactIn', 'minswap', () => [orderOutput(orderAddress, minswapOrder(canceller, receiver, { step: constr(1, [bool(true), constr(0, [SOLD_LOVELACE]), SOLD_LOVELACE]) }))], {}],
    ['SAOAll amount', 'minswap', () => [orderOutput(orderAddress, minswapOrder(canceller, receiver, { step: constr(0, [bool(true), constr(1, [0n]), SOLD_LOVELACE * PRICE_NUMERATOR, bool(false)]) }))], {}],
    ['receiver datum is not EODNoDatum', 'minswap', () => [orderOutput(orderAddress, minswapOrder(canceller, receiver, { successReceiverDatum: constr(1, [bytes('aa'.repeat(32))]) }))], {}],
    ['same payment credential, another stake part', 'logic', () => [orderOutput(Cometa.BaseAddress.fromCredentials(Cometa.NetworkId.Testnet, { hash: MINSWAP_ORDER_SCRIPT, type: Cometa.CredentialType.ScriptHash }, { hash: agent.keyHash, type: Cometa.CredentialType.KeyHash }).toAddress().toString(), minswapOrder(canceller, receiver))], {}],
    ['recreated grant drops the recipient policy', 'logic', valid, { recreatedGrantDatum: (datum) => withRecipientPolicy(datum, undefined) }],
    ['recreated grant changes the policy script', 'logic', valid, { recreatedGrantDatum: (datum) => withRecipientPolicy(datum, { script: deployment.sundaeHash }) }],
    ['recreated grant changes the settings', 'logic', valid, { recreatedGrantDatum: (datum) => withRecipientPolicy(datum, { settings: 7n }) }],
  ];
  for (const [name, expected, outputs, extra] of cases) {
    const control = await submitAndConfirm([agent.wallet], () => spend(context, slot, valid(), { unchecked: true }));
    await confirmedRow(`control for: ${name}`, control, 'unchecked valid twin');
    await refuseAtNode(`REFUSE ${name}`, expected, () => spend(context, slot, outputs(), { unchecked: true, ...extra }));
  }
};

/** A grant datum with the policy of the Minswap recipient, the first listed, replaced or removed. */
const withRecipientPolicy = (datum: PlutusData, change: { script?: string; settings?: bigint } | undefined): PlutusData => {
  if (!Cometa.isPlutusDataConstr(datum)) {
    throw new Error('The grant datum is not a constructor');
  }
  const [slotField, grantee, generation, scope] = datum.fields.items as [PlutusData, PlutusData, PlutusData, PlutusData];
  if (!Cometa.isPlutusDataConstr(scope)) {
    throw new Error('The scope is not a constructor');
  }
  const fields = scope.fields.items;
  const recipients = fields[6] as { items: PlutusData[] };
  const [first, ...rest] = recipients.items as [PlutusData, ...PlutusData[]];
  if (!Cometa.isPlutusDataConstr(first)) {
    throw new Error('The recipient is not a constructor');
  }
  const [address, option] = first.fields.items as [PlutusData, PlutusData];
  const next = change === undefined ? constr(1) : rewritePolicy(option, change);
  const nextRecipient = constr(0, [address, next]);
  const scopeNext = [...fields.slice(0, 6), { items: [nextRecipient, ...rest] }];
  return constr(0, [slotField, grantee, generation, constr(0, scopeNext)]);
};

/** A `Some` policy option with its script or settings replaced. */
const rewritePolicy = (option: PlutusData, change: { script?: string; settings?: bigint }): PlutusData => {
  if (!Cometa.isPlutusDataConstr(option)) {
    throw new Error('The recipient option is not a constructor');
  }
  const [policy] = option.fields.items as [PlutusData];
  if (!Cometa.isPlutusDataConstr(policy)) {
    throw new Error('The policy is not a constructor');
  }
  const [script, settings] = policy.fields.items as [PlutusData, PlutusData];
  return constr(0, [constr(0, [change.script === undefined ? script : bytes(change.script), change.settings ?? settings])]);
};

/** The steps of the spike for a Sundae policied grant. */
const sundaeCases = async (context: SpendContext, slot: bigint, orderAddress: string, owner: string, receiver: string): Promise<void> => {
  const valid = (): AccountOutput[] => [orderOutput(orderAddress, sundaeOrder(owner, receiver))];
  const cases: [string, () => AccountOutput[]][] = [
    ['a late bound Strategy', () => [orderOutput(orderAddress, sundaeOrder(owner, receiver, { details: constr(0, [constr(0, [bytes('aa')])]) }))]],
    ['Self destination', () => [orderOutput(orderAddress, sundaeOrder(owner, receiver, { destination: constr(1) }))]],
    ['None pool ident', () => [orderOutput(orderAddress, sundaeOrder(owner, receiver, { pool: encodeOption(undefined) }))]],
    ['a changed owner', () => [orderOutput(orderAddress, sundaeOrder(owner, receiver, { owner: sundaeOwner(agent.keyHash) }))]],
    ['excessive max_protocol_fee', () => [orderOutput(orderAddress, sundaeOrder(owner, receiver, { maxFee: MAX_PROTOCOL_FEE + 1n }))]],
    ['a bad price', () => [orderOutput(orderAddress, sundaeOrder(owner, receiver, { details: sundaeSwap(SOLD_LOVELACE * PRICE_NUMERATOR - 1n) }))]],
  ];
  for (const [name, outputs] of cases) {
    const control = await submitAndConfirm([agent.wallet], () => spend(context, slot, valid(), { unchecked: true }));
    await confirmedRow(`control for Sundae: ${name}`, control, 'unchecked valid twin');
    await refuseAtNode(`REFUSE Sundae ${name}`, 'sundae', () => spend(context, slot, outputs(), { unchecked: true }));
  }
};

/** Refuses an issuance that lists the same recipient address twice, with its control. */
const refuseDuplicateRecipients = async (context: AccountContext, network: NetworkScripts): Promise<void> => {
  const control = await submitAndConfirm([context.owner.wallet], () =>
    issueGrant({ ...ownerParams(context, network), unchecked: true, grants: [{ grantee: agent.keyHash, scope: scopeOf([entry(recipient.address), entry(funding.address)]) }] }),
  );
  rows.push({ step: 'control for: duplicate recipients', result: 'accepted', txId: control.txId, memory: '', steps: '', fee: '', size: '', note: 'unchecked distinct addresses' });
  const tx = await issueGrant({ ...ownerParams(context, network), unchecked: true, grants: [{ grantee: agent.keyHash, scope: scopeOf([entry(recipient.address), entry(recipient.address)]) }] });
  const signedTx = await signed([context.owner.wallet], tx);
  try {
    const txId = await context.owner.wallet.submitTransaction(signedTx);
    throw new Error(`NOT REFUSED: duplicate recipient issuance was accepted as ${txId}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isNodeScriptRefusal(error)) {
      throw new Error(`The duplicate issuance failed with a non-script error: ${message.slice(0, 400)}`);
    }
    const script = failingScript(message);
    if (script !== 'logic') {
      unexpectedRefusals += 1;
    }
    rows.push({ step: 'REFUSE duplicate recipient addresses at issuance', result: script === 'logic' ? 'refused' : 'refused by another script', txId: '-', memory: '', steps: '', fee: '', size: '', note: `node names failing script: ${script}, expected logic` });
    console.log(`REFUSE duplicate recipients: failing script ${script}`);
  }
};

const main = async (): Promise<void> => {
  const network = loadRunEnvironment(loadEnv as (options: { path: string; override?: boolean }) => unknown);
  if (network !== DEVNET_NETWORK) {
    throw new Error(`The spike only runs against the devnet; CARDANO_NETWORK is ${network}`);
  }
  await Cometa.ready();
  target = providerConfiguration();
  provider = new Cometa.BlockfrostProvider({ network: target.networkMagic, projectId: target.projectId, baseUrl: target.baseUrl });
  projectId = target.projectId;
  mnemonics = (process.env['FUNDING_MNEMONIC'] ?? '').trim().split(/\s+/);
  funding = await keyed(0);
  const balance = (await funding.wallet.getBalance()).coins;
  console.log(`funding wallet balance ${balance}`);
  if (balance < MINIMUM_FUNDING) {
    throw new Error(`The funding wallet needs at least ${MINIMUM_FUNDING / ADA} tADA: run npm run devnet:bootstrap`);
  }

  const deployment = await deploy();
  scriptNames.set(deployment.logicHash, 'logic');
  scriptNames.set(deployment.minswapHash, 'minswap');
  scriptNames.set(deployment.sundaeHash, 'sundae');
  scriptNames.set(deployment.proxyHash, 'proxy');
  const agentIndex = (await freshOwner()).index + AGENT_OFFSET;
  agent = await keyed(agentIndex);
  recipient = await keyed(agentIndex + RECIPIENT_OFFSET);
  if ((await agent.wallet.getBalance()).coins < 5n * ADA) {
    await fund(agent.address, AGENT_WALLET_LOVELACE);
  }

  const minswapPolicy = (ownerKey: string): GrantPolicy => ({ script: deployment.minswapHash, settings: minswapSettings(ownerKey) });
  const sundaePolicy = (ownerKey: string): GrantPolicy => ({ script: deployment.sundaeHash, settings: sundaeSettings(ownerKey) });
  const minswapOrderAddress = Cometa.EnterpriseAddress.fromCredentials(Cometa.NetworkId.Testnet, { hash: MINSWAP_ORDER_SCRIPT, type: Cometa.CredentialType.ScriptHash }).toAddress().toString();
  const sundaeOrderAddress = Cometa.EnterpriseAddress.fromCredentials(Cometa.NetworkId.Testnet, { hash: SUNDAE_ORDER_SCRIPT, type: Cometa.CredentialType.ScriptHash }).toAddress().toString();

  const main = await createFundedAccount(deployment, 'A', [ACCOUNT_A_DEPOSIT]);
  const receiver = main.record.address;
  const context: SpendContext = { account: main, slot: 0n, policies: [deployment.minswap, deployment.sundae], network: deployment.network };
  const recipients = [entry(minswapOrderAddress, minswapPolicy(main.owner.keyHash)), entry(sundaeOrderAddress, sundaePolicy(main.owner.keyHash)), entry(recipient.address)];
  const policiedSlot = await issue(main, deployment.network, agent.keyHash, recipients);
  const plainSlot = await issue(main, deployment.network, agent.keyHash, [entry(recipient.address)]);

  await accept('ACCEPT one Minswap order, 1 deposit', () => spend(context, policiedSlot, [orderOutput(minswapOrderAddress, minswapOrder(main.owner.keyHash, receiver))]));
  await accept('ACCEPT one Sundae order', () => spend(context, policiedSlot, [orderOutput(sundaeOrderAddress, sundaeOrder(main.owner.keyHash, receiver))]));
  await accept('ACCEPT plain spend on a grant with no policied recipients', () => spend(context, plainSlot, [{ address: recipient.address, value: { coins: 3n * ADA } }]));
  await accept('ACCEPT plain recipient on a grant that also has a policied recipient', () => spend(context, policiedSlot, [{ address: recipient.address, value: { coins: 3n * ADA } }]), 'no policy script runs');
  await accept('ACCEPT plain and policied recipients in one transaction', () => spend(context, policiedSlot, [orderOutput(minswapOrderAddress, minswapOrder(main.owner.keyHash, receiver)), { address: recipient.address, value: { coins: 3n * ADA } }]), 'only the needed script runs');
  const twoScripts = await accept('ACCEPT Minswap and Sundae recipients in one transaction', () => spend(context, policiedSlot, [orderOutput(minswapOrderAddress, minswapOrder(main.owner.keyHash, receiver)), orderOutput(sundaeOrderAddress, sundaeOrder(main.owner.keyHash, receiver))]), 'two policy scripts');
  let fourOrders: { memory: bigint; steps: bigint; size: number; fee: bigint } | undefined;
  try {
    fourOrders = await accept('ACCEPT 4 orders in one transaction', () => spend(context, policiedSlot, Array.from({ length: 4 }, () => orderOutput(minswapOrderAddress, minswapOrder(main.owner.keyHash, receiver)))));
  } catch (error) {
    rows.push({ step: 'ACCEPT 4 orders', result: 'did not fit', txId: '-', memory: '', steps: '', fee: '', size: '', note: error instanceof Error ? error.message.slice(0, 120) : String(error) });
    console.log(`4 orders did not fit: ${error instanceof Error ? error.message : String(error)}`);
  }

  await minswapCases(context, policiedSlot, deployment, minswapOrderAddress, main.owner.keyHash, receiver);
  await sundaeCases(context, policiedSlot, sundaeOrderAddress, main.owner.keyHash, receiver);
  await refuseDuplicateRecipients(main, deployment.network);

  const twelve = await createFundedAccount(deployment, 'B', [30n * ADA]);
  const twelveContext: SpendContext = { account: twelve, slot: 0n, policies: [deployment.minswap, deployment.sundae], network: deployment.network };
  const twelveSlot = await issue(twelve, deployment.network, agent.keyHash, [entry(minswapOrderAddress, minswapPolicy(twelve.owner.keyHash))]);
  const fundedTwelve = await submitAndConfirm([funding.wallet], async () => {
    const builder = await funding.wallet.createTransactionBuilder();
    for (let index = 0; index < MAX_FUND_INPUTS; index += 1) {
      builder.sendValue({ address: twelve.record.address, value: { coins: 10n * ADA } });
    }
    return builder.build();
  });
  setupRow('fund account B with 12 deposits', fundedTwelve.txId);
  const funds = (await provider.getUnspentOutputs(twelve.record.address)).filter((utxo) => utxo.output.datum === undefined && utxo.output.datumHash === undefined && Object.keys(utxo.output.value.assets ?? {}).length === 0);
  const topTwelve = funds
    .map((utxo) => utxo.output.value.coins)
    .sort((a, b) => Number(b - a))
    .slice(0, MAX_FUND_INPUTS)
    .reduce((total, coins) => total + coins, 0n);
  const worstCoins = topTwelve - DEFAULT_GRANT_FEE_BOUND - TWELVE_CHANGE_FLOOR;
  const worstStep = constr(0, [bool(true), constr(0, [worstCoins - 4n * ADA]), (worstCoins - 4n * ADA) * PRICE_NUMERATOR, bool(false)]);
  const worst = await accept('ACCEPT one order over 12 fund UTxOs (worst case)', () =>
    spend(twelveContext, twelveSlot, [{ ...orderOutput(minswapOrderAddress, minswapOrder(twelve.owner.keyHash, twelve.record.address, { step: worstStep })), value: { coins: worstCoins } }]),
  );

  printTable();
  console.log('');
  const worstMemory = `${worst.memory} of ${LIMIT_MEMORY} (${percent(worst.memory, LIMIT_MEMORY)})`;
  console.log(`12 deposit case: memory ${worstMemory}`);
  console.log(`12 deposit case: steps ${worst.steps} of ${LIMIT_STEPS} (${percent(worst.steps, LIMIT_STEPS)})`);
  console.log(`12 deposit case: size ${worst.size} of ${LIMIT_SIZE} (${percent(BigInt(worst.size), BigInt(LIMIT_SIZE))})`);
  console.log(`12 deposit case: fee ${worst.fee} of bound ${DEFAULT_GRANT_FEE_BOUND} (${percent(worst.fee, DEFAULT_GRANT_FEE_BOUND)})`);
  console.log(`two script case: memory ${twoScripts.memory}, steps ${twoScripts.steps}, size ${twoScripts.size}, fee ${twoScripts.fee}`);
  if (fourOrders) {
    console.log(`4 order case: memory ${fourOrders.memory}, steps ${fourOrders.steps}, size ${fourOrders.size}, fee ${fourOrders.fee}`);
  }
  if (unexpectedRefusals > 0) {
    throw new Error(`${unexpectedRefusals} refusals named another script than expected`);
  }
};

main().catch((error: unknown) => {
  printTable();
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
