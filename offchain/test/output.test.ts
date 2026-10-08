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
import { Cometa } from '../src/cometa.js';
import { encodeAccountState } from '../src/data.js';
import { DEFAULT_ADA_PER_UTXO_BYTE, minimumLovelaceForSize, minimumUtxoLovelace, serialiseOutput } from '../src/output.js';
import { TOKEN_ASSET_ID, address, grantedState, nftAssetId, recipientAddress } from './support/account.js';

/* TESTS **********************************************************************/

describe('serialiseOutput', () => {
  it('round trips a lovelace only output', () => {
    const output = { address: recipientAddress, value: { coins: 1_500_000n } };
    expect(Cometa.readTxOutFromCbor(Cometa.uint8ArrayToHex(serialiseOutput(output)))).toEqual(output);
  });

  it('round trips an output carrying tokens and an inline datum', () => {
    const output = { address, value: { coins: 2_000_000n, assets: { [nftAssetId]: 1n, [TOKEN_ASSET_ID]: 3n } }, datum: encodeAccountState(grantedState) };
    const read = Cometa.readTxOutFromCbor(Cometa.uint8ArrayToHex(serialiseOutput(output)));
    expect(read.address).toBe(address);
    expect(read.value).toEqual(output.value);
    expect(Cometa.plutusDataToCbor(read.datum!)).toBe(Cometa.plutusDataToCbor(output.datum));
  });
});

describe('minimumUtxoLovelace', () => {
  it('prices the output by its serialised size plus the ledger overhead', () => {
    const output = { address: recipientAddress, value: { coins: 0n } };
    const minimum = minimumUtxoLovelace(output);
    const size = serialiseOutput({ ...output, value: { coins: minimum } }).length;
    expect(minimum).toBe(minimumLovelaceForSize(size, DEFAULT_ADA_PER_UTXO_BYTE));
    expect(minimum).toBeGreaterThan(800_000n);
    expect(minimum).toBeLessThan(1_200_000n);
  });

  it('grows with the datum and the tokens the output carries', () => {
    const plain = minimumUtxoLovelace({ address, value: { coins: 0n } });
    const withToken = minimumUtxoLovelace({ address, value: { coins: 0n, assets: { [TOKEN_ASSET_ID]: 1n } } });
    const withState = minimumUtxoLovelace({ address, value: { coins: 0n, assets: { [nftAssetId]: 1n } }, datum: encodeAccountState(grantedState) });
    expect(withToken).toBeGreaterThan(plain);
    expect(withState).toBeGreaterThan(withToken);
    expect(minimumUtxoLovelace({ address, value: { coins: 0n } }, 2n * DEFAULT_ADA_PER_UTXO_BYTE)).toBe(2n * plain);
  });
});
