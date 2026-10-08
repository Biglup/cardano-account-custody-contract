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
import { DEFAULT_GRANT_FEE_BOUND } from '../src/transactions.js';
import {
  CAP,
  DEPOSIT_LOVELACE,
  FIRST_LARGEST_SLOT,
  FLOW_PLAN,
  GRANT_BATCH,
  GRANT_SPEND_LOVELACE,
  LARGEST_DEVICES,
  LARGEST_GRANTS,
  LARGEST_REVOKED,
  type MeasuredTransaction,
  NODE_REFUSAL_LENGTH,
  PER_CALL_CAP,
  ROTATION_KEYS,
  SMALL_DEPOSIT_COUNT,
  SMALL_DEPOSIT_LOVELACE,
  SWEEP_BATCH,
  SWEEP_GRANT_CAP,
  SWEEP_GRANT_SLOT,
  TOKEN_CAP,
  TOKEN_LOVELACE_CAP,
  TOKEN_LOVELACE_PER_CALL_CAP,
  TOKEN_PER_CALL_CAP,
  TOKEN_SPEND_LOVELACE,
  TOKEN_SUPPLY,
  TRANSACTION_MEMORY_LIMIT,
  TRANSACTION_STEPS_LIMIT,
  budgetRows,
  classifyFailure,
  evidenceDocument,
  evidenceRow,
  explorerLink,
  heaviestOf,
  isNodePhaseOneRefusal,
  isNodeScriptRefusal,
  memoryOf,
  nodeRefusalSummary,
  stepsOf,
  unitsRow,
} from '../scripts/flow-plan.js';

/* CONSTANTS ******************************************************************/

const TX_ID = 'ab'.repeat(32);

/** The text of a Plutus failure as the ledger prints it, with the script bytes ahead of the error and the context after it. */
const PLUTUS_FAILURE_TEXT = [
  '',
  'The PlutusV3 script failed:',
  'Base64-encoded script bytes:',
  `\\"${'WRVq'.repeat(400)}\\"`,
  'The script hash is:ScriptHash \\"1d6e11888f1f6734c1e0cc479f29864e3ec932d33ad86da3c6431fa0\\"',
  'The plutus evaluation error is: CekError An error has occurred:',
  "The machine terminated because of an error, either from a built-in function or from an explicit use of 'error'.",
  'Caused by: error',
  'The protocol version is: Version 11',
  'ScriptInfo: SpendingScript (TxOutRef {txOutRefId = ab, txOutRefIdx = 0}) (Just (Datum {getDatum = Constr 0 []}))',
  'TxInfo:',
  '  Inputs: [ ab!2 -> - Value {getValue = Map {unMap = [(,Map {unMap = [(0x,33289278)]})]}} ]',
].join('\\n');

/** The ledger failure as Blockfrost quotes it: the Haskell show of the Conway failure holding the Plutus failure text and its debug bytes. */
const LEDGER_FAILURE = `ConwayUtxowFailure (UtxoFailure (UtxosFailure (ValidationTagMismatch Phase2Valid (FailedUnexpectedly (PlutusFailure \\"${PLUTUS_FAILURE_TEXT}\\" \\"${'kOrB'.repeat(300)}\\" :| [])))))`;

/** A submission error as cometa raises it from the body Blockfrost returns for a phase two failure, which nests the ledger failure in two JSON layers. */
const SUBMIT_ERROR =
  'postTransactionToChain: failed to submit transaction to Blockfrost endpoint.\nError ' +
  JSON.stringify({
    error: 'Bad Request',
    message: JSON.stringify({
      contents: {
        contents: { contents: { era: 'ShelleyBasedEraConway', error: [LEDGER_FAILURE] }, kind: 'ShelleyTxValidationError' },
        tag: 'TxValidationErrorInCardanoMode',
      },
      tag: 'TxSubmitFail',
    }),
    status_code: 400,
  });

/** A submission error as cometa raises it when the ledger refuses a transaction in phase one over a spent reference input. */
const PHASE_ONE_ERROR =
  'postTransactionToChain: failed to submit transaction to Blockfrost endpoint.\nError ' +
  JSON.stringify({
    error: 'Bad Request',
    message: JSON.stringify({
      contents: {
        contents: {
          contents: {
            era: 'ShelleyBasedEraConway',
            error: ['ConwayUtxowFailure (UtxoFailure (BadInputsUTxO (fromList [TxIn (TxId {unTxId = SafeHash \\"ab\\"}) (TxIx {unTxIx = 0})])))'],
          },
          kind: 'ShelleyTxValidationError',
        },
        tag: 'TxValidationErrorInCardanoMode',
      },
      tag: 'TxSubmitFail',
    }),
    status_code: 400,
  });

/** A measured transaction with a spend and a mint redeemer. */
const measured = (txId: string, spendMemory: bigint): MeasuredTransaction => ({
  txId,
  redeemers: [
    { purpose: 'spend', index: 0, memory: spendMemory, steps: 300_000_000n },
    { purpose: 'mint', index: 0, memory: 5_000_000n, steps: 1_500_000_000n },
  ],
});

/* TESTS **********************************************************************/

describe('FLOW_PLAN', () => {
  it('lists the forty two flows in order', () => {
    expect(FLOW_PLAN.map((flow) => flow.step)).toEqual(Array.from({ length: 42 }, (_, index) => index + 1));
    expect(FLOW_PLAN.some((flow) => /secp256k1/.test(flow.description))).toBe(false);
  });

  it('registers at creation, operates the stake credential through both devices and ends with a sweep that keeps the control UTxO', () => {
    expect(FLOW_PLAN[0]!.description).toContain('registers the stake credential');
    expect(FLOW_PLAN.filter((flow) => /withdrawRewards|delegateStake/.test(flow.description)).map((flow) => flow.step)).toEqual([5, 6, 35]);
    expect(FLOW_PLAN[25]!.description).toContain('addDevice');
    expect(FLOW_PLAN[33]!.description).toContain('signed by the agent device');
    expect(FLOW_PLAN[41]!.description).toContain('leaving only the control UTxO');
    expect(FLOW_PLAN.some((flow) => /deleteAccount|deregister/.test(flow.description))).toBe(false);
    for (const step of [5, 6, 35]) {
      expect(FLOW_PLAN[step - 1]!.outcome).toBe('confirmed');
    }
  });

  it('funds a reserve, pays the owner steps from it, keeps each grant in its own UTxO and sweeps every dead grant', () => {
    expect(FLOW_PLAN[2]!.description).toContain('as a reserve');
    expect(FLOW_PLAN[3]!.description).toContain('fee drawn from the reserve');
    expect(FLOW_PLAN[6]!.description).toContain('its own grant UTxO');
    expect(FLOW_PLAN[7]!.description).toContain('referencing the control UTxO');
    expect(FLOW_PLAN.filter((flow) => /sweepGrant/.test(flow.description)).map((flow) => flow.step)).toEqual([22, 25, 29, 33]);
    expect(FLOW_PLAN[20]!.description).toContain('revokeAllGrants');
    expect(FLOW_PLAN[41]!.description).toContain('fund and reserve UTxO');
  });

  it('mints a test token, issues a token grant and exhausts it with two spends', () => {
    expect(FLOW_PLAN[12]!.description).toContain('mint 20 test tokens');
    expect(FLOW_PLAN[13]!.description).toContain('issueGrant slot 1');
    expect(FLOW_PLAN[16]!.description).toContain('twice');
    expect(TOKEN_SUPPLY).toBe(TOKEN_CAP);
    expect(TOKEN_CAP % TOKEN_PER_CALL_CAP).toBe(0n);
    expect(TOKEN_SPEND_LOVELACE + DEFAULT_GRANT_FEE_BOUND).toBeLessThanOrEqual(TOKEN_LOVELACE_PER_CALL_CAP);
    expect((TOKEN_CAP / TOKEN_PER_CALL_CAP) * (TOKEN_SPEND_LOVELACE + DEFAULT_GRANT_FEE_BOUND)).toBeLessThanOrEqual(TOKEN_LOVELACE_CAP);
  });

  it('holds an agent spend in flight while the revoke lands and expects the node to refuse it in phase one', () => {
    const flow = FLOW_PLAN[17]!;
    expect(flow.outcome).toBe('refused by the node in phase one');
    expect(flow.description).toContain('revokeGrant slot 0');
    expect(flow.expectedMessage?.test('ConwayUtxowFailure (UtxoFailure (BadInputsUTxO (fromList [TxIn ...])))')).toBe(true);
    expect(flow.expectedMessage?.test('PlutusFailure')).toBe(false);
  });

  it('builds the largest state with eight devices, thirty two revoked slots and sixteen outstanding grants before the rewrite', () => {
    expect(LARGEST_DEVICES).toBe(1 + 1 + ROTATION_KEYS);
    expect(LARGEST_REVOKED).toBe(2 * LARGEST_GRANTS);
    expect(LARGEST_GRANTS % GRANT_BATCH).toBe(0);
    expect(SWEEP_GRANT_SLOT).toBe(FIRST_LARGEST_SLOT + 32n);
    expect(FLOW_PLAN[25]!.description).toContain('eight devices');
    expect(FLOW_PLAN[31]!.description).toContain('thirty two revoked slots');
    expect(FLOW_PLAN[31]!.description).toContain('sixteen outstanding grants');
    expect(FLOW_PLAN.filter((flow) => flow.budget !== undefined).map((flow) => flow.step)).toEqual([27, 28, 29, 30, 31, 32, 33, 39]);
    for (const flow of FLOW_PLAN.filter((candidate) => candidate.budget !== undefined)) {
      for (const reference of flow.budget!) {
        expect(reference.netMemory).toBeLessThan(Number(TRANSACTION_MEMORY_LIMIT));
        expect(reference.netSteps).toBeLessThan(Number(TRANSACTION_STEPS_LIMIT));
      }
    }
  });

  it('shows one sweep over every deposit refused over the limit, then sweeps at least twenty deposits in bounded batches under a grant wide enough', () => {
    expect(SMALL_DEPOSIT_COUNT).toBeGreaterThanOrEqual(20);
    expect(SWEEP_BATCH).toBeLessThan(SMALL_DEPOSIT_COUNT);
    expect(FLOW_PLAN[35]!.description).toContain('twenty UTxOs');
    expect(FLOW_PLAN[37]!.outcome).toBe('refused by the builder');
    expect(FLOW_PLAN[37]!.expectedMessage?.test('A spend over 25 fund UTxOs evaluates at 20575197 memory units and 7772140129 steps over 26 redeemers, which exceeds the transaction memory limit of 14000000 memory units and 10000000000 steps')).toBe(true);
    expect(FLOW_PLAN[38]!.description).toContain('at most twelve fund UTxOs');
    expect(SWEEP_GRANT_CAP).toBeGreaterThan(DEPOSIT_LOVELACE + BigInt(SMALL_DEPOSIT_COUNT) * SMALL_DEPOSIT_LOVELACE);
  });

  it('expects the builder to refuse the cap, recipient, token cap, revoked grant and expiry spends', () => {
    expect(FLOW_PLAN.filter((flow) => flow.outcome === 'refused by the builder').map((flow) => flow.step)).toEqual([9, 11, 15, 19, 23, 38]);
  });

  it('expects the node to refuse the unchecked cap, recipient, token cap, revoked and expiry spends in phase two', () => {
    expect(FLOW_PLAN.filter((flow) => flow.outcome === 'refused by the node').map((flow) => flow.step)).toEqual([10, 12, 16, 20, 24]);
  });

  it('follows every builder refusal the node can also show with the unchecked submission', () => {
    for (const step of [9, 11, 15, 19, 23]) {
      expect(FLOW_PLAN[step]!.outcome).toBe('refused by the node');
      expect(FLOW_PLAN[step]!.description).toContain('unchecked');
    }
  });

  it('matches each builder refusal against the message the builder produces, and not against an unrelated builder error', () => {
    const evidenceMessages: Record<number, string> = {
      9: 'Grant 0 refuses the spend: 9500000 of the scoped asset exceeds the remaining cap of 5500000',
      11: 'addr_test1qpq5gz7gyn39a0jh7sln54yrx7a72mgtmsm0zckkhve03zgkyqa8k48398gsyllkypnjqhavl6ghmejkwudrka28g8cqkygz08 is not a recipient of grant 0',
      15: 'Grant 1 refuses the spend: 11 of the scoped asset exceeds the per call cap of 10',
      19: 'Grant 0 is dead: slot 0 is revoked',
      23: 'Slot 135678122 starts after grant 2 expires',
      38: 'A spend over 25 fund UTxOs evaluates at 20575197 memory units and 7772140129 steps over 26 redeemers, which exceeds the transaction memory limit of 14000000 memory units and 10000000000 steps',
    };
    const unrelatedBuilderError = 'Grant 0 refuses the spend: the agent does not hold enough funds';
    for (const [step, message] of Object.entries(evidenceMessages)) {
      const flow = FLOW_PLAN[Number(step) - 1]!;
      expect(flow.expectedMessage?.test(message)).toBe(true);
      expect(flow.expectedMessage?.test(unrelatedBuilderError)).toBe(false);
    }
  });

  it('matches each node refusal against a validation tag mismatch or a plutus failure, and not against an unrelated submission error', () => {
    const nodeRefusalMessage =
      'ConwayUtxowFailure (UtxoFailure (UtxosFailure (ValidationTagMismatch Phase2Valid (FailedUnexpectedly (PlutusFailure "boom")))))';
    const unrelatedSubmissionError = 'BadInputsUTxO';
    for (const step of [10, 12, 16, 20, 24]) {
      const flow = FLOW_PLAN[step - 1]!;
      expect(flow.expectedMessage?.test(nodeRefusalMessage)).toBe(true);
      expect(flow.expectedMessage?.test(unrelatedSubmissionError)).toBe(false);
    }
  });

  it('sizes the grant spends so that the first fits with the fee bound and the second breaks the remaining cap', () => {
    expect(GRANT_SPEND_LOVELACE + DEFAULT_GRANT_FEE_BOUND).toBeLessThanOrEqual(PER_CALL_CAP);
    expect(GRANT_SPEND_LOVELACE + DEFAULT_GRANT_FEE_BOUND).toBeLessThanOrEqual(CAP);
    expect(2n * GRANT_SPEND_LOVELACE).toBeGreaterThan(CAP - GRANT_SPEND_LOVELACE - DEFAULT_GRANT_FEE_BOUND);
  });
});

describe('classifyFailure', () => {
  it('recognises the builder applying the grant rules', () => {
    expect(classifyFailure(new Error('Grant 0 refuses the spend: 9 exceeds the remaining cap of 6'))).toBe('refusal');
    expect(classifyFailure(new Error('addr_test1 is not a recipient of grant 0'))).toBe('refusal');
    expect(classifyFailure(new Error('The account has no grant UTxO in slot 0'))).toBe('refusal');
    expect(classifyFailure(new Error('Grant 0 is dead: slot 0 is revoked'))).toBe('refusal');
    expect(classifyFailure(new Error('Slot 100 starts after grant 2 expires'))).toBe('refusal');
    expect(classifyFailure(new Error('A spend over 25 fund UTxOs evaluates at 20575197 memory units, which exceeds the transaction memory limit of 14000000'))).toBe('refusal');
  });

  it('recognises the node refusing a script at submission', () => {
    expect(classifyFailure(new Error('postTransactionToChain: failed. Error {"contents":{"contents":{"contents":{"era":"ShelleyBasedEraConway","error":["ScriptFailure"]}}}}'))).toBe('refusal');
    expect(classifyFailure(new Error('evaluateTransaction: Blockfrost threw "..."'))).toBe('refusal');
    expect(classifyFailure(new Error(SUBMIT_ERROR))).toBe('refusal');
  });

  it('recognises the node refusing a transaction over a spent input in phase one', () => {
    expect(classifyFailure(new Error(PHASE_ONE_ERROR))).toBe('refusal');
  });

  it('never counts a network error as a refusal', () => {
    expect(classifyFailure(new Error('fetch failed'))).toBe('network');
    expect(classifyFailure(new Error('getUnspentOutputs: Network request failed with status 502.'))).toBe('network');
    expect(classifyFailure(new Error('getParameters: Blockfrost threw "Usage is over limit." 429'))).toBe('network');
  });

  it('leaves anything else unexplained', () => {
    expect(classifyFailure(new Error('Cannot read properties of undefined'))).toBe('unexpected');
    expect(classifyFailure('boom')).toBe('unexpected');
  });
});

describe('isNodeScriptRefusal', () => {
  it('only accepts a submission the ledger refused over a script', () => {
    expect(isNodeScriptRefusal(new Error(SUBMIT_ERROR))).toBe(true);
    expect(isNodeScriptRefusal(new Error('Grant 0 refuses the spend: 9 exceeds the remaining cap of 6'))).toBe(false);
    expect(isNodeScriptRefusal(new Error('postTransactionToChain: failed to submit transaction to Blockfrost endpoint.\nError {"message":"BadInputsUTxO"}'))).toBe(false);
    expect(isNodeScriptRefusal(new Error('evaluateTransaction: Blockfrost threw "PlutusFailure"'))).toBe(false);
  });
});

describe('isNodePhaseOneRefusal', () => {
  it('only accepts a submission the ledger refused before running a script', () => {
    expect(isNodePhaseOneRefusal(new Error(PHASE_ONE_ERROR))).toBe(true);
    expect(isNodePhaseOneRefusal(new Error(SUBMIT_ERROR))).toBe(false);
    expect(isNodePhaseOneRefusal(new Error('Grant 0 is dead: slot 0 is revoked'))).toBe(false);
    expect(isNodePhaseOneRefusal(new Error('fetch failed'))).toBe(false);
  });
});

describe('nodeRefusalSummary', () => {
  it('quotes the ledger failure and the script error on one line, without the script bytes or the context dump', () => {
    const summary = nodeRefusalSummary(SUBMIT_ERROR);
    expect(summary).toBe(
      'ConwayUtxowFailure (UtxoFailure (UtxosFailure (ValidationTagMismatch Phase2Valid (FailedUnexpectedly (PlutusFailure ' +
        '"The PlutusV3 script failed: The script hash is:ScriptHash "1d6e11888f1f6734c1e0cc479f29864e3ec932d33ad86da3c6431fa0" ' +
        'The plutus evaluation error is: CekError An error has occurred: ' +
        "The machine terminated because of an error, either from a built-in function or from an explicit use of 'error'. Caused by: error...",
    );
    expect(summary.length).toBeLessThanOrEqual(NODE_REFUSAL_LENGTH + 3);
  });

  it('cuts a long failure to the readable length', () => {
    const summary = nodeRefusalSummary(SUBMIT_ERROR, 60);
    expect(summary).toBe('ConwayUtxowFailure (UtxoFailure (UtxosFailure (ValidationTag...');
  });

  it('keeps a short message whole and falls back to the raw text when the body is not JSON', () => {
    expect(nodeRefusalSummary('postTransactionToChain: failed to submit transaction to Blockfrost endpoint.\nError {"message":"short"}')).toBe('short');
    expect(nodeRefusalSummary('postTransactionToChain: failed to submit transaction to Blockfrost endpoint.\nError   not json\n  at all')).toBe('not json at all');
    expect(nodeRefusalSummary('x'.repeat(10), 4)).toBe('xxxx...');
  });

  it('quotes a phase one failure whole', () => {
    expect(nodeRefusalSummary(PHASE_ONE_ERROR)).toBe(
      'ConwayUtxowFailure (UtxoFailure (BadInputsUTxO (fromList [TxIn (TxId {unTxId = SafeHash "ab"}) (TxIx {unTxIx = 0})])))',
    );
  });

  it('starts at the ledger failure when it sits inside other text', () => {
    expect(nodeRefusalSummary('"transaction submit error ShelleyTxValidationError ShelleyBasedEraConway (ApplyTxError (ConwayUtxowFailure x))"')).toBe(
      'ShelleyTxValidationError ShelleyBasedEraConway (ApplyTxError (ConwayUtxowFailure x))...',
    );
  });
});

describe('evidence', () => {
  it('links every transaction to the preprod explorer', () => {
    expect(explorerLink(TX_ID)).toBe(`https://preprod.cardanoscan.io/transaction/${TX_ID}`);
    expect(evidenceRow({ flow: FLOW_PLAN[0]!, txIds: [TX_ID] })).toBe(
      `| 1 | ${FLOW_PLAN[0]!.description} | [${TX_ID.slice(0, 12)}](${explorerLink(TX_ID)}) | confirmed |`,
    );
  });

  it('quotes the refusal of a refused flow, naming who refused and escaping pipes', () => {
    expect(evidenceRow({ flow: FLOW_PLAN[8]!, txIds: [], refusal: 'Grant 0 refuses the spend' })).toBe(
      `| 9 | ${FLOW_PLAN[8]!.description} | none | refused by the builder: "Grant 0 refuses the spend" |`,
    );
    expect(evidenceRow({ flow: FLOW_PLAN[9]!, txIds: [], refusal: 'PlutusFailure :| []' })).toBe(
      `| 10 | ${FLOW_PLAN[9]!.description} | none | refused by the node: "PlutusFailure :\\| []" |`,
    );
  });

  it('quotes the phase one refusal beside the revoke that landed', () => {
    expect(evidenceRow({ flow: FLOW_PLAN[17]!, txIds: [TX_ID], refusal: 'BadInputsUTxO' })).toBe(
      `| 18 | ${FLOW_PLAN[17]!.description} | [${TX_ID.slice(0, 12)}](${explorerLink(TX_ID)}) | refused by the node in phase one: "BadInputsUTxO" |`,
    );
  });

  it('sums the units of a measured transaction and picks the heaviest of a record', () => {
    const light = measured('11'.repeat(32), 1_000_000n);
    const heavy = measured('22'.repeat(32), 1_200_000n);
    expect(memoryOf(heavy)).toBe(6_200_000n);
    expect(stepsOf(heavy)).toBe(1_800_000_000n);
    expect(heaviestOf({ flow: FLOW_PLAN[26]!, txIds: [], measured: [light, heavy] })).toBe(heavy);
    expect(heaviestOf({ flow: FLOW_PLAN[26]!, txIds: [] })).toBeUndefined();
  });

  it('lists the heaviest transaction of a step with its share of the limits and its breakdown, and nothing for a step without scripts', () => {
    const row = unitsRow({ flow: FLOW_PLAN[26]!, txIds: [], measured: [measured('11'.repeat(32), 1_000_000n), measured(TX_ID, 1_200_000n)] });
    expect(row).toBe(
      `| 27 | 2 | [${TX_ID.slice(0, 12)}](${explorerLink(TX_ID)}) | spend, mint | 6,200,000 (44.2%) | 1,800,000,000 (18.0%) | mint 0: 5,000,000 / 1,500,000,000; spend 0: 1,200,000 / 300,000,000 |`,
    );
    expect(unitsRow({ flow: FLOW_PLAN[1]!, txIds: [TX_ID], measured: [] })).toBeUndefined();
  });

  it('compares the heaviest transaction of a measured step with every budget row it names', () => {
    const rows = budgetRows({ flow: FLOW_PLAN[38]!, txIds: [TX_ID], measured: [measured(TX_ID, 3_000_000n)] });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('| 39 | agent spend over eight deposits | SpendWithGrant and eight Fund |');
    expect(rows[0]).toContain('| 2 | 8,000,000 | 1,800,000,000 | 3,200,000 | 1,130,000,000 | 57.1% / 18.0% |');
    expect(rows[1]).toContain('agent spend over forty deposits');
    expect(budgetRows({ flow: FLOW_PLAN[0]!, txIds: [TX_ID], measured: [measured(TX_ID, 1n)] })).toEqual([]);
    expect(budgetRows({ flow: FLOW_PLAN[38]!, txIds: [TX_ID] })).toEqual([]);
  });

  it('writes the account facts and every table', () => {
    const document = evidenceDocument({
      date: '2026-10-08',
      fundingAddress: 'addr_test1funding',
      ownerAddress: 'addr_test1owner',
      agentAddress: 'addr_test1agent',
      recipientAddress: 'addr_test1recipient',
      accountAddress: 'addr_test1account',
      scriptHash: 'cd'.repeat(28),
      stakeScriptHash: 'ef'.repeat(28),
      rewardAddress: 'stake_test1reward',
      poolId: 'pool1pool',
      tokenPolicyId: '99'.repeat(28),
      records: [
        { flow: FLOW_PLAN[0]!, txIds: [TX_ID] },
        { flow: FLOW_PLAN[31]!, txIds: [TX_ID], measured: [measured(TX_ID, 1_100_000n)] },
      ],
      supporting: [{ description: 'fund the agent wallet', txId: TX_ID }],
    });
    expect(document).toContain('- Date: 2026-10-08');
    expect(document).toContain('- Owner address: `addr_test1owner`');
    expect(document).toContain('- Agent address: `addr_test1agent`');
    expect(document).toContain('- Recipient address: `addr_test1recipient`');
    expect(document).toContain('- Account address: `addr_test1account`');
    expect(document).toContain(`- State NFT policy id: \`${'cd'.repeat(28)}\``);
    expect(document).toContain(`- Account stake credential: \`${'ef'.repeat(28)}\``);
    expect(document).toContain('- Reward address: `stake_test1reward`');
    expect(document).toContain('- Delegated pool: `pool1pool`');
    expect(document).toContain(`- Test token policy id: \`${'99'.repeat(28)}\``);
    expect(document).toContain('## Flows');
    expect(document).toContain('| 1 | createAccount');
    expect(document).toContain('## Execution units');
    expect(document).toContain('| 32 | 1 |');
    expect(document).toContain('## Budget comparison');
    expect(document).toContain('| 32 | device rewrite over the largest state | Device |');
    expect(document).toContain('## Supporting transactions');
    expect(document).toContain('| fund the agent wallet |');
    expect(document).toContain('no\ncollateral is consumed');
    expect(document).toContain('references the control UTxO');
    expect(document).toContain('the control UTxO the held transaction references');
  });
});
