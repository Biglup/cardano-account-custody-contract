# Quickstart

This guide runs the whole life of a grant on preprod from a checkout. It
creates an account, deposits funds and a reserve, issues a grant to an
agent, spends under it, revokes it and sweeps it. The code is TypeScript
against the off-chain library. Terms are defined in the
[glossary](../glossary.md).

The library, `cardano-account-custody-offchain`, is private and is not
published to any registry. It is used from a checkout of this repository.
It reads the [blueprint](../glossary.md#blueprint) and the network files
relative to its own location, so it only works inside a checkout. See
[offchain/README.md](../../offchain/README.md) for the ways to use it.

## Before you start

You need:

- Node 22 and a checkout of this repository.
- A Blockfrost project id for preprod.
- A BIP-39 mnemonic whose account 0 holds at least 100 tADA on preprod.
  The preprod faucet can fund it. That wallet acts as the
  [fee sponsor](../glossary.md#fee-sponsor), the
  [collateral wallet](../glossary.md#collateral-wallet) and the
  depositor.

Install the dependencies:

```sh
cd offchain
npm ci
```

The guide uses three wallets of the mnemonic:

| Account index | Role |
| --- | --- |
| 0 | Fee sponsor, collateral wallet, depositor and payee |
| `OWNER_ACCOUNT` | The owner, the account's first device |
| `OWNER_ACCOUNT` + 1 | The agent, holding the grantee key |

An owner key creates one account, once. Its stake credential stays
registered for life, so a second creation with the same key always fails;
see [ADR 0002](../adr/0002-no-stake-credential-deregistration.md). Each
run therefore needs an `OWNER_ACCOUNT` that has never created an account.
The owner and the agent wallets hold no ADA in this guide.

The guide uses the reference scripts parked on preprod, which
[offchain/networks/preprod.json](../../offchain/networks/preprod.json)
records. Preprod's logic credential is registered. See
[network setup](../operations/network-setup.md).

## The script

Create `offchain/quickstart.ts` from the blocks below, in order. They form
one file.

### 1. Load the library and the wallets

`Cometa.ready()` must resolve before any other call. The library takes
key hashes, not keys: `paymentKeyHashOf` reads a wallet's payment key
hash from its address.

```ts
import { randomBytes } from 'node:crypto';
import type { Wallet } from '@biglup/cometa';
import {
  Cometa,
  LOVELACE,
  type AccountRecord,
  accountByOwner,
  accountExists,
  addBalances,
  createAccount,
  deposit,
  findAccountUtxos,
  issueGrant,
  loadNetworkScripts,
  paymentKeyHashOf,
  posixTimeToSlot,
  revokeGrant,
  spendWithDevice,
  spendWithGrant,
  sweepGrant,
  toBalance,
  toValue,
} from './src/index.js';

const projectId = process.env['BLOCKFROST_PREPROD_PROJECT_ID'] ?? '';
const mnemonics = (process.env['MNEMONIC'] ?? '').trim().split(/\s+/);
const ownerIndex = Number(process.env['OWNER_ACCOUNT'] ?? '1');

await Cometa.ready();
const provider = new Cometa.BlockfrostProvider({ network: Cometa.NetworkMagic.Preprod, projectId });
const network = loadNetworkScripts('preprod');

const password = randomBytes(32);
const walletAt = (account: number): Promise<Wallet> =>
  Cometa.SingleAddressWallet.createFromMnemonics({
    mnemonics,
    provider,
    getPassword: () => Promise.resolve(new Uint8Array(password)),
    credentialsConfig: { account, paymentIndex: 0, stakingIndex: 0 },
  });

const keyHashOf = async (wallet: Wallet): Promise<string> => {
  const keyHash = paymentKeyHashOf(await wallet.getChangeAddress());
  if (keyHash === undefined) {
    throw new Error('The wallet address pays to no key');
  }
  return keyHash;
};

const sponsor = await walletAt(0);
const owner = await walletAt(ownerIndex);
const agent = await walletAt(ownerIndex + 1);
const sponsorAddress = (await sponsor.getChangeAddress()).toString();
const ownerKey = await keyHashOf(owner);
const agentKey = await keyHashOf(agent);
```

### 2. Derive the account

The account address is a function of the owner key hash and the
blueprint. `accountByOwner` derives it. The
[account record](../glossary.md#account-record) is what every other party
uses to find the account.

```ts
const { stakeScriptHash, address } = accountByOwner(ownerKey);
const record: AccountRecord = { owner: ownerKey, stakeScriptHash, address };
if (await accountExists(provider, record)) {
  throw new Error(`Owner key ${ownerKey} has an account already; choose another OWNER_ACCOUNT`);
}
console.log(`Account address: ${address}`);
```

### 3. Sign and submit

Every builder returns an unsigned transaction as CBOR hex. The caller
collects a witness set from each wallet that must sign, submits, and waits
for the provider to show the result. Each step below reads the account's
UTxOs, so it waits until the previous transaction is visible.

```ts
const submit = async (tx: string, signers: Wallet[]): Promise<string> => {
  const witnesses = [];
  for (const signer of signers) {
    witnesses.push(...(await signer.signTransaction(tx, true)));
  }
  const txId = await provider.submitTransaction(Cometa.applyVkeyWitnessSet(tx, witnesses));
  if (!(await provider.confirmTransaction(txId, 600_000))) {
    throw new Error(`${txId} was not confirmed`);
  }
  while (!(await provider.getUnspentOutputs(address)).some((utxo) => utxo.input.txId === txId)) {
    await new Promise((done) => setTimeout(done, 5_000));
  }
  console.log(txId);
  return txId;
};
```

### 4. Create the account

The owner signs the [creation](../glossary.md#creation). The fee sponsor
pays the fee, the collateral, the registration deposit and the control
UTxO's lovelace. The initial state lists the owner as the only device,
with zero counters. It names no logic, so the builder pins `logic_v1`.

```ts
await submit(
  await createAccount({
    owner: ownerKey,
    wallet: owner,
    sponsor,
    provider,
    network,
    state: { devices: [ownerKey], grantGeneration: 0n, nextSlot: 0n, revoked: [], outstanding: 0n },
  }),
  [owner, sponsor],
);
```

### 5. Deposit funds and a reserve

Anyone can deposit. A plain deposit becomes a
[fund UTxO](../glossary.md#fund-utxo). A deposit with `reserve: true`
becomes a [reserve](../glossary.md#reserve), which only a device can
spend. Owner transactions draw their fee from it.

```ts
await submit(await deposit({ record, wallet: sponsor, network, value: { coins: 50_000_000n } }), [sponsor]);
await submit(await deposit({ record, wallet: sponsor, network, value: { coins: 10_000_000n }, reserve: true }), [sponsor]);
```

### 6. Issue a grant

From here on the owner's operations are paid by the account, with the
fee drawn from the reserve; see
[reserves and fee payment](../architecture.md#reserves-and-fee-payment).
The `collateral` option makes the sponsor provide
only the collateral, so the sponsor signs too. The grant lets the agent
move up to 10 ADA per transaction and 20 ADA in total, for one hour, to
the sponsor's address only. It takes slot 0, the account's first
[slot](../glossary.md#slot).

```ts
const device = { owner: ownerKey, wallet: owner, collateral: sponsor, provider, network };

await submit(
  await issueGrant({
    ...device,
    grants: [
      {
        grantee: agentKey,
        scope: {
          asset: LOVELACE,
          perCallCap: 10_000_000n,
          cap: 20_000_000n,
          lovelacePerCallCap: 0n,
          lovelaceCap: 0n,
          expiresAt: BigInt(Date.now()) + 3_600_000n,
          recipients: [sponsorAddress],
        },
      },
    ],
  }),
  [owner, sponsor],
);
```

### 7. Spend under the grant

The agent identifies the account by its record, not by the owner key. A
[grant spend](../glossary.md#grant-spend) must end its validity range no
later than the grant's expiry; here it ends 600 slots from now. The
account pays the fee. The grant's caps drop by the 5 ADA paid plus the
[fee bound](../glossary.md#fee-bound), so the per call cap must cover
both.

```ts
await submit(
  await spendWithGrant({
    record,
    wallet: agent,
    collateral: sponsor,
    provider,
    network,
    slot: 0n,
    grantee: agentKey,
    outputs: [{ address: sponsorAddress, value: { coins: 5_000_000n } }],
    validUntilSlot: posixTimeToSlot(BigInt(Date.now())) + 600n,
  }),
  [agent, sponsor],
);
```

### 8. Revoke and sweep

The [revoke](../glossary.md#revoke) adds slot 0 to the revoked list. The
grant is dead from the moment it confirms. The
[sweep](../glossary.md#sweep) then burns the grant token and returns the
grant UTxO's lovelace to the account. The two cannot share a transaction.

```ts
await submit(await revokeGrant({ ...device, slot: 0n }), [owner, sponsor]);
await submit(await sweepGrant({ ...device, slots: [0n] }), [owner, sponsor]);
```

### 9. Return the funds

The owner pays every fund UTxO and reserve back to the sponsor, which
sponsors this last transaction. The control UTxO stays: an account is
never deleted.

```ts
const { funds, reserves } = await findAccountUtxos(provider, { record, wallet: owner });
const balance = addBalances(...[...funds, ...reserves].map((utxo) => toBalance(utxo.output.value)));
await submit(
  await spendWithDevice({ owner: ownerKey, wallet: owner, sponsor, provider, network, outputs: [{ address: sponsorAddress, value: toValue(balance) }] }),
  [owner, sponsor],
);
```

## Run it

From `offchain/`:

```sh
BLOCKFROST_PREPROD_PROJECT_ID=<project id> \
MNEMONIC="<24 words>" \
OWNER_ACCOUNT=1 \
npx tsx quickstart.ts
```

The script prints the account address and one transaction id per step.

## When a step fails

- The builders check each operation against the contract's rules before
  anything reaches the chain. A refusal is a plain `Error` with an English
  message naming the rule, such as `exceeds the remaining cap`.
- A build that the scripts refuse is evaluated again through the provider,
  and the error carries the validator's own failure.
- `createAccount` fails when the owner key's stake credential is
  registered already. Use another `OWNER_ACCOUNT`.

## Next

- [Devices](devices.md): add a second device and remove one.
- [Grants](grants.md): scopes, batching, fee bounds and expiry.
- [Upgrade](upgrade.md): move an account to another logic.
- [Signers](signers.md): what a wallet must check before signing.
- [Transactions](../protocol/transactions.md): the shape of every
  operation.
