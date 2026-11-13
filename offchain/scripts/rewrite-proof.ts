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
import type { NativeScript, PlutusData, PlutusScript, Provider, Wallet } from '@biglup/cometa';
import { config as loadEnv } from 'dotenv';
import { paymentKeyHashOf, rewardAddress } from '../src/address.js';
import { accountScript, accountScriptHash, loadBlueprint } from '../src/blueprint.js';
import { posixTimeToSlot, transactionBodyParts } from '../src/body.js';
import { Cometa } from '../src/cometa.js';
import { DEVNET_NETWORK, type ProviderConfiguration, loadRunEnvironment, providerConfiguration } from '../src/config.js';
import { type AccountState, type GrantPolicy, type Recipient, type Scope, bytes, constr, encodeAddress, encodeLogicRedeemer, encodeOption } from '../src/data.js';
import { accountByOwner } from '../src/discovery.js';
import { currentLogicHash, currentLogicScript, logicScriptHash } from '../src/logic.js';
import { type NetworkScripts, type ReferenceScriptRecord, networkFilePath } from '../src/network.js';
import { minimumUtxoLovelace } from '../src/output.js';
import { applyParameters } from '../src/stake-script.js';
import { LOVELACE } from '../src/state.js';
import {
  type AccountOutput,
  type RewriteGrantParams,
  type RewriteGrantTamper,
  createAccount,
  findAccountUtxos,
  issueGrant,
  revokeAllGrants,
  revokeGrant,
  rewriteGrant,
  rewriteState,
  spendWithGrant,
} from '../src/transactions.js';
import { isNodePhaseOneRefusal, isNodeScriptRefusal, nodeRefusalSummary } from './flow-plan.js';

/* CONSTANTS ******************************************************************/

/** The repository root, under which the example blueprints live. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The lovelace of one ADA, how long a transaction waits and the poll interval. */
const ADA = 1_000_000n;
const CONFIRMATION_TIMEOUT_MS = 180_000;
const POLL_MS = 250;
const REDEEMER_WAIT_MS = 30_000;

/** How many slots an agent spend stays valid for. */
const VALIDITY_WINDOW_SLOTS = 90n;

/** How long a grant lives, and how long the short lived grant does before it expires. */
const GRANT_LIFETIME_MS = 2n * 60n * 60n * 1000n;
const SHORT_LIFETIME_MS = 12_000n;

/** The terms a grant starts under and the terms a renewal gives it. */
const OLD_PER_CALL = 5n * ADA;
const OLD_CAP = 6n * ADA;
const NEW_PER_CALL = 20n * ADA;
const NEW_CAP = 50n * ADA;

/** A payment only the renewed terms allow, and a small one any grant allows. */
const LARGE_SPEND = 8n * ADA;
const SMALL_SPEND = 2n * ADA;

/** The owners the run derives, the first unregistered candidates. */
const FIRST_OWNER_ACCOUNT = 6000;
const OWNER_ACCOUNT_STRIDE = 5;
const OWNER_ACCOUNT_CANDIDATES = 400;

/** The wallets of the actors. */
const OWNER_WALLET_LOVELACE = 40n * ADA;
const AGENT_WALLET_LOVELACE = 30n * ADA;

/** The stand-ins for a Minswap order and pool. */
const MINSWAP_ORDER_SCRIPT = 'aa'.repeat(28);
const MINSWAP_LP_POLICY = 'cc'.repeat(28);
const MINSWAP_LP_NAME = 'dd'.repeat(32);
const ORDER_LOVELACE = 3n * ADA;
const SOLD_LOVELACE = 2n * ADA;
const PRICE_NUMERATOR = 3n;
const PRICE_DENOMINATOR = 1n;
const MAX_BATCHER_FEE = 2n * ADA;
const MAX_TIP = ADA;

/** The token an attack adds to the grant output. */
const TEST_TOKEN_NAME = 'ee'.repeat(4);

/** The bounds of the largest state, and the deposits behind which the grant is sorted. */
const MAX_DEVICES = 8;
const MAX_REVOKED = 32;
const MAX_RECIPIENTS = 8;
const DEPOSIT_COUNT = 12;
const DEPOSIT_LOVELACE = 10n * ADA;
const POSITION_ATTEMPTS = 8;

/** The limits a measurement is compared against. */
const LIMIT_MEMORY = 17_500_000n;
const LIMIT_STEPS = 10_000_000_000n;
const LIMIT_SIZE = 16_384;

/** The password cometa encrypts derived keys with, fresh per process. */
const password = randomBytes(32);

/* TYPES **********************************************************************/

/** A step of the run, as the table prints it. */
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

/** An account the run created. */
interface AccountContext {
  owner: Keyed;
  record: { owner: string; stakeScriptHash: string; address: string };
}

/** A transaction that was submitted and confirmed. */
interface Built {
  txId: string;
  tx: string;
  signedTx: string;
}

/** The scripts of the deployment. */
interface Deployment {
  proxyHash: string;
  logicHash: string;
  minswap: PlutusScript;
  minswapHash: string;
  network: NetworkScripts;
}

/* FUNCTIONS ******************************************************************/

let target: ProviderConfiguration;
let provider: Provider;
let funding: Keyed;
let agent: Keyed;
let newAgent: Keyed;
let recipient: Keyed;
let projectId = '';
let mnemonics: string[];
let deployment: Deployment;
const rows: Row[] = [];
const scriptNames = new Map<string, string>();
let nextOwnerCandidate = 0;

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

/** Waits until the chain holds a transaction and every output address lists it. */
const confirmed = async (tx: string, txId: string): Promise<void> => {
  const deadline = Date.now() + CONFIRMATION_TIMEOUT_MS;
  while ((await blockfrost(`/txs/${txId}`)) === undefined) {
    if (Date.now() > deadline) {
      throw new Error(`The devnet never held ${txId}`);
    }
    await sleep(POLL_MS);
  }
  for (const address of new Set(transactionBodyParts(tx).outputs.map((output) => output.address))) {
    while (!(await provider.getUnspentOutputs(address)).some((utxo) => utxo.input.txId === txId)) {
      if (Date.now() > deadline) {
        throw new Error(`The provider never listed an output of ${txId} at ${address}`);
      }
      await sleep(POLL_MS);
    }
  }
};

/** Submits a signed transaction and waits for it. */
const confirm = async (signer: Wallet, tx: string, signedTx: string): Promise<Built> => {
  const txId = await signer.submitTransaction(signedTx);
  await confirmed(tx, txId);
  return { txId, tx, signedTx };
};

/** Builds, signs, submits and confirms a transaction that must succeed. */
const submitAndConfirm = async (signers: [Wallet, ...Wallet[]], build: () => Promise<string>): Promise<Built> => {
  const tx = await build();
  return confirm(signers[0], tx, await signed(signers, tx));
};

/** Pays from the funding wallet and waits. */
const fund = (address: string, lovelace: bigint): Promise<Built> =>
  submitAndConfirm([funding.wallet], async () => (await funding.wallet.createTransactionBuilder()).sendLovelace({ address, amount: lovelace }).build());

/** Records a step that needed no measurement. */
const note = (step: string, txId: string, detail = ''): void => {
  rows.push({ step, result: 'ok', txId, memory: '', steps: '', fee: '', size: '', note: detail });
  console.log(`setup: ${step} ${txId} ${detail}`);
};

/** The memory and steps the chain recorded for a transaction, polled until every redeemer is listed. */
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

/** The percentage one value is of a limit. */
const percent = (value: bigint, limit: bigint): string => `${(Number((value * 10000n) / limit) / 100).toFixed(2)}%`;

/** Records a transaction the chain accepted, with its measurements. */
const accepted = async (step: string, built: Built, detail = ''): Promise<void> => {
  const { memory, steps, count } = await executionUnits(built.txId, Cometa.readRedeemersFromTx(built.tx).length);
  const { fee } = transactionBodyParts(built.tx);
  const size = built.signedTx.length / 2;
  rows.push({ step, result: 'accepted', txId: built.txId, memory: `${memory} (${percent(memory, LIMIT_MEMORY)})`, steps: `${steps} (${percent(steps, LIMIT_STEPS)})`, fee: fee.toString(), size: `${size} (${percent(BigInt(size), BigInt(LIMIT_SIZE))})`, note: `${detail}${detail ? ', ' : ''}redeemers ${count}` });
  console.log(`ACCEPT ${step}: ${built.txId} mem=${memory} steps=${steps} fee=${fee} size=${size} ${detail}`);
};

/** Builds, signs and confirms a transaction the chain must accept, and records it. */
const accept = async (step: string, signers: [Wallet, ...Wallet[]], build: () => Promise<string>, detail = ''): Promise<Built> => {
  const built = await submitAndConfirm(signers, build);
  await accepted(step, built, detail);
  return built;
};

/** Submits a signed transaction the node must refuse, and checks the kind of refusal. */
const refused = async (step: string, kind: 'script' | 'input', signer: Wallet, signedTx: string, detail = ''): Promise<string> => {
  try {
    const txId = await signer.submitTransaction(signedTx);
    throw new Error(`NOT REFUSED: ${step} was accepted as ${txId}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('NOT REFUSED')) {
      throw error;
    }
    const matches = kind === 'script' ? isNodeScriptRefusal(error) : isNodePhaseOneRefusal(error);
    if (!matches) {
      throw new Error(`${step} failed differently than a ${kind} refusal: ${message.slice(0, 600)}`);
    }
    const failing = /ScriptHash\W+([0-9a-f]{56})/.exec(message)?.[1];
    const script = kind === 'script' && failing ? (scriptNames.get(failing) ?? failing) : '-';
    const summary = nodeRefusalSummary(message).slice(0, 180);
    rows.push({ step, result: `refused (${kind})`, txId: '-', memory: '', steps: '', fee: '', size: '', note: `${detail}${detail ? ', ' : ''}script ${script}: ${summary}` });
    console.log(`REFUSE ${step}: script=${script} ${summary}`);
    return message;
  }
};

/** Builds and signs a transaction the node must refuse with a script failure. */
const refuse = async (step: string, signers: [Wallet, ...Wallet[]], build: () => Promise<string>, detail = ''): Promise<void> => {
  const tx = await build();
  await refused(step, 'script', signers[0], await signed(signers, tx), detail);
};

/** Throws unless a condition read back from the chain holds. */
const expectChain = (condition: boolean, what: string): void => {
  if (!condition) {
    throw new Error(`CHAIN CHECK FAILED: ${what}`);
  }
  console.log(`check: ${what}`);
};

/** Whether a credential is registered. */
const isRegistered = async (reward: string): Promise<boolean> => (await blockfrost<{ active: boolean }>(`/accounts/${reward}`))?.active === true;

/** The next owner whose account does not exist yet. */
const freshOwner = async (): Promise<Keyed> => {
  while (nextOwnerCandidate < OWNER_ACCOUNT_CANDIDATES) {
    const key = await keyed(FIRST_OWNER_ACCOUNT + nextOwnerCandidate * OWNER_ACCOUNT_STRIDE);
    nextOwnerCandidate += 1;
    const { rewardAddress: reward, address } = accountByOwner(key.keyHash);
    if (!(await isRegistered(reward)) && (await provider.getUnspentOutputs(address)).length === 0) {
      return key;
    }
  }
  throw new Error('No unused owner left');
};

/** The address the scripts are parked at: the logic script as a payment credential, which no one can spend. */
const parkAddress = (logicHash: string): string =>
  Cometa.EnterpriseAddress.fromCredentials(Cometa.NetworkId.Testnet, { hash: logicHash, type: Cometa.CredentialType.ScriptHash }).toAddress().toString();

/** Registers a script credential through its publish handler, tolerating an indexer that does not report it. */
const ensureRegistered = async (name: string, script: PlutusScript): Promise<void> => {
  const reward = rewardAddress(logicScriptHash(script)).toBech32();
  if (await isRegistered(reward)) {
    return;
  }
  try {
    const { txId } = await submitAndConfirm([funding.wallet], async () =>
      (await funding.wallet.createTransactionBuilder()).registerStakeAddress({ rewardAddress: rewardAddress(logicScriptHash(script)), redeemer: encodeLogicRedeemer() }).addScript(script).build(),
    );
    note(`register ${name}`, txId);
  } catch (error) {
    if (!(error instanceof Error ? error.message : String(error)).includes('StakeKeyRegisteredDELEG')) {
      throw error;
    }
  }
};

/** Parks a script, returning its record. */
const park = async (name: string, script: PlutusScript, address: string): Promise<ReferenceScriptRecord> => {
  const adaPerUtxoByte = BigInt((await provider.getParameters()).adaPerUtxoByte);
  const output = { address, value: { coins: 0n }, scriptReference: script };
  const coins = minimumUtxoLovelace(output, adaPerUtxoByte);
  const { txId } = await submitAndConfirm([funding.wallet], async () => (await funding.wallet.createTransactionBuilder()).addOutput({ ...output, value: { coins } }).build());
  const utxo = (await provider.getUnspentOutputs(address)).find((candidate) => candidate.input.txId === txId && candidate.output.scriptReference !== undefined);
  if (!utxo) {
    throw new Error(`The parked ${name} is not at ${address}`);
  }
  note(`park ${name}`, txId, `${Math.round(script.bytes.length / 2)} bytes`);
  return { scriptHash: Cometa.computeScriptHash(script), txId, index: utxo.input.index, address, lovelace: coins.toString() };
};

/** The Minswap example policy applied to the proxy. */
const minswapScript = (proxyHash: string): PlutusScript => {
  const path = resolve(REPO_ROOT, 'examples', 'minswap-v2-policy', 'plutus.json');
  if (!existsSync(path)) {
    throw new Error(`${path} is missing`);
  }
  const validator = loadBlueprint(path).validators.find((entry) => entry.title.endsWith('.withdraw'));
  if (!validator) {
    throw new Error(`${path} has no withdraw handler`);
  }
  return { type: Cometa.ScriptType.Plutus, bytes: applyParameters(validator.compiledCode, [bytes(proxyHash)]), version: Cometa.PlutusLanguageVersion.V3 };
};

/** Deploys the scripts the proof uses. */
const deploy = async (): Promise<Deployment> => {
  const proxy = accountScript();
  const proxyHash = accountScriptHash(proxy);
  const logic = currentLogicScript(proxyHash);
  const logicHash = logicScriptHash(logic);
  if (logicHash !== currentLogicHash(proxyHash)) {
    throw new Error('The blueprint logic disagrees with the applied logic');
  }
  const minswap = minswapScript(proxyHash);
  const minswapHash = logicScriptHash(minswap);
  await ensureRegistered('logic', logic);
  await ensureRegistered('Minswap policy', minswap);
  const address = parkAddress(logicHash);
  const path = networkFilePath(DEVNET_NETWORK);
  const stored = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as NetworkScripts) : { network: DEVNET_NETWORK, references: [] };
  const references: ReferenceScriptRecord[] = [];
  for (const [name, script] of [['proxy', proxy], ['logic', logic], ['minswap policy', minswap]] as [string, PlutusScript][]) {
    const hash = Cometa.computeScriptHash(script);
    const existing = stored.references.find((record) => record.scriptHash === hash);
    references.push(existing && (await provider.resolveUnspentOutputs([{ txId: existing.txId, index: existing.index }])).length === 1 ? existing : await park(name, script, address));
  }
  const network: NetworkScripts = { network: DEVNET_NETWORK, references };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(network, null, 2)}\n`);
  return { proxyHash, logicHash, minswap, minswapHash, network };
};

/** Creates an account holding the deposits. */
const createFundedAccount = async (label: string, deposits: bigint[]): Promise<AccountContext> => {
  const owner = await freshOwner();
  await fund(owner.address, OWNER_WALLET_LOVELACE);
  const initial: Omit<AccountState, 'logic'> & { logic?: string } = { devices: [owner.keyHash], grantGeneration: 0n, nextSlot: 0n, revoked: [], outstanding: 0n };
  const created = await submitAndConfirm([owner.wallet], () => createAccount({ owner: owner.keyHash, wallet: owner.wallet, state: initial, provider, network: deployment.network }));
  note(`create account ${label}`, created.txId);
  const discovered = accountByOwner(owner.keyHash);
  const record = { owner: discovered.owner, stakeScriptHash: discovered.stakeScriptHash, address: discovered.address };
  const paid = await submitAndConfirm([funding.wallet], async () => {
    const builder = await funding.wallet.createTransactionBuilder();
    for (const lovelace of deposits) {
      builder.sendValue({ address: record.address, value: { coins: lovelace } });
    }
    return builder.build();
  });
  note(`fund account ${label}`, paid.txId);
  return { owner, record };
};

/** A lovelace scope. */
const scopeOf = (perCallCap: bigint, cap: bigint, recipients: Recipient[] = [], expiresAt: bigint = BigInt(Date.now()) + GRANT_LIFETIME_MS): Scope => ({
  asset: LOVELACE,
  perCallCap,
  cap,
  lovelacePerCallCap: 0n,
  lovelaceCap: 0n,
  expiresAt,
  recipients,
});

/** The parameters every owner transaction shares. */
const ownerParams = (context: AccountContext, network: NetworkScripts = deployment.network) => ({ wallet: context.owner.wallet, provider, owner: context.owner.keyHash, network, slotConfig: target.slotConfig });

/** What the chain holds for an account. */
const read = (context: AccountContext) => findAccountUtxos(provider, { provider, owner: context.owner.keyHash, wallet: context.owner.wallet, network: deployment.network } as Parameters<typeof findAccountUtxos>[1]);

/** The grant UTxO of a slot, as the chain holds it. */
const grantAt = async (context: AccountContext, slot: bigint) => {
  const found = (await read(context)).grants.find(({ prefix }) => prefix.slot === slot);
  if (!found?.grant) {
    throw new Error(`The chain holds no readable grant in slot ${slot}`);
  }
  return { ...found, grant: found.grant };
};

/** Issues a grant and returns its slot. */
const issue = async (context: AccountContext, grantee: string, scope: Scope): Promise<bigint> => {
  const { state } = await read(context);
  const { txId } = await submitAndConfirm([context.owner.wallet], () => issueGrant({ ...ownerParams(context), grants: [{ grantee, scope }] }));
  note('issue grant', txId, `slot ${state.nextSlot}`);
  return state.nextSlot;
};

/** The parameters of a renewal. */
const renewal = (context: AccountContext, slot: bigint, grantee: string, scope: Scope, extra: Pick<RewriteGrantParams, 'lovelace' | 'sweptSlots'> = {}): RewriteGrantParams => ({ ...ownerParams(context), slot, grantee, scope, ...extra });

/** Builds a renewal that skips the off-chain guards, optionally tampering with what it writes back. */
const uncheckedRenewal = (context: AccountContext, slot: bigint, grantee: string, scope: Scope, tamper?: RewriteGrantTamper, wallet?: Wallet, lovelace?: bigint): Promise<string> =>
  rewriteGrant({ ...renewal(context, slot, grantee, scope, lovelace === undefined ? {} : { lovelace }), unchecked: true, ...(tamper ? { tamper } : {}), ...(wallet ? { wallet } : {}) });

/** The parameters of an agent spend paying the outputs. */
const spend = (context: AccountContext, slot: bigint, outputs: AccountOutput[], wallet: Keyed = agent, unchecked = false, policies: PlutusScript[] = [deployment.minswap], extra: object = {}): Promise<string> =>
  spendWithGrant({
    wallet: wallet.wallet,
    provider,
    record: context.record,
    network: deployment.network,
    policies,
    slotConfig: target.slotConfig,
    slot,
    grantee: wallet.keyHash,
    outputs,
    validUntilSlot: currentSlot() + VALIDITY_WINDOW_SLOTS,
    ...(unchecked ? { unchecked: true } : {}),
    ...extra,
  });

/** A payment to the recipient. */
const pay = (lovelace: bigint): AccountOutput[] => [{ address: recipient.address, value: { coins: lovelace } }];

/** The Minswap settings naming a canceller. */
const minswapSettings = (canceller: string): PlutusData =>
  constr(0, [constr(0, [bytes(canceller)]), constr(0, [bytes(MINSWAP_LP_POLICY), bytes(MINSWAP_LP_NAME)]), constr(1), PRICE_NUMERATOR, PRICE_DENOMINATOR, MAX_BATCHER_FEE, MAX_TIP]);

/** A Minswap order the settings accept. */
const minswapOrder = (canceller: string, receiver: string): PlutusData =>
  constr(0, [
    constr(0, [bytes(canceller)]),
    encodeAddress(receiver),
    constr(0),
    encodeAddress(receiver),
    constr(0),
    constr(0, [bytes(MINSWAP_LP_POLICY), bytes(MINSWAP_LP_NAME)]),
    constr(0, [constr(1), constr(0, [SOLD_LOVELACE]), SOLD_LOVELACE * PRICE_NUMERATOR, constr(0)]),
    2n * ADA,
    encodeOption({ items: [BigInt(Date.now() + 3600 * 1000), 0n] }),
  ]);

/** An order output at an address, with or without its datum. */
const orderOutput = (address: string, datum?: PlutusData): AccountOutput =>
  datum === undefined ? { address, value: { coins: ORDER_LOVELACE } } : { address, value: { coins: ORDER_LOVELACE }, datum: { type: Cometa.DatumType.InlineData, inlineDatum: datum } };

/** The POSIX time of the newest block the chain holds. */
const chainTime = async (): Promise<bigint> => {
  const block = await blockfrost<{ slot: number; time: number }>('/blocks/latest');
  if (!block) {
    throw new Error('The devnet reports no latest block');
  }
  return target.slotConfig.zeroTime + (BigInt(block.slot) - target.slotConfig.zeroSlot) * target.slotConfig.slotLength;
};

/** Accepted: a live grant is renewed in one transaction, and the agent then spends what only the new terms allow. */
const renewLiveGrant = async (context: AccountContext): Promise<void> => {
  const slot = await issue(context, agent.keyHash, scopeOf(OLD_PER_CALL, OLD_CAP));
  await refuse('old terms refuse a payment over the per call cap', [agent.wallet], () => spend(context, slot, pay(LARGE_SPEND), agent, true), 'control: the same payment after the renewal');
  const staleTx = await spend(context, slot, pay(SMALL_SPEND));
  const staleSigned = await signed([agent.wallet], staleTx);
  const before = await read(context);
  const grantBefore = await grantAt(context, slot);
  const scope = scopeOf(NEW_PER_CALL, NEW_CAP);
  const renewed = await accept('M1 ACCEPT renew a live grant in one transaction', [context.owner.wallet], () => rewriteGrant(renewal(context, slot, agent.keyHash, scope)), 'references, no mint');
  const parts = transactionBodyParts(renewed.tx);
  expectChain(Object.keys(parts.mint).length === 0, 'the renewal mints and burns nothing');
  const after = await read(context);
  const grantAfter = await grantAt(context, slot);
  expectChain(after.grants.length === before.grants.length, `grant UTxO count unchanged at ${after.grants.length}`);
  expectChain(grantAfter.assetId === grantBefore.assetId, 'the grant token is the same');
  expectChain(grantAfter.utxo.input.txId === renewed.txId, 'the grant UTxO is the output of the renewal');
  expectChain(after.state.outstanding === before.state.outstanding && after.state.nextSlot === before.state.nextSlot, 'outstanding and next_slot unchanged');
  expectChain(after.state.revoked.length === 0, 'no slot is revoked, so nothing needs sweeping');
  expectChain(grantAfter.grant.scope.cap === NEW_CAP && grantAfter.grant.scope.perCallCap === NEW_PER_CALL && grantAfter.grant.scope.expiresAt === scope.expiresAt, 'the datum carries the new caps and expiry');
  await refused('R10 the agent spends the OLD outpoint after the renewal', 'input', agent.wallet, staleSigned, 'expects a missing input');
  await accept('R10 control: the same small payment rebuilt on the new outpoint', [agent.wallet], () => spend(context, slot, pay(SMALL_SPEND)));
  await accept('ACCEPT the agent pays what only the new terms allow', [agent.wallet], () => spend(context, slot, pay(LARGE_SPEND)), 'control of the old terms refusal');
};

/** Accepted: a grant that has expired on chain is renewed and spends again. */
const renewExpiredGrant = async (context: AccountContext): Promise<void> => {
  const expiresAt = BigInt(Date.now()) + SHORT_LIFETIME_MS;
  const slot = await issue(context, agent.keyHash, scopeOf(NEW_PER_CALL, NEW_CAP, [], expiresAt));
  while ((await chainTime()) <= expiresAt) {
    await sleep(POLL_MS);
  }
  expectChain((await chainTime()) > expiresAt, 'the newest block is past the grant expiry');
  await refuse('an expired grant refuses the agent', [agent.wallet], () => spend(context, slot, pay(SMALL_SPEND), agent, true), 'control: the same payment after the renewal');
  await accept('ACCEPT renew an expired grant', [context.owner.wallet], () => rewriteGrant(renewal(context, slot, agent.keyHash, scopeOf(NEW_PER_CALL, NEW_CAP))));
  await accept('ACCEPT the agent spends after the expired grant is renewed', [agent.wallet], () => spend(context, slot, pay(SMALL_SPEND)));
};

/** Accepted: a renewal moves the grant to another key. */
const changeGrantee = async (context: AccountContext): Promise<void> => {
  const slot = await issue(context, agent.keyHash, scopeOf(NEW_PER_CALL, NEW_CAP));
  await accept('ACCEPT renew with another grantee', [context.owner.wallet], () => rewriteGrant(renewal(context, slot, newAgent.keyHash, scopeOf(NEW_PER_CALL, NEW_CAP))));
  expectChain((await grantAt(context, slot)).grant.grantee === newAgent.keyHash, 'the datum names the new grantee');
  await refuse('the old grantee can no longer spend', [agent.wallet], () => spend(context, slot, pay(SMALL_SPEND), agent, true, [deployment.minswap], { grantee: newAgent.keyHash, signer: agent.keyHash }), 'control: the new grantee below');
  await accept('ACCEPT the new grantee spends', [newAgent.wallet], () => spend(context, slot, pay(SMALL_SPEND), newAgent));
};

/** Accepted: a renewal adds a policy to a recipient, which then has to run. */
const addPolicy = async (context: AccountContext): Promise<void> => {
  const orderAddress = Cometa.EnterpriseAddress.fromCredentials(Cometa.NetworkId.Testnet, { hash: MINSWAP_ORDER_SCRIPT, type: Cometa.CredentialType.ScriptHash }).toAddress().toString();
  const slot = await issue(context, agent.keyHash, scopeOf(NEW_PER_CALL, NEW_CAP, [{ address: orderAddress }]));
  await accept('ACCEPT a datumless order before the policy is added', [agent.wallet], () => spend(context, slot, [orderOutput(orderAddress)]), 'plain recipient runs no policy');
  const policy: GrantPolicy = { script: deployment.minswapHash, settings: minswapSettings(context.owner.keyHash) };
  await accept('ACCEPT renew adding a Minswap policy to the recipient', [context.owner.wallet], () => rewriteGrant(renewal(context, slot, agent.keyHash, scopeOf(NEW_PER_CALL, NEW_CAP, [{ address: orderAddress, policy }]))));
  expectChain((await grantAt(context, slot)).grant.scope.recipients[0]?.policy?.script === deployment.minswapHash, 'the datum names the policy');
  await refuse('the policied recipient refuses a spend that runs no policy', [agent.wallet], () => spend(context, slot, [orderOutput(orderAddress)], agent, true, [deployment.minswap], { runPolicies: [] }), 'control: the valid order below');
  await accept('ACCEPT a valid order runs the policy after the renewal', [agent.wallet], () => spend(context, slot, [orderOutput(orderAddress, minswapOrder(context.owner.keyHash, context.record.address))]));
};

/** Accepted: a renewal beside the sweep of another, dead grant. */
const renewBesideSweep = async (context: AccountContext): Promise<void> => {
  const dead = await issue(context, agent.keyHash, scopeOf(OLD_PER_CALL, OLD_CAP));
  const live = await issue(context, agent.keyHash, scopeOf(OLD_PER_CALL, OLD_CAP));
  const { txId } = await submitAndConfirm([context.owner.wallet], () => revokeGrant({ ...ownerParams(context), slot: dead }));
  note('revoke the grant to sweep', txId, `slot ${dead}`);
  const before = await read(context);
  await accept('ACCEPT renew beside the sweep of another dead grant', [context.owner.wallet], () => rewriteGrant(renewal(context, live, agent.keyHash, scopeOf(NEW_PER_CALL, NEW_CAP), { sweptSlots: [dead] })));
  const after = await read(context);
  expectChain(after.state.outstanding === before.state.outstanding - 1n, 'outstanding fell by the one grant swept');
  expectChain(!after.grants.some(({ prefix }) => prefix.slot === dead), 'the swept grant UTxO is gone');
  expectChain((await grantAt(context, live)).grant.scope.cap === NEW_CAP, 'the renewed grant carries the new cap');
};

/** Refusals of a tampered output, each followed by a control that differs only in the tampering. */
const tamperedOutputs = async (context: AccountContext): Promise<void> => {
  const slot = await issue(context, agent.keyHash, scopeOf(OLD_PER_CALL, OLD_CAP));
  const scope = scopeOf(NEW_PER_CALL, NEW_CAP);
  const tokenScript: NativeScript = { type: Cometa.ScriptType.Native, kind: Cometa.NativeScriptKind.RequireSignature, keyHash: funding.keyHash };
  const tokenId = `${Cometa.computeScriptHash(tokenScript)}${TEST_TOKEN_NAME}`;
  const minted = await submitAndConfirm([funding.wallet], async () =>
    (await funding.wallet.createTransactionBuilder()).mintToken({ assetIdHex: tokenId, amount: 1n }).addScript(tokenScript).sendValue({ address: context.record.address, value: { coins: 3n * ADA, assets: { [tokenId]: 1n } } }).build(),
  );
  note('mint a token into the account for the extra token attack', minted.txId);
  /** Refuses a tampered renewal, then accepts the same renewal untampered. */
  const attack = async (step: string, tamper: RewriteGrantTamper, lovelace?: bigint): Promise<void> => {
    await refuse(step, [context.owner.wallet], () => uncheckedRenewal(context, slot, agent.keyHash, scope, tamper, undefined, lovelace));
    await accept(`${step.split(' ')[0]} control: the same renewal untampered`, [context.owner.wallet], () => uncheckedRenewal(context, slot, agent.keyHash, scope));
  };
  await attack('R4 changed generation in the datum', { grant: (grant) => ({ ...grant, generation: grant.generation + 1n }) });
  await attack('R5 changed slot in the datum', { grant: (grant) => ({ ...grant, slot: grant.slot + 1n }) });
  await attack('R6 grant output sent to another address', { address: recipient.address });
  await attack('R7 extra token on the grant output', { assets: { [tokenId]: 1n } }, 4n * ADA);
  await attack('R8 reference script on the grant output', { scriptReference: deployment.minswap }, 20n * ADA);
  await refuse('R9 malformed scope, a negative cap', [context.owner.wallet], () => uncheckedRenewal(context, slot, agent.keyHash, { ...scope, cap: -1n }));
  await accept('R9 control: the same renewal with a sound cap', [context.owner.wallet], () => uncheckedRenewal(context, slot, agent.keyHash, scope));
  await refuse('R3 no device signature, the grantee signs alone', [agent.wallet], () => uncheckedRenewal(context, slot, agent.keyHash, scope, undefined, agent.wallet));
  await accept('R3 control: the same renewal signed by the device', [context.owner.wallet], () => uncheckedRenewal(context, slot, agent.keyHash, scope));
  await accept('R1 control: the same renewal before the revoke', [context.owner.wallet], () => uncheckedRenewal(context, slot, agent.keyHash, scope));
  const { txId } = await submitAndConfirm([context.owner.wallet], () => revokeGrant({ ...ownerParams(context), slot }));
  note('revoke the grant', txId, `slot ${slot}`);
  await refuse('R1 renew a revoked grant', [context.owner.wallet], () => uncheckedRenewal(context, slot, agent.keyHash, scope));
};

/** The documented contention: the agent spends first, the owner's renewal fails on the stale input and a rebuild lands. */
const contention = async (context: AccountContext): Promise<void> => {
  const slot = await issue(context, agent.keyHash, scopeOf(NEW_PER_CALL, NEW_CAP));
  const scope = scopeOf(NEW_PER_CALL, NEW_CAP * 2n);
  const stale = await rewriteGrant(renewal(context, slot, agent.keyHash, scope));
  const staleSigned = await signed([context.owner.wallet], stale);
  const { utxo } = await grantAt(context, slot);
  const spent = await accept('R11 the agent spends the grant first', [agent.wallet], () => spend(context, slot, pay(SMALL_SPEND)));
  const message = await refused('R11 the renewal built before that spend', 'input', context.owner.wallet, staleSigned, 'expects the stale grant input');
  expectChain(message.includes(utxo.input.txId), 'the node names the stale grant outpoint');
  expectChain(spent.txId !== utxo.input.txId, 'the grant UTxO moved');
  await accept('R11 control: the renewal rebuilt against the new UTxO', [context.owner.wallet], () => rewriteGrant(renewal(context, slot, agent.keyHash, scope)));
};

/** A superseded grant: renewal works until the generation bumps, then it is refused. */
const superseded = async (context: AccountContext): Promise<void> => {
  const slot = await issue(context, agent.keyHash, scopeOf(OLD_PER_CALL, OLD_CAP));
  const scope = scopeOf(NEW_PER_CALL, NEW_CAP);
  await accept('R2 control: the same renewal before the generation bump', [context.owner.wallet], () => uncheckedRenewal(context, slot, agent.keyHash, scope));
  const { txId } = await submitAndConfirm([context.owner.wallet], () => revokeAllGrants(ownerParams(context)));
  note('bump the grant generation', txId);
  await refuse('R2 renew a superseded grant', [context.owner.wallet], () => uncheckedRenewal(context, slot, agent.keyHash, scope));
};

/** The renewal with scripts attached instead of referenced, on a small and on the largest state. */
const attached = (step: string, context: AccountContext, slot: bigint, grantee: string, scope: Scope): Promise<Built> =>
  accept(step, [context.owner.wallet], () => rewriteGrant({ ...renewal(context, slot, grantee, scope), network: { network: DEVNET_NETWORK, references: [] } }), 'scripts attached');

/** Measures the renewal at the largest state, with the grant input behind the deposits. */
const largestState = async (context: AccountContext): Promise<void> => {
  const padding = Array.from({ length: MAX_DEVICES - 1 }, (_, index) => (index + 1).toString(16).padStart(2, '0').repeat(28));
  const { state } = await read(context);
  const big: AccountState = { ...state, devices: [...padding, context.owner.keyHash], revoked: Array.from({ length: MAX_REVOKED }, (_, index) => BigInt(1000 + index)) };
  const { txId } = await submitAndConfirm([context.owner.wallet], () => rewriteState({ ...ownerParams(context), newState: big }));
  note('write the largest state', txId, `${MAX_DEVICES} devices, ${MAX_REVOKED} revoked`);
  const policy: GrantPolicy = { script: deployment.minswapHash, settings: minswapSettings(context.owner.keyHash) };
  const recipients: Recipient[] = Array.from({ length: MAX_RECIPIENTS }, (_, index) => ({
    address: Cometa.EnterpriseAddress.fromCredentials(Cometa.NetworkId.Testnet, { hash: (index + 16).toString(16).padStart(2, '0').repeat(28), type: Cometa.CredentialType.ScriptHash }).toAddress().toString(),
    policy,
  }));
  const scope = scopeOf(NEW_PER_CALL, NEW_CAP, recipients);
  const slot = await issue(context, agent.keyHash, scope);
  const renewedScope = scopeOf(NEW_PER_CALL, NEW_CAP * 2n, recipients);
  await accept('M2 ACCEPT renew at the largest state, 8 policied recipients', [context.owner.wallet], () => rewriteGrant(renewal(context, slot, agent.keyHash, renewedScope)), 'references');
  await attached('M4b ACCEPT renew at the largest state, scripts attached', context, slot, agent.keyHash, renewedScope).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    rows.push({ step: 'M4b renew at the largest state, scripts attached', result: 'did not fit', txId: '-', memory: '', steps: '', fee: '', size: '', note: message.slice(0, 160) });
    console.log(`M4b did not fit: ${message.slice(0, 300)}`);
  });
  const deposits = await submitAndConfirm([funding.wallet], async () => {
    const builder = await funding.wallet.createTransactionBuilder();
    for (let index = 0; index < DEPOSIT_COUNT; index += 1) {
      builder.sendValue({ address: context.record.address, value: { coins: DEPOSIT_LOVELACE } });
    }
    return builder.build();
  });
  note('pay the deposits', deposits.txId, `${DEPOSIT_COUNT} outputs`);
  for (let attempt = 0; attempt < POSITION_ATTEMPTS; attempt += 1) {
    const { utxo } = await grantAt(context, slot);
    if (utxo.input.txId > deposits.txId) {
      break;
    }
    const moved = await submitAndConfirm([context.owner.wallet], () => rewriteGrant(renewal(context, slot, agent.keyHash, renewedScope)));
    note('renew again to move the grant behind the deposits', moved.txId);
  }
  const { funds } = await read(context);
  const grant = await grantAt(context, slot);
  const available = funds.reduce((total, utxo) => total + utxo.output.value.coins, 0n);
  const lovelace = grant.utxo.output.value.coins + available - 8n * ADA;
  const built = await submitAndConfirm([context.owner.wallet], () => rewriteGrant(renewal(context, slot, agent.keyHash, renewedScope, { lovelace })));
  const body = transactionBodyParts(built.tx);
  const sorted = [...body.inputs].sort((a, b) => (a.txId === b.txId ? a.index - b.index : a.txId < b.txId ? -1 : 1));
  const position = sorted.findIndex((input) => input.txId === grant.utxo.input.txId && input.index === grant.utxo.input.index);
  const behind = sorted.slice(0, position).filter((input) => input.txId === deposits.txId).length;
  await accepted('M3 ACCEPT renew with the grant input behind the deposits, largest state', built, `grant at position ${position + 1} of ${sorted.length}, behind ${behind} deposits, references`);
};

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

/* MAIN ***********************************************************************/

const main = async (): Promise<void> => {
  const network = loadRunEnvironment(loadEnv as (options: { path: string; override?: boolean }) => unknown);
  if (network !== DEVNET_NETWORK) {
    throw new Error(`The proof only runs against the devnet; CARDANO_NETWORK is ${network}`);
  }
  await Cometa.ready();
  target = providerConfiguration();
  provider = new Cometa.BlockfrostProvider({ network: target.networkMagic, projectId: target.projectId, baseUrl: target.baseUrl });
  projectId = target.projectId;
  mnemonics = (process.env['FUNDING_MNEMONIC'] ?? '').trim().split(/\s+/);
  funding = await keyed(0);
  console.log(`funding wallet balance ${(await funding.wallet.getBalance()).coins}`);
  deployment = await deploy();
  console.log(`proxy ${deployment.proxyHash}, logic ${deployment.logicHash}`);
  scriptNames.set(deployment.logicHash, 'logic');
  scriptNames.set(deployment.proxyHash, 'proxy');
  scriptNames.set(deployment.minswapHash, 'minswap');
  agent = await freshOwner();
  newAgent = await freshOwner();
  recipient = await freshOwner();
  await fund(agent.address, AGENT_WALLET_LOVELACE);
  await fund(newAgent.address, AGENT_WALLET_LOVELACE);

  const main_ = await createFundedAccount('A', [300n * ADA]);
  await renewLiveGrant(main_);
  await renewExpiredGrant(main_);
  await changeGrantee(main_);
  await addPolicy(main_);
  await renewBesideSweep(main_);
  await tamperedOutputs(main_);
  await contention(main_);
  const small = await issue(main_, agent.keyHash, scopeOf(NEW_PER_CALL, NEW_CAP));
  await attached('M4a ACCEPT renew a small grant, scripts attached', main_, small, agent.keyHash, scopeOf(NEW_PER_CALL, NEW_CAP * 2n));
  await superseded(await createFundedAccount('B', [60n * ADA]));
  await largestState(await createFundedAccount('C', [60n * ADA]));

  printTable();
  console.log(`limits: ${LIMIT_MEMORY} memory, ${LIMIT_STEPS} steps, ${LIMIT_SIZE} bytes`);
};

main().catch((error: unknown) => {
  printTable();
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
