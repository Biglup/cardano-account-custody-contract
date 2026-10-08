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
import { posixTimeToSlot, slotToPosixTime, transactionBodyParts, upperBoundTime, validityRangeFromSlots } from '../src/body.js';
import { Cometa } from '../src/cometa.js';
import { encodeAccountState, withoutCborCache } from '../src/data.js';
import { createAccount } from '../src/transactions.js';
import { OWNER_PAYMENT_KEY, initialState, nftAssetId, scenario, script } from './support/account.js';

/* TESTS **********************************************************************/

describe('validity range', () => {
  it('converts slots with the preprod slot config', () => {
    expect(slotToPosixTime(86_400n)).toBe(1_655_769_600_000n);
    expect(slotToPosixTime(86_401n)).toBe(1_655_769_601_000n);
    expect(posixTimeToSlot(1_655_769_601_999n)).toBe(86_401n);
  });

  it('makes the lower bound inclusive and the upper bound exclusive', () => {
    const range = validityRangeFromSlots({ invalidBefore: 100n, invalidHereafter: 200n });
    expect(range.lowerBound).toEqual({ bound: { kind: 'finite', time: slotToPosixTime(100n) }, inclusive: true });
    expect(range.upperBound).toEqual({ bound: { kind: 'finite', time: slotToPosixTime(200n) }, inclusive: false });
    expect(upperBoundTime(range)).toBe(slotToPosixTime(200n));
  });

  it('leaves missing bounds infinite', () => {
    const range = validityRangeFromSlots({});
    expect(range.lowerBound).toEqual({ bound: { kind: 'negativeInfinity' }, inclusive: true });
    expect(range.upperBound).toEqual({ bound: { kind: 'positiveInfinity' }, inclusive: true });
    expect(upperBoundTime(range)).toBeUndefined();
  });
});

describe('transaction body parts', () => {
  it('reads the inputs, outputs, fee, validity interval and mint of a built transaction', async () => {
    const { owner } = scenario(undefined, []);
    const tx = await createAccount({ wallet: owner, owner: OWNER_PAYMENT_KEY, state: initialState, script });
    const parts = transactionBodyParts(tx);
    const inspected = Cometa.inspectTx(tx) as {
      body: { fee: string; inputs: { transaction_id: string; index: number }[]; outputs: unknown[] };
    };
    expect(parts.inputs).toEqual(inspected.body.inputs.map((input) => ({ txId: input.transaction_id, index: input.index })));
    expect(parts.outputs).toHaveLength(inspected.body.outputs.length);
    expect(parts.fee).toBe(BigInt(inspected.body.fee));
    expect(parts.mint).toEqual({ [nftAssetId]: 1n });
    expect(parts.validityRange).toEqual(validityRangeFromSlots({}));
    const control = parts.outputs.find((output) => output.datum !== undefined);
    expect(control?.value.assets).toEqual({ [nftAssetId]: 1n });
    expect(Cometa.plutusDataToCbor(withoutCborCache(control!.datum!))).toBe(Cometa.plutusDataToCbor(encodeAccountState(initialState)));
  });

  it('sorts inputs by transaction id and index', () => {
    const tx =
      '84a300d9010283825820' + 'bb'.repeat(32) + '00825820' + 'aa'.repeat(32) + '01825820' + 'aa'.repeat(32) + '00' +
      '0180021a000f4240a0f5f6';
    expect(transactionBodyParts(tx).inputs).toEqual([
      { txId: 'aa'.repeat(32), index: 0 },
      { txId: 'aa'.repeat(32), index: 1 },
      { txId: 'bb'.repeat(32), index: 0 },
    ]);
  });
});
