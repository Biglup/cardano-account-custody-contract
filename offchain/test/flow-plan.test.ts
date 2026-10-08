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
  FLOW_PLAN,
  GRANT_SPEND_LOVELACE,
  PER_CALL_CAP,
  NODE_REFUSAL_LENGTH,
  classifyFailure,
  evidenceDocument,
  evidenceRow,
  explorerLink,
  isNodeScriptRefusal,
  nodeRefusalSummary,
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

/* TESTS **********************************************************************/

describe('FLOW_PLAN', () => {
  it('lists the twenty four flows in order', () => {
    expect(FLOW_PLAN.map((flow) => flow.step)).toEqual(Array.from({ length: 24 }, (_, index) => index + 1));
    expect(FLOW_PLAN.some((flow) => /secp256k1/.test(flow.description))).toBe(false);
  });

  it('registers at creation, operates the stake credential through both devices and ends with a sweep that keeps the control UTxO', () => {
    expect(FLOW_PLAN[0]!.description).toContain('registers the stake credential');
    expect(FLOW_PLAN.filter((flow) => /withdrawRewards|delegateStake/.test(flow.description)).map((flow) => flow.step)).toEqual([5, 6, 21]);
    expect(FLOW_PLAN[19]!.description).toContain('addDevice');
    expect(FLOW_PLAN[19]!.description).toContain('signed by the new device');
    expect(FLOW_PLAN[23]!.description).toContain('leaving only the control UTxO');
    expect(FLOW_PLAN.some((flow) => /deleteAccount|deregister/.test(flow.description))).toBe(false);
    for (const step of [5, 6, 21]) {
      expect(FLOW_PLAN[step - 1]!.outcome).toBe('confirmed');
    }
  });

  it('funds a reserve, pays the owner steps from it, keeps each grant in its own UTxO and sweeps both dead grants', () => {
    expect(FLOW_PLAN[2]!.description).toContain('as a reserve');
    expect(FLOW_PLAN[3]!.description).toContain('fee drawn from the reserve');
    expect(FLOW_PLAN[6]!.description).toContain('its own grant UTxO');
    expect(FLOW_PLAN[7]!.description).toContain('referencing the control UTxO');
    expect(FLOW_PLAN.filter((flow) => /sweepGrant/.test(flow.description)).map((flow) => flow.step)).toEqual([16, 19]);
    expect(FLOW_PLAN[12]!.description).toContain('revokeGrant slot 0');
    expect(FLOW_PLAN[22]!.description).toContain('revokeAllGrants');
    expect(FLOW_PLAN[23]!.description).toContain('fund and reserve UTxO');
  });

  it('expects the builder to refuse the cap, recipient, revoked grant and expiry spends', () => {
    expect(FLOW_PLAN.filter((flow) => flow.outcome === 'refused by the builder').map((flow) => flow.step)).toEqual([9, 11, 14, 17]);
  });

  it('expects the node to refuse the unchecked cap, recipient, revoked and expiry spends', () => {
    expect(FLOW_PLAN.filter((flow) => flow.outcome === 'refused by the node').map((flow) => flow.step)).toEqual([10, 12, 15, 18]);
  });

  it('follows every builder refusal the node can also show with the unchecked submission', () => {
    for (const step of [9, 11, 14, 17]) {
      expect(FLOW_PLAN[step]!.outcome).toBe('refused by the node');
      expect(FLOW_PLAN[step]!.description).toContain('unchecked');
    }
  });

  it('matches each builder refusal against the message the builder produces, and not against an unrelated builder error', () => {
    const evidenceMessages: Record<number, string> = {
      9: 'Grant 0 refuses the spend: 9500000 of the scoped asset exceeds the remaining cap of 5500000',
      11: 'addr_test1qpq5gz7gyn39a0jh7sln54yrx7a72mgtmsm0zckkhve03zgkyqa8k48398gsyllkypnjqhavl6ghmejkwudrka28g8cqkygz08 is not a recipient of grant 0',
      14: 'Grant 0 is dead: slot 0 is revoked',
      17: 'Slot 135678122 starts after grant 1 expires',
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
    for (const step of [10, 12, 15, 18]) {
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
  });

  it('recognises the node refusing a script at submission', () => {
    expect(classifyFailure(new Error('postTransactionToChain: failed. Error {"contents":{"contents":{"contents":{"era":"ShelleyBasedEraConway","error":["ScriptFailure"]}}}}'))).toBe('refusal');
    expect(classifyFailure(new Error('evaluateTransaction: Blockfrost threw "..."'))).toBe('refusal');
    expect(classifyFailure(new Error(SUBMIT_ERROR))).toBe('refusal');
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

  it('writes the account facts and both tables', () => {
    const document = evidenceDocument({
      date: '2026-10-07',
      fundingAddress: 'addr_test1funding',
      ownerAddress: 'addr_test1owner',
      accountAddress: 'addr_test1account',
      scriptHash: 'cd'.repeat(28),
      stakeScriptHash: 'ef'.repeat(28),
      rewardAddress: 'stake_test1reward',
      poolId: 'pool1pool',
      records: [{ flow: FLOW_PLAN[0]!, txIds: [TX_ID] }],
      supporting: [{ description: 'fund the agent wallet', txId: TX_ID }],
    });
    expect(document).toContain('- Date: 2026-10-07');
    expect(document).toContain('- Owner address: `addr_test1owner`');
    expect(document).toContain('- Account address: `addr_test1account`');
    expect(document).toContain(`- State NFT policy id: \`${'cd'.repeat(28)}\``);
    expect(document).toContain(`- Account stake credential: \`${'ef'.repeat(28)}\``);
    expect(document).toContain('- Reward address: `stake_test1reward`');
    expect(document).toContain('- Delegated pool: `pool1pool`');
    expect(document).toContain('| 1 | createAccount');
    expect(document).toContain('| fund the agent wallet |');
    expect(document).toContain('no\ncollateral is consumed');
    expect(document).toContain('references the control UTxO');
    expect(document).toContain('steps 4 to 7, 13, 16, 17 and 19 to 23, is\npaid from the account, its fee drawn from a reserve UTxO');
  });
});
