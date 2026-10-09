# Contributing

This page holds everything needed to build, test and change the
contract, its off-chain library and its documentation. What the contract
does is in [docs/overview.md](docs/overview.md) and
[docs/architecture.md](docs/architecture.md).

## Repository layout

| Path | Contents |
| --- | --- |
| `validators/` | The proxy (`account.ak`), the logic (`logic_v1.ak`), the stake script (`account_stake.ak`) and their tests |
| `lib/cardano_account_custody_contract/` | The shared Aiken modules and their tests |
| `plutus.json` | The blueprint `aiken build` writes, committed |
| `offchain/` | The TypeScript library, its tests, the flow script and the devnet harness; see [offchain/README.md](offchain/README.md) |
| `offchain/networks/` | One network file per network; see [network setup](docs/operations/network-setup.md) |
| `fixtures/upgrade-logic/` | The upgrade fixture, a separate Aiken project |
| `docs/` | The documentation, including the generated evidence documents |

## Toolchain

- [Aiken](https://aiken-lang.org) v1.1.24, with aiken-lang/stdlib v4.0.0
  and aiken-lang/fuzz v3.0.0. The validators are Plutus V3.
- Node 22 for the off-chain library.
- Docker with Compose, and curl, for the local devnet only.

## Build and test the validators

From the repository root:

```sh
aiken fmt --check
aiken check -D
aiken build
```

`aiken build` writes `plutus.json`. The blueprint is committed so that
off-chain code loads it directly. Continuous integration runs the three
commands above and fails when the built `plutus.json` differs from the
committed one.

### The compiled bytes of deployed validators do not change

Every account depends on the exact bytes of the deployed validators:

- The proxy's hash is the payment credential of every account address and
  the policy id of every account token.
- The stake script's code fixes every account's stake credential, address
  and token names.
- The applied hash of `logic_v1` is the credential every account names.

A change that alters the compiled bytes of the proxy or the stake script
is a different contract, not a new version. Its accounts have new
addresses and new tokens, and no existing account can move to it. A
change that alters the compiled bytes of `logic_v1` is a new logic
version. Only logic changes are versions. Either change alters the
blueprint, and the diff of `plutus.json` shows it. A refactor that keeps
the rules but changes the bytes is not acceptable for a deployed
validator. For the same reason
`validators/logic_v1.ak` writes out the dispatch of
`logic.validates_withdrawal` in its handler: a call in its place
compiles to different code.

The hashes of the committed blueprint:

| Validator | Hash |
| --- | --- |
| Proxy, `account` | `ed61963ac94d12c0b320be5a336c36af66bc02c380e0aa3001899253` |
| Logic, `logic_v1`, unapplied | `7cf7daa6c0a5825e23a9dadece990d5a602fa1508d01f061eacaed52` |
| Logic, `logic_v1`, applied to the proxy hash | `2cd68e398bdf9fbc8d257614b54403451ee722520ec785fe14f8df5a` |
| Stake script, `account_stake`, unapplied | `edcfa41389b7b924916ad7408cd2d0f75a7a3dae8717f9bbf1a668c6` |

A new logic version is a new validator with its own module, its own
review and its own deployment; see
[ADR 0001](docs/adr/0001-permanent-proxy-and-replaceable-logic.md) and
[upgrade](docs/guides/upgrade.md).

### Tests

- Validator tests live beside their validators in `validators/*.test.ak`.
  Module tests live in `lib/cardano_account_custody_contract/*.test.ak`.
- `validators/attacks.test.ak` holds the adversarial tests, named
  `attack_<class>_<case>`, and the budget tests, named `budget_<case>`.
- How an attack test asserts a refusal, and which tests carry a `///`
  narration, is set out in [verification](docs/verification.md#conventions).

## Build and test the off-chain library

```sh
cd offchain
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

Continuous integration runs `npm ci`, `lint`, `typecheck` and `test` on
Node 22. `npm run build` writes `offchain/dist`. Tests live in
`offchain/test` and run with Vitest.

## The flow script

`offchain/scripts/preprod-e2e.ts` runs every operation of the contract
against a live network and writes an evidence document. It is a
development tool, not part of the library. Its flows are listed in
`offchain/scripts/flow-plan.ts`: the setup plan of a network, then the
owner, stake and agent flows, the largest state, a batched agent sweep and
an upgrade to a second logic.

```sh
cd offchain
npm run e2e
npm run setup
```

`npm run e2e` runs the setup when the network needs it, then every flow.
`npm run setup` runs the setup alone; see
[network setup](docs/operations/network-setup.md#run-the-setup).

### Configuration

The script reads `.env` at the repository root. `.env.example` names the
variables: `BLOCKFROST_PREPROD_PROJECT_ID` and `FUNDING_MNEMONIC`.

- With no funding mnemonic, the first run generates one, stores it in
  `.env`, prints the funding address and exits. Fund that address from
  the preprod faucet and run again.
- The funding wallet is account 0 of the mnemonic. The script refuses to
  start while it holds less than 400 tADA.
- An account is permanent, so every run creates a new one. The owner
  wallet is the first account index from 15 upwards, in strides of ten,
  whose stake credential is not registered. The agent, the recipient and
  the rotation keys take the indexes at offsets one, two and three to
  nine from it. No run shares a key with another.
- The owner wallet holds one collateral UTxO and nothing else. The
  funding wallet sponsors the creation and the final sweep. Every other
  owner transaction is paid from the account.

### Network setup first

Before the flows, the script runs the setup of the network when
`offchain/networks/<network>.json` does not record the proxy and the
current logic. It registers the logic credential, parks the proxy and the
logic, and writes the network file; see
[network setup](docs/operations/network-setup.md). It then submits two
zero withdrawals the node must refuse: a bare one from the registered
logic credential, which takes the logic's arrival path and finds no
control output, and one from an unregistered logic credential, which the
node refuses before any script runs.

### Outcomes

Each flow has one expected outcome:

- confirmed on chain;
- refused by the builder, before anything reaches the chain;
- built unchecked, signed and submitted, and refused by the node in phase
  two with the validator's own failure;
- held in flight until the owner's revoke lands, then refused by the node
  in phase one.

The script stops when a flow ends in any other way. A refusal must also
match the message pattern the plan records for it.

### Switches

| Variable | Effect |
| --- | --- |
| `CARDANO_NETWORK` | `preprod` (default) or `devnet`. Picks the network, its endpoint, slot configuration, validity windows and polling interval, and the evidence path. |
| `PROVIDER_BASE_URL` | Overrides the endpoint of either network. |
| `WITHOUT_UPGRADE` | `1` or `true`: stops after flow 42, the final sweep under `logic_v1`. Flows 43 to 54 do not run, so no second logic is registered or parked. Registering and parking it is a permanent cost on the network for a script no account runs. |
| `SETUP_ONLY` | `1` or `true`: stops once the network file records the proxy and the current logic. `npm run setup` sets it. It writes no evidence document and leaves a network already recorded untouched. |

Both switches accept their values in any letter case and refuse any other
value. The script reads each one only when it reaches it, so a typo is
caught late. An invalid `WITHOUT_UPGRADE` is refused only when the run
reaches the upgrade, after flows 1 to 42. An invalid `SETUP_ONLY` is
refused only after the setup has run.

The devnet chain runs network magic 42 with testnet addresses. The script
gives the library preprod's magic for it. Cometa uses the magic only to
pick the testnet network id and a slot configuration, which the run
replaces with the one read from the devnet genesis.

## The local devnet

The devnet is one Cardano node in Conway at preprod's protocol version,
on a chain of its own with one second slots and blocks and 300 slot
epochs. A Blockfrost compatible API sits in front of it. The setup and
every flow, the upgrade included, run on it in minutes and cost nothing.

```sh
cd offchain
npm run devnet:start
npm run devnet:bootstrap
npm run devnet:e2e
npm run devnet:stop
```

- `devnet:start` deletes the previous chain and the devnet network file,
  brings the containers up on a fresh chain, waits until the API answers
  and copies the chain's Shelley genesis to `offchain/devnet/run`. The
  scripts read the slot configuration from it.
- `devnet:bootstrap` fills the funding wallet from the wallet the devnet
  genesis funds, when it holds less than the flow script needs, and
  confirms one plain transaction.
- `devnet:e2e` runs the setup and every flow and writes
  `docs/devnet-evidence.md`.
- `devnet:stop` stops the containers and keeps the chain.
  `devnet:reset` stops them and deletes the chain, its database and the
  network file.

The devnet keys are the same on every start, and an account is
permanent, so each run needs a fresh chain.

The configuration is committed in `offchain/devnet`:

| File | Purpose |
| --- | --- |
| `docker-compose.yml` | The devnet node and store, and the compatibility service in front of them |
| `node.properties` | The genesis parameters, written by `npm run devnet:parameters` |
| `preprod-parameters.json` | The preprod parameters that script read |
| `devnet.env` | The keys and network name of a devnet run. They are not secret. |
| `blockfrost-compat.mjs` | Corrects the answers where the devnet store differs from the hosted API |

Continuous integration does not run the devnet. It needs a multi
gigabyte container image and a container runtime.

### How the devnet differs from preprod

`npm run devnet:parameters` reads preprod's current parameters, records
them in `preprod-parameters.json` and writes `node.properties`. It needs
`BLOCKFROST_PREPROD_PROJECT_ID`. It copies the parameters listed in
`COPIED_PARAMETERS` in `offchain/scripts/devnet-parameters.ts`:
`min_fee_a`, `min_fee_b`, `max_block_size`, `max_tx_size`,
`max_block_header_size`, `key_deposit`, `pool_deposit`, `e_max`,
`n_opt`, `min_pool_cost`, `max_val_size`, `collateral_percent`,
`max_collateral_inputs`, `max_tx_ex_mem`, `max_tx_ex_steps`,
`max_block_ex_mem`, `max_block_ex_steps`, `protocol_major_ver`,
`protocol_minor_ver` and `min_fee_ref_script_cost_per_byte`. It
converts `coins_per_utxo_size`, `price_mem` and `price_step` to the cost
per word and the price fractions the genesis takes. Nothing else is
copied.

- The monetary expansion rate and the treasury growth rate equal
  preprod's 0.003 and 0.2 because they are the image's own defaults.
- The pool pledge influence is 0 against preprod's 0.3, and the minimum
  committee size 0 against 3. No transaction of the contract depends on
  either.
- The cost models are the devnet's own. Its Conway genesis carries a
  Plutus V3 model of 251 entries; preprod reports 350. Of the 251 shared
  entries, 7 differ, all CPU entries: the division coefficients of
  `divideInteger`, `modInteger`, `quotientInteger` and
  `remainderInteger` (indexes 54, 119, 135 and 146) are 549 against 960,
  and the three `equalsByteString` CPU entries (indexes 64, 65 and 66)
  are 24548, 29498 and 38 against 30623, 28755 and 75. The Plutus V1
  and V2 models are shorter than preprod's and differ in the same three
  byte string equality entries. The devnet's parameters endpoint
  reports no V2 model.
- Preprod's cost models cannot be put on the devnet chain. The image
  ships them at `/app/config/plutus-costmodels-v11.json`. Writing their
  350 entries into the cluster's Conway genesis makes cardano-node 11.0.1
  refuse to start, since it reads the Conway genesis model at 251
  entries. The image's other route submits the file as a parameter change
  governance action on the first run of a cluster, and that proposal
  never reaches the chain.

## The upgrade fixture

`fixtures/upgrade-logic` is a separate Aiken project holding `logic_v2`,
a throwaway second logic. Proving an upgrade on a chain needs a second
logic to move an account to, and the contract has one. The fixture is
the shared rules plus one visible bound: at most 8 tokens minted or
burned under the account policy per transaction.

The fixture is not part of the contract. No account runs it, it is
absent from `plutus.json`, nothing ships it and an audit excludes it.

- It compiles the contract's library through the relative symlink
  `fixtures/upgrade-logic/lib/cardano_account_custody_contract`.
- It commits its own blueprint, so a flow run needs no extra build.
- Continuous integration checks it like the main project, blueprint
  diff included.
- Its hashes: unapplied
  `03489f90cbd00ec38d8669cb582fa7014becd1122b9ba3a03c7b7dc1`, applied to
  the proxy hash `69baa8a8c877247028c56c8130449e186e3658d541536d168f92db3d`.

```sh
cd fixtures/upgrade-logic
aiken fmt --check
aiken check -D
aiken build
```

The flow script loads it through `offchain/scripts/fixture-logic.ts` and
uses it in flows 43 to 54.

## Evidence documents

`docs/preprod-evidence.md` and `docs/devnet-evidence.md` are generated by
the flow script. Do not edit them by hand. A run rewrites
`docs/<network>-evidence.md` with every transaction, refusal and the
execution units the chain charged.

| Document | Command |
| --- | --- |
| `docs/preprod-evidence.md` | `WITHOUT_UPGRADE=1 npm run e2e` |
| `docs/devnet-evidence.md` | `npm run devnet:e2e` on a fresh devnet |

A setup only run writes no evidence. What the evidence establishes is in
[verification](docs/verification.md).

## Documentation

The documentation describes the system as it is:

- Present tense. No history, no versions of the documents themselves.
- Normative statements, not narration of a run. The flow script, its
  steps, the devnet and the fixture appear only here and in
  [verification](docs/verification.md).
- Test names, test counts and measurements appear only in this page,
  `docs/verification.md` and the evidence documents. Bounds such as 8
  devices are functionality and belong in the documentation.
- Each term is defined once, in the [glossary](docs/glossary.md), and
  used consistently. One fact lives in one place; link to it.
- Design rationale goes in a decision record under `docs/adr/`.
- ASCII only. Diagrams are Mermaid flowcharts, sequence diagrams or state
  diagrams. Transaction shapes are tables.
- Every fact is checked against the code. Where a document and the code
  disagree, the code wins and the document is fixed.
