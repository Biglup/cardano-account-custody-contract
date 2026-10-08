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
import type { Provider, Wallet } from '@biglup/cometa';
import { config as loadEnv } from 'dotenv';
import { accountAddress, paymentKeyHashOf, rewardAddress } from '../src/address.js';
import { accountScript, accountScriptHash } from '../src/blueprint.js';
import { Cometa } from '../src/cometa.js';
import { posixTimeToSlot, transactionBodyParts } from '../src/body.js';
import type { AccountState, Grant, Scope } from '../src/data.js';
import { type AccountRecord, accountByOwner, accountExists } from '../src/discovery.js';
import { stakeScript, stakeScriptHash } from '../src/stake-script.js';
import { LOVELACE } from '../src/state.js';
import {
  addDevice,
  createAccount,
  delegateStake,
  deposit,
  findAccountUtxos,
  issueGrant,
  removeDevice,
  revokeAllGrants,
  revokeGrant,
  spendWithDevice,
  spendWithGrant,
  withdrawRewards,
} from '../src/transactions.js';
import {
  AGENT_GRANT_SLOT,
  AGENT_WALLET_LOVELACE,
  CAP,
  DEPOSIT_LOVELACE,
  DEVICE_SPEND_LOVELACE,
  FLOW_PLAN,
  type Flow,
  type FlowRecord,
  GRANT_LIFETIME_MS,
  GRANT_SPEND_LOVELACE,
  MINIMUM_FUNDING_LOVELACE,
  NEW_DEVICE_SPEND_LOVELACE,
  OWNER_COLLATERAL_LOVELACE,
  PER_CALL_CAP,
  REVOKED_SPEND_LOVELACE,
  SHORT_GRANT_LIFETIME_MS,
  SHORT_GRANT_SLOT,
  STRANGER_SPEND_LOVELACE,
  type SupportingTransaction,
  WITHDRAWN_LOVELACE,
  classifyFailure,
  evidenceDocument,
  isNodeScriptRefusal,
  nodeRefusalSummary,
} from './flow-plan.js';

/* CONSTANTS ******************************************************************/

/** The repository root, where the environment file and the evidence document live. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENV_PATH = resolve(REPO_ROOT, '.env');
const EVIDENCE_PATH = resolve(REPO_ROOT, 'docs', 'preprod-evidence.md');

/** How long to wait for a transaction to be confirmed and for the provider's view to catch up. */
const CONFIRMATION_TIMEOUT_MS = 10 * 60 * 1000;
const UTXO_VIEW_TIMEOUT_MS = 5 * 60 * 1000;
const UTXO_VIEW_POLL_MS = 5_000;

/** How far the provider's view of the current slot can lag behind the wall clock on preprod. */
const PROVIDER_SLOT_VIEW_LAG_MS = 120_000;

/** The extra time added past the provider's lag before the expiry flow attempts its spend. */
const EXPIRY_SAFETY_MARGIN_MS = 20_000;

/** How far past a grant's expiry the expiry flow waits before attempting its spend. */
const EXPIRY_MARGIN_MS = PROVIDER_SLOT_VIEW_LAG_MS + EXPIRY_SAFETY_MARGIN_MS;

/** How many slots a grant spend stays valid for, and how few the expiry attempt asks for. */
const VALIDITY_WINDOW_SLOTS = 600n;
const EXPIRED_WINDOW_SLOTS = 5n;

/** The message printed when the funding wallet cannot pay for the run. */
const FUND_MESSAGE = 'Fund this address with tADA from the preprod faucet and rerun';

/** The Blockfrost preprod endpoint, queried directly for what the provider does not expose: pools and reward account status. */
const BLOCKFROST_URL = 'https://cardano-preprod.blockfrost.io/api/v0';

/** How many registered pools are examined before giving up on finding an active one. */
const POOL_CANDIDATES = 10;

/** The account index of the mnemonic the agent wallet is derived from; the funding wallet is index 0. */
const AGENT_ACCOUNT = 1;

/** The first account index of the mnemonic tried for the owner wallet, and how many are tried. */
const FIRST_OWNER_ACCOUNT = 2;
const OWNER_ACCOUNT_CANDIDATES = 50;

/** The password cometa encrypts the derived keys with, fresh for every process. */
const password = randomBytes(32);

/* TYPES **********************************************************************/

/** The owner wallet of a run and the account identifiers its payment key fixes. */
interface Owner {
  owner: Wallet;
  ownerAddress: string;
  ownerKeyHash: string;
  stakeCredential: string;
  reward: string;
}

/** The keys, addresses and identifiers every flow works with. */
interface Actors {
  provider: Provider;
  funding: Wallet;
  owner: Wallet;
  agent: Wallet;
  fundingAddress: string;
  ownerAddress: string;
  agentAddress: string;
  ownerKeyHash: string;
  agentKeyHash: string;
  /** What the agent persists to find the account: it never holds the owner key or wallet. */
  record: AccountRecord;
  poolId: string;
}

/* FUNCTIONS ******************************************************************/

/** Hands cometa a copy of the password, since it wipes what it is given after use. */
const getPassword = (): Promise<Uint8Array> => Promise.resolve(new Uint8Array(password));

/** Sleeps for a number of milliseconds. */
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** The slot the current wall clock time falls in on preprod. */
const currentSlot = (): bigint => posixTimeToSlot(BigInt(Date.now()));

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

/**
 * Signs a built transaction with every wallet that must witness it and
 * submits it, returning the transaction id. Each wallet contributes its
 * own witness set, so a sponsored transaction gathers the owner's
 * signature and the sponsor's without either wallet seeing the other's
 * keys.
 */
const submit = async (signers: Wallet[], tx: string): Promise<string> => {
  const witnesses = [];
  for (const wallet of signers) {
    witnesses.push(...(await wallet.signTransaction(tx, true)));
  }
  const [submitter] = signers;
  if (!submitter) {
    throw new Error('A transaction needs at least one signer');
  }
  return submitter.submitTransaction(Cometa.applyVkeyWitnessSet(tx, witnesses));
};

/** Polls an address until the provider lists an output of the transaction at it. */
const waitForOutput = async (provider: Provider, address: string, txId: string): Promise<void> => {
  const deadline = Date.now() + UTXO_VIEW_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const utxos = await provider.getUnspentOutputs(address);
    if (utxos.some((utxo) => utxo.input.txId === txId)) {
      return;
    }
    await sleep(UTXO_VIEW_POLL_MS);
  }
  throw new Error(`The provider never listed an output of ${txId} at ${address}`);
};

/** Blockfrost's answer to a query, or undefined when the resource does not exist. */
const blockfrost = async <T>(projectId: string, path: string): Promise<T | undefined> => {
  const response = await fetch(`${BLOCKFROST_URL}${path}`, { headers: { project_id: projectId } });
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
 * The first registered preprod pool that is not retiring and has live
 * stake, so that the delegation flow names a pool the ledger accepts.
 */
const firstActivePool = async (projectId: string): Promise<string> => {
  const pools = (await blockfrost<string[]>(projectId, `/pools?count=${POOL_CANDIDATES}`)) ?? [];
  for (const poolId of pools) {
    const pool = await blockfrost<{ retirement: unknown[]; live_stake: string }>(projectId, `/pools/${poolId}`);
    if (pool && pool.retirement.length === 0 && BigInt(pool.live_stake) > 0n) {
      return poolId;
    }
  }
  throw new Error(`None of the first ${POOL_CANDIDATES} preprod pools is active`);
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
  for (let index = FIRST_OWNER_ACCOUNT; index < FIRST_OWNER_ACCOUNT + OWNER_ACCOUNT_CANDIDATES; index += 1) {
    const owner = await walletOf(provider, mnemonics, index);
    const ownerAddress = (await owner.getChangeAddress()).toString();
    const ownerKeyHash = paymentKeyHashOf(ownerAddress);
    if (!ownerKeyHash) {
      throw new Error('The owner wallet did not derive a key address');
    }
    const stakeCredential = stakeScriptHash(stakeScript(ownerKeyHash, scriptHash));
    const reward = rewardAddress(stakeCredential).toBech32();
    if (!(await isStakeCredentialRegistered(projectId, reward))) {
      console.log(`Owner wallet: account index ${index} of the mnemonic`);
      return { owner, ownerAddress, ownerKeyHash, stakeCredential, reward };
    }
  }
  throw new Error(`Every owner account index from ${FIRST_OWNER_ACCOUNT} onwards already has a registered stake credential`);
};

/** Polls an address until the provider lists nothing at it. */
const waitForEmpty = async (provider: Provider, address: string): Promise<void> => {
  const deadline = Date.now() + UTXO_VIEW_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await provider.getUnspentOutputs(address)).length === 0) {
      return;
    }
    await sleep(UTXO_VIEW_POLL_MS);
  }
  throw new Error(`The provider still lists outputs at ${address}`);
};

/** Waits for a submitted transaction to be confirmed and for every address it pays to show its outputs. */
const settle = async (provider: Provider, txId: string, tx: string): Promise<void> => {
  const confirmed = await provider.confirmTransaction(txId, CONFIRMATION_TIMEOUT_MS);
  if (!confirmed) {
    throw new Error(`Transaction ${txId} was not confirmed within ${CONFIRMATION_TIMEOUT_MS / 1000} seconds`);
  }
  for (const address of new Set(transactionBodyParts(tx).outputs.map((output) => output.address))) {
    await waitForOutput(provider, address, txId);
  }
};

/** Runs the flows in order, recording transactions and refusals for the evidence document. */
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
    const record: FlowRecord = { flow: this.flow(step), txIds: [] };
    this.records.push(record);
    console.log(`Step ${step}: ${record.flow.description}`);
    return record;
  }

  /** Builds, signs, submits and settles a transaction that must succeed. */
  async confirm(step: number, description: string, signers: Wallet[], build: () => Promise<string>): Promise<string> {
    const record = this.record(step);
    const tx = await build();
    const txId = await submit(signers, tx);
    console.log(`  ${txId} ${description}`);
    await settle(this.actors.provider, txId, tx);
    record.txIds.push(txId);
    return txId;
  }

  /** Builds, signs, submits and settles a transaction outside the plan. */
  async support(description: string, signers: Wallet[], build: () => Promise<string>): Promise<string> {
    const tx = await build();
    const txId = await submit(signers, tx);
    console.log(`  ${txId} ${description}`);
    await settle(this.actors.provider, txId, tx);
    this.supporting.push({ description, txId });
    return txId;
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
    const record = this.record(step);
    try {
      await build();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const kind = classifyFailure(error);
      if (kind !== 'refusal' || isNodeScriptRefusal(error)) {
        throw new Error(`Step ${step} failed with a ${kind} error instead of a refusal by the builder: ${message}`);
      }
      const expected = record.flow.expectedMessage;
      if (!expected) {
        throw new Error(`Step ${step} has no expected message pattern to verify the builder refusal against`);
      }
      if (!expected.test(message)) {
        throw new Error(`Step ${step} was refused by the builder but the message did not match ${expected}: ${message}`);
      }
      record.refusal = message;
      console.log(`  refused by the builder: ${message}`);
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
    const record = this.record(step);
    const tx = await build();
    let txId: string;
    try {
      txId = await submit(signers, tx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isNodeScriptRefusal(error)) {
        throw new Error(`Step ${step} failed with a ${classifyFailure(error)} error instead of a refusal by the node: ${message}`);
      }
      const expected = record.flow.expectedMessage;
      if (!expected) {
        throw new Error(`Step ${step} has no expected message pattern to verify the node refusal against`);
      }
      if (!expected.test(message)) {
        throw new Error(`Step ${step} was refused by the node but the message did not match ${expected}: ${message}`);
      }
      record.refusal = nodeRefusalSummary(message);
      console.log(`  refused by the node: ${record.refusal}`);
      return;
    }
    throw new Error(
      `Step ${step} was not refused: ${description} was accepted as ${txId}. Check whether it entered a block and consumed the collateral of ${
        this.actors.agentAddress
      } before submitting anything else`,
    );
  }

  /** A lovelace scope paying the owner only, expiring after a lifetime from now. */
  private scope(lifetimeMs: bigint): Scope {
    return {
      asset: LOVELACE,
      perCallCap: PER_CALL_CAP,
      cap: CAP,
      lovelacePerCallCap: 0n,
      lovelaceCap: 0n,
      expiresAt: BigInt(Date.now()) + lifetimeMs,
      recipients: [this.actors.ownerAddress],
    };
  }

  /** The parameters every owner transaction shares: the owner key is the account's initial device and the owner of its stake script. */
  private get ownerParams() {
    const { owner, provider, ownerKeyHash } = this.actors;
    return { wallet: owner, provider, owner: ownerKeyHash };
  }

  /** The parameters every agent transaction shares: the agent wallet signs and provides the collateral, and the account comes from the persisted record. */
  private get agentParams() {
    const { agent, provider, record } = this.actors;
    return { wallet: agent, provider, record };
  }

  /**
   * A grant spend paying lovelace to one address, valid for a window of
   * slots from now. An unchecked spend skips the builder's checks so that
   * the validator is the one to refuse it.
   */
  private grantSpend(
    slot: bigint,
    grantee: string,
    address: string,
    lovelace: bigint,
    windowSlots: bigint,
    unchecked = false,
  ): Promise<string> {
    return spendWithGrant({
      ...this.agentParams,
      slot,
      grantee,
      outputs: [{ address, value: { coins: lovelace } }],
      validUntilSlot: currentSlot() + windowSlots,
      unchecked,
    });
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

  /**
   * An owner spend paying every fund UTxO of the account to the funding
   * wallet, which sponsors the fee so that nothing returns to the account
   * and only the control UTxO stays.
   */
  private async sweepAccount(): Promise<string> {
    const { provider, funding, fundingAddress } = this.actors;
    const { funds } = await findAccountUtxos(provider, this.ownerParams);
    const lovelace = funds.reduce((total, utxo) => total + utxo.output.value.coins, 0n);
    return spendWithDevice({ ...this.ownerParams, sponsor: funding, outputs: [{ address: fundingAddress, value: { coins: lovelace } }] });
  }

  /** Executes the flows of the plan in order. */
  async flows(): Promise<void> {
    const { funding, owner, agent, ownerAddress, agentAddress, ownerKeyHash, agentKeyHash, poolId } = this.actors;
    const initialState: AccountState = { devices: [ownerKeyHash], grants: [], grantGeneration: 0n };

    await this.confirm(1, 'createAccount sponsored by the funding wallet', [owner, funding], () =>
      createAccount({ ...this.ownerParams, sponsor: funding, state: initialState }),
    );
    await this.confirm(2, `deposit ${DEPOSIT_LOVELACE} lovelace from the funding wallet`, [funding], () =>
      deposit({ ...this.ownerParams, wallet: funding, value: { coins: DEPOSIT_LOVELACE } }),
    );
    await this.confirm(3, `spendWithDevice ${DEVICE_SPEND_LOVELACE} lovelace to the owner`, [owner], () =>
      spendWithDevice({ ...this.ownerParams, outputs: [{ address: ownerAddress, value: { coins: DEVICE_SPEND_LOVELACE } }] }),
    );
    await this.confirm(4, `withdrawRewards ${WITHDRAWN_LOVELACE} lovelace signed by the owner device`, [owner], () =>
      withdrawRewards({ ...this.ownerParams, amount: WITHDRAWN_LOVELACE }),
    );
    await this.confirm(5, `delegateStake to ${poolId} signed by the owner device`, [owner], () => delegateStake({ ...this.ownerParams, poolId }));

    const agentGrant: Grant = { slot: AGENT_GRANT_SLOT, grantee: agentKeyHash, scope: this.scope(GRANT_LIFETIME_MS) };
    await this.confirm(6, `issueGrant slot ${AGENT_GRANT_SLOT} to the agent`, [owner], () => issueGrant({ ...this.ownerParams, grant: agentGrant }));
    await this.confirm(7, `spendWithGrant ${GRANT_SPEND_LOVELACE} lovelace to the owner`, [agent], () =>
      this.grantSpend(AGENT_GRANT_SLOT, agentKeyHash, ownerAddress, GRANT_SPEND_LOVELACE, VALIDITY_WINDOW_SLOTS),
    );
    await this.refuseInBuilder(8, `spendWithGrant ${GRANT_SPEND_LOVELACE} lovelace beyond the remaining cap`, () =>
      this.grantSpend(AGENT_GRANT_SLOT, agentKeyHash, ownerAddress, GRANT_SPEND_LOVELACE, VALIDITY_WINDOW_SLOTS),
    );
    await this.refuseAtNode(9, `spendWithGrant ${GRANT_SPEND_LOVELACE} lovelace beyond the remaining cap, unchecked`, [agent], () =>
      this.grantSpend(AGENT_GRANT_SLOT, agentKeyHash, ownerAddress, GRANT_SPEND_LOVELACE, VALIDITY_WINDOW_SLOTS, true),
    );
    await this.refuseInBuilder(10, `spendWithGrant ${STRANGER_SPEND_LOVELACE} lovelace to an address outside the recipients`, () =>
      this.grantSpend(AGENT_GRANT_SLOT, agentKeyHash, agentAddress, STRANGER_SPEND_LOVELACE, VALIDITY_WINDOW_SLOTS),
    );
    await this.refuseAtNode(11, `spendWithGrant ${STRANGER_SPEND_LOVELACE} lovelace to an address outside the recipients, unchecked`, [agent], () =>
      this.grantSpend(AGENT_GRANT_SLOT, agentKeyHash, agentAddress, STRANGER_SPEND_LOVELACE, VALIDITY_WINDOW_SLOTS, true),
    );
    await this.confirm(12, `revokeGrant slot ${AGENT_GRANT_SLOT}`, [owner], () => revokeGrant({ ...this.ownerParams, slot: AGENT_GRANT_SLOT }));
    await this.refuseInBuilder(13, `spendWithGrant ${REVOKED_SPEND_LOVELACE} lovelace with the revoked grant`, () =>
      this.grantSpend(AGENT_GRANT_SLOT, agentKeyHash, ownerAddress, REVOKED_SPEND_LOVELACE, VALIDITY_WINDOW_SLOTS),
    );

    const shortGrant: Grant = { slot: SHORT_GRANT_SLOT, grantee: agentKeyHash, scope: this.scope(SHORT_GRANT_LIFETIME_MS) };
    await this.confirm(14, `issueGrant slot ${SHORT_GRANT_SLOT} expiring in ${SHORT_GRANT_LIFETIME_MS / 1000n} seconds`, [owner], () =>
      issueGrant({ ...this.ownerParams, grant: shortGrant }),
    );
    const resumeAt = Number(shortGrant.scope.expiresAt) + EXPIRY_MARGIN_MS;
    const waitMs = resumeAt - Date.now();
    if (waitMs > 0) {
      console.log(`  waiting ${Math.ceil(waitMs / 1000)} seconds for grant ${SHORT_GRANT_SLOT} to expire`);
      await sleep(waitMs);
    }
    await this.refuseInBuilder(14, `spendWithGrant ${REVOKED_SPEND_LOVELACE} lovelace with the expired grant`, () =>
      this.grantSpend(SHORT_GRANT_SLOT, agentKeyHash, ownerAddress, REVOKED_SPEND_LOVELACE, EXPIRED_WINDOW_SLOTS),
    );
    await this.refuseAtNode(15, `spendWithGrant ${REVOKED_SPEND_LOVELACE} lovelace with the expired grant, unchecked`, [agent], () =>
      this.grantSpend(SHORT_GRANT_SLOT, agentKeyHash, ownerAddress, REVOKED_SPEND_LOVELACE, VALIDITY_WINDOW_SLOTS, true),
    );

    await this.confirm(16, 'addDevice the agent wallet key', [owner], () => addDevice({ ...this.ownerParams, device: agentKeyHash }));
    await this.confirm(16, `spendWithDevice ${NEW_DEVICE_SPEND_LOVELACE} lovelace signed by the new device`, [agent], () =>
      spendWithDevice({ ...this.agentParams, outputs: [{ address: ownerAddress, value: { coins: NEW_DEVICE_SPEND_LOVELACE } }] }),
    );
    await this.confirm(17, `withdrawRewards ${WITHDRAWN_LOVELACE} lovelace signed by the new device`, [agent], () =>
      withdrawRewards({ ...this.agentParams, amount: WITHDRAWN_LOVELACE }),
    );
    await this.confirm(18, 'removeDevice the agent wallet key', [owner], () => removeDevice({ ...this.ownerParams, device: agentKeyHash }));
    await this.confirm(19, 'revokeAllGrants', [owner], () => revokeAllGrants(this.ownerParams));
    await this.confirm(20, 'spendWithDevice sweeping every fund UTxO to the funding wallet, sponsored by it', [owner, funding], () =>
      this.sweepAccount(),
    );
  }
}

/** Prints the funding address and the funding request, then ends the process successfully. */
const askForFunds = (address: string): never => {
  console.log(address);
  console.log(FUND_MESSAGE);
  process.exit(0);
};

/** Runs every flow against preprod and writes the evidence document. */
const main = async (): Promise<void> => {
  loadEnv({ path: ENV_PATH });
  await Cometa.ready();
  const projectId = process.env['BLOCKFROST_PREPROD_PROJECT_ID'];
  if (!projectId) {
    throw new Error('BLOCKFROST_PREPROD_PROJECT_ID is not set in the environment file');
  }
  const provider = new Cometa.BlockfrostProvider({ network: Cometa.NetworkMagic.Preprod, projectId });

  let mnemonics = fundingMnemonic();
  const generated = mnemonics === undefined;
  if (mnemonics === undefined) {
    mnemonics = Cometa.entropyToMnemonic(randomBytes(32));
    storeMnemonic(mnemonics);
  }
  const funding = await walletOf(provider, mnemonics, 0);
  const fundingAddress = (await funding.getChangeAddress()).toString();
  if (generated) {
    askForFunds(fundingAddress);
  }
  const balance = (await funding.getBalance()).coins;
  if (balance < MINIMUM_FUNDING_LOVELACE) {
    askForFunds(fundingAddress);
  }

  const scriptHash = accountScriptHash(accountScript());
  const { owner, ownerAddress, ownerKeyHash, stakeCredential, reward } = await freshOwner(provider, projectId, mnemonics, scriptHash);
  const address = accountAddress(scriptHash, stakeCredential).toString();
  const discovered = accountByOwner(ownerKeyHash);
  if (discovered.address !== address || discovered.stakeScriptHash !== stakeCredential || discovered.rewardAddress !== reward) {
    throw new Error('Account discovery from the owner key disagrees with the derived account');
  }
  const record: AccountRecord = { owner: discovered.owner, stakeScriptHash: discovered.stakeScriptHash, address: discovered.address };
  const agent = await walletOf(provider, mnemonics, AGENT_ACCOUNT);
  const agentAddress = (await agent.getChangeAddress()).toString();
  const agentKeyHash = paymentKeyHashOf(agentAddress);
  if (!agentKeyHash) {
    throw new Error('The agent wallet did not derive a key address');
  }
  const poolId = await firstActivePool(projectId);
  const actors: Actors = {
    provider,
    funding,
    owner,
    agent,
    fundingAddress,
    ownerAddress,
    agentAddress,
    ownerKeyHash,
    agentKeyHash,
    record,
    poolId,
  };

  const run = new Run(actors);
  console.log(`Funding address: ${fundingAddress}`);
  console.log(`Owner address: ${ownerAddress}`);
  console.log(`Agent address: ${agentAddress}`);
  console.log(`Account address: ${address}`);
  console.log(`Account script hash: ${scriptHash}`);
  console.log(`Account stake credential: ${stakeCredential}`);
  console.log(`Reward address: ${reward}`);
  console.log(`Delegation pool: ${poolId}`);

  await run.fundOwnerCollateral();
  await run.fundAgentWallet();
  await run.flows();
  await run.sweepAgentWallet();
  await run.sweepOwnerWallet();

  const remaining = await provider.getUnspentOutputs(address);
  const live = await accountExists(provider, record);
  if (remaining.length !== 1 || !live || live.state.devices.length !== 1) {
    throw new Error(`The account address should hold only its control UTxO after the sweep but holds ${remaining.length} UTxOs`);
  }
  if (!(await isStakeCredentialRegistered(projectId, reward))) {
    throw new Error(`Blockfrost no longer lists ${reward} as registered`);
  }

  mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
  writeFileSync(
    EVIDENCE_PATH,
    evidenceDocument({
      date: new Date().toISOString().slice(0, 10),
      fundingAddress,
      ownerAddress,
      accountAddress: address,
      scriptHash,
      stakeScriptHash: stakeCredential,
      rewardAddress: reward,
      poolId,
      records: run.records,
      supporting: run.supporting,
    }),
  );
  console.log(`Evidence written to ${EVIDENCE_PATH}`);
};

/* MAIN ***********************************************************************/

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
