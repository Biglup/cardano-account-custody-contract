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
import { DEFAULT_GRANT_FEE_BOUND, MAX_FUND_INPUTS } from '../src/transactions.js';
import {
  CAP,
  DEPOSIT_LOVELACE,
  FIRST_LARGEST_SLOT,
  FLOW_PLAN,
  GENERATION_AFTER_UPGRADE,
  GENERATION_BEFORE_UPGRADE,
  GRANT_BATCH,
  GRANT_SPEND_LOVELACE,
  LARGEST_DEVICES,
  LARGEST_GRANTS,
  LARGEST_REVOKED,
  type MeasuredTransaction,
  NODE_REFUSAL_LENGTH,
  PER_CALL_CAP,
  PRE_UPGRADE_GRANT_SLOT,
  REISSUED_GRANT_SLOT,
  ROTATION_KEYS,
  SETUP_PLAN,
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

/** The per transaction execution unit limits preprod reports, as a run reads them from the chain. */
const LIMITS = { memory: 17_500_000n, steps: 10_000_000_000n };

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

describe('SETUP_PLAN', () => {
  it('registers the logic credential, parks the proxy and the logic, and shows the bare withdrawal refused from a registered and an unregistered credential', () => {
    expect(SETUP_PLAN.map((flow) => flow.step)).toEqual([1, 2, 3, 4, 5]);
    expect(SETUP_PLAN[0]!.description).toContain('register the logic v1 credential');
    expect(SETUP_PLAN[1]!.description).toContain('park the proxy as a reference script');
    expect(SETUP_PLAN[2]!.description).toContain('park logic v1 as a reference script');
    expect(SETUP_PLAN.filter((flow) => /always fail script address/.test(flow.description)).map((flow) => flow.step)).toEqual([2, 3]);
    expect(SETUP_PLAN[3]!.outcome).toBe('refused by the node');
    expect(SETUP_PLAN[3]!.description).toContain('bare zero withdrawal from the registered logic v1 credential');
    expect(SETUP_PLAN[3]!.description).toContain('arrival path');
    expect(SETUP_PLAN[3]!.expectedMessage?.test('ValidationTagMismatch Phase2Valid (FailedUnexpectedly (PlutusFailure "boom")))')).toBe(true);
    expect(SETUP_PLAN[3]!.expectedMessage?.test('ConwayCertsFailure (WithdrawalsNotInRewardsCERTS (fromList [...]))')).toBe(false);
    expect(SETUP_PLAN[4]!.outcome).toBe('refused by the node in phase one');
    expect(SETUP_PLAN[4]!.expectedMessage?.test('ConwayCertsFailure (WithdrawalsNotInRewardsCERTS (fromList [...]))')).toBe(true);
    expect(SETUP_PLAN[4]!.expectedMessage?.test('PlutusFailure')).toBe(false);
  });
});

describe('FLOW_PLAN', () => {
  it('lists the fifty four flows in order', () => {
    expect(FLOW_PLAN.map((flow) => flow.step)).toEqual(Array.from({ length: 54 }, (_, index) => index + 1));
    expect(FLOW_PLAN.some((flow) => /secp256k1/.test(flow.description))).toBe(false);
  });

  it('runs the logic through its zero withdrawal from creation on and references the parked scripts', () => {
    expect(FLOW_PLAN[0]!.description).toContain('names logic v1 in the control datum and runs it through its zero withdrawal');
    expect(FLOW_PLAN[7]!.description).toContain('running logic v1 through its zero withdrawal');
    expect(FLOW_PLAN[45]!.description).toContain('both referenced from their parked UTxOs');
  });

  it('sets up logic v2, upgrades, kills and sweeps the old grant, reissues under v2, spends under v2 and refuses the grantee', () => {
    expect(FLOW_PLAN[42]!.description).toContain('setup of logic v2');
    expect(FLOW_PLAN[43]!.description).toContain('deposit 30 tADA');
    expect(FLOW_PLAN[44]!.description).toContain(`issueGrant slot ${PRE_UPGRADE_GRANT_SLOT}`);
    expect(FLOW_PLAN[44]!.description).toContain('under logic v1');
    expect(FLOW_PLAN[45]!.description).toContain('upgradeLogic to v2');
    expect(FLOW_PLAN[45]!.description).toContain(`generation bumped to ${GENERATION_AFTER_UPGRADE}`);
    expect(FLOW_PLAN[45]!.budget).toEqual([{ path: 'upgrade', handlers: 'Device, the leaving logic and the arriving logic', netMemory: 1_620_000, netSteps: 500_000_000 }]);
    expect(FLOW_PLAN[46]!.outcome).toBe('refused by the builder');
    expect(FLOW_PLAN[46]!.expectedMessage?.test(`Grant ${PRE_UPGRADE_GRANT_SLOT} is dead: grant ${PRE_UPGRADE_GRANT_SLOT} was issued under generation ${GENERATION_BEFORE_UPGRADE} and the account is at ${GENERATION_AFTER_UPGRADE}`)).toBe(true);
    expect(FLOW_PLAN[47]!.outcome).toBe('refused by the node');
    expect(FLOW_PLAN[48]!.description).toContain('stable prefix');
    expect(FLOW_PLAN[49]!.description).toContain(`issueGrant slot ${REISSUED_GRANT_SLOT}`);
    expect(FLOW_PLAN[49]!.description).toContain('survivingGrantRequests');
    expect(FLOW_PLAN[50]!.description).toContain('names logic v2');
    expect(FLOW_PLAN[51]!.expectedMessage?.test('The wallet payment key is not a device of the account')).toBe(true);
    expect(FLOW_PLAN[52]!.outcome).toBe('refused by the node');
    expect(FLOW_PLAN[53]!.description).toContain('leaving only the control UTxO under logic v2');
    expect(PRE_UPGRADE_GRANT_SLOT).toBe(SWEEP_GRANT_SLOT + 1n);
    expect(REISSUED_GRANT_SLOT).toBe(PRE_UPGRADE_GRANT_SLOT + 1n);
    expect(GENERATION_BEFORE_UPGRADE).toBe(2n);
    expect(GENERATION_AFTER_UPGRADE).toBe(GENERATION_BEFORE_UPGRADE + 1n);
    expect(FLOW_PLAN[53]!.description).toContain(`slot ${REISSUED_GRANT_SLOT} grant is revoked and swept`);
  });

  it('registers at creation, operates the stake credential through both devices and ends with a sweep that keeps the control UTxO', () => {
    expect(FLOW_PLAN[0]!.description).toContain('registers the stake credential');
    expect(FLOW_PLAN.filter((flow) => /withdrawRewards|delegateStake/.test(flow.description)).map((flow) => flow.step)).toEqual([5, 6, 35]);
    expect(FLOW_PLAN[25]!.description).toContain('addDevice');
    expect(FLOW_PLAN[33]!.description).toContain('signed by the agent device');
    expect(FLOW_PLAN[41]!.description).toContain('leaving only the control UTxO');
    expect(FLOW_PLAN.some((flow) => /deleteAccount|deregister/.test(flow.description))).toBe(false);
    expect(SETUP_PLAN.some((flow) => /deregister/.test(flow.description))).toBe(false);
    for (const step of [5, 6, 35]) {
      expect(FLOW_PLAN[step - 1]!.outcome).toBe('confirmed');
    }
  });

  it('funds a reserve, pays the owner steps from it, keeps each grant in its own UTxO and sweeps every dead grant', () => {
    expect(FLOW_PLAN[2]!.description).toContain('as a reserve');
    expect(FLOW_PLAN[3]!.description).toContain('fee drawn from the reserve');
    expect(FLOW_PLAN[6]!.description).toContain('its own grant UTxO');
    expect(FLOW_PLAN[7]!.description).toContain('referencing the control UTxO');
    expect(FLOW_PLAN.filter((flow) => /sweepGrant/.test(flow.description)).map((flow) => flow.step)).toEqual([22, 25, 29, 33, 49]);
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
    expect(FLOW_PLAN.filter((flow) => flow.budget !== undefined).map((flow) => flow.step)).toEqual([27, 28, 29, 30, 31, 32, 33, 39, 46]);
    for (const flow of FLOW_PLAN.filter((candidate) => candidate.budget !== undefined)) {
      for (const reference of flow.budget!) {
        expect(reference.netMemory).toBeLessThan(Number(LIMITS.memory));
        expect(reference.netSteps).toBeLessThan(Number(LIMITS.steps));
      }
    }
  });

  it('shows a spend over one more fund UTxO than the bound refused by the builder, then sweeps at least twenty deposits in bounded batches under a grant wide enough', () => {
    expect(SMALL_DEPOSIT_COUNT).toBeGreaterThanOrEqual(20);
    expect(SWEEP_BATCH).toBe(MAX_FUND_INPUTS);
    expect(SWEEP_BATCH).toBe(12);
    expect(SWEEP_BATCH + 1).toBeLessThan(SMALL_DEPOSIT_COUNT);
    expect(FLOW_PLAN[35]!.description).toContain('twenty UTxOs');
    expect(FLOW_PLAN[37]!.outcome).toBe('refused by the builder');
    expect(FLOW_PLAN[37]!.description).toContain('13 largest fund UTxOs');
    expect(FLOW_PLAN[37]!.expectedMessage?.test('The spend needs 13 fund UTxOs, more than the 12 one grant spend may take; sweep the funds in batches of fundBatches first')).toBe(true);
    expect(FLOW_PLAN[37]!.expectedMessage?.test('The spend needs 13 fund UTxOs, more than the 14 one grant spend may take')).toBe(false);
    expect(FLOW_PLAN[38]!.description).toContain('at most 12 fund UTxOs');
    expect(FLOW_PLAN[38]!.description).toContain('the first over exactly 12');
    expect(SWEEP_GRANT_CAP).toBeGreaterThan(DEPOSIT_LOVELACE + BigInt(SMALL_DEPOSIT_COUNT) * SMALL_DEPOSIT_LOVELACE);
  });

  it('expects the builder to refuse the cap, recipient, token cap, revoked grant, expiry, whole sweep, dead grant and grantee upgrade', () => {
    expect(FLOW_PLAN.filter((flow) => flow.outcome === 'refused by the builder').map((flow) => flow.step)).toEqual([9, 11, 15, 19, 23, 38, 47, 52]);
  });

  it('expects the node to refuse the unchecked cap, recipient, token cap, revoked, expiry, dead grant and grantee upgrade in phase two', () => {
    expect(FLOW_PLAN.filter((flow) => flow.outcome === 'refused by the node').map((flow) => flow.step)).toEqual([10, 12, 16, 20, 24, 48, 53]);
  });

  it('follows every builder refusal the node can also show with the unchecked submission', () => {
    for (const step of [9, 11, 15, 19, 23, 47]) {
      expect(FLOW_PLAN[step]!.outcome).toBe('refused by the node');
      expect(FLOW_PLAN[step]!.description).toContain('unchecked');
    }
    expect(FLOW_PLAN[52]!.outcome).toBe('refused by the node');
    expect(FLOW_PLAN[52]!.description).toContain('signed and submitted');
  });

  it('matches each builder refusal against the message the builder produces, and not against an unrelated builder error', () => {
    const evidenceMessages: Record<number, string> = {
      9: 'Grant 0 refuses the spend: 9500000 of the scoped asset exceeds the remaining cap of 5500000',
      11: 'addr_test1qpq5gz7gyn39a0jh7sln54yrx7a72mgtmsm0zckkhve03zgkyqa8k48398gsyllkypnjqhavl6ghmejkwudrka28g8cqkygz08 is not a recipient of grant 0',
      15: 'Grant 1 refuses the spend: 11 of the scoped asset exceeds the per call cap of 10',
      19: 'Grant 0 is dead: slot 0 is revoked',
      23: 'Slot 135678122 starts after grant 2 expires',
      38: 'The spend needs 13 fund UTxOs, more than the 12 one grant spend may take; sweep the funds in batches of fundBatches first',
      47: 'Grant 36 is dead: grant 36 was issued under generation 2 and the account is at 3',
      52: 'The wallet payment key is not a device of the account',
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
    for (const step of [10, 12, 16, 20, 24, 48, 53]) {
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
    expect(classifyFailure(new Error('The spend needs 13 fund UTxOs, more than the 12 one grant spend may take; sweep the funds in batches of fundBatches first'))).toBe('refusal');
    expect(classifyFailure(new Error('The wallet payment key is not a device of the account'))).toBe('refusal');
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
    expect(classifyFailure(new Error('getParameters: Request failed with status 429. Usage is over limit.'))).toBe('network');
    expect(classifyFailure(new Error('getParameters: Blockfrost threw "rate limit exceeded"'))).toBe('network');
  });

  it('never counts a refusal naming the number 429 as a network error', () => {
    expect(classifyFailure(new Error('Slot 429 starts after grant 2 expires'))).toBe('refusal');
    expect(classifyFailure(new Error('Grant 429 is dead: slot 429 is revoked'))).toBe('refusal');
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
    const row = unitsRow({ flow: FLOW_PLAN[26]!, txIds: [], measured: [measured('11'.repeat(32), 1_000_000n), measured(TX_ID, 1_200_000n)] }, LIMITS);
    expect(row).toBe(
      `| 27 | 2 | [${TX_ID.slice(0, 12)}](${explorerLink(TX_ID)}) | spend, mint | 6,200,000 (35.4%) | 1,800,000,000 (18.0%) | mint 0: 5,000,000 / 1,500,000,000; spend 0: 1,200,000 / 300,000,000 |`,
    );
    expect(unitsRow({ flow: FLOW_PLAN[26]!, txIds: [], measured: [measured(TX_ID, 1_200_000n)] }, { memory: 20_000_000n, steps: 10_000_000_000n })).toContain('| 6,200,000 (31.0%) |');
    expect(unitsRow({ flow: FLOW_PLAN[1]!, txIds: [TX_ID], measured: [] }, LIMITS)).toBeUndefined();
  });

  it('compares the heaviest transaction of a measured step with every budget row it names', () => {
    const rows = budgetRows({ flow: FLOW_PLAN[38]!, txIds: [TX_ID], measured: [measured(TX_ID, 3_000_000n)] }, LIMITS);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('| 39 | agent spend over eight deposits | SpendWithGrant and eight Fund |');
    expect(rows[0]).toContain('| 2 | 8,000,000 | 1,800,000,000 | 3,200,000 | 1,130,000,000 | 45.7% / 18.0% |');
    expect(rows[1]).toContain('agent spend over forty deposits');
    expect(budgetRows({ flow: FLOW_PLAN[45]!, txIds: [TX_ID], measured: [measured(TX_ID, 1_000_000n)] }, LIMITS)).toEqual([
      `| 46 | upgrade | Device, the leaving logic and the arriving logic | [${TX_ID.slice(0, 12)}](${explorerLink(TX_ID)}) | 2 | 6,000,000 | 1,800,000,000 | 1,620,000 | 500,000,000 | 34.2% / 18.0% |`,
    ]);
    expect(budgetRows({ flow: FLOW_PLAN[0]!, txIds: [TX_ID], measured: [measured(TX_ID, 1n)] }, LIMITS)).toEqual([]);
    expect(budgetRows({ flow: FLOW_PLAN[38]!, txIds: [TX_ID] }, LIMITS)).toEqual([]);
  });

  it('writes the account facts and every table', () => {
    const document = evidenceDocument({
      limits: LIMITS,
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
      logicV1Hash: '11'.repeat(28),
      logicV2Hash: '22'.repeat(28),
      setup: [{ flow: SETUP_PLAN[0]!, txIds: [TX_ID] }, { flow: SETUP_PLAN[4]!, txIds: [], refusal: 'WithdrawalsNotInRewardsCERTS' }],
      records: [
        { flow: FLOW_PLAN[0]!, txIds: [TX_ID] },
        { flow: FLOW_PLAN[31]!, txIds: [TX_ID], measured: [measured(TX_ID, 1_100_000n)] },
        { flow: FLOW_PLAN[45]!, txIds: [TX_ID], measured: [measured(TX_ID, 2_000_000n)] },
      ],
      supporting: [{ description: 'fund the agent wallet', txId: TX_ID }],
    });
    expect(document).toContain('- Date: 2026-10-08');
    expect(document).toContain(`- Account proxy hash: \`${'cd'.repeat(28)}\``);
    expect(document).toContain(`- Logic v1 hash: \`${'11'.repeat(28)}\``);
    expect(document).toContain(`- Logic v2 hash: \`${'22'.repeat(28)}\``);
    expect(document).toContain('## Setup');
    expect(document).toContain('refused by the logic in\nphase two');
    expect(document).toContain('| 1 | register the logic v1 credential');
    expect(document).toContain('| 5 | a zero withdrawal from an unregistered logic credential');
    expect(document).toContain('refused by the node in phase one: "WithdrawalsNotInRewardsCERTS"');
    expect(document).toContain('| 46 | upgradeLogic to v2');
    expect(document).toContain('| 46 | upgrade | Device, the leaving logic and the arriving logic |');
    expect(document).toContain('over an account holding one device, no revoked\nslot and one outstanding grant');
    expect(document).toContain('refused a move back to the first version');
    expect(document).toContain('zero\nwithdrawal from the logic credential');
    expect(document.indexOf('## Setup')).toBeLessThan(document.indexOf('## Flows'));
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
    expect(document).toContain('17,500,000 memory units and 10,000,000,000 steps, as the protocol\nparameters of preprod report it');
    expect(document).toContain('| 32 | 1 |');
    expect(document).toContain('| 6,100,000 (34.8%) |');
    expect(document).toContain('at most twelve\nfund UTxOs');
    expect(document).toContain('## Budget comparison');
    expect(document).toContain('| 32 | device rewrite over the largest state | Device |');
    expect(document).toContain('## Supporting transactions');
    expect(document).toContain('| fund the agent wallet |');
    expect(document).toContain('no\ncollateral is consumed');
    expect(document).toContain('references the control UTxO');
    expect(document).toContain('the control UTxO the held transaction references');
  });

  it('leaves out the logic v2 fact and the setup section while the run records neither', () => {
    const document = evidenceDocument({
      limits: LIMITS,
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
      logicV1Hash: '11'.repeat(28),
      records: [{ flow: FLOW_PLAN[0]!, txIds: [TX_ID] }],
      supporting: [],
    });
    expect(document).toContain(`- Logic v1 hash: \`${'11'.repeat(28)}\`\n\n## Flows`);
    expect(document).not.toContain('Logic v2 hash');
    expect(document).not.toContain('## Setup');
    expect(document).not.toContain('| ---- | ---- | ------------ | ------- |\n\n');
    expect(document).toContain('| 1 | createAccount');
  });

  it('titles a devnet run, lists its transactions by id and states the limits it read from the devnet', () => {
    const document = evidenceDocument({
      network: 'devnet',
      limits: LIMITS,
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
      logicV1Hash: '11'.repeat(28),
      records: [{ flow: FLOW_PLAN[31]!, txIds: [TX_ID], measured: [measured(TX_ID, 1_100_000n)] }],
      supporting: [],
    });
    expect(document).toContain('# Devnet evidence');
    expect(document).toContain('cost models of its own\nConway genesis, whose memory prices equal preprod and whose CPU prices\nfor integer division and byte string equality sit below it');
    expect(document).toContain(`| 32 | ${FLOW_PLAN[31]!.description} | \`${TX_ID.slice(0, 12)}\` | confirmed |`);
    expect(document).toContain('parameters of devnet report it');
    expect(document).not.toContain(explorerLink(TX_ID));
  });
});
