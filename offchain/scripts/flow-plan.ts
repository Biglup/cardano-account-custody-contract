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

/* CONSTANTS ******************************************************************/

/** The pattern the node's refusal message must match for every flow the node refuses in phase two. */
const NODE_REFUSAL_MESSAGE = /ValidationTagMismatch|PlutusFailure/;

/** The pattern the node's refusal message must match when a spent reference input fails a transaction in phase one. */
const PHASE_ONE_REFUSAL_MESSAGE = /BadInputsUTxO/;

/** The lovelace in one tADA. */
export const TADA = 1_000_000n;

/** The lovelace the agent wallet receives for collateral and fees. */
export const AGENT_WALLET_LOVELACE = 10n * TADA;

/**
 * The lovelace the owner wallet receives once, as the single UTxO it
 * offers as collateral. The owner holds no other ADA: creation is paid by
 * the funding wallet as sponsor and every later owner operation is paid
 * from the account's own funds, so the owner only ever signs. Collateral
 * is only taken when a transaction fails in phase two, which the builder
 * never lets happen, and even then the collateral return the builder sets
 * would give back everything above the amount owed; a sponsored
 * production flow provides the owner's collateral the same way.
 */
export const OWNER_COLLATERAL_LOVELACE = 5n * TADA;

/** The lovelace deposited into the account as plain funds, enough to hold sixteen of the largest grant UTxOs at once. */
export const DEPOSIT_LOVELACE = 120n * TADA;

/**
 * The lovelace deposited into the account as a reserve, which the owner
 * alone can spend. An owner operation draws its fee from the reserve only
 * while the reserve can cover the most a transaction can cost and still be
 * recreated above its minimum UTxO value, about 4.4 tADA on preprod, so
 * the reserve is sized to stay above that through the seventy odd owner
 * steps of the run and no owner step depends on a fund UTxO an agent may
 * be spending.
 */
export const RESERVE_LOVELACE = 60n * TADA;

/** The lovelace the owner spends in the first device spend. */
export const DEVICE_SPEND_LOVELACE = 5n * TADA;

/** The lovelace of each grant spend the agent attempts. */
export const GRANT_SPEND_LOVELACE = 8n * TADA;

/** The lovelace of the grant spend aimed at an address outside the recipients. */
export const STRANGER_SPEND_LOVELACE = 3n * TADA;

/** The lovelace of the grant spend the agent holds in flight while the owner revokes, and of the spends attempted after the revoke. */
export const REVOKED_SPEND_LOVELACE = 1n * TADA;

/** The lovelace the new device spends. */
export const NEW_DEVICE_SPEND_LOVELACE = 1n * TADA;

/** The rewards withdrawn in every withdrawal flow: the account earns none during the run, so only a zero withdrawal is valid. */
export const WITHDRAWN_LOVELACE = 0n;

/** The per call cap of the lovelace grants issued in the run. */
export const PER_CALL_CAP = 10n * TADA;

/** The cumulative cap of the lovelace grants issued in the run. */
export const CAP = 15n * TADA;

/** How long the long lived grants stay valid. */
export const GRANT_LIFETIME_MS = 2n * 60n * 60n * 1000n;

/** How long the short lived grant of the expiry flow stays valid. */
export const SHORT_GRANT_LIFETIME_MS = 90n * 1000n;

/** The least balance the funding wallet needs before the run starts. */
export const MINIMUM_FUNDING_LOVELACE = 400n * TADA;

/** The slot of the first grant issued to the agent, which a fresh account issues first. */
export const AGENT_GRANT_SLOT = 0n;

/** The slot of the token grant, issued second. */
export const TOKEN_GRANT_SLOT = 1n;

/** The slot of the short lived grant used to prove the expiry rule, issued third. */
export const SHORT_GRANT_SLOT = 2n;

/** The name of the test token the funding wallet mints, as hex. */
export const TOKEN_NAME_HEX = '637573746f64792d74657374';

/** How many test tokens the funding wallet mints and deposits into the account: exactly what the token grant lets the agent send. */
export const TOKEN_SUPPLY = 20n;

/** The tokens the token grant lets the agent send per call and in total. */
export const TOKEN_PER_CALL_CAP = 10n;
export const TOKEN_CAP = 20n;

/**
 * The lovelace the token grant lets leave alongside the tokens per call
 * and in total. The fee counts as leaving lovelace, and the builder
 * reduces the caps by its fee bound of 1.5 tADA ahead of the fee, so the
 * per call cap covers the 1.5 tADA sent with the tokens plus the bound.
 */
export const TOKEN_LOVELACE_PER_CALL_CAP = 3n * TADA;
export const TOKEN_LOVELACE_CAP = 7n * TADA;

/** The lovelace that travels with the tokens of each token spend, above the minimum UTxO value of a token output. */
export const TOKEN_SPEND_LOVELACE = 1_500_000n;

/** How many tokens the refused token spend attempts, one above the per call cap. */
export const TOKEN_OVER_CAP = TOKEN_PER_CALL_CAP + 1n;

/** The lovelace of the token deposit, which carries the minted tokens into the account. */
export const TOKEN_DEPOSIT_LOVELACE = 2n * TADA;

/** How many deposits the multi deposit flow makes and the lovelace of each. */
export const SMALL_DEPOSIT_COUNT = 20;
export const SMALL_DEPOSIT_LOVELACE = 1_500_000n;

/** The caps of the sweep grant, wide enough to take every fund UTxO in one spend. */
export const SWEEP_GRANT_CAP = 1_000n * TADA;

/** The fee bound of the multi deposit sweeps, which spend over a dozen inputs each. */
export const SWEEP_FEE_BOUND = 2n * TADA;

/**
 * The most fund UTxOs one agent sweep spends. On chain every script
 * execution pays a fixed cost for the transaction context on top of the
 * handler's own work, so each Fund execution of a spend over twenty five
 * deposits costs about 0.7 M memory units and the whole spend about
 * 20.6 M, above the 14 M limit; twelve deposits beside the grant spend
 * stay near half of it.
 */
export const SWEEP_BATCH = 12;

/** The devices the largest state holds and how many the run adds beyond the owner: the agent key and six rotation keys. */
export const LARGEST_DEVICES = 8;
export const ROTATION_KEYS = 6;

/** The grants the largest state holds outstanding, the recipients each lists, and how many one transaction issues or sweeps. */
export const LARGEST_GRANTS = 16;
export const LARGEST_RECIPIENTS = 8;
export const GRANT_BATCH = 8;

/** The revoked slots the largest state lists, filled by revoking two rounds of sixteen grants one by one. */
export const LARGEST_REVOKED = 32;

/** The slot the first largest grant takes, after the three grants of the earlier flows. */
export const FIRST_LARGEST_SLOT = 3n;

/** The slot of the sweep grant, issued after the two rounds of largest grants. */
export const SWEEP_GRANT_SLOT = FIRST_LARGEST_SLOT + BigInt(2 * LARGEST_GRANTS);

/** The execution units a preprod transaction may use, as the protocol parameters set them. */
export const TRANSACTION_MEMORY_LIMIT = 14_000_000n;
export const TRANSACTION_STEPS_LIMIT = 10_000_000_000n;

/** One million memory units and one billion steps, the units the budget table counts in. */
const MEGA = 1_000_000;
const GIGA = 1_000_000_000;

/**
 * The flows of the preprod run in order. Each flow either confirms a
 * transaction on chain, is refused by the builder before anything reaches
 * the chain, is built without the builder's checks, signed and submitted
 * so that the node refuses it with the validator's own failure, or is
 * held in flight until the owner's revoke lands and then refused by the
 * node in phase one. A flow measured against the budget table names the
 * rows of the table its heaviest transaction is compared with.
 */
export const FLOW_PLAN: Flow[] = [
  { step: 1, description: 'createAccount, sponsored by the funding wallet and signed by the owner key, registers the stake credential with its deposit and mints the state NFT with the owner key as the only device and zero counters', outcome: 'confirmed' },
  { step: 2, description: 'deposit 120 tADA into the account with a plain transfer from the funding wallet', outcome: 'confirmed' },
  { step: 3, description: 'deposit 60 tADA into the account as a reserve from the funding wallet, under the reserve datum the owner alone can spend', outcome: 'confirmed' },
  { step: 4, description: 'spendWithDevice 5 tADA to the owner address, fee drawn from the reserve and the reserve recreated', outcome: 'confirmed' },
  { step: 5, description: 'withdrawRewards of zero from the reward account signed by the owner device', outcome: 'confirmed' },
  { step: 6, description: 'delegateStake to an active preprod pool signed by the owner device', outcome: 'confirmed' },
  { step: 7, description: 'issueGrant slot 0 to the agent key: 10 tADA per call, 15 tADA in total, owner as the only recipient, minted into its own grant UTxO paid by the account', outcome: 'confirmed' },
  { step: 8, description: 'spendWithGrant 8 tADA to the owner address signed by the agent, spending the grant UTxO and referencing the control UTxO', outcome: 'confirmed' },
  { step: 9, description: 'spendWithGrant 8 tADA again, beyond the remaining cap', outcome: 'refused by the builder', expectedMessage: /exceeds the remaining cap/ },
  { step: 10, description: 'spendWithGrant 8 tADA again, beyond the remaining cap, built unchecked, signed and submitted', outcome: 'refused by the node', expectedMessage: NODE_REFUSAL_MESSAGE },
  { step: 11, description: 'spendWithGrant 3 tADA to an address outside the recipients', outcome: 'refused by the builder', expectedMessage: /is not a recipient/ },
  { step: 12, description: 'spendWithGrant 3 tADA to an address outside the recipients, built unchecked, signed and submitted', outcome: 'refused by the node', expectedMessage: NODE_REFUSAL_MESSAGE },
  { step: 13, description: 'mint 20 test tokens under a native policy of the funding wallet key and deposit them into the account as plain funds', outcome: 'confirmed' },
  { step: 14, description: 'issueGrant slot 1 to the agent key over the test token: 10 tokens per call, 20 in total, 3 tADA alongside per call, 7 tADA alongside in total, the recipient wallet as the only recipient', outcome: 'confirmed' },
  { step: 15, description: 'spendWithGrant 11 tokens to the recipient, beyond the per call cap', outcome: 'refused by the builder', expectedMessage: /exceeds the per call cap/ },
  { step: 16, description: 'spendWithGrant 11 tokens to the recipient, beyond the per call cap, built unchecked, signed and submitted', outcome: 'refused by the node', expectedMessage: NODE_REFUSAL_MESSAGE },
  { step: 17, description: 'spendWithGrant 10 tokens with 1.5 tADA to the recipient twice, which exhausts the token cap and leaves no token in the account', outcome: 'confirmed' },
  { step: 18, description: 'the agent builds and signs spendWithGrant 1 tADA against slot 0 and holds it; revokeGrant slot 0 spends the control UTxO it references and lands; the agent then submits the held transaction and the node refuses it in phase one, its reference input spent', outcome: 'refused by the node in phase one', expectedMessage: PHASE_ONE_REFUSAL_MESSAGE },
  { step: 19, description: 'spendWithGrant 1 tADA with the revoked grant', outcome: 'refused by the builder', expectedMessage: /is dead: slot 0 is revoked/ },
  { step: 20, description: 'spendWithGrant 1 tADA with the revoked grant, built unchecked against the revoked control state, signed and submitted', outcome: 'refused by the node', expectedMessage: NODE_REFUSAL_MESSAGE },
  { step: 21, description: 'revokeAllGrants, bumping the grant generation to one and clearing the revoked list, which kills the exhausted token grant too', outcome: 'confirmed' },
  { step: 22, description: 'sweepGrant slots 0 and 1, dead by generation, burning both grant tokens and freeing their lovelace to the account', outcome: 'confirmed' },
  { step: 23, description: 'issueGrant slot 2 expiring in 90 seconds, then spendWithGrant after the expiry', outcome: 'refused by the builder', expectedMessage: /starts after grant .* expires/ },
  { step: 24, description: 'spendWithGrant 1 tADA with the expired grant, built unchecked with a validity range ending after the expiry, signed and submitted', outcome: 'refused by the node', expectedMessage: NODE_REFUSAL_MESSAGE },
  { step: 25, description: 'sweepGrant slot 2 with a validity range starting after its expiry, burning its grant token', outcome: 'confirmed' },
  { step: 26, description: 'addDevice seven times: the agent wallet key and six rotation keys, one transaction each, until the account holds eight devices', outcome: 'confirmed' },
  {
    step: 27,
    description: 'issueGrant eight grants with eight recipients each to the agent key, twice, slots 3 to 18, until sixteen grants are outstanding',
    outcome: 'confirmed',
    budget: [{ path: 'issue of eight grants with eight recipients each', handlers: 'Device and IssueGrants', netMemory: 6.91 * MEGA, netSteps: 2.13 * GIGA }],
  },
  {
    step: 28,
    description: 'revokeGrant slots 3 to 18 one by one, sixteen transactions, each appending its slot to the revoked list',
    outcome: 'confirmed',
    budget: [{ path: 'revoke of one slot', handlers: 'Device', netMemory: 1.1 * MEGA, netSteps: 0.32 * GIGA }],
  },
  {
    step: 29,
    description: 'sweepGrant slots 3 to 10 and 11 to 18, eight dead grants per transaction, burning their tokens',
    outcome: 'confirmed',
    budget: [{ path: 'sweep of eight dead grants', handlers: 'Device, eight SweepGrant and BurnGrants', netMemory: 8.26 * MEGA, netSteps: 2.55 * GIGA }],
  },
  {
    step: 30,
    description: 'issueGrant eight grants with eight recipients each, twice, slots 19 to 34, until sixteen grants are outstanding again',
    outcome: 'confirmed',
    budget: [{ path: 'issue of eight grants with eight recipients each', handlers: 'Device and IssueGrants', netMemory: 6.91 * MEGA, netSteps: 2.13 * GIGA }],
  },
  {
    step: 31,
    description: 'revokeGrant slots 19 to 34 one by one, sixteen transactions, until the revoked list holds its thirty two slots',
    outcome: 'confirmed',
    budget: [{ path: 'revoke of one slot over the largest state', handlers: 'Device', netMemory: 1.1 * MEGA, netSteps: 0.32 * GIGA }],
  },
  {
    step: 32,
    description: 'rewriteState over the largest state, eight devices, thirty two revoked slots and sixteen outstanding grants, replacing the sixth rotation key with a seventh',
    outcome: 'confirmed',
    budget: [{ path: 'device rewrite over the largest state', handlers: 'Device', netMemory: 1.1 * MEGA, netSteps: 0.32 * GIGA }],
  },
  {
    step: 33,
    description: 'sweepGrant slots 19 to 26 and 27 to 34 over the largest state, eight dead grants per transaction, burning their tokens',
    outcome: 'confirmed',
    budget: [{ path: 'sweep of eight dead grants over the largest state', handlers: 'Device, eight SweepGrant and BurnGrants', netMemory: 8.26 * MEGA, netSteps: 2.55 * GIGA }],
  },
  { step: 34, description: 'spendWithDevice 1 tADA to the owner address signed by the agent device, which finds the account by its persisted record and its own wallet alone', outcome: 'confirmed' },
  { step: 35, description: 'withdrawRewards of zero from the reward account signed by the agent device, again from the account record and its own wallet alone', outcome: 'confirmed' },
  { step: 36, description: 'deposit twenty UTxOs of 1.5 tADA into the account in one transaction from the funding wallet', outcome: 'confirmed' },
  { step: 37, description: 'issueGrant slot 35 to the agent key: 1,000 tADA per call and in total, the funding wallet as the only recipient', outcome: 'confirmed' },
  {
    step: 38,
    description: 'spendWithGrant over every fund UTxO of the account at once, the twenty deposits among them, built unchecked and evaluated through the provider: the execution units exceed the transaction limit, so it is refused before submission',
    outcome: 'refused by the builder',
    expectedMessage: /exceeds the transaction memory limit/,
  },
  {
    step: 39,
    description: 'spendWithGrant sweeping every fund UTxO of the account to the funding wallet in batches of at most twelve fund UTxOs per transaction, each referencing the largest control state',
    outcome: 'confirmed',
    budget: [
      { path: 'agent spend over eight deposits', handlers: 'SpendWithGrant and eight Fund', netMemory: 3.2 * MEGA, netSteps: 1.13 * GIGA },
      { path: 'agent spend over forty deposits', handlers: 'SpendWithGrant and forty Fund', netMemory: 13.4 * MEGA, netSteps: 6.18 * GIGA },
    ],
  },
  { step: 40, description: 'removeDevice the agent wallet key', outcome: 'confirmed' },
  { step: 41, description: 'removeDevice the six rotation keys, one transaction each, until the owner key is the only device', outcome: 'confirmed' },
  { step: 42, description: 'spendWithDevice, sponsored by the funding wallet, sweeps every fund and reserve UTxO back to it, leaving only the control UTxO at the account address', outcome: 'confirmed' },
];

/** The prefix cometa puts before the body Blockfrost returns for a submission it refused. */
const SUBMIT_FAILURE_PREFIX = /^postTransactionToChain: failed to submit transaction to Blockfrost endpoint\.\s*Error\s*/;

/** The errors the ledger reports when a script refused the transaction in phase two. */
const SCRIPT_FAILURE = /PlutusFailure|ScriptFailure|ValidationTagMismatch/;

/** The most characters of a node refusal the evidence quotes. */
export const NODE_REFUSAL_LENGTH = 480;

/** Where the ledger's own account of a refused transaction starts, when it is not already the whole text. */
const LEDGER_FAILURE_START = /ShelleyTxValidationError|ApplyTxError|ConwayUtxowFailure/;

/** The base64 script bytes the ledger prints ahead of a script's evaluation error. */
const SCRIPT_BYTES = /Base64-encoded script bytes:\s*"[^"]*"\s*/;

/** Where the ledger's dump of the script's arguments and context starts, which the evidence leaves out. */
const CONTEXT_DUMP = /\s*The protocol version is:.*$/;

/** Errors raised while talking to the network, which never count as a refusal. */
const NETWORK_FAILURE = /fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket hang up|status 5\d\d|429|rate limit|Could not parse response/i;

/**
 * Errors that show the contract, or the builder applying its rules ahead of
 * the chain, refusing the spend: the builder's own scope, recipient,
 * liveness and expiry checks, the node's phase two script failures as
 * Blockfrost reports them at submission or evaluation, and the node's
 * phase one refusal of a transaction whose reference input was spent.
 */
const REFUSAL = /refuses the spend|is not a recipient of grant|has no grant UTxO in slot|is dead:|starts after grant .* expires|exceeds the transaction memory limit|ScriptFailure|PlutusFailure|ValidationTagMismatch|BadInputsUTxO|script integrity|evaluateTransaction|not well formed|does not hold enough funds/i;

/* TYPES **********************************************************************/

/**
 * What a flow of the preprod run is expected to end in: a confirmed
 * transaction, a refusal by the builder applying the contract's rules
 * before anything reaches the chain, a refusal by the node running the
 * validator over a transaction built without those rules, or a refusal
 * by the node in phase one of a transaction held in flight while the
 * owner's revoke spent the control UTxO it references.
 */
export type FlowOutcome = 'confirmed' | 'refused by the builder' | 'refused by the node' | 'refused by the node in phase one';

/**
 * A row of the budget table in the security review a measured flow is
 * compared with: the path, the handlers the transaction runs, and the
 * net memory units and steps the review measured for them with the test
 * runner, summed over the handlers.
 */
export interface BudgetReference {
  path: string;
  handlers: string;
  netMemory: number;
  netSteps: number;
}

/**
 * One flow of the preprod run: its number, a one line description and the
 * outcome it must end in. A flow refused by the builder or the node also
 * carries the pattern its refusal message must match, so that an unrelated
 * error at the same step is never recorded as the expected refusal. A
 * flow measured against the budget table carries the rows it is compared
 * with.
 */
export interface Flow {
  step: number;
  description: string;
  outcome: FlowOutcome;
  expectedMessage?: RegExp;
  budget?: BudgetReference[];
}

/** The reasons a step can fail: refused by the contract or its builder, or broken by something else. */
export type FailureKind = 'refusal' | 'network' | 'unexpected';

/** The execution units one redeemer of a confirmed transaction used, as the chain recorded them. */
export interface RedeemerUnits {
  purpose: string;
  index: number;
  memory: bigint;
  steps: bigint;
}

/** A confirmed transaction with the execution units of each of its redeemers. */
export interface MeasuredTransaction {
  txId: string;
  redeemers: RedeemerUnits[];
}

/** The record of one flow after the run: its transactions, the refusal observed, and the execution units of its script transactions. */
export interface FlowRecord {
  flow: Flow;
  txIds: string[];
  refusal?: string;
  measured?: MeasuredTransaction[];
}

/** A transaction the run needs around the flows, such as funding the agent wallet. */
export interface SupportingTransaction {
  description: string;
  txId: string;
}

/** The facts of a run the evidence document states. */
export interface EvidenceFacts {
  date: string;
  fundingAddress: string;
  ownerAddress: string;
  agentAddress: string;
  recipientAddress: string;
  accountAddress: string;
  scriptHash: string;
  stakeScriptHash: string;
  rewardAddress: string;
  poolId: string;
  tokenPolicyId: string;
  records: FlowRecord[];
  supporting: SupportingTransaction[];
}

/* FUNCTIONS ******************************************************************/

/** Whether an error is the node refusing a submitted transaction because a script failed. */
export const isNodeScriptRefusal = (error: unknown): boolean => {
  const text = error instanceof Error ? error.message : String(error);
  return SUBMIT_FAILURE_PREFIX.test(text) && SCRIPT_FAILURE.test(text);
};

/** Whether an error is the node refusing a submitted transaction in phase one, before any script ran. */
export const isNodePhaseOneRefusal = (error: unknown): boolean => {
  const text = error instanceof Error ? error.message : String(error);
  return SUBMIT_FAILURE_PREFIX.test(text) && !SCRIPT_FAILURE.test(text);
};

/**
 * The text the ledger wrote inside a value Blockfrost returned: the
 * value itself when it is text, otherwise the first text found under its
 * message, error or contents fields, which is how Blockfrost nests the
 * ledger's failure.
 */
const ledgerText = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(ledgerText).find((text) => text !== undefined);
  }
  if (value !== null && typeof value === 'object') {
    for (const key of ['message', 'error', 'contents']) {
      const text = key in value ? ledgerText((value as Record<string, unknown>)[key]) : undefined;
      if (text !== undefined) {
        return text;
      }
    }
  }
  return undefined;
};

/** The text under every layer of JSON a body wraps it in. */
const unwrapJson = (body: string): string => {
  let text = body;
  for (let layer = 0; layer < 4; layer += 1) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return text;
    }
    const inner = ledgerText(parsed);
    if (inner === undefined || inner === text) {
      return text;
    }
    text = inner;
  }
  return text;
};

/**
 * The ledger error of a submission the node refused, as the evidence
 * quotes it: the ledger's failure dug out of the JSON layers Blockfrost
 * wraps it in, with its string escapes undone and on one line, without
 * the script bytes the ledger prints ahead of the evaluation error and
 * without the script context it prints after, cut to a readable length.
 */
export const nodeRefusalSummary = (message: string, maxLength: number = NODE_REFUSAL_LENGTH): string => {
  const text = unwrapJson(message.replace(SUBMIT_FAILURE_PREFIX, ''));
  const flat = text
    .replace(/\\+n/g, ' ')
    .replace(/\\+"/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
  const start = flat.search(LEDGER_FAILURE_START);
  const ledger = (start > 0 ? flat.slice(start) : flat)
    .replace(SCRIPT_BYTES, '')
    .replace(CONTEXT_DUMP, '')
    .replace(/\(PlutusFailure "\s+/, '(PlutusFailure "');
  const cut = ledger.length > maxLength ? ledger.slice(0, maxLength).trimEnd() : ledger;
  return cut.length < flat.length ? `${cut}...` : cut;
};

/** Classifies why a step failed from the error's text. */
export const classifyFailure = (error: unknown): FailureKind => {
  const text = error instanceof Error ? error.message : String(error);
  if (NETWORK_FAILURE.test(text)) {
    return 'network';
  }
  if (REFUSAL.test(text)) {
    return 'refusal';
  }
  return 'unexpected';
};

/** The link to a transaction on the preprod explorer. */
export const explorerLink = (txId: string): string => `https://preprod.cardanoscan.io/transaction/${txId}`;

/** A transaction id as a short explorer link. */
const link = (txId: string): string => `[${txId.slice(0, 12)}](${explorerLink(txId)})`;

/** Text as a markdown table cell holds it, with pipes escaped. */
const cell = (text: string): string => text.replace(/\|/g, '\\|');

/** A quantity with thousands separators. */
const grouped = (quantity: bigint): string => quantity.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** A share of a limit as a percentage with one decimal. */
const percent = (quantity: bigint, limit: bigint): string => `${(Number((quantity * 1000n) / limit) / 10).toFixed(1)}%`;

/** The memory units a measured transaction used over all its redeemers. */
export const memoryOf = (transaction: MeasuredTransaction): bigint => transaction.redeemers.reduce((total, redeemer) => total + redeemer.memory, 0n);

/** The steps a measured transaction used over all its redeemers. */
export const stepsOf = (transaction: MeasuredTransaction): bigint => transaction.redeemers.reduce((total, redeemer) => total + redeemer.steps, 0n);

/** The measured transaction of a record that used the most memory, or undefined when none ran a script. */
export const heaviestOf = (record: FlowRecord): MeasuredTransaction | undefined =>
  (record.measured ?? []).reduce<MeasuredTransaction | undefined>(
    (heaviest, candidate) => (heaviest === undefined || memoryOf(candidate) > memoryOf(heaviest) ? candidate : heaviest),
    undefined,
  );

/** The redeemers of a transaction grouped by purpose, as "3 spend" or "spend, mint". */
const redeemerSummary = (transaction: MeasuredTransaction): string => {
  const counts = new Map<string, number>();
  for (const redeemer of transaction.redeemers) {
    counts.set(redeemer.purpose, (counts.get(redeemer.purpose) ?? 0) + 1);
  }
  return [...counts.entries()].map(([purpose, count]) => (count === 1 ? purpose : `${count} ${purpose}`)).join(', ');
};

/** The memory and steps of each redeemer of a transaction, heaviest first, as the evidence lists them. */
const redeemerBreakdown = (transaction: MeasuredTransaction): string =>
  [...transaction.redeemers]
    .sort((a, b) => Number(b.memory - a.memory))
    .map((redeemer) => `${redeemer.purpose} ${redeemer.index}: ${grouped(redeemer.memory)} / ${grouped(redeemer.steps)}`)
    .join('; ');

/** The markdown row of a flow in the evidence table. */
export const evidenceRow = ({ flow, txIds, refusal }: FlowRecord): string => {
  const links = txIds.map(link).join(', ');
  const result = flow.outcome === 'confirmed' ? 'confirmed' : `${flow.outcome}: "${cell(refusal ?? '')}"`;
  return `| ${flow.step} | ${flow.description} | ${links || 'none'} | ${result} |`;
};

/** The markdown row of the heaviest script transaction of a flow in the execution units table. */
export const unitsRow = (record: FlowRecord): string | undefined => {
  const heaviest = heaviestOf(record);
  if (!heaviest) {
    return undefined;
  }
  const count = (record.measured ?? []).length;
  const memory = memoryOf(heaviest);
  const steps = stepsOf(heaviest);
  return `| ${record.flow.step} | ${count} | ${link(heaviest.txId)} | ${redeemerSummary(heaviest)} | ${grouped(memory)} (${percent(memory, TRANSACTION_MEMORY_LIMIT)}) | ${grouped(steps)} (${percent(steps, TRANSACTION_STEPS_LIMIT)}) | ${redeemerBreakdown(heaviest)} |`;
};

/** The markdown rows comparing the heaviest transaction of a measured flow with the budget rows it names. */
export const budgetRows = (record: FlowRecord): string[] => {
  const heaviest = heaviestOf(record);
  if (!heaviest || !record.flow.budget) {
    return [];
  }
  const memory = memoryOf(heaviest);
  const steps = stepsOf(heaviest);
  return record.flow.budget.map(
    (reference) =>
      `| ${record.flow.step} | ${reference.path} | ${reference.handlers} | ${link(heaviest.txId)} | ${heaviest.redeemers.length} | ${grouped(memory)} | ${grouped(steps)} | ${grouped(BigInt(Math.round(reference.netMemory)))} | ${grouped(BigInt(Math.round(reference.netSteps)))} | ${percent(memory, TRANSACTION_MEMORY_LIMIT)} / ${percent(steps, TRANSACTION_STEPS_LIMIT)} |`,
  );
};

/** The markdown row of a supporting transaction. */
export const supportingRow = ({ description, txId }: SupportingTransaction): string => `| ${description} | ${link(txId)} |`;

/** The markdown evidence document of a run. */
export const evidenceDocument = (facts: EvidenceFacts): string =>
  [
    '# Preprod evidence',
    '',
    'Every flow of the account custody contract exercised on the Cardano preprod',
    'network through Blockfrost. Confirmed flows link to their transactions on',
    'the preprod explorer. Flows refused by the builder quote the check that',
    'stopped them before anything reached the chain. Flows refused by the node',
    'were built without those checks, signed and submitted, and quote the',
    'ledger error Blockfrost returned when the validator failed in phase two;',
    'the node rejects such a transaction before it enters a block, so no',
    'collateral is consumed. The flow refused in phase one was built, signed',
    'and held while the owner revoked the grant it spends; the revoke spent',
    'the control UTxO the held transaction references, so the node refused',
    'it as a transaction over a spent input before running any script. The',
    "account stake credential is the hash of the account's own stake script,",
    'applied to the owner key and the account script hash: creation registers',
    'it with the deposit, and the owner device and later the agent device',
    'operate its reward account. Each grant lives in its own grant UTxO under',
    'its grant token; an agent spend consumes the grant UTxO and plain funds',
    'and references the control UTxO, which only the owner spends. The owner',
    'wallet holds no ADA beyond one collateral UTxO: the funding wallet',
    'sponsors the creation and the final sweep, and every other owner',
    'operation is paid from the account, its fee drawn from a reserve UTxO',
    'the owner alone can spend for as long as the reserve can cover the most',
    'a transaction can cost. The run builds the largest state the validators',
    'admit, eight devices, thirty two revoked slots and sixteen outstanding',
    'grants with eight recipients each, and records the execution units the',
    'chain charged for every script transaction, with the heaviest paths set',
    'against the budget table of the security review. An account is never',
    'deleted and its credential stays registered, so the run ends by sweeping',
    'the funds and the reserve back and leaving the control UTxO in place;',
    'every run therefore creates its account for a fresh owner key of the',
    'mnemonic.',
    '',
    `- Date: ${facts.date}`,
    `- Funding address: \`${facts.fundingAddress}\``,
    `- Owner address: \`${facts.ownerAddress}\``,
    `- Agent address: \`${facts.agentAddress}\``,
    `- Recipient address: \`${facts.recipientAddress}\``,
    `- Account address: \`${facts.accountAddress}\``,
    `- Account script hash: \`${facts.scriptHash}\``,
    `- State NFT policy id: \`${facts.scriptHash}\``,
    `- Account stake credential: \`${facts.stakeScriptHash}\``,
    `- Reward address: \`${facts.rewardAddress}\``,
    `- Delegated pool: \`${facts.poolId}\``,
    `- Test token policy id: \`${facts.tokenPolicyId}\``,
    '',
    '## Flows',
    '',
    '| Step | Flow | Transactions | Outcome |',
    '| ---- | ---- | ------------ | ------- |',
    ...facts.records.map(evidenceRow),
    '',
    '## Execution units',
    '',
    'The execution units the chain recorded for the heaviest script',
    'transaction of every step that ran one, read back from the redeemers of',
    'the confirmed transaction. Memory is in memory units and steps in CPU',
    'steps, each followed by its share of the per transaction limit of',
    `${grouped(TRANSACTION_MEMORY_LIMIT)} memory units and ${grouped(TRANSACTION_STEPS_LIMIT)} steps. The`,
    'breakdown lists every redeemer of the transaction by purpose and index,',
    'heaviest first, as memory / steps.',
    '',
    '| Step | Transactions | Heaviest | Redeemers | Memory | Steps | Breakdown |',
    '| ---- | ------------ | -------- | --------- | ------ | ----- | --------- |',
    ...facts.records.map(unitsRow).filter((row): row is string => row !== undefined),
    '',
    '## Budget comparison',
    '',
    'The heaviest transaction of each measured step against the rows of the',
    'budget table in `docs/security-review.md`, which gives the net memory',
    'units and steps of each handler as the test runner charged them over the',
    'largest state, summed here over the handlers the transaction runs. The',
    'on-chain figures are what the ledger charged for the same handlers over',
    'the real transaction, so they are the ones the limits apply to. The',
    'heaviest agent sweep batch is set against the eight and forty deposit',
    'rows of the review; its input count is in the Redeemers column, one Fund',
    'execution per deposit beside the SpendWithGrant execution. The forty',
    'deposit row is not reachable on chain: the whole sweep refused in the',
    'flows table above quotes the units a single spend over every deposit',
    'evaluated at.',
    '',
    '| Step | Path | Handlers | Transaction | Redeemers | On-chain memory | On-chain steps | Review net memory | Review net steps | Share of the limits |',
    '| ---- | ---- | -------- | ----------- | --------- | --------------- | -------------- | ----------------- | ---------------- | ------------------- |',
    ...facts.records.flatMap(budgetRows),
    '',
    '## Supporting transactions',
    '',
    '| Purpose | Transaction |',
    '| ------- | ----------- |',
    ...facts.supporting.map(supportingRow),
    '',
  ].join('\n');
