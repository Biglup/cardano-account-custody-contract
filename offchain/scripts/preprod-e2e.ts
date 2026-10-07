import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { secp256k1 } from '@noble/curves/secp256k1';
import { blake2b } from '@noble/hashes/blake2';
import type { Provider, Wallet } from '@biglup/cometa';
import { config as loadEnv } from 'dotenv';
import { accountAddress, paymentKeyHashOf, stakeKeyHashOf } from '../src/address.js';
import { accountScript, accountScriptHash } from '../src/blueprint.js';
import { Cometa } from '../src/cometa.js';
import type { AccountState, Grant, Grantee, Scope } from '../src/data.js';
import { granteePublicKey, posixTimeToSlot, transactionBodyParts } from '../src/message.js';
import { LOVELACE } from '../src/state.js';
import {
  type GranteeSigner,
  addDevice,
  createAccount,
  deleteAccount,
  deposit,
  issueGrant,
  removeDevice,
  revokeAllGrants,
  revokeGrant,
  spendWithDevice,
  spendWithGrant,
} from '../src/transactions.js';
import {
  AGENT_WALLET_LOVELACE,
  CAP,
  DEPOSIT_LOVELACE,
  DEVICE_SPEND_LOVELACE,
  ED25519_GRANT_SLOT,
  FLOW_PLAN,
  type Flow,
  type FlowRecord,
  GRANT_LIFETIME_MS,
  GRANT_SPEND_LOVELACE,
  MINIMUM_FUNDING_LOVELACE,
  NEW_DEVICE_SPEND_LOVELACE,
  PER_CALL_CAP,
  REVOKED_SPEND_LOVELACE,
  SECP256K1_GRANT_SLOT,
  SECP256K1_SPEND_LOVELACE,
  SHORT_GRANT_LIFETIME_MS,
  SHORT_GRANT_SLOT,
  STRANGER_SPEND_LOVELACE,
  type SupportingTransaction,
  classifyFailure,
  evidenceDocument,
  isNodeScriptRefusal,
  nodeRefusalSummary,
} from './flow-plan.js';

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

/** The domain string under which the secp256k1 agent key is derived from the mnemonic entropy. */
const SECP256K1_KEY_DOMAIN = 'cardano_account_custody:e2e:secp256k1';

/** The password cometa encrypts the derived keys with, fresh for every process. */
const password = randomBytes(32);

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

/** A secp256k1 private key derived deterministically from the mnemonic entropy. */
const secp256k1KeyOf = (mnemonics: string[]): Uint8Array => {
  const entropy = Cometa.mnemonicToEntropy(mnemonics);
  const key = blake2b(new Uint8Array([...Cometa.utf8ToUint8Array(SECP256K1_KEY_DOMAIN), ...entropy]), { dkLen: 32 });
  entropy.fill(0);
  if (!secp256k1.utils.isValidPrivateKey(key)) {
    throw new Error('The derived secp256k1 key is not a valid scalar');
  }
  return key;
};

/** Signs a built transaction with a wallet and submits it, returning the transaction id. */
const submit = async (wallet: Wallet, tx: string): Promise<string> => {
  const witnesses = await wallet.signTransaction(tx, false);
  return wallet.submitTransaction(Cometa.applyVkeyWitnessSet(tx, witnesses));
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

/** The keys, addresses and identifiers every flow works with. */
interface Actors {
  provider: Provider;
  owner: Wallet;
  agent: Wallet;
  ownerAddress: string;
  agentAddress: string;
  ownerKeyHash: string;
  agentKeyHash: string;
  stakeKeyHash: string;
  secp256k1Key: Uint8Array;
  secp256k1Grantee: Grantee;
}

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
  async confirm(step: number, description: string, wallet: Wallet, build: () => Promise<string>): Promise<string> {
    const record = this.record(step);
    const tx = await build();
    const txId = await submit(wallet, tx);
    console.log(`  ${txId} ${description}`);
    await settle(this.actors.provider, txId, tx);
    record.txIds.push(txId);
    return txId;
  }

  /** Builds, signs, submits and settles a transaction outside the plan. */
  async support(description: string, wallet: Wallet, build: () => Promise<string>): Promise<string> {
    const tx = await build();
    const txId = await submit(wallet, tx);
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
  async refuseAtNode(step: number, description: string, wallet: Wallet, build: () => Promise<string>): Promise<void> {
    const record = this.record(step);
    const tx = await build();
    let txId: string;
    try {
      txId = await submit(wallet, tx);
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
      lovelaceCap: 0n,
      expiresAt: BigInt(Date.now()) + lifetimeMs,
      recipients: [this.actors.ownerAddress],
    };
  }

  /** The parameters every owner transaction shares. */
  private get ownerParams() {
    const { owner, provider, stakeKeyHash } = this.actors;
    return { wallet: owner, provider, stakeKeyHash };
  }

  /** The parameters every agent transaction shares: the agent wallet signs and provides the collateral. */
  private get agentParams() {
    const { agent, provider, stakeKeyHash } = this.actors;
    return { wallet: agent, provider, stakeKeyHash };
  }

  /**
   * A grant spend paying lovelace to one address, valid for a window of
   * slots from now. An unchecked spend skips the builder's checks so that
   * the validator is the one to refuse it.
   */
  private grantSpend(
    slot: bigint,
    grantee: GranteeSigner,
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

  /** Gives the agent wallet lovelace for collateral and fees unless it holds enough already. */
  async fundAgentWallet(): Promise<void> {
    const { agent, owner, agentAddress } = this.actors;
    const balance = (await agent.getBalance()).coins;
    if (balance >= AGENT_WALLET_LOVELACE / 2n) {
      console.log(`The agent wallet already holds ${balance} lovelace`);
      return;
    }
    await this.support(`fund the agent wallet with ${AGENT_WALLET_LOVELACE} lovelace`, owner, async () =>
      (await owner.createTransactionBuilder()).sendLovelace({ address: agentAddress, amount: AGENT_WALLET_LOVELACE }).build(),
    );
  }

  /**
   * Returns everything the agent wallet holds to the funding wallet and
   * waits until the provider no longer lists anything at the agent
   * address, so that a run started right after this one sees the agent
   * wallet empty rather than a stale view of the swept outputs.
   */
  async sweepAgentWallet(): Promise<void> {
    const { agent, provider, ownerAddress, agentAddress } = this.actors;
    const utxos = await agent.getUnspentOutputs();
    if (utxos.length === 0) {
      return;
    }
    await this.support('return the agent wallet balance to the funding wallet', agent, async () => {
      const builder = await agent.createTransactionBuilder();
      for (const utxo of utxos) {
        builder.addInput({ utxo });
      }
      return builder.setChangeAddress(ownerAddress).build();
    });
    await waitForEmpty(provider, agentAddress);
  }

  /** Executes the eighteen flows of the plan in order. */
  async flows(): Promise<void> {
    const { owner, agent, ownerAddress, agentAddress, ownerKeyHash, agentKeyHash, secp256k1Key, secp256k1Grantee } = this.actors;
    const ed25519Grantee: GranteeSigner = { kind: 'ed25519', keyHash: agentKeyHash };
    const secp256k1Signer: GranteeSigner = { kind: 'secp256k1', privateKey: secp256k1Key };
    const initialState: AccountState = { devices: [ownerKeyHash], grants: [], grantGeneration: 0n };

    await this.confirm(1, 'createAccount', owner, () => createAccount({ ...this.ownerParams, state: initialState }));
    await this.confirm(2, `deposit ${DEPOSIT_LOVELACE} lovelace`, owner, () =>
      deposit({ ...this.ownerParams, value: { coins: DEPOSIT_LOVELACE } }),
    );
    await this.confirm(3, `spendWithDevice ${DEVICE_SPEND_LOVELACE} lovelace to the owner`, owner, () =>
      spendWithDevice({ ...this.ownerParams, outputs: [{ address: ownerAddress, value: { coins: DEVICE_SPEND_LOVELACE } }] }),
    );

    const ed25519Grant: Grant = { slot: ED25519_GRANT_SLOT, grantee: { kind: 'ed25519', keyHash: agentKeyHash }, scope: this.scope(GRANT_LIFETIME_MS) };
    await this.confirm(4, `issueGrant slot ${ED25519_GRANT_SLOT} to the Ed25519 agent`, owner, () =>
      issueGrant({ ...this.ownerParams, grant: ed25519Grant }),
    );
    await this.confirm(5, `spendWithGrant ${GRANT_SPEND_LOVELACE} lovelace to the owner`, agent, () =>
      this.grantSpend(ED25519_GRANT_SLOT, ed25519Grantee, ownerAddress, GRANT_SPEND_LOVELACE, VALIDITY_WINDOW_SLOTS),
    );
    await this.refuseInBuilder(6, `spendWithGrant ${GRANT_SPEND_LOVELACE} lovelace beyond the remaining cap`, () =>
      this.grantSpend(ED25519_GRANT_SLOT, ed25519Grantee, ownerAddress, GRANT_SPEND_LOVELACE, VALIDITY_WINDOW_SLOTS),
    );
    await this.refuseAtNode(7, `spendWithGrant ${GRANT_SPEND_LOVELACE} lovelace beyond the remaining cap, unchecked`, agent, () =>
      this.grantSpend(ED25519_GRANT_SLOT, ed25519Grantee, ownerAddress, GRANT_SPEND_LOVELACE, VALIDITY_WINDOW_SLOTS, true),
    );
    await this.refuseInBuilder(8, `spendWithGrant ${STRANGER_SPEND_LOVELACE} lovelace to an address outside the recipients`, () =>
      this.grantSpend(ED25519_GRANT_SLOT, ed25519Grantee, agentAddress, STRANGER_SPEND_LOVELACE, VALIDITY_WINDOW_SLOTS),
    );
    await this.refuseAtNode(9, `spendWithGrant ${STRANGER_SPEND_LOVELACE} lovelace to an address outside the recipients, unchecked`, agent, () =>
      this.grantSpend(ED25519_GRANT_SLOT, ed25519Grantee, agentAddress, STRANGER_SPEND_LOVELACE, VALIDITY_WINDOW_SLOTS, true),
    );
    await this.confirm(10, `revokeGrant slot ${ED25519_GRANT_SLOT}`, owner, () => revokeGrant({ ...this.ownerParams, slot: ED25519_GRANT_SLOT }));
    await this.refuseInBuilder(11, `spendWithGrant ${REVOKED_SPEND_LOVELACE} lovelace with the revoked grant`, () =>
      this.grantSpend(ED25519_GRANT_SLOT, ed25519Grantee, ownerAddress, REVOKED_SPEND_LOVELACE, VALIDITY_WINDOW_SLOTS),
    );

    const secp256k1Grant: Grant = { slot: SECP256K1_GRANT_SLOT, grantee: secp256k1Grantee, scope: this.scope(GRANT_LIFETIME_MS) };
    await this.confirm(12, `issueGrant slot ${SECP256K1_GRANT_SLOT} to the secp256k1 agent`, owner, () =>
      issueGrant({ ...this.ownerParams, grant: secp256k1Grant }),
    );
    await this.confirm(12, `spendWithGrant ${SECP256K1_SPEND_LOVELACE} lovelace with the secp256k1 signature`, agent, () =>
      this.grantSpend(SECP256K1_GRANT_SLOT, secp256k1Signer, ownerAddress, SECP256K1_SPEND_LOVELACE, VALIDITY_WINDOW_SLOTS),
    );

    const shortGrant: Grant = { slot: SHORT_GRANT_SLOT, grantee: { kind: 'ed25519', keyHash: agentKeyHash }, scope: this.scope(SHORT_GRANT_LIFETIME_MS) };
    await this.confirm(13, `issueGrant slot ${SHORT_GRANT_SLOT} expiring in ${SHORT_GRANT_LIFETIME_MS / 1000n} seconds`, owner, () =>
      issueGrant({ ...this.ownerParams, grant: shortGrant }),
    );
    const resumeAt = Number(shortGrant.scope.expiresAt) + EXPIRY_MARGIN_MS;
    const waitMs = resumeAt - Date.now();
    if (waitMs > 0) {
      console.log(`  waiting ${Math.ceil(waitMs / 1000)} seconds for grant ${SHORT_GRANT_SLOT} to expire`);
      await sleep(waitMs);
    }
    await this.refuseInBuilder(13, `spendWithGrant ${REVOKED_SPEND_LOVELACE} lovelace with the expired grant`, () =>
      this.grantSpend(SHORT_GRANT_SLOT, ed25519Grantee, ownerAddress, REVOKED_SPEND_LOVELACE, EXPIRED_WINDOW_SLOTS),
    );
    await this.refuseAtNode(14, `spendWithGrant ${REVOKED_SPEND_LOVELACE} lovelace with the expired grant, unchecked`, agent, () =>
      this.grantSpend(SHORT_GRANT_SLOT, ed25519Grantee, ownerAddress, REVOKED_SPEND_LOVELACE, VALIDITY_WINDOW_SLOTS, true),
    );

    await this.confirm(15, 'addDevice the agent wallet key', owner, () => addDevice({ ...this.ownerParams, device: agentKeyHash }));
    await this.confirm(15, `spendWithDevice ${NEW_DEVICE_SPEND_LOVELACE} lovelace signed by the new device`, agent, () =>
      spendWithDevice({ ...this.agentParams, outputs: [{ address: ownerAddress, value: { coins: NEW_DEVICE_SPEND_LOVELACE } }] }),
    );
    await this.confirm(16, 'removeDevice the agent wallet key', owner, () => removeDevice({ ...this.ownerParams, device: agentKeyHash }));
    await this.confirm(17, 'revokeAllGrants', owner, () => revokeAllGrants(this.ownerParams));
    await this.confirm(18, 'deleteAccount', owner, () => deleteAccount(this.ownerParams));
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
  const owner = await walletOf(provider, mnemonics, 0);
  const ownerAddress = (await owner.getChangeAddress()).toString();
  if (generated) {
    askForFunds(ownerAddress);
  }
  const balance = (await owner.getBalance()).coins;
  if (balance < MINIMUM_FUNDING_LOVELACE) {
    askForFunds(ownerAddress);
  }

  const agent = await walletOf(provider, mnemonics, 1);
  const agentAddress = (await agent.getChangeAddress()).toString();
  const ownerKeyHash = paymentKeyHashOf(ownerAddress);
  const agentKeyHash = paymentKeyHashOf(agentAddress);
  const stakeKeyHash = stakeKeyHashOf(ownerAddress);
  if (!ownerKeyHash || !agentKeyHash || !stakeKeyHash) {
    throw new Error('The wallets did not derive key addresses');
  }
  const secp256k1Key = secp256k1KeyOf(mnemonics);
  const scriptHash = accountScriptHash(accountScript());
  const actors: Actors = {
    provider,
    owner,
    agent,
    ownerAddress,
    agentAddress,
    ownerKeyHash,
    agentKeyHash,
    stakeKeyHash,
    secp256k1Key,
    secp256k1Grantee: { kind: 'secp256k1', publicKey: granteePublicKey(secp256k1Key) },
  };

  const run = new Run(actors);
  const address = accountAddress(scriptHash, stakeKeyHash).toString();
  console.log(`Funding and owner address: ${ownerAddress}`);
  console.log(`Agent address: ${agentAddress}`);
  console.log(`Account address: ${address}`);
  console.log(`Account script hash: ${scriptHash}`);

  await run.fundAgentWallet();
  await run.flows();
  await run.sweepAgentWallet();

  const remaining = await provider.getUnspentOutputs(address);
  if (remaining.length > 0) {
    throw new Error(`The account address still holds ${remaining.length} UTxOs after deletion`);
  }

  mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
  writeFileSync(
    EVIDENCE_PATH,
    evidenceDocument({
      date: new Date().toISOString().slice(0, 10),
      fundingAddress: ownerAddress,
      accountAddress: address,
      scriptHash,
      records: run.records,
      supporting: run.supporting,
    }),
  );
  console.log(`Evidence written to ${EVIDENCE_PATH}`);
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
