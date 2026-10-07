/**
 * What a flow of the preprod run is expected to end in: a confirmed
 * transaction, a refusal by the builder applying the contract's rules
 * before anything reaches the chain, or a refusal by the node running the
 * validator over a transaction built without those rules.
 */
export type FlowOutcome = 'confirmed' | 'refused by the builder' | 'refused by the node';

/**
 * One flow of the preprod run: its number, a one line description and the
 * outcome it must end in. A flow refused by the builder or the node also
 * carries the pattern its refusal message must match, so that an unrelated
 * error at the same step is never recorded as the expected refusal.
 */
export interface Flow {
  step: number;
  description: string;
  outcome: FlowOutcome;
  expectedMessage?: RegExp;
}

/** The pattern the node's refusal message must match for every flow the node refuses. */
const NODE_REFUSAL_MESSAGE = /ValidationTagMismatch|PlutusFailure/;

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

/** The lovelace deposited into the account. */
export const DEPOSIT_LOVELACE = 50n * TADA;

/** The lovelace the owner spends in the first device spend. */
export const DEVICE_SPEND_LOVELACE = 5n * TADA;

/** The lovelace of each grant spend the agent attempts. */
export const GRANT_SPEND_LOVELACE = 8n * TADA;

/** The lovelace of the grant spend aimed at an address outside the recipients. */
export const STRANGER_SPEND_LOVELACE = 3n * TADA;

/** The lovelace of the grant spend attempted after the grant was revoked. */
export const REVOKED_SPEND_LOVELACE = 1n * TADA;

/** The lovelace the new device spends. */
export const NEW_DEVICE_SPEND_LOVELACE = 1n * TADA;

/** The rewards withdrawn in every withdrawal flow: the account earns none during the run, so only a zero withdrawal is valid. */
export const WITHDRAWN_LOVELACE = 0n;

/** The per call cap of every grant issued in the run. */
export const PER_CALL_CAP = 10n * TADA;

/** The cumulative cap of every grant issued in the run. */
export const CAP = 15n * TADA;

/** How long the long lived grants stay valid. */
export const GRANT_LIFETIME_MS = 2n * 60n * 60n * 1000n;

/** How long the short lived grant of the expiry flow stays valid. */
export const SHORT_GRANT_LIFETIME_MS = 90n * 1000n;

/** The least balance the funding wallet needs before the run starts. */
export const MINIMUM_FUNDING_LOVELACE = 200n * TADA;

/** The slot of the first grant issued to the agent. */
export const AGENT_GRANT_SLOT = 0n;
/** The slot of the short lived grant used to prove the expiry rule. */
export const SHORT_GRANT_SLOT = 1n;

/**
 * The flows of the preprod run in order. Each flow either confirms a
 * transaction on chain, is refused by the builder before anything reaches
 * the chain, or is built without the builder's checks, signed and
 * submitted so that the node refuses it with the validator's own failure.
 */
export const FLOW_PLAN: Flow[] = [
  { step: 1, description: 'createAccount, sponsored by the funding wallet and signed by the owner key, registers the stake credential with its deposit and mints the state NFT with the owner key as the only device', outcome: 'confirmed' },
  { step: 2, description: 'deposit 50 tADA into the account with a plain transfer from the funding wallet', outcome: 'confirmed' },
  { step: 3, description: 'spendWithDevice 5 tADA to the owner address, fee paid from the account', outcome: 'confirmed' },
  { step: 4, description: 'withdrawRewards of zero from the reward account signed by the owner device', outcome: 'confirmed' },
  { step: 5, description: 'delegateStake to an active preprod pool signed by the owner device', outcome: 'confirmed' },
  { step: 6, description: 'issueGrant slot 0 to the agent key: 10 tADA per call, 15 tADA in total, owner as the only recipient', outcome: 'confirmed' },
  { step: 7, description: 'spendWithGrant 8 tADA to the owner address signed by the agent', outcome: 'confirmed' },
  { step: 8, description: 'spendWithGrant 8 tADA again, beyond the remaining cap', outcome: 'refused by the builder', expectedMessage: /exceeds the remaining cap/ },
  { step: 9, description: 'spendWithGrant 8 tADA again, beyond the remaining cap, built unchecked, signed and submitted', outcome: 'refused by the node', expectedMessage: NODE_REFUSAL_MESSAGE },
  { step: 10, description: 'spendWithGrant 3 tADA to an address outside the recipients', outcome: 'refused by the builder', expectedMessage: /is not a recipient/ },
  { step: 11, description: 'spendWithGrant 3 tADA to an address outside the recipients, built unchecked, signed and submitted', outcome: 'refused by the node', expectedMessage: NODE_REFUSAL_MESSAGE },
  { step: 12, description: 'revokeGrant slot 0', outcome: 'confirmed' },
  { step: 13, description: 'spendWithGrant 1 tADA with the revoked grant', outcome: 'refused by the builder', expectedMessage: /no grant in slot/ },
  { step: 14, description: 'issueGrant slot 1 expiring in 90 seconds, then spendWithGrant after the expiry', outcome: 'refused by the builder', expectedMessage: /starts after grant .* expires/ },
  { step: 15, description: 'spendWithGrant 1 tADA with the expired grant, built unchecked with a validity range ending after the expiry, signed and submitted', outcome: 'refused by the node', expectedMessage: NODE_REFUSAL_MESSAGE },
  { step: 16, description: 'addDevice the agent wallet key, then spendWithDevice 1 tADA signed by the new device, which finds the account by its persisted record and its own wallet alone', outcome: 'confirmed' },
  { step: 17, description: 'withdrawRewards of zero from the reward account signed by the new device, again from the account record and its own wallet alone', outcome: 'confirmed' },
  { step: 18, description: 'removeDevice the agent wallet key', outcome: 'confirmed' },
  { step: 19, description: 'revokeAllGrants', outcome: 'confirmed' },
  { step: 20, description: 'spendWithDevice, sponsored by the funding wallet, sweeps every fund UTxO back to it, leaving only the control UTxO at the account address', outcome: 'confirmed' },
];

/** The reasons a step can fail: refused by the contract or its builder, or broken by something else. */
export type FailureKind = 'refusal' | 'network' | 'unexpected';

/** The prefix cometa puts before the body Blockfrost returns for a submission it refused. */
const SUBMIT_FAILURE_PREFIX = /^postTransactionToChain: failed to submit transaction to Blockfrost endpoint\.\s*Error\s*/;

/** The errors the ledger reports when a script refused the transaction in phase two. */
const SCRIPT_FAILURE = /PlutusFailure|ScriptFailure|ValidationTagMismatch/;

/** Whether an error is the node refusing a submitted transaction because a script failed. */
export const isNodeScriptRefusal = (error: unknown): boolean => {
  const text = error instanceof Error ? error.message : String(error);
  return SUBMIT_FAILURE_PREFIX.test(text) && SCRIPT_FAILURE.test(text);
};

/** The most characters of a node refusal the evidence quotes. */
export const NODE_REFUSAL_LENGTH = 480;

/** Where the ledger's own account of a refused transaction starts, when it is not already the whole text. */
const LEDGER_FAILURE_START = /ShelleyTxValidationError|ApplyTxError|ConwayUtxowFailure/;

/** The base64 script bytes the ledger prints ahead of a script's evaluation error. */
const SCRIPT_BYTES = /Base64-encoded script bytes:\s*"[^"]*"\s*/;

/** Where the ledger's dump of the script's arguments and context starts, which the evidence leaves out. */
const CONTEXT_DUMP = /\s*The protocol version is:.*$/;

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

/** Errors raised while talking to the network, which never count as a refusal. */
const NETWORK_FAILURE = /fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket hang up|status 5\d\d|429|rate limit|Could not parse response/i;

/**
 * Errors that show the contract, or the builder applying its rules ahead of
 * the chain, refusing the spend: the builder's own scope, recipient, grant
 * and expiry checks, and the node's phase two script failures as Blockfrost
 * reports them at submission or evaluation.
 */
const REFUSAL = /refuses the spend|is not a recipient of grant|has no grant in slot|starts after grant .* expires|ScriptFailure|PlutusFailure|ValidationTagMismatch|script integrity|evaluateTransaction|not well formed|does not hold enough funds/i;

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

/** The record of one flow after the run: its transactions, or the refusal observed. */
export interface FlowRecord {
  flow: Flow;
  txIds: string[];
  refusal?: string;
}

/** Text as a markdown table cell holds it, with pipes escaped. */
const cell = (text: string): string => text.replace(/\|/g, '\\|');

/** The markdown row of a flow in the evidence table. */
export const evidenceRow = ({ flow, txIds, refusal }: FlowRecord): string => {
  const links = txIds.map((txId) => `[${txId.slice(0, 12)}](${explorerLink(txId)})`).join(', ');
  const result = flow.outcome === 'confirmed' ? 'confirmed' : `${flow.outcome}: "${cell(refusal ?? '')}"`;
  return `| ${flow.step} | ${flow.description} | ${links || 'none'} | ${result} |`;
};

/** A transaction the run needs around the flows, such as funding the agent wallet. */
export interface SupportingTransaction {
  description: string;
  txId: string;
}

/** The markdown row of a supporting transaction. */
export const supportingRow = ({ description, txId }: SupportingTransaction): string =>
  `| ${description} | [${txId.slice(0, 12)}](${explorerLink(txId)}) |`;

/** The markdown evidence document of a run. */
export const evidenceDocument = (facts: {
  date: string;
  fundingAddress: string;
  ownerAddress: string;
  accountAddress: string;
  scriptHash: string;
  stakeScriptHash: string;
  rewardAddress: string;
  poolId: string;
  records: FlowRecord[];
  supporting: SupportingTransaction[];
}): string =>
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
    'collateral is consumed. The account stake credential is the hash of the',
    "account's own stake script, applied to the owner key and the account",
    'script hash: creation registers it with the deposit, and the owner device',
    'and later the second device operate its reward account. The owner wallet',
    'holds no ADA beyond one collateral UTxO: the funding wallet sponsors the',
    'creation and every later owner operation is paid from the account. An',
    'account is never deleted and its credential stays registered, so the run',
    'ends by sweeping the funds back and leaving the control UTxO in place;',
    'every run therefore creates its account for a fresh owner key of the',
    'mnemonic.',
    '',
    `- Date: ${facts.date}`,
    `- Funding address: \`${facts.fundingAddress}\``,
    `- Owner address: \`${facts.ownerAddress}\``,
    `- Account address: \`${facts.accountAddress}\``,
    `- Account script hash: \`${facts.scriptHash}\``,
    `- State NFT policy id: \`${facts.scriptHash}\``,
    `- Account stake credential: \`${facts.stakeScriptHash}\``,
    `- Reward address: \`${facts.rewardAddress}\``,
    `- Delegated pool: \`${facts.poolId}\``,
    '',
    '| Step | Flow | Transactions | Outcome |',
    '| ---- | ---- | ------------ | ------- |',
    ...facts.records.map(evidenceRow),
    '',
    '## Supporting transactions',
    '',
    '| Purpose | Transaction |',
    '| ------- | ----------- |',
    ...facts.supporting.map(supportingRow),
    '',
  ].join('\n');
