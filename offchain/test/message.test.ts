import { describe, expect, it } from 'vitest';
import { accountAddress } from '../src/address.js';
import { Cometa } from '../src/cometa.js';
import { type AccountState, encodeAccountState } from '../src/data.js';
import {
  type GrantMessageParts,
  encodeValue,
  granteeMessage,
  granteeMessageData,
  granteePublicKey,
  grantMessagePartsOf,
  posixTimeToSlot,
  signGrantMessage,
  slotToPosixTime,
  transactionBodyParts,
  upperBoundTime,
  validityRangeFromSlots,
  verifyGrantSignature,
  withoutCborCache,
} from '../src/message.js';
import { createAccount } from '../src/transactions.js';
import { GRANTEE_PRIVATE_KEY, GRANTEE_PUBLIC_KEY, initialState, nftAssetId, scenario, script } from './support/account.js';

const SCRIPT_HASH = '00000000000000000000000000000000000000000000000000000001';
const STAKE_KEY_HASH = '00000000000000000000000000000000000000000000000000000002';
const DEVICE_KEY = '00000000000000000000000000000000000000000000000000000004';
const STRANGER_KEY = '00000000000000000000000000000000000000000000000000000006';
const TOKEN_POLICY = '00000000000000000000000000000000000000000000000000000099';
const TOKEN_NAME = Cometa.utf8ToHex('token');
const EXPIRY = 1_800_000_000_000n;
const EXPECTED_MESSAGE = '72c8e421c9df7618914257c72d2770c87dff708c74d44cf906e52cb15493a9f2';
const EXPECTED_SIGNATURE =
  '8ed140d804d03766e38ecc5459647f19447616d17eced4c9c89e2a63949c4c652ddd60209604f585f38a5374a61400cbb9a1bc07889b97ef18970f5f3e83eb32';

/** The transaction the validator tests sign with the secp256k1 grantee key. */
const fixtureParts = (): GrantMessageParts => {
  const address = accountAddress(SCRIPT_HASH, STAKE_KEY_HASH).toString();
  const recipient = Cometa.EnterpriseAddress.fromCredentials(Cometa.NetworkId.Testnet, {
    hash: STRANGER_KEY,
    type: Cometa.CredentialType.KeyHash,
  })
    .toAddress()
    .toString();
  const state: AccountState = {
    devices: [DEVICE_KEY],
    grants: [
      {
        slot: 0n,
        grantee: { kind: 'ed25519', keyHash: STRANGER_KEY },
        scope: { asset: { policyId: '', assetName: '' }, perCallCap: 3_000_000n, cap: 5_000_000n, lovelaceCap: 0n, expiresAt: EXPIRY, recipients: [] },
      },
      {
        slot: 1n,
        grantee: { kind: 'secp256k1', publicKey: GRANTEE_PUBLIC_KEY },
        scope: { asset: { policyId: TOKEN_POLICY, assetName: TOKEN_NAME }, perCallCap: 10n, cap: 40n, lovelaceCap: 0n, expiresAt: EXPIRY, recipients: [recipient] },
      },
    ],
    grantGeneration: 0n,
  };
  const nft = `${SCRIPT_HASH}${STAKE_KEY_HASH}`;
  const token = `${TOKEN_POLICY}${TOKEN_NAME}`;
  return {
    controlReference: { txId: '00'.repeat(32), index: 0 },
    inputs: [
      { txId: '00'.repeat(32), index: 0 },
      { txId: '00'.repeat(32), index: 1 },
    ],
    outputs: [
      { address, value: { coins: 2_000_000n, assets: { [nft]: 1n } }, datum: encodeAccountState(state) },
      { address, value: { coins: 8_000_000n, assets: { [token]: 10n } } },
      { address: recipient, value: { coins: 2_000_000n, assets: { [token]: 10n } } },
    ],
    fee: 0n,
    validityRange: {
      lowerBound: { bound: { kind: 'negativeInfinity' }, inclusive: true },
      upperBound: { bound: { kind: 'finite', time: EXPIRY }, inclusive: true },
    },
    mint: {},
  };
};

describe('grantee message', () => {
  it('serialises the tuple with the ledger encoding', () => {
    const cbor = Cometa.plutusDataToCbor(granteeMessageData(fixtureParts()));
    expect(cbor.startsWith(`9f5820${Cometa.utf8ToHex('cardano_account_custody:grant:v1')}d8799f5820`)).toBe(true);
    expect(cbor.endsWith('a0ff')).toBe(true);
  });

  it('reproduces the digest the validator tests sign', () => {
    expect(Cometa.uint8ArrayToHex(granteeMessage(fixtureParts()))).toBe(EXPECTED_MESSAGE);
  });

  it('changes with every signed part', () => {
    const base = Cometa.uint8ArrayToHex(granteeMessage(fixtureParts()));
    const variants: ((parts: GrantMessageParts) => GrantMessageParts)[] = [
      (parts) => ({ ...parts, controlReference: { txId: '00'.repeat(32), index: 1 } }),
      (parts) => ({ ...parts, inputs: parts.inputs.slice(0, 1) }),
      (parts) => ({ ...parts, outputs: parts.outputs.slice(0, 2) }),
      (parts) => ({ ...parts, fee: 1n }),
      (parts) => ({ ...parts, validityRange: validityRangeFromSlots({ invalidHereafter: 1n }) }),
      (parts) => ({ ...parts, mint: { [`${TOKEN_POLICY}${TOKEN_NAME}`]: -1n } }),
    ];
    for (const variant of variants) {
      expect(Cometa.uint8ArrayToHex(granteeMessage(variant(fixtureParts())))).not.toBe(base);
    }
  });

  it('signs the digest in low s form and verifies it', () => {
    const message = granteeMessage(fixtureParts());
    expect(granteePublicKey(GRANTEE_PRIVATE_KEY)).toBe(GRANTEE_PUBLIC_KEY);
    const signature = signGrantMessage(GRANTEE_PRIVATE_KEY, message);
    expect(Cometa.uint8ArrayToHex(signature)).toBe(EXPECTED_SIGNATURE);
    expect(verifyGrantSignature(GRANTEE_PUBLIC_KEY, message, signature)).toBe(true);
    expect(verifyGrantSignature(GRANTEE_PUBLIC_KEY, granteeMessage({ ...fixtureParts(), fee: 1n }), signature)).toBe(false);
    expect(() => signGrantMessage(GRANTEE_PRIVATE_KEY, new Uint8Array(31))).toThrow(/32 byte/);
  });

  it('orders a value with lovelace first and policies and names sorted', () => {
    const value = { coins: 5n, assets: { ['bb'.repeat(28) + 'ff']: 1n, ['aa'.repeat(28) + '02']: 2n, ['aa'.repeat(28) + '01']: 3n } };
    expect(Cometa.plutusDataToCbor(encodeValue(value))).toBe(
      `a340a14005581c${'aa'.repeat(28)}a2410103410202581c${'bb'.repeat(28)}a141ff01`,
    );
  });

  it('drops the serialisation cache before re-encoding', () => {
    const cached = Cometa.cborToPlutusData('d8799f9f0102ffa14000ff');
    const stripped = withoutCborCache(cached);
    expect(JSON.stringify(stripped, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain('cbor');
    expect(Cometa.plutusDataToCbor(stripped)).toBe('d8799f9f0102ffa14000ff');
  });
});

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
    const tx = await createAccount({ wallet: owner, stakeKeyHash: owner.stakeKeyHash, state: initialState, script });
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
    const message = grantMessagePartsOf(tx, parts.inputs[0]!);
    expect(message.controlReference).toEqual(parts.inputs[0]);
    expect(message.fee).toBe(parts.fee);
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
