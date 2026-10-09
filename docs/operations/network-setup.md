# Network setup

Accounts on a network need two things that exist once per network: a
registered logic credential and, in practice, the scripts parked as
reference scripts. This is the [network setup](../glossary.md#network-setup).
Anyone can perform it, and it is done once. The
[architecture](../architecture.md#reference-scripts) explains why each
part exists, and [ADR 0005](../adr/0005-scripts-parked-at-the-logic-address.md)
why the scripts sit where they do.

The network setup is not part of the library. The library only reads its
result, the network file. The setup is performed by the repository's
flow script, `offchain/scripts/preprod-e2e.ts`, in setup mode.

## What the setup does

The setup submits three transactions, paid by the funding wallet. Their
shape is in [transactions](../protocol/transactions.md#network-setup).

### 1. Register the logic credential

The setup registers the credential of `logic_v1` applied to the proxy
hash. The funding wallet pays the registration deposit the protocol
parameters set. The credential can never be deregistered, so the deposit
stays locked; see
[ADR 0002](../adr/0002-no-stake-credential-deregistration.md).

### 2. Park the proxy and the logic

The setup parks the proxy and the logic, each in its own UTxO at the
script address of `logic_v1`. The funding wallet pays each UTxO's
minimum lovelace. Nobody can spend a parked UTxO, so that lovelace stays
locked. When the scripts must be parked is set out in
[reference scripts](../architecture.md#reference-scripts).

### 3. Record the network file

The setup writes `offchain/networks/<network>.json`:

```json
{
  "network": "preprod",
  "references": [
    {
      "scriptHash": "<28 byte script hash, hex>",
      "txId": "<transaction id, hex>",
      "index": 0,
      "address": "<address of the parked UTxO>",
      "lovelace": "<lovelace it holds, as a decimal string>"
    }
  ]
}
```

`loadNetworkScripts(network)` reads it, and every builder takes the
result as its `network` option. The rules:

- A network with no file has no reference scripts. The builders embed
  every script.
- A file must name its own network and hold well formed records, one per
  script hash. Anything else is refused.
- A builder given a `provider` checks through it that each recorded UTxO
  is unspent and carries a script of the recorded hash. A stale file is
  refused before anything is built.

## Run the setup

The flow script reads a `.env` file at the repository root. Copy
`.env.example` to `.env` and set `BLOCKFROST_PREPROD_PROJECT_ID`.

```sh
cd offchain
npm ci
npm run setup
```

- With no `FUNDING_MNEMONIC` set, the script generates a mnemonic, stores
  it in `.env`, prints the funding address and exits. The funding wallet
  is account 0 of that mnemonic.
- The script refuses to start while the funding wallet holds less than
  400 tADA. Fund it from the preprod faucet and run it again.
- When the network file records the proxy and the current logic, the
  script submits nothing and says so.
- Otherwise it registers the logic credential, parks both scripts,
  writes the network file and prints each transaction, each parked UTxO
  with its lovelace, the logic's reward address and what the funding
  wallet paid.

The script targets preprod by default. It derives the parking address
with the testnet network id. The variables that select another target
or endpoint are described in [CONTRIBUTING](../../CONTRIBUTING.md#switches).

## Preprod

Preprod is set up. [offchain/networks/preprod.json](../../offchain/networks/preprod.json)
is the record.

| Item | Value |
| --- | --- |
| Proxy hash | `ed61963ac94d12c0b320be5a336c36af66bc02c380e0aa3001899253` |
| Logic credential (`logic_v1` applied) | `2cd68e398bdf9fbc8d257614b54403451ee722520ec785fe14f8df5a` |
| Logic reward address | `stake_test17qkddr3e300el0ydy4mpfd2yqdz3aeez2g8v0p07znud7ksul9rpg` |
| Parking address | `addr_test1wqkddr3e300el0ydy4mpfd2yqdz3aeez2g8v0p07znud7ksuhmmkz` |
| Parked proxy | `574e6c3d2e64303015f4db89930848b47fef501c65c448a59d843a383a63fc7e#0` |
| Parked logic | `000b0715bb8613761555becc9b50105dd3e23b93f91bce01dea72c3bbd0228f8#0` |

## Add a logic version

A new logic version needs the same two steps on every network where
accounts will move to it. The flow script has no command for this. With
the library and a funded cometa wallet `funder`:

```ts
const proxyHash = accountScriptHash(accountScript());
const logic = logicScript(logicValidator(loadBlueprint('/path/to/next/plutus.json')), proxyHash);
const logicHash = logicScriptHash(logic);

const register = await (await funder.createTransactionBuilder())
  .registerStakeAddress({ rewardAddress: rewardAddress(logicHash), redeemer: encodeLogicRedeemer() })
  .addScript(logic)
  .build();

const parkedAt = referenceOf(loadNetworkScripts('preprod'), proxyHash)?.address;
if (parkedAt === undefined) {
  throw new Error('The network file records no parked proxy');
}
const adaPerUtxoByte = BigInt((await provider.getParameters()).adaPerUtxoByte);
const parked = { address: parkedAt, value: { coins: 0n }, scriptReference: logic };
const park = await (await funder.createTransactionBuilder())
  .addOutput({ ...parked, value: { coins: minimumUtxoLovelace(parked, adaPerUtxoByte) } })
  .build();
```

Sign and submit `register`, then `park`. Find the parked output's index
through the provider, and append a record for `logicHash` to the network
file. The new logic is parked beside the others, at the address of
`logic_v1`.

Before any account moves to the new version, read [upgrade](../guides/upgrade.md).
