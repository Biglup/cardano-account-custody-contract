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
import type { NativeScript, PlutusScript, Provider, UTxO, Wallet } from '@biglup/cometa';
import { config as loadEnv } from 'dotenv';
import { accountAddress, paymentKeyHashOf, rewardAddress } from '../src/address.js';
import { accountScript, accountScriptHash, loadBlueprint, logicValidator } from '../src/blueprint.js';
import { Cometa } from '../src/cometa.js';
import { DEVNET_NETWORK, ENV_PATH, type ProviderConfiguration, isSetupOnly, loadRunEnvironment, providerConfiguration } from '../src/config.js';
import { posixTimeToSlot, transactionBodyParts } from '../src/body.js';
import { type AccountState, type Asset, type Scope, encodeLogicRedeemer } from '../src/data.js';
import { type AccountRecord, accountByOwner, accountExists } from '../src/discovery.js';
import { type NetworkScripts, type ReferenceScriptRecord, loadNetworkScripts, networkFilePath, referenceOf, resolveReferenceScript } from '../src/network.js';
import { minimumUtxoLovelace } from '../src/output.js';
import { currentLogicHash, currentLogicScript, logicScript, logicScriptHash } from '../src/logic.js';
import { fixtureLogicScript } from './fixture-logic.js';
import { stakeScript, stakeScriptHash } from '../src/stake-script.js';
import { LOVELACE } from '../src/state.js';
import {
  type AccountOutput,
  UNCHECKED_EXECUTION_UNITS,
  addDevice,
  createAccount,
  delegateStake,
  deposit,
  findAccountUtxos,
  fixedBudgetEvaluator,
  fundBatches,
  issueGrant,
  removeDevice,
  revokeAllGrants,
  revokeGrant,
  rewriteState,
  spendWithDevice,
  spendWithGrant,
  survivingGrantRequests,
  sweepGrant,
  upgradeLogic,
  withdrawRewards,
} from '../src/transactions.js';
import { addBalances, toBalance, toValue } from '../src/value.js';
import {
  AGENT_GRANT_SLOT,
  AGENT_WALLET_LOVELACE,
  CAP,
  DEPOSIT_LOVELACE,
  DEVICE_SPEND_LOVELACE,
  type ExecutionLimits,
  FIRST_LARGEST_SLOT,
  FLOW_PLAN,
  type Flow,
  type FlowRecord,
  GENERATION_AFTER_UPGRADE,
  GENERATION_BEFORE_UPGRADE,
  GRANT_BATCH,
  GRANT_LIFETIME_MS,
  GRANT_SPEND_LOVELACE,
  LARGEST_GRANTS,
  LARGEST_RECIPIENTS,
  MINIMUM_FUNDING_LOVELACE,
  NEW_DEVICE_SPEND_LOVELACE,
  OWNER_COLLATERAL_LOVELACE,
  PER_CALL_CAP,
  PRE_UPGRADE_GRANT_SLOT,
  type RedeemerUnits,
  REISSUED_GRANT_SLOT,
  RESERVE_LOVELACE,
  REVOKED_SPEND_LOVELACE,
  ROTATION_KEYS,
  SETUP_PLAN,
  SHORT_GRANT_LIFETIME_MS,
  SHORT_GRANT_SLOT,
  SMALL_DEPOSIT_COUNT,
  SMALL_DEPOSIT_LOVELACE,
  STRANGER_SPEND_LOVELACE,
  SWEEP_BATCH,
  SWEEP_FEE_BOUND,
  SWEEP_GRANT_CAP,
  SWEEP_GRANT_SLOT,
  type SupportingTransaction,
  TOKEN_CAP,
  TOKEN_DEPOSIT_LOVELACE,
  TOKEN_GRANT_SLOT,
  TOKEN_LOVELACE_CAP,
  TOKEN_LOVELACE_PER_CALL_CAP,
  TOKEN_NAME_HEX,
  TOKEN_OVER_CAP,
  TOKEN_PER_CALL_CAP,
  TOKEN_SPEND_LOVELACE,
  TOKEN_SUPPLY,
  UPGRADE_DEPOSIT_LOVELACE,
  WITHDRAWN_LOVELACE,
  classifyFailure,
  evidenceDocument,
  isNodePhaseOneRefusal,
  isNodeScriptRefusal,
  nodeRefusalSummary,
} from './flow-plan.js';

/* CONSTANTS ******************************************************************/

/** The repository root, where the environment file and the evidence document live. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** How long to wait for a transaction to be confirmed and for the provider's view to catch up. */
const CONFIRMATION_TIMEOUT_MS = 10 * 60 * 1000;
const UTXO_VIEW_TIMEOUT_MS = 5 * 60 * 1000;

/** How long to wait for Blockfrost to index the redeemers of a confirmed transaction. */
const REDEEMER_VIEW_TIMEOUT_MS = 60 * 1000;

/**
 * How often the run asks the provider again and how far its view of the
 * current slot can lag behind the wall clock, per network. A devnet
 * confirms in about a second and runs beside the process, so it is asked
 * far more often than the hosted endpoint, which rate limits.
 */
const VIEW_POLL_MS: Record<string, number> = { preprod: 5_000, devnet: 250 };
const SLOT_VIEW_LAG_MS: Record<string, number> = { preprod: 120_000, devnet: 5_000 };

/** The extra time added past the provider's lag before the expiry flow attempts its spend. */
const EXPIRY_SAFETY_MARGIN_MS = 20_000;

/**
 * How many slots a grant spend stays valid for and how long the held
 * spend stays valid while the revoke lands, per network. A validity bound
 * must fall inside the slots the ledger can still translate to a time,
 * which reaches far on preprod and only a stability window past the
 * current epoch on a devnet whose epochs are minutes long.
 */
const VALIDITY_WINDOW_SLOTS: Record<string, bigint> = { preprod: 600n, devnet: 90n };
const HELD_WINDOW_SLOTS: Record<string, bigint> = { preprod: 3_600n, devnet: 120n };

/** How few slots the expiry attempt asks for. */
const EXPIRED_WINDOW_SLOTS = 5n;

/** The parameter an unregistered logic credential is derived from in the setup, which is no proxy hash. */
const UNREGISTERED_LOGIC_PARAMETER = '00'.repeat(28);

/** The message printed when the funding wallet cannot pay for the run. */
const FUND_MESSAGE = 'Fund this address with tADA from the preprod faucet and rerun';
const DEVNET_FUND_MESSAGE = 'Fill this address with "npm run devnet:bootstrap" and rerun';

/** How many registered pools are examined before giving up on finding an active one. */
const POOL_CANDIDATES = 10;

/**
 * The account indexes of the mnemonic a run derives its keys from: the
 * owner wallet takes the first candidate index whose stake credential is
 * not registered, trying every stride from the first index on, and the
 * agent, the recipient and the rotation keys take the indexes that follow
 * it within the stride, so that no run shares a key with another. The
 * funding wallet is index 0.
 */
const FIRST_OWNER_ACCOUNT = 15;
const OWNER_ACCOUNT_STRIDE = 10;
const OWNER_ACCOUNT_CANDIDATES = 50;
const AGENT_OFFSET = 1;
const RECIPIENT_OFFSET = 2;
const ROTATION_OFFSET = 3;

/** The password cometa encrypts the derived keys with, fresh for every process. */
const password = randomBytes(32);

/**
 * Where this run submits and reads from and the slot configuration of the
 * chain behind it, taken from the environment before any flow runs. The
 * same flows run against preprod or against the devnet by it alone.
 */
let target: ProviderConfiguration;

/** How often this run asks the provider again, and how far past an expiry it waits before attempting a spend. */
let viewPollMs: number;
let expiryMarginMs: number;

/** How many slots a grant spend and a held spend of this run stay valid for. */
let validityWindowSlots: bigint;
let heldWindowSlots: bigint;

/* TYPES **********************************************************************/

/** The owner wallet of a run, its account index and the account identifiers its payment key fixes. */
interface Owner {
  owner: Wallet;
  ownerAccount: number;
  ownerAddress: string;
  ownerKeyHash: string;
  stakeCredential: string;
  reward: string;
}

/** A wallet derived from the mnemonic with its address and payment key hash. */
interface Keyed {
  wallet: Wallet;
  address: string;
  keyHash: string;
}

/** The keys, addresses and identifiers every flow works with. */
interface Actors {
  provider: Provider;
  projectId: string;
  funding: Wallet;
  owner: Wallet;
  agent: Wallet;
  recipient: Wallet;
  fundingAddress: string;
  ownerAddress: string;
  agentAddress: string;
  recipientAddress: string;
  ownerKeyHash: string;
  agentKeyHash: string;
  /** The rotation keys the largest state adds as devices, six at first and a seventh that replaces the sixth. */
  rotation: Keyed[];
  /** What the agent persists to find the account: it never holds the owner key or wallet. */
  record: AccountRecord;
  /** The reference scripts recorded for the network, or none, in which case the builders embed the scripts. */
  network: NetworkScripts;
  poolId: string;
  /** The native policy of the test token, requiring the funding wallet's signature, and the token's asset. */
  tokenScript: NativeScript;
  token: Asset;
  /**
   * The throwaway second logic of the upgrade fixture project applied to
   * the proxy hash. It is outside the blueprint, so every builder of the
   * run is given it among the logics it may attach, both before the
   * upgrade, when no account names it, and after, when the account does.
   */
  secondLogic: PlutusScript;
}

/** A redeemer of a transaction as Blockfrost lists it. */
interface BlockfrostRedeemer {
  tx_index: number;
  purpose: string;
  unit_mem: string;
  unit_steps: string;
}

/* FUNCTIONS ******************************************************************/

/** Hands cometa a copy of the password, since it wipes what it is given after use. */
const getPassword = (): Promise<Uint8Array> => Promise.resolve(new Uint8Array(password));

/** Sleeps for a number of milliseconds. */
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** The slot the current wall clock time falls in on the network this run targets. */
const currentSlot = (): bigint => posixTimeToSlot(BigInt(Date.now()), target.slotConfig);

/** The mnemonic words of the funding wallet, or undefined when the environment holds none. */
const fundingMnemonic = (): string[] | undefined => {
  const words = (process.env['FUNDING_MNEMONIC'] ?? '').trim().split(/\s+/).filter((word) => word.length > 0);
  return words.length === 0 ? undefined : words;
};

/** Stores a freshly generated mnemonic in the environment file without printing it. */
const storeMnemonic = (words: string[]): void => {
  const line = `FUNDING_MNEMONIC=${words.join(' ')}`;
  const current = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
  const next = /^FUNDING_MNEMONIC=\s*$/m.test(current)
    ? current.replace(/^FUNDING_MNEMONIC=\s*$/m, line)
    : `${current}${current.length > 0 && !current.endsWith('\n') ? '\n' : ''}${line}\n`;
  writeFileSync(ENV_PATH, next, { mode: 0o600 });
};

/** A single address wallet of one account of the funding mnemonic. */
const walletOf = (provider: Provider, mnemonics: string[], account: number): Promise<Wallet> =>
  Cometa.SingleAddressWallet.createFromMnemonics({
    mnemonics,
    provider,
    getPassword,
    credentialsConfig: { account, paymentIndex: 0, stakingIndex: 0 },
  });

/** A wallet of one account of the mnemonic with its address and payment key hash. */
const keyedWalletOf = async (provider: Provider, mnemonics: string[], account: number, name: string): Promise<Keyed> => {
  const wallet = await walletOf(provider, mnemonics, account);
  const address = (await wallet.getChangeAddress()).toString();
  const keyHash = paymentKeyHashOf(address);
  if (!keyHash) {
    throw new Error(`The ${name} wallet did not derive a key address`);
  }
  return { wallet, address, keyHash };
};

/**
 * Signs a built transaction with every wallet that must witness it. Each
 * wallet contributes its own witness set, so a sponsored transaction
 * gathers the owner's signature and the sponsor's without either wallet
 * seeing the other's keys.
 */
const signedBy = async (signers: Wallet[], tx: string): Promise<string> => {
  const witnesses = [];
  for (const wallet of signers) {
    witnesses.push(...(await wallet.signTransaction(tx, true)));
  }
  return Cometa.applyVkeyWitnessSet(tx, witnesses);
};

/** Signs a built transaction with every wallet that must witness it and submits it through the first, returning the transaction id. */
const submit = async (signers: Wallet[], tx: string): Promise<string> => {
  const [submitter] = signers;
  if (!submitter) {
    throw new Error('A transaction needs at least one signer');
  }
  return submitter.submitTransaction(await signedBy(signers, tx));
};

/** Polls an address until the provider lists an output of the transaction at it. */
const waitForOutput = async (provider: Provider, address: string, txId: string): Promise<void> => {
  const deadline = Date.now() + UTXO_VIEW_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const utxos = await provider.getUnspentOutputs(address);
    if (utxos.some((utxo) => utxo.input.txId === txId)) {
      return;
    }
    await sleep(viewPollMs);
  }
  throw new Error(`The provider never listed an output of ${txId} at ${address}`);
};

/** Blockfrost's answer to a query, or undefined when the resource does not exist. */
const blockfrost = async <T>(projectId: string, path: string): Promise<T | undefined> => {
  const response = await fetch(`${target.baseUrl}${path}`, { headers: { project_id: projectId } });
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`Blockfrost answered ${path} with status ${response.status}`);
  }
  return (await response.json()) as T;
};

/** Whether Blockfrost lists a reward account as registered; a never registered account is not listed at all. */
const isStakeCredentialRegistered = async (projectId: string, rewardAddress: string): Promise<boolean> => {
  const account = await blockfrost<{ active: boolean }>(projectId, `/accounts/${rewardAddress}`);
  return account?.active === true;
};

/**
 * The execution units the chain recorded for every redeemer of a
 * confirmed transaction, read from Blockfrost, which indexes them a
 * moment after the transaction itself. A transaction carrying redeemers
 * is polled until they appear or the wait runs out.
 */
const executionUnitsOf = async (projectId: string, txId: string, expected: number): Promise<RedeemerUnits[]> => {
  const deadline = Date.now() + REDEEMER_VIEW_TIMEOUT_MS;
  for (;;) {
    const redeemers = (await blockfrost<BlockfrostRedeemer[]>(projectId, `/txs/${txId}/redeemers`)) ?? [];
    if (redeemers.length >= expected || Date.now() >= deadline) {
      return redeemers.map((redeemer) => ({
        purpose: redeemer.purpose,
        index: redeemer.tx_index,
        memory: BigInt(redeemer.unit_mem),
        steps: BigInt(redeemer.unit_steps),
      }));
    }
    await sleep(viewPollMs);
  }
};

/**
 * The first registered pool of the network that is not retiring and has
 * live stake, so that the delegation flow names a pool the ledger accepts.
 */
const firstActivePool = async (projectId: string): Promise<string> => {
  const pools = (await blockfrost<string[]>(projectId, `/pools?count=${POOL_CANDIDATES}`)) ?? [];
  for (const poolId of pools) {
    const pool = await blockfrost<{ retirement: unknown[]; live_stake: string }>(projectId, `/pools/${poolId}`);
    if (pool && pool.retirement.length === 0 && BigInt(pool.live_stake) > 0n) {
      return poolId;
    }
  }
  throw new Error(`None of the first ${POOL_CANDIDATES} registered pools of the network is active`);
};

/**
 * The owner wallet of this run: the wallet of the first candidate account
 * index of the mnemonic whose stake credential is not registered. An
 * account is never deleted and its credential stays registered for life,
 * so an owner key that already created an account can never create
 * another, and every run takes a fresh one. The wallet starts empty and
 * only ever receives its collateral UTxO and what the flows pay to the
 * owner address.
 */
const freshOwner = async (provider: Provider, projectId: string, mnemonics: string[], scriptHash: string): Promise<Owner> => {
  for (let candidate = 0; candidate < OWNER_ACCOUNT_CANDIDATES; candidate += 1) {
    const ownerAccount = FIRST_OWNER_ACCOUNT + candidate * OWNER_ACCOUNT_STRIDE;
    const { wallet: owner, address: ownerAddress, keyHash: ownerKeyHash } = await keyedWalletOf(provider, mnemonics, ownerAccount, 'owner');
    const stakeCredential = stakeScriptHash(stakeScript(ownerKeyHash, scriptHash));
    const reward = rewardAddress(stakeCredential).toBech32();
    if (!(await isStakeCredentialRegistered(projectId, reward))) {
      console.log(`Owner wallet: account index ${ownerAccount} of the mnemonic`);
      return { owner, ownerAccount, ownerAddress, ownerKeyHash, stakeCredential, reward };
    }
  }
  throw new Error(`Every owner account index from ${FIRST_OWNER_ACCOUNT} in strides of ${OWNER_ACCOUNT_STRIDE} already has a registered stake credential`);
};

/** Polls an address until the provider lists nothing at it. */
const waitForEmpty = async (provider: Provider, address: string): Promise<void> => {
  const deadline = Date.now() + UTXO_VIEW_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await provider.getUnspentOutputs(address)).length === 0) {
      return;
    }
    await sleep(viewPollMs);
  }
  throw new Error(`The provider still lists outputs at ${address}`);
};

/** Polls the endpoint until it holds a submitted transaction, which it does a block after the submission. */
const waitForTransaction = async (projectId: string, txId: string): Promise<void> => {
  const deadline = Date.now() + CONFIRMATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await blockfrost<{ hash: string }>(projectId, `/txs/${txId}`)) !== undefined) {
      return;
    }
    await sleep(viewPollMs);
  }
};

/**
 * Waits for a submitted transaction to be confirmed and for every address
 * it pays to show its outputs. The endpoint is polled for the transaction
 * first, since the provider's own wait sleeps for twenty seconds between
 * attempts, which is longer than a devnet block takes to hold it.
 */
const settle = async (provider: Provider, projectId: string, txId: string, tx: string): Promise<void> => {
  await waitForTransaction(projectId, txId);
  const confirmed = await provider.confirmTransaction(txId, CONFIRMATION_TIMEOUT_MS);
  if (!confirmed) {
    throw new Error(`Transaction ${txId} was not confirmed within ${CONFIRMATION_TIMEOUT_MS / 1000} seconds`);
  }
  for (const address of new Set(transactionBodyParts(tx).outputs.map((output) => output.address))) {
    await waitForOutput(provider, address, txId);
  }
};

/** The slots from a first slot on, as many as asked. */
const slotsFrom = (first: bigint, count: number): bigint[] => Array.from({ length: count }, (_, index) => first + BigInt(index));

/** The execution units one transaction may use on the network this run targets, read from its protocol parameters. */
const executionLimits = async (provider: Provider): Promise<ExecutionLimits> => {
  const { maxTxExUnits } = await provider.getParameters();
  return { memory: BigInt(maxTxExUnits.memory), steps: BigInt(maxTxExUnits.steps) };
};

/** Runs the flows in order, recording transactions, refusals and execution units for the evidence document. */
class Run {
  readonly records: FlowRecord[] = [];
  readonly supporting: SupportingTransaction[] = [];

  constructor(private readonly actors: Actors) {}

  /** The flow of the plan with a step number. */
  private flow(step: number): Flow {
    const flow = FLOW_PLAN.find((candidate) => candidate.step === step);
    if (!flow) {
      throw new Error(`The plan has no step ${step}`);
    }
    return flow;
  }

  /** The record of a flow, created on first use. */
  private record(step: number): FlowRecord {
    const existing = this.records.find((record) => record.flow.step === step);
    if (existing) {
      return existing;
    }
    const record: FlowRecord = { flow: this.flow(step), txIds: [], measured: [] };
    this.records.push(record);
    console.log(`Step ${step}: ${record.flow.description}`);
    return record;
  }

  /**
   * Builds, signs, submits and settles a transaction that must succeed,
   * then reads the execution units the chain recorded for its redeemers
   * when it ran any script.
   */
  async confirm(step: number, description: string, signers: Wallet[], build: () => Promise<string>): Promise<string> {
    const record = this.record(step);
    const tx = await build();
    const txId = await submit(signers, tx);
    console.log(`  ${txId} ${description}`);
    await settle(this.actors.provider, this.actors.projectId, txId, tx);
    record.txIds.push(txId);
    const expected = Cometa.readRedeemersFromTx(tx).length;
    if (expected > 0) {
      const redeemers = await executionUnitsOf(this.actors.projectId, txId, expected);
      const memory = redeemers.reduce((total, redeemer) => total + redeemer.memory, 0n);
      const steps = redeemers.reduce((total, redeemer) => total + redeemer.steps, 0n);
      console.log(`  ${redeemers.length} redeemers, ${memory} memory units, ${steps} steps`);
      record.measured?.push({ txId, redeemers });
    }
    return txId;
  }

  /** Builds, signs, submits and settles a transaction outside the plan. */
  async support(description: string, signers: Wallet[], build: () => Promise<string>): Promise<string> {
    const tx = await build();
    const txId = await submit(signers, tx);
    console.log(`  ${txId} ${description}`);
    await settle(this.actors.provider, this.actors.projectId, txId, tx);
    this.supporting.push({ description, txId });
    return txId;
  }

  /** Checks a refusal message against the pattern the flow expects and records it. */
  private recordRefusal(step: number, refusedBy: string, message: string, summary: string): void {
    const record = this.record(step);
    const expected = record.flow.expectedMessage;
    if (!expected) {
      throw new Error(`Step ${step} has no expected message pattern to verify the ${refusedBy} refusal against`);
    }
    if (!expected.test(message)) {
      throw new Error(`Step ${step} was refused by the ${refusedBy} but the message did not match ${expected}: ${message}`);
    }
    record.refusal = summary;
    console.log(`  refused by the ${refusedBy}: ${summary}`);
  }

  /**
   * Attempts a transaction that the builder must refuse while applying
   * the contract's rules, so that nothing reaches the chain. The error is
   * accepted only when it classifies as a refusal and its message matches
   * the flow's expected pattern, so that an unrelated builder error at the
   * same step is never recorded as the expected refusal. The refusal is
   * then recorded; a network error, any other error, a mismatched message
   * or a built transaction fails the run.
   */
  async refuseInBuilder(step: number, description: string, build: () => Promise<string>): Promise<void> {
    this.record(step);
    try {
      await build();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const kind = classifyFailure(error);
      if (kind !== 'refusal' || isNodeScriptRefusal(error)) {
        throw new Error(`Step ${step} failed with a ${kind} error instead of a refusal by the builder: ${message}`);
      }
      this.recordRefusal(step, 'builder', message, message);
      return;
    }
    throw new Error(`Step ${step} was not refused: ${description} was built`);
  }

  /**
   * Builds a transaction without the builder's checks, signs it and
   * submits it, expecting the node to refuse it because the validator
   * fails in phase two. The node runs the scripts while validating the
   * transaction for its mempool and rejects a failing one outright, so
   * the transaction never enters a block and no collateral is consumed;
   * Blockfrost reports that rejection as a submission error carrying the
   * ledger's failure, which is recorded once its text also matches the
   * flow's expected pattern. Should the node accept the transaction
   * instead, the run stops without retrying: either the validator passed
   * a spend it must refuse, or the transaction entered a block as invalid
   * and took the wallet's collateral, and both need a look before
   * anything else is submitted.
   */
  async refuseAtNode(step: number, description: string, signers: Wallet[], build: () => Promise<string>): Promise<void> {
    this.record(step);
    const tx = await build();
    let txId: string;
    try {
      txId = await submit(signers, tx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isNodeScriptRefusal(error)) {
        throw new Error(`Step ${step} failed with a ${classifyFailure(error)} error instead of a refusal by the node: ${message}`);
      }
      this.recordRefusal(step, 'node', message, nodeRefusalSummary(message));
      return;
    }
    throw new Error(
      `Step ${step} was not refused: ${description} was accepted as ${txId}. Check whether it entered a block and consumed the collateral of ${
        this.actors.agentAddress
      } before submitting anything else`,
    );
  }

  /**
   * Submits a transaction signed earlier, expecting the node to refuse it
   * in phase one because an input it references was spent since it was
   * built. No script runs in phase one, so no collateral is at stake; the
   * ledger's failure is recorded once its text matches the flow's
   * expected pattern. Should the node accept the transaction instead, the
   * run stops, since the held spend would then have passed a revoke.
   */
  async refuseInPhaseOne(step: number, description: string, submitter: Wallet, signedTx: string): Promise<void> {
    this.record(step);
    let txId: string;
    try {
      txId = await submitter.submitTransaction(signedTx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isNodePhaseOneRefusal(error)) {
        throw new Error(`Step ${step} failed with a ${classifyFailure(error)} error instead of a phase one refusal by the node: ${message}`);
      }
      this.recordRefusal(step, 'node in phase one', message, nodeRefusalSummary(message));
      return;
    }
    throw new Error(`Step ${step} was not refused: ${description} was accepted as ${txId} after the revoke landed`);
  }

  /** A lovelace scope with the run's caps, paying the given recipients only, expiring after a lifetime from now. */
  private scope(lifetimeMs: bigint, recipients: string[] = [this.actors.ownerAddress], perCallCap = PER_CALL_CAP, cap = CAP): Scope {
    return {
      asset: LOVELACE,
      perCallCap,
      cap,
      lovelacePerCallCap: 0n,
      lovelaceCap: 0n,
      expiresAt: BigInt(Date.now()) + lifetimeMs,
      recipients,
    };
  }

  /** The token scope: a few tokens per call with some lovelace alongside, paying the recipient wallet only. */
  private tokenScope(): Scope {
    return {
      asset: this.actors.token,
      perCallCap: TOKEN_PER_CALL_CAP,
      cap: TOKEN_CAP,
      lovelacePerCallCap: TOKEN_LOVELACE_PER_CALL_CAP,
      lovelaceCap: TOKEN_LOVELACE_CAP,
      expiresAt: BigInt(Date.now()) + GRANT_LIFETIME_MS,
      recipients: [this.actors.recipientAddress],
    };
  }

  /** The eight recipients of the largest grants: every address the run derives. */
  private largestRecipients(): string[] {
    const { ownerAddress, agentAddress, recipientAddress, fundingAddress, rotation } = this.actors;
    return [ownerAddress, agentAddress, recipientAddress, fundingAddress, ...rotation.map((keyed) => keyed.address)].slice(0, LARGEST_RECIPIENTS);
  }

  /** The parameters every owner transaction shares: the owner key is the account's initial device and the owner of its stake script. */
  private get ownerParams() {
    const { owner, provider, ownerKeyHash, network, secondLogic } = this.actors;
    return { wallet: owner, provider, owner: ownerKeyHash, network, logics: [secondLogic], slotConfig: target.slotConfig };
  }

  /** The parameters every agent transaction shares: the agent wallet signs and provides the collateral, and the account comes from the persisted record. */
  private get agentParams() {
    const { agent, provider, record, network, secondLogic } = this.actors;
    return { wallet: agent, provider, record, network, logics: [secondLogic], slotConfig: target.slotConfig };
  }

  /**
   * A grant spend paying one output, valid for a window of slots from
   * now. An unchecked spend skips the builder's checks so that the
   * validator is the one to refuse it.
   */
  private grantSpend(slot: bigint, output: AccountOutput, windowSlots: bigint, unchecked = false, feeBound?: bigint): Promise<string> {
    const params = {
      ...this.agentParams,
      slot,
      grantee: this.actors.agentKeyHash,
      outputs: [output],
      validUntilSlot: currentSlot() + windowSlots,
      unchecked,
    };
    return spendWithGrant(feeBound === undefined ? params : { ...params, feeBound });
  }

  /** A grant spend paying lovelace to one address. */
  private lovelaceSpend(slot: bigint, address: string, lovelace: bigint, windowSlots: bigint, unchecked = false): Promise<string> {
    return this.grantSpend(slot, { address, value: { coins: lovelace } }, windowSlots, unchecked);
  }

  /** A token grant spend paying tokens with some lovelace to the recipient wallet. */
  private tokenSpend(tokens: bigint, unchecked = false): Promise<string> {
    const { recipientAddress, token } = this.actors;
    const output: AccountOutput = { address: recipientAddress, value: { coins: TOKEN_SPEND_LOVELACE, assets: { [`${token.policyId}${token.assetName}`]: tokens } } };
    return this.grantSpend(TOKEN_GRANT_SLOT, output, validityWindowSlots, unchecked);
  }

  /** Gives a wallet lovelace from the funding wallet unless it holds at least half the amount already. */
  private async fund(name: string, wallet: Wallet, address: string, lovelace: bigint): Promise<void> {
    const { funding } = this.actors;
    const balance = (await wallet.getBalance()).coins;
    if (balance >= lovelace / 2n) {
      console.log(`The ${name} wallet already holds ${balance} lovelace`);
      return;
    }
    await this.support(`fund the ${name} wallet with ${lovelace} lovelace`, [funding], async () =>
      (await funding.createTransactionBuilder()).sendLovelace({ address, amount: lovelace }).build(),
    );
  }

  /** Gives the owner wallet its one collateral UTxO, the only ADA it ever holds of its own. */
  fundOwnerCollateral(): Promise<void> {
    const { owner, ownerAddress } = this.actors;
    return this.fund('owner', owner, ownerAddress, OWNER_COLLATERAL_LOVELACE);
  }

  /** Gives the agent wallet lovelace for collateral and fees. */
  fundAgentWallet(): Promise<void> {
    const { agent, agentAddress } = this.actors;
    return this.fund('agent', agent, agentAddress, AGENT_WALLET_LOVELACE);
  }

  /**
   * Returns everything a wallet holds to the funding wallet and waits
   * until the provider no longer lists anything at its address, so that a
   * run started right after this one sees the wallet empty rather than a
   * stale view of the swept outputs.
   */
  private async sweep(name: string, wallet: Wallet, address: string): Promise<void> {
    const { provider, fundingAddress } = this.actors;
    const utxos = await wallet.getUnspentOutputs();
    if (utxos.length === 0) {
      return;
    }
    await this.support(`return the ${name} wallet balance to the funding wallet`, [wallet], async () => {
      const builder = await wallet.createTransactionBuilder();
      for (const utxo of utxos) {
        builder.addInput({ utxo });
      }
      return builder.setChangeAddress(fundingAddress).build();
    });
    await waitForEmpty(provider, address);
  }

  /** Returns the owner wallet's balance to the funding wallet. */
  sweepOwnerWallet(): Promise<void> {
    const { owner, ownerAddress } = this.actors;
    return this.sweep('owner', owner, ownerAddress);
  }

  /** Returns the agent wallet's balance to the funding wallet. */
  sweepAgentWallet(): Promise<void> {
    const { agent, agentAddress } = this.actors;
    return this.sweep('agent', agent, agentAddress);
  }

  /** Returns the recipient wallet's tokens and lovelace to the funding wallet. */
  sweepRecipientWallet(): Promise<void> {
    const { recipient, recipientAddress } = this.actors;
    return this.sweep('recipient', recipient, recipientAddress);
  }

  /**
   * An owner spend paying every fund and reserve UTxO of the account,
   * tokens included, to the funding wallet, which sponsors the fee so
   * that nothing returns to the account and only the control UTxO stays.
   */
  private async sweepAccount(): Promise<string> {
    const { provider, funding, fundingAddress } = this.actors;
    const { funds, reserves } = await findAccountUtxos(provider, this.ownerParams);
    const balance = addBalances(...[...funds, ...reserves].map((utxo) => toBalance(utxo.output.value)));
    return spendWithDevice({ ...this.ownerParams, sponsor: funding, outputs: [{ address: fundingAddress, value: toValue(balance) }] });
  }

  /** The fund UTxOs of the account as the agent sees them, largest first. */
  private async fundsLargestFirst(): Promise<UTxO[]> {
    const { funds } = await findAccountUtxos(this.actors.provider, { ...this.agentParams });
    return [...funds].sort((a, b) => Number(b.output.value.coins - a.output.value.coins));
  }

  /** The least lovelace a plain change output at the account address may hold. */
  private async changeFloor(): Promise<bigint> {
    const { provider, record } = this.actors;
    return minimumUtxoLovelace({ address: record.address, value: { coins: 0n } }, BigInt((await provider.getParameters()).adaPerUtxoByte));
  }

  /**
   * An agent sweep of the given fund UTxOs under the sweep grant: it pays
   * the funding wallet everything they hold beyond the fee bound and the
   * change floor, so that the selection, which takes the largest fund
   * UTxOs first, needs exactly those UTxOs and the change returns as a
   * single plain deposit at the floor.
   */
  private sweepOf(funds: UTxO[], floor: bigint, unchecked: boolean): Promise<string> {
    const total = funds.reduce((sum, utxo) => sum + utxo.output.value.coins, 0n);
    const output: AccountOutput = { address: this.actors.fundingAddress, value: { coins: total - SWEEP_FEE_BOUND - floor } };
    return this.grantSpend(SWEEP_GRANT_SLOT, output, validityWindowSlots, unchecked, SWEEP_FEE_BOUND);
  }

  /**
   * A grant spend over one more fund UTxO than a checked spend may take,
   * the largest ones, which the builder refuses while selecting the
   * inputs, before anything is evaluated or submitted. The output asks
   * for everything those UTxOs hold beyond the fee bound and the change
   * floor, so the selection, largest first, needs exactly those UTxOs.
   */
  private async overBoundSpend(): Promise<string> {
    const funds = (await this.fundsLargestFirst()).slice(0, SWEEP_BATCH + 1);
    if (funds.length !== SWEEP_BATCH + 1) {
      throw new Error(`The account holds ${funds.length} fund UTxOs, fewer than the ${SWEEP_BATCH + 1} the spend over the bound needs`);
    }
    return this.sweepOf(funds, await this.changeFloor(), false);
  }

  /**
   * Sweeps every fund UTxO of the account in the batches `fundBatches`
   * splits it into, largest first, as many batches as the count at the
   * start needs; each sweep takes the first batch of what the account
   * holds then, since the change of the one before it is a fund UTxO the
   * next batch or the owner's final sweep takes. The first batch spends exactly
   * `SWEEP_BATCH` fund UTxOs, so the heaviest grant spend the library
   * submits is confirmed and measured, and at least the twenty small
   * deposits must be spent over the batches.
   */
  private async sweepFundsInBatches(step: number): Promise<void> {
    const { agent } = this.actors;
    const floor = await this.changeFloor();
    const planned = fundBatches(await this.fundsLargestFirst(), SWEEP_BATCH).length;
    let spent = 0;
    for (let batch = 0; batch < planned; batch += 1) {
      const [funds = []] = fundBatches(await this.fundsLargestFirst(), SWEEP_BATCH);
      if (batch === 0 && funds.length !== SWEEP_BATCH) {
        throw new Error(`The first sweep batch takes ${funds.length} fund UTxOs instead of ${SWEEP_BATCH}`);
      }
      await this.confirm(step, `spendWithGrant sweeping ${funds.length} fund UTxOs to the funding wallet`, [agent], async () => {
        const tx = await this.sweepOf(funds, floor, false);
        const inputs = transactionBodyParts(tx).inputs.filter((input) => funds.some((utxo) => utxo.input.txId === input.txId && utxo.input.index === input.index));
        if (inputs.length !== funds.length) {
          throw new Error(`The sweep spends ${inputs.length} fund UTxOs instead of the ${funds.length} selected`);
        }
        spent += inputs.length;
        return tx;
      });
    }
    if (spent < SMALL_DEPOSIT_COUNT) {
      throw new Error(`The sweeps spent ${spent} fund UTxOs, fewer than the ${SMALL_DEPOSIT_COUNT} deposits`);
    }
    console.log(`  the sweeps spent ${spent} fund UTxOs over ${planned} transactions`);
  }

  /** Creation, deposits, the first owner spend and the stake operations of the owner device. */
  private async basics(): Promise<void> {
    const { funding, owner, ownerAddress, ownerKeyHash, poolId } = this.actors;
    const initialState: Omit<AccountState, 'logic'> = { devices: [ownerKeyHash], grantGeneration: 0n, nextSlot: 0n, revoked: [], outstanding: 0n };

    await this.confirm(1, 'createAccount sponsored by the funding wallet', [owner, funding], () =>
      createAccount({ ...this.ownerParams, sponsor: funding, state: initialState }),
    );
    await this.confirm(2, `deposit ${DEPOSIT_LOVELACE} lovelace from the funding wallet`, [funding], () =>
      deposit({ ...this.ownerParams, wallet: funding, value: { coins: DEPOSIT_LOVELACE } }),
    );
    await this.confirm(3, `deposit ${RESERVE_LOVELACE} lovelace as a reserve from the funding wallet`, [funding], () =>
      deposit({ ...this.ownerParams, wallet: funding, value: { coins: RESERVE_LOVELACE }, reserve: true }),
    );
    await this.confirm(4, `spendWithDevice ${DEVICE_SPEND_LOVELACE} lovelace to the owner`, [owner], () =>
      spendWithDevice({ ...this.ownerParams, outputs: [{ address: ownerAddress, value: { coins: DEVICE_SPEND_LOVELACE } }] }),
    );
    await this.confirm(5, `withdrawRewards ${WITHDRAWN_LOVELACE} lovelace signed by the owner device`, [owner], () =>
      withdrawRewards({ ...this.ownerParams, amount: WITHDRAWN_LOVELACE }),
    );
    await this.confirm(6, `delegateStake to ${poolId} signed by the owner device`, [owner], () => delegateStake({ ...this.ownerParams, poolId }));
  }

  /** The lovelace grant: one spend within the caps, then the cap and recipient refusals by the builder and by the node. */
  private async lovelaceGrant(): Promise<void> {
    const { owner, agent, ownerAddress, agentAddress, agentKeyHash } = this.actors;
    await this.confirm(7, `issueGrant slot ${AGENT_GRANT_SLOT} to the agent`, [owner], () =>
      issueGrant({ ...this.ownerParams, grants: [{ grantee: agentKeyHash, scope: this.scope(GRANT_LIFETIME_MS) }] }),
    );
    await this.confirm(8, `spendWithGrant ${GRANT_SPEND_LOVELACE} lovelace to the owner`, [agent], () =>
      this.lovelaceSpend(AGENT_GRANT_SLOT, ownerAddress, GRANT_SPEND_LOVELACE, validityWindowSlots),
    );
    await this.refuseInBuilder(9, `spendWithGrant ${GRANT_SPEND_LOVELACE} lovelace beyond the remaining cap`, () =>
      this.lovelaceSpend(AGENT_GRANT_SLOT, ownerAddress, GRANT_SPEND_LOVELACE, validityWindowSlots),
    );
    await this.refuseAtNode(10, `spendWithGrant ${GRANT_SPEND_LOVELACE} lovelace beyond the remaining cap, unchecked`, [agent], () =>
      this.lovelaceSpend(AGENT_GRANT_SLOT, ownerAddress, GRANT_SPEND_LOVELACE, validityWindowSlots, true),
    );
    await this.refuseInBuilder(11, `spendWithGrant ${STRANGER_SPEND_LOVELACE} lovelace to an address outside the recipients`, () =>
      this.lovelaceSpend(AGENT_GRANT_SLOT, agentAddress, STRANGER_SPEND_LOVELACE, validityWindowSlots),
    );
    await this.refuseAtNode(12, `spendWithGrant ${STRANGER_SPEND_LOVELACE} lovelace to an address outside the recipients, unchecked`, [agent], () =>
      this.lovelaceSpend(AGENT_GRANT_SLOT, agentAddress, STRANGER_SPEND_LOVELACE, validityWindowSlots, true),
    );
  }

  /** The token grant: the funding wallet mints and deposits the tokens, the owner issues the grant, the agent is refused over the per call cap and then exhausts the cap. */
  private async tokenGrant(): Promise<void> {
    const { funding, owner, agent, agentKeyHash, record, tokenScript, token } = this.actors;
    const assetId = `${token.policyId}${token.assetName}`;
    await this.confirm(13, `mint ${TOKEN_SUPPLY} test tokens and deposit them into the account`, [funding], async () =>
      (await funding.createTransactionBuilder())
        .mintToken({ assetIdHex: assetId, amount: TOKEN_SUPPLY })
        .addScript(tokenScript)
        .sendValue({ address: record.address, value: { coins: TOKEN_DEPOSIT_LOVELACE, assets: { [assetId]: TOKEN_SUPPLY } } })
        .build(),
    );
    await this.confirm(14, `issueGrant slot ${TOKEN_GRANT_SLOT} over the test token to the agent`, [owner], () =>
      issueGrant({ ...this.ownerParams, grants: [{ grantee: agentKeyHash, scope: this.tokenScope() }] }),
    );
    await this.refuseInBuilder(15, `spendWithGrant ${TOKEN_OVER_CAP} tokens beyond the per call cap`, () => this.tokenSpend(TOKEN_OVER_CAP));
    await this.refuseAtNode(16, `spendWithGrant ${TOKEN_OVER_CAP} tokens beyond the per call cap, unchecked`, [agent], () =>
      this.tokenSpend(TOKEN_OVER_CAP, true),
    );
    for (let call = 0; call < Number(TOKEN_CAP / TOKEN_PER_CALL_CAP); call += 1) {
      await this.confirm(17, `spendWithGrant ${TOKEN_PER_CALL_CAP} tokens with ${TOKEN_SPEND_LOVELACE} lovelace to the recipient`, [agent], () =>
        this.tokenSpend(TOKEN_PER_CALL_CAP),
      );
    }
  }

  /** The revoke that lands under a held agent spend, the refusals of the revoked grant, the generation bump and the sweep of both dead grants. */
  private async revocation(): Promise<void> {
    const { owner, agent, ownerAddress } = this.actors;
    const held = await signedBy([agent], await this.lovelaceSpend(AGENT_GRANT_SLOT, ownerAddress, REVOKED_SPEND_LOVELACE, heldWindowSlots));
    console.log(`  the agent holds a signed spendWithGrant ${REVOKED_SPEND_LOVELACE} lovelace against slot ${AGENT_GRANT_SLOT}`);
    await this.confirm(18, `revokeGrant slot ${AGENT_GRANT_SLOT} while the agent holds its signed spend`, [owner], () =>
      revokeGrant({ ...this.ownerParams, slot: AGENT_GRANT_SLOT }),
    );
    await this.refuseInPhaseOne(18, `the held spendWithGrant ${REVOKED_SPEND_LOVELACE} lovelace`, agent, held);
    await this.refuseInBuilder(19, `spendWithGrant ${REVOKED_SPEND_LOVELACE} lovelace with the revoked grant`, () =>
      this.lovelaceSpend(AGENT_GRANT_SLOT, ownerAddress, REVOKED_SPEND_LOVELACE, validityWindowSlots),
    );
    await this.refuseAtNode(20, `spendWithGrant ${REVOKED_SPEND_LOVELACE} lovelace with the revoked grant, unchecked`, [agent], () =>
      this.lovelaceSpend(AGENT_GRANT_SLOT, ownerAddress, REVOKED_SPEND_LOVELACE, validityWindowSlots, true),
    );
    await this.confirm(21, 'revokeAllGrants', [owner], () => revokeAllGrants(this.ownerParams));
    await this.confirm(22, `sweepGrant slots ${AGENT_GRANT_SLOT} and ${TOKEN_GRANT_SLOT}`, [owner], () =>
      sweepGrant({ ...this.ownerParams, slots: [AGENT_GRANT_SLOT, TOKEN_GRANT_SLOT] }),
    );
  }

  /** The short lived grant: issued, left to expire, refused by the builder and the node, then swept. */
  private async expiry(): Promise<void> {
    const { owner, agent, ownerAddress, agentKeyHash } = this.actors;
    const shortScope = this.scope(SHORT_GRANT_LIFETIME_MS);
    await this.confirm(23, `issueGrant slot ${SHORT_GRANT_SLOT} expiring in ${SHORT_GRANT_LIFETIME_MS / 1000n} seconds`, [owner], () =>
      issueGrant({ ...this.ownerParams, grants: [{ grantee: agentKeyHash, scope: shortScope }] }),
    );
    const resumeAt = Number(shortScope.expiresAt) + expiryMarginMs;
    const waitMs = resumeAt - Date.now();
    if (waitMs > 0) {
      console.log(`  waiting ${Math.ceil(waitMs / 1000)} seconds for grant ${SHORT_GRANT_SLOT} to expire`);
      await sleep(waitMs);
    }
    await this.refuseInBuilder(23, `spendWithGrant ${REVOKED_SPEND_LOVELACE} lovelace with the expired grant`, () =>
      this.lovelaceSpend(SHORT_GRANT_SLOT, ownerAddress, REVOKED_SPEND_LOVELACE, EXPIRED_WINDOW_SLOTS),
    );
    await this.refuseAtNode(24, `spendWithGrant ${REVOKED_SPEND_LOVELACE} lovelace with the expired grant, unchecked`, [agent], () =>
      this.lovelaceSpend(SHORT_GRANT_SLOT, ownerAddress, REVOKED_SPEND_LOVELACE, validityWindowSlots, true),
    );
    await this.confirm(25, `sweepGrant slot ${SHORT_GRANT_SLOT} after its expiry`, [owner], () =>
      sweepGrant({ ...this.ownerParams, slots: [SHORT_GRANT_SLOT], validFromSlot: posixTimeToSlot(shortScope.expiresAt, target.slotConfig) + 1n }),
    );
  }

  /** Issues two batches of the largest grants to the agent, taking the next slots in order. */
  private async issueLargestGrants(step: number): Promise<void> {
    const { owner, agentKeyHash } = this.actors;
    const scope = this.scope(GRANT_LIFETIME_MS, this.largestRecipients(), NEW_DEVICE_SPEND_LOVELACE, NEW_DEVICE_SPEND_LOVELACE);
    const grants = Array.from({ length: GRANT_BATCH }, () => ({ grantee: agentKeyHash, scope }));
    for (let batch = 0; batch < LARGEST_GRANTS / GRANT_BATCH; batch += 1) {
      await this.confirm(step, `issueGrant ${GRANT_BATCH} grants with ${LARGEST_RECIPIENTS} recipients each`, [owner], () =>
        issueGrant({ ...this.ownerParams, grants }),
      );
    }
  }

  /** Revokes the given slots one transaction at a time. */
  private async revokeSlots(step: number, slots: bigint[]): Promise<void> {
    const { owner } = this.actors;
    for (const slot of slots) {
      await this.confirm(step, `revokeGrant slot ${slot}`, [owner], () => revokeGrant({ ...this.ownerParams, slot }));
    }
  }

  /** Sweeps the given dead slots in batches of eight. */
  private async sweepSlots(step: number, slots: bigint[]): Promise<void> {
    const { owner } = this.actors;
    for (let start = 0; start < slots.length; start += GRANT_BATCH) {
      const batch = slots.slice(start, start + GRANT_BATCH);
      await this.confirm(step, `sweepGrant slots ${batch[0]} to ${batch[batch.length - 1]}`, [owner], () =>
        sweepGrant({ ...this.ownerParams, slots: batch }),
      );
    }
  }

  /**
   * Builds the largest state the validators admit and rewrites it: seven
   * devices are added, sixteen largest grants are issued, revoked one by
   * one and swept, sixteen more are issued and revoked one by one, which
   * fills the revoked list, then the state is rewritten with one rotation
   * key replaced and the sixteen dead grants are swept.
   */
  private async largestState(): Promise<void> {
    const { owner, agentKeyHash, rotation } = this.actors;
    const added = [agentKeyHash, ...rotation.slice(0, ROTATION_KEYS).map((keyed) => keyed.keyHash)];
    for (const device of added) {
      await this.confirm(26, `addDevice ${device}`, [owner], () => addDevice({ ...this.ownerParams, device }));
    }
    const firstRound = slotsFrom(FIRST_LARGEST_SLOT, LARGEST_GRANTS);
    const secondRound = slotsFrom(FIRST_LARGEST_SLOT + BigInt(LARGEST_GRANTS), LARGEST_GRANTS);
    await this.issueLargestGrants(27);
    await this.revokeSlots(28, firstRound);
    await this.sweepSlots(29, firstRound);
    await this.issueLargestGrants(30);
    await this.revokeSlots(31, secondRound);

    const retired = rotation[ROTATION_KEYS - 1]?.keyHash;
    const replacement = rotation[ROTATION_KEYS]?.keyHash;
    if (retired === undefined || replacement === undefined) {
      throw new Error(`The run needs ${ROTATION_KEYS + 1} rotation keys`);
    }
    await this.confirm(32, `rewriteState replacing device ${retired} with ${replacement}`, [owner], async () => {
      const { state } = await findAccountUtxos(this.actors.provider, this.ownerParams);
      return rewriteState({ ...this.ownerParams, newState: { ...state, devices: state.devices.map((device) => (device === retired ? replacement : device)) } });
    });
    await this.sweepSlots(33, secondRound);
  }

  /** The agent device spends and withdraws from the persisted record, then the funding wallet deposits twenty UTxOs the agent sweeps under a wide grant, in batches after a spend over one more fund UTxO than the bound is shown refused. */
  private async agentDeviceAndSweep(): Promise<void> {
    const { funding, owner, agent, ownerAddress, fundingAddress, agentKeyHash, record } = this.actors;
    await this.confirm(34, `spendWithDevice ${NEW_DEVICE_SPEND_LOVELACE} lovelace signed by the agent device`, [agent], () =>
      spendWithDevice({ ...this.agentParams, outputs: [{ address: ownerAddress, value: { coins: NEW_DEVICE_SPEND_LOVELACE } }] }),
    );
    await this.confirm(35, `withdrawRewards ${WITHDRAWN_LOVELACE} lovelace signed by the agent device`, [agent], () =>
      withdrawRewards({ ...this.agentParams, amount: WITHDRAWN_LOVELACE }),
    );
    await this.confirm(36, `deposit ${SMALL_DEPOSIT_COUNT} UTxOs of ${SMALL_DEPOSIT_LOVELACE} lovelace from the funding wallet`, [funding], async () => {
      const builder = await funding.createTransactionBuilder();
      for (let index = 0; index < SMALL_DEPOSIT_COUNT; index += 1) {
        builder.sendLovelace({ address: record.address, amount: SMALL_DEPOSIT_LOVELACE });
      }
      return builder.build();
    });
    await this.confirm(37, `issueGrant slot ${SWEEP_GRANT_SLOT} to the agent paying the funding wallet`, [owner], () =>
      issueGrant({ ...this.ownerParams, grants: [{ grantee: agentKeyHash, scope: this.scope(GRANT_LIFETIME_MS, [fundingAddress], SWEEP_GRANT_CAP, SWEEP_GRANT_CAP) }] }),
    );
    await this.refuseInBuilder(38, `spendWithGrant over ${SWEEP_BATCH + 1} fund UTxOs`, () => this.overBoundSpend());
    await this.sweepFundsInBatches(39);
  }

  /** Removes the agent key and the rotation keys, then sweeps the account to its control UTxO. */
  private async teardown(): Promise<void> {
    const { owner, funding, agentKeyHash, rotation } = this.actors;
    await this.confirm(40, 'removeDevice the agent wallet key', [owner], () => removeDevice({ ...this.ownerParams, device: agentKeyHash }));
    const { state } = await findAccountUtxos(this.actors.provider, this.ownerParams);
    for (const device of rotation.map((keyed) => keyed.keyHash).filter((keyHash) => state.devices.includes(keyHash))) {
      await this.confirm(41, `removeDevice ${device}`, [owner], () => removeDevice({ ...this.ownerParams, device }));
    }
    await this.support('revokeAllGrants, which kills the sweep grant', [owner], () => revokeAllGrants(this.ownerParams));
    await this.support(`sweepGrant slot ${SWEEP_GRANT_SLOT}, the last outstanding grant, so that only the control UTxO is left to sweep`, [owner], () =>
      sweepGrant({ ...this.ownerParams, slots: [SWEEP_GRANT_SLOT] }),
    );
    await this.confirm(42, 'spendWithDevice sweeping every fund and reserve UTxO to the funding wallet, sponsored by it', [owner, funding], () =>
      this.sweepAccount(),
    );
  }

  /** Throws unless the account names the logic and sits at the generation the plan expects at a point of the run. */
  private async assertAccountAt(logic: string, generation: bigint, when: string): Promise<AccountState> {
    const { state } = await findAccountUtxos(this.actors.provider, this.ownerParams);
    if (state.logic !== logic) {
      throw new Error(`The account names logic ${state.logic} ${when}, not ${logic}`);
    }
    if (state.grantGeneration !== generation) {
      throw new Error(`The account is at generation ${state.grantGeneration} ${when}, not the ${generation} the plan expects`);
    }
    return state;
  }

  /**
   * Step 43, the setup of the second logic on the network: its credential
   * registered through the logic publish handler and the script parked at
   * the always fail address the proxy is parked at, both paid by the
   * funding wallet and appended to the network file, from which every
   * later builder references it. On a network whose file records the
   * second logic already the parked UTxO is checked through the provider
   * and reused, and the step lists the transaction that parked it.
   */
  private async setUpSecondLogic(logic: PlutusScript): Promise<void> {
    const { provider, funding, network } = this.actors;
    const logicHash = logicScriptHash(logic);
    const proxy = referenceOf(network, accountScriptHash(accountScript()));
    if (!proxy) {
      throw new Error('The network file does not record the proxy, so the setup of the second logic has no address to park it at');
    }
    const record = this.record(43);
    const recorded = referenceOf(network, logicHash);
    if (recorded) {
      await resolveReferenceScript(provider, recorded, logic);
      record.txIds.push(recorded.txId);
      console.log(`  the second logic ${logicHash} is registered and parked already at ${recorded.txId}#${recorded.index}`);
      return;
    }
    const adaPerUtxoByte = BigInt((await provider.getParameters()).adaPerUtxoByte);
    await this.confirm(43, `register the second logic credential ${logicHash}`, [funding], () => registerLogic(funding, logic));
    const txId = await this.confirm(43, `park the second logic at ${proxy.address}`, [funding], () => parkScript(funding, proxy.address, logic, adaPerUtxoByte));
    const reference = await parkedRecord(provider, logic, proxy.address, txId, adaPerUtxoByte);
    writeNetworkFile([...network.references, reference]);
    this.actors.network = loadNetworkScripts(target.network);
  }

  /**
   * Steps 43 to 54: the second logic set up on the network, a deposit the
   * owner steps are paid from, a grant issued under the logic the account
   * runs, the upgrade with both logics running, the grant dead by the
   * generation bump, refused by the builder and by the second logic and
   * swept under it, issued again from the surviving requests, spent under
   * it, the move back refused to the grantee by the builder and by the
   * second logic, and the account swept to its control UTxO.
   */
  private async upgrade(): Promise<void> {
    const { funding, owner, agent, ownerAddress, agentKeyHash, secondLogic } = this.actors;
    const scriptHash = accountScriptHash(accountScript());
    const logicHash = currentLogicHash(scriptHash);
    const secondLogicHash = logicScriptHash(secondLogic);
    await this.setUpSecondLogic(secondLogic);
    await this.confirm(44, `deposit ${UPGRADE_DEPOSIT_LOVELACE} lovelace from the funding wallet`, [funding], () =>
      deposit({ ...this.ownerParams, wallet: funding, value: { coins: UPGRADE_DEPOSIT_LOVELACE } }),
    );
    await this.assertAccountAt(logicHash, GENERATION_BEFORE_UPGRADE, "before the grant issued under the contract's logic");
    await this.confirm(45, `issueGrant slot ${PRE_UPGRADE_GRANT_SLOT} to the agent under the contract's logic`, [owner], () =>
      issueGrant({ ...this.ownerParams, grants: [{ grantee: agentKeyHash, scope: this.scope(GRANT_LIFETIME_MS) }] }),
    );
    const before = await findAccountUtxos(this.actors.provider, this.ownerParams);
    if (before.grants.length !== 1 || before.grants[0]?.prefix.slot !== PRE_UPGRADE_GRANT_SLOT) {
      throw new Error(`The account holds ${before.grants.length} grant UTxOs before the upgrade instead of the one in slot ${PRE_UPGRADE_GRANT_SLOT}`);
    }
    await this.confirm(46, `upgradeLogic to ${secondLogicHash}`, [owner], () => upgradeLogic({ ...this.ownerParams, newLogic: secondLogicHash }));
    await this.assertAccountAt(secondLogicHash, GENERATION_AFTER_UPGRADE, 'after the upgrade');
    await this.refuseInBuilder(47, `spendWithGrant ${REVOKED_SPEND_LOVELACE} lovelace with the grant issued before the upgrade`, () =>
      this.lovelaceSpend(PRE_UPGRADE_GRANT_SLOT, ownerAddress, REVOKED_SPEND_LOVELACE, validityWindowSlots),
    );
    await this.refuseAtNode(48, `spendWithGrant ${REVOKED_SPEND_LOVELACE} lovelace with the grant issued before the upgrade, unchecked`, [agent], () =>
      this.lovelaceSpend(PRE_UPGRADE_GRANT_SLOT, ownerAddress, REVOKED_SPEND_LOVELACE, validityWindowSlots, true),
    );
    await this.confirm(49, `sweepGrant slot ${PRE_UPGRADE_GRANT_SLOT} under the second logic`, [owner], () =>
      sweepGrant({ ...this.ownerParams, slots: [PRE_UPGRADE_GRANT_SLOT] }),
    );
    const requests = survivingGrantRequests(before.grants, before.state);
    if (requests.length !== 1 || requests[0]?.grantee !== agentKeyHash) {
      throw new Error(`survivingGrantRequests lists ${requests.length} grants to issue again instead of the one issued before the upgrade`);
    }
    await this.confirm(50, `issueGrant slot ${REISSUED_GRANT_SLOT} from the surviving request under the second logic`, [owner], () =>
      issueGrant({ ...this.ownerParams, grants: requests }),
    );
    await this.confirm(51, `spendWithGrant ${GRANT_SPEND_LOVELACE} lovelace to the owner under the second logic`, [agent], () =>
      this.lovelaceSpend(REISSUED_GRANT_SLOT, ownerAddress, GRANT_SPEND_LOVELACE, validityWindowSlots),
    );
    await this.refuseInBuilder(52, "upgradeLogic back to the contract's logic from the agent wallet", () => upgradeLogic({ ...this.agentParams, newLogic: logicHash }));
    await this.refuseAtNode(53, "upgradeLogic back to the contract's logic assembled on the agent wallet, unchecked", [agent], () =>
      upgradeLogic({ ...this.agentParams, newLogic: logicHash, unchecked: true }),
    );
    await this.support(`revokeGrant slot ${REISSUED_GRANT_SLOT}, which kills the grant issued again under the second logic`, [owner], () =>
      revokeGrant({ ...this.ownerParams, slot: REISSUED_GRANT_SLOT }),
    );
    await this.support(`sweepGrant slot ${REISSUED_GRANT_SLOT}, the last outstanding grant, so that only the control UTxO is left to sweep`, [owner], () =>
      sweepGrant({ ...this.ownerParams, slots: [REISSUED_GRANT_SLOT] }),
    );
    await this.confirm(54, 'spendWithDevice sweeping every fund UTxO to the funding wallet, sponsored by it', [owner, funding], () => this.sweepAccount());
  }

  /** Executes the flows of the plan in order. */
  async flows(): Promise<void> {
    await this.basics();
    await this.lovelaceGrant();
    await this.tokenGrant();
    await this.revocation();
    await this.expiry();
    await this.largestState();
    await this.agentDeviceAndSweep();
    await this.teardown();
    await this.upgrade();
  }
}

/**
 * The address the setup parks the reference scripts at: the logic script
 * as a payment credential, which has no spend handler, so every spend
 * from it fails and nobody can take the parked UTxOs.
 */
const alwaysFailAddress = (logicHash: string): string =>
  Cometa.EnterpriseAddress.fromCredentials(Cometa.NetworkId.Testnet, { hash: logicHash, type: Cometa.CredentialType.ScriptHash }).toAddress().toString();

/** The record of a setup flow, printed as it starts. */
const setupRecord = (step: number, records: FlowRecord[]): FlowRecord => {
  const flow = SETUP_PLAN.find((candidate) => candidate.step === step);
  if (!flow) {
    throw new Error(`The setup plan has no step ${step}`);
  }
  const record: FlowRecord = { flow, txIds: [], measured: [] };
  records.push(record);
  console.log(`Setup ${step}: ${flow.description}`);
  return record;
};

/** Builds, signs, submits and settles a setup transaction that must succeed. */
const confirmSetup = async (
  provider: Provider,
  projectId: string,
  wallet: Wallet,
  record: FlowRecord,
  build: () => Promise<string>,
): Promise<string> => {
  const tx = await build();
  const txId = await submit([wallet], tx);
  console.log(`  ${txId}`);
  await settle(provider, projectId, txId, tx);
  record.txIds.push(txId);
  return txId;
};

/** Registers the credential of a logic script with the Conway deposit through its publish handler, paid by the wallet. */
const registerLogic = async (wallet: Wallet, logic: PlutusScript): Promise<string> =>
  (await wallet.createTransactionBuilder()).registerStakeAddress({ rewardAddress: rewardAddress(logicScriptHash(logic)), redeemer: encodeLogicRedeemer() }).addScript(logic).build();

/** Writes the reference script records of the network this run targets to its network file. */
const writeNetworkFile = (references: ReferenceScriptRecord[]): void => {
  const path = networkFilePath(target.network);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ network: target.network, references }, null, 2)}\n`);
  console.log(`Network file written to ${path}`);
};

/** Parks a script in its own UTxO at the always fail address, holding its minimum lovelace. */
const parkScript = async (wallet: Wallet, address: string, script: PlutusScript, adaPerUtxoByte: bigint): Promise<string> => {
  const output = { address, value: { coins: 0n }, scriptReference: script };
  const coins = minimumUtxoLovelace(output, adaPerUtxoByte);
  return (await wallet.createTransactionBuilder()).addOutput({ ...output, value: { coins } }).build();
};

/** The record of a parked script, as the network file holds it. */
const parkedRecord = async (provider: Provider, script: PlutusScript, address: string, txId: string, adaPerUtxoByte: bigint): Promise<ReferenceScriptRecord> => {
  const utxos = await provider.getUnspentOutputs(address);
  const parked = utxos.find((utxo) => utxo.input.txId === txId && utxo.output.scriptReference !== undefined);
  if (!parked) {
    throw new Error(`The parked script of ${txId} is not at ${address}`);
  }
  return {
    scriptHash: Cometa.computeScriptHash(script),
    txId,
    index: parked.input.index,
    address,
    lovelace: minimumUtxoLovelace({ address, value: { coins: 0n }, scriptReference: script }, adaPerUtxoByte).toString(),
  };
};

/**
 * A bare zero withdrawal from the credential of a logic script in a
 * plain transaction of a wallet, built with fixed budgets so that no
 * evaluation stands in for the node, and signed, ready to submit.
 */
const bareWithdrawal = async (wallet: Wallet, logic: PlutusScript): Promise<string> =>
  signedBy(
    [wallet],
    await (await wallet.createTransactionBuilder())
      .setTxEvaluator(fixedBudgetEvaluator(UNCHECKED_EXECUTION_UNITS))
      .withdrawRewards({ rewardAddress: rewardAddress(logicScriptHash(logic)), amount: 0n, redeemer: encodeLogicRedeemer() })
      .addScript(logic)
      .build(),
  );

/**
 * Submits a signed setup transaction the node must refuse, checks that
 * the refusal is of the kind the flow expects and that its text matches
 * the flow's pattern, and records it. A transaction the node accepts
 * instead fails the setup.
 */
const refuseSetup = async (wallet: Wallet, record: FlowRecord, signedTx: string, refusedBy: string, isExpected: (error: unknown) => boolean): Promise<void> => {
  let txId: string;
  try {
    txId = await wallet.submitTransaction(signedTx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isExpected(error) || !record.flow.expectedMessage?.test(message)) {
      throw new Error(`Setup step ${record.flow.step} failed with ${message} instead of a refusal by the ${refusedBy}`);
    }
    record.refusal = nodeRefusalSummary(message);
    console.log(`  refused by the ${refusedBy}: ${record.refusal}`);
    return;
  }
  throw new Error(`Setup step ${record.flow.step} was not refused: the withdrawal was accepted as ${txId}`);
};

/**
 * Runs the setup plan of a network once: the logic credential is
 * registered with the Conway deposit through the logic publish handler,
 * the proxy and the logic are parked as reference scripts at the always
 * fail address, a bare zero withdrawal from the registered credential is
 * shown refused by the logic in phase two, since with no control UTxO
 * spent or referenced it takes its arrival path and finds no control
 * output, and a zero withdrawal from an unregistered credential, the
 * same logic applied to another parameter, is shown refused by the node
 * before any script runs. The records it parks are written to the
 * network file.
 */
const setUpNetwork = async (provider: Provider, projectId: string, funding: Wallet, scriptHash: string): Promise<FlowRecord[]> => {
  const records: FlowRecord[] = [];
  const proxy = accountScript();
  const logic = currentLogicScript(scriptHash);
  const logicHash = logicScriptHash(logic);
  const parkedAt = alwaysFailAddress(logicHash);
  const adaPerUtxoByte = BigInt((await provider.getParameters()).adaPerUtxoByte);
  console.log(`Network setup: logic ${logicHash} parked at ${parkedAt}`);

  await confirmSetup(provider, projectId, funding, setupRecord(1, records), () => registerLogic(funding, logic));

  const references: ReferenceScriptRecord[] = [];
  for (const [step, script] of [[2, proxy] as const, [3, logic] as const]) {
    const txId = await confirmSetup(provider, projectId, funding, setupRecord(step, records), () => parkScript(funding, parkedAt, script, adaPerUtxoByte));
    references.push(await parkedRecord(provider, script, parkedAt, txId, adaPerUtxoByte));
  }

  await refuseSetup(funding, setupRecord(4, records), await bareWithdrawal(funding, logic), 'node', isNodeScriptRefusal);

  const stranger = logicScript(logicValidator(loadBlueprint()), UNREGISTERED_LOGIC_PARAMETER);
  await refuseSetup(funding, setupRecord(5, records), await bareWithdrawal(funding, stranger), 'node in phase one', isNodePhaseOneRefusal);

  writeNetworkFile(references);
  return records;
};

/**
 * Prints what the setup of a network left behind: the transactions of
 * every step, the reference scripts parked with the lovelace each holds,
 * the reward address of the registered logic credential and what the
 * funding wallet paid. A network whose file already records the proxy and
 * the current logic is set up and nothing was submitted.
 */
const reportSetup = async (funding: Wallet, fundingAddress: string, before: bigint, scriptHash: string, setup: FlowRecord[] | undefined): Promise<void> => {
  const logicHash = currentLogicHash(scriptHash);
  if (setup === undefined) {
    console.log(`The network file of ${target.network} already records the proxy ${scriptHash} and the logic ${logicHash}`);
    return;
  }
  for (const record of setup) {
    console.log(`Setup ${record.flow.step}: ${record.txIds.join(' ') || record.refusal || record.flow.outcome}`);
  }
  for (const reference of loadNetworkScripts(target.network).references) {
    console.log(`Parked ${reference.scriptHash} at ${reference.txId}#${reference.index} holding ${reference.lovelace} lovelace`);
  }
  console.log(`Logic reward address: ${rewardAddress(logicHash).toBech32()}`);
  const after = (await funding.getBalance()).coins;
  console.log(`Funding address: ${fundingAddress}`);
  console.log(`Funding balance: ${before} lovelace before the setup, ${after} lovelace after it, ${before - after} lovelace spent`);
};

/** Prints the funding address and the funding request of the network, then ends the process successfully. */
const askForFunds = (address: string): never => {
  console.log(address);
  console.log(target.network === DEVNET_NETWORK ? DEVNET_FUND_MESSAGE : FUND_MESSAGE);
  process.exit(0);
};

/**
 * Runs the setup of the network the environment names when its file does
 * not record one, then every flow against it, and writes the evidence
 * document. A run the environment asks for the setup alone stops once the
 * setup is recorded and writes no evidence, since the document states a
 * full run.
 */
const main = async (): Promise<void> => {
  loadRunEnvironment(loadEnv as (options: { path: string; override?: boolean }) => unknown);
  await Cometa.ready();
  target = providerConfiguration();
  viewPollMs = VIEW_POLL_MS[target.network] ?? 5_000;
  expiryMarginMs = (SLOT_VIEW_LAG_MS[target.network] ?? 120_000) + EXPIRY_SAFETY_MARGIN_MS;
  validityWindowSlots = VALIDITY_WINDOW_SLOTS[target.network] ?? 600n;
  heldWindowSlots = HELD_WINDOW_SLOTS[target.network] ?? 3_600n;
  const evidencePath = resolve(REPO_ROOT, 'docs', `${target.network}-evidence.md`);
  const { projectId } = target;
  const provider = new Cometa.BlockfrostProvider({ network: target.networkMagic, projectId, baseUrl: target.baseUrl });
  console.log(`Network: ${target.network} at ${target.baseUrl}`);
  const limits = await executionLimits(provider);
  console.log(`Execution unit limits: ${limits.memory} memory units and ${limits.steps} steps per transaction`);

  let mnemonics = fundingMnemonic();
  const generated = mnemonics === undefined;
  if (mnemonics === undefined) {
    mnemonics = Cometa.entropyToMnemonic(randomBytes(32));
    storeMnemonic(mnemonics);
  }
  const { wallet: funding, address: fundingAddress, keyHash: fundingKeyHash } = await keyedWalletOf(provider, mnemonics, 0, 'funding');
  if (generated) {
    askForFunds(fundingAddress);
  }
  const balance = (await funding.getBalance()).coins;
  if (balance < MINIMUM_FUNDING_LOVELACE) {
    askForFunds(fundingAddress);
  }

  const scriptHash = accountScriptHash(accountScript());
  const recorded = loadNetworkScripts(target.network);
  const setUpAlready = referenceOf(recorded, scriptHash) !== undefined && referenceOf(recorded, currentLogicHash(scriptHash)) !== undefined;
  const setup = setUpAlready ? undefined : await setUpNetwork(provider, projectId, funding, scriptHash);
  if (isSetupOnly()) {
    await reportSetup(funding, fundingAddress, balance, scriptHash, setup);
    return;
  }
  const { owner, ownerAccount, ownerAddress, ownerKeyHash, stakeCredential, reward } = await freshOwner(provider, projectId, mnemonics, scriptHash);
  const address = accountAddress(scriptHash, stakeCredential).toString();
  const discovered = accountByOwner(ownerKeyHash);
  if (discovered.address !== address || discovered.stakeScriptHash !== stakeCredential || discovered.rewardAddress !== reward) {
    throw new Error('Account discovery from the owner key disagrees with the derived account');
  }
  const record: AccountRecord = { owner: discovered.owner, stakeScriptHash: discovered.stakeScriptHash, address: discovered.address };
  const { wallet: agent, address: agentAddress, keyHash: agentKeyHash } = await keyedWalletOf(provider, mnemonics, ownerAccount + AGENT_OFFSET, 'agent');
  const { wallet: recipient, address: recipientAddress } = await keyedWalletOf(provider, mnemonics, ownerAccount + RECIPIENT_OFFSET, 'recipient');
  const rotation: Keyed[] = [];
  for (let index = 0; index <= ROTATION_KEYS; index += 1) {
    rotation.push(await keyedWalletOf(provider, mnemonics, ownerAccount + ROTATION_OFFSET + index, `rotation ${index + 1}`));
  }
  const tokenScript: NativeScript = { type: Cometa.ScriptType.Native, kind: Cometa.NativeScriptKind.RequireSignature, keyHash: fundingKeyHash };
  const token: Asset = { policyId: Cometa.computeScriptHash(tokenScript), assetName: TOKEN_NAME_HEX };
  const poolId = await firstActivePool(projectId);
  const network = loadNetworkScripts(target.network);
  const actors: Actors = {
    provider,
    projectId,
    funding,
    owner,
    agent,
    recipient,
    fundingAddress,
    ownerAddress,
    agentAddress,
    recipientAddress,
    ownerKeyHash,
    agentKeyHash,
    rotation,
    record,
    network,
    poolId,
    tokenScript,
    token,
    secondLogic: fixtureLogicScript(scriptHash),
  };

  const run = new Run(actors);
  console.log(`Funding address: ${fundingAddress}`);
  console.log(`Owner address: ${ownerAddress}`);
  console.log(`Agent address: ${agentAddress}`);
  console.log(`Recipient address: ${recipientAddress}`);
  console.log(`Account address: ${address}`);
  console.log(`Account script hash: ${scriptHash}`);
  console.log(`Account stake credential: ${stakeCredential}`);
  console.log(`Reward address: ${reward}`);
  console.log(`Delegation pool: ${poolId}`);
  console.log(`Test token policy id: ${token.policyId}`);

  await run.fundOwnerCollateral();
  await run.fundAgentWallet();
  await run.flows();
  await run.sweepAgentWallet();
  await run.sweepOwnerWallet();
  await run.sweepRecipientWallet();

  const secondLogicHash = logicScriptHash(actors.secondLogic);
  const remaining = await provider.getUnspentOutputs(address);
  const live = await accountExists(provider, record);
  if (remaining.length !== 1 || !live || live.state.devices.length !== 1) {
    throw new Error(`The account address should hold only its control UTxO with the owner device after the sweep but holds ${remaining.length} UTxOs`);
  }
  if (live.logic !== secondLogicHash) {
    throw new Error(`The account should run the second logic ${secondLogicHash} after the run but names ${live.logic}`);
  }
  if (!(await isStakeCredentialRegistered(projectId, reward))) {
    throw new Error(`Blockfrost no longer lists ${reward} as registered`);
  }

  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(
    evidencePath,
    evidenceDocument({
      network: target.network,
      limits,
      date: new Date().toISOString().slice(0, 10),
      ...(setup === undefined ? {} : { setup }),
      fundingAddress,
      ownerAddress,
      agentAddress,
      recipientAddress,
      accountAddress: address,
      scriptHash,
      stakeScriptHash: stakeCredential,
      rewardAddress: reward,
      poolId,
      tokenPolicyId: token.policyId,
      logicHash: currentLogicHash(scriptHash),
      secondLogicHash,
      records: run.records,
      supporting: run.supporting,
    }),
  );
  console.log(`Evidence written to ${evidencePath}`);
};

/* MAIN ***********************************************************************/

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
