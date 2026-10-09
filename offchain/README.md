# cardano-account-custody-offchain

The TypeScript library that builds every transaction of the Cardano
account custody contract. It derives an account's identifiers from the
blueprint, finds the account's UTxOs and builds each operation the
validators accept. It is built on [cometa.js](https://www.npmjs.com/package/@biglup/cometa).

This package is the reference implementation of the transaction
builders. It is private (`"private": true`) and is not published to npm
or any other registry. Wallets and services that integrate the contract
use it from a checkout, or port it to their own transaction builder.

Terms are defined in the [glossary](../docs/glossary.md).

## Requirements

- Node 22.
- A checkout of the repository. The library reads `plutus.json` from the
  repository root and the network files from `offchain/networks`,
  relative to its own location.

## Use from a checkout

Install the dependencies once:

```sh
cd offchain
npm ci
```

Then either:

- Write a script inside `offchain/` that imports from `./src/index.js`,
  and run it with `npx tsx <script>.ts`. The
  [quickstart](../docs/guides/quickstart.md) works this way.
- Build the package with `npm run build`, and install it into another
  Node project by path: `npm install /path/to/checkout/offchain`. npm
  links the directory, so the library keeps reading the checkout's
  blueprint and network files. Import from
  `cardano-account-custody-offchain`.

Await `Cometa.ready()`, exported by the library, before any other call.
The library loads cometa's CommonJS build and runs on Node only.

Every builder returns the unsigned transaction as CBOR hex. The caller
gathers a witness set from every wallet that must sign it and submits it.
Errors are plain `Error` objects with English messages that name the rule
or the value at fault.

## Module map

| Module | Contents |
| --- | --- |
| `cometa` | The `Cometa` namespace, loaded once for every module |
| `blueprint` | `loadBlueprint`, the proxy script and hash, `logicValidator` |
| `stake-script` | `applyParameters`, `stakeScript`, `stakeScriptHash`, `stakeCredential` |
| `logic` | `logicScript`, `currentLogicScript`, `currentLogicHash`, `logicCatalog` |
| `network` | `loadNetworkScripts`, reference script records and their resolution |
| `discovery` | `accountByOwner`, `accountExists`, `grantsOf`, `deadGrantsOf`, `classifyAccountUtxos`, `AccountRecord` |
| `address` | Account and reward addresses, state NFT and grant token names, `paymentKeyHashOf` |
| `data` | The datum and redeemer types, with an encoder and a decoder for each |
| `state` | The bounds, well formedness, state transforms, scope checks and `LOVELACE` |
| `value` | Multi asset balances and their arithmetic |
| `output` | Minimum UTxO lovelace of an output |
| `body` | Slot and POSIX time conversion, `transactionBodyParts` |
| `transactions` | The builders, `findAccountUtxos`, `selectFundUtxos`, `fundBatches`, `survivingGrantRequests`, `buildChecked` |

`applyParameters` applies parameters to a blueprint validator in
TypeScript. Its result is byte for byte what `aiken blueprint apply`
produces. `stakeScript` and `logicScript` build on it.

`accountExists` returns the control UTxO, the state it carries and the
logic hash its control datum names. It returns null when the account
has no control UTxO.

`src/config.ts` holds the run configuration of the repository's scripts.
`src/index.ts` does not export it.

## Builders

| Builder | Operation | Signed by |
| --- | --- | --- |
| `createAccount` | Creation | The owner, and the fee sponsor when given |
| `deposit` | A plain deposit or, with `reserve: true`, a reserve | The paying wallet |
| `spendWithDevice` | Pay outputs from funds and reserves, optionally rewriting the state | A device |
| `rewriteState` | Rewrite the state, counters unchanged | A device |
| `addDevice`, `removeDevice` | Change the device list | A device |
| `issueGrant` | Issue one to eight grants | A device |
| `revokeGrant`, `revokeAllGrants` | Revoke a slot, or raise the generation | A device |
| `sweepGrant` | Sweep one to eight dead grants | A device |
| `upgradeLogic` | Point the account at another logic | A device |
| `withdrawRewards`, `delegateStake` | Withdraw rewards, delegate to a pool | A device |
| `spendWithGrant` | Spend under a grant | The grantee |

A fee sponsor or a collateral wallet signs too when given. The shape of
each transaction is in
[transactions](../docs/protocol/transactions.md). The guides show each
builder in use: [quickstart](../docs/guides/quickstart.md),
[devices](../docs/guides/devices.md), [grants](../docs/guides/grants.md)
and [upgrade](../docs/guides/upgrade.md).

## Options

| Option | Meaning |
| --- | --- |
| `owner` or `record` | The account, by its owner key hash or by its account record |
| `wallet` | The signing wallet: a device, the grantee's wallet, or the depositor |
| `sponsor` | A fee sponsor that pays the fee and collateral and receives the change. Refused on a grant spend. |
| `collateral` | A wallet that provides only the collateral. Not together with `sponsor`. |
| `provider` | Lists UTxOs, reads parameters and evaluates scripts. Required for every builder that reads the account. |
| `network` | The reference scripts `loadNetworkScripts` read. Scripts are embedded when omitted. |
| `logics` | Logic scripts beyond the blueprint's, applied to the proxy hash |
| `script` | The proxy script; the blueprint's by default |
| `networkId` | The address network; testnet by default |
| `slotConfig` | Slot timing for validity bounds; preprod's by default |
| `validUntilSlot` | The validity end. Optional on owner transactions, required on a grant spend. |
| `minimumChangeLovelace` | The least lovelace of a change output to the account |
| `unchecked` | Skips the builder's checks and the evaluation, and carries fixed execution budgets, so that the node refuses what the validators refuse. Never for transactions meant to confirm. |

The fixed budgets go per redeemer. Every withdrawal redeemer, the logic withdrawal among them,
gets the logic budget. Every other redeemer gets the proxy budget. The
budgets are `UNCHECKED_EXECUTION_UNITS`, applied by
`fixedBudgetEvaluator`.

Without a sponsor, an owner transaction is paid by the account. The fee
comes from the largest reserve that can cover the most a transaction can
cost, else from the fund UTxOs. A reserve that carries only a datum hash
is listed but never spent. Every transaction the account pays, a grant
spend included, uses `accountOnlyCoinSelector`. It spends nothing beyond
the account UTxOs the builder selected. The signing wallet, or the
collateral wallet when given, provides only the collateral. See
[reserves and fee payment](../docs/architecture.md#reserves-and-fee-payment).

## Porting

A port to another transaction builder must be able to:

- spend Plutus V3 script inputs with a redeemer, with an inline datum and
  without a datum;
- mint and burn several token names under one Plutus V3 policy with one
  redeemer;
- register a script stake credential with the Conway deposit, delegate it
  and withdraw from its reward account, each with a redeemer and the
  script attached;
- withdraw zero from the logic credential with the `Run` redeemer on
  every transaction but a plain deposit, reading the logic hash from field
  0 of the control datum, and from two credentials on an upgrade;
- write inline datums;
- add the control UTxO as a reference input on a grant spend, and the
  parked proxy and logic as reference inputs, or embed the scripts when
  the network records none;
- select collateral and its return from a wallet other than the account;
- evaluate every transaction through a provider, and set fixed execution
  budgets for a transaction built unchecked;
- apply parameters to the blueprint's stake validator and logic
  validators;
- declare required signers and gather witnesses from several wallets;
- size the control output and each new grant output to the minimum UTxO
  value;
- set a validity lower bound for a sweep of an expired grant and an upper
  bound for every grant spend;
- set an exact minimum fee, so that a reserve is recreated with the fee
  taken out;
- return change to the account address with no datum;
- spend only account UTxOs on a grant spend, at most 12 fund UTxOs, with
  the agent wallet or a collateral wallet used for collateral alone;
- read the fee of a built transaction back, to check it against the fee
  bound.

## Development

Building, linting and testing the package are covered in
[CONTRIBUTING](../CONTRIBUTING.md#build-and-test-the-off-chain-library).
