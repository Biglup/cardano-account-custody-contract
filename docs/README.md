# Documentation

Every document of the Cardano account custody contract, grouped by
reader, with its purpose. Terms are defined in the
[glossary](glossary.md).

## Newcomer

| Document | Purpose |
| --- | --- |
| [Overview](overview.md) | The problem the contract solves, who may do what, the trust model and the guarantees. |
| [Glossary](glossary.md) | Every term the documentation uses, defined once. |
| [Architecture](architecture.md) | The three validators, how they divide the work, upgrades, permanence, fee payment and reference scripts. |

## Integrator

For wallets, agents, agent key signers and fee sponsors that build or
sign account transactions.

| Document | Purpose |
| --- | --- |
| [Quickstart](guides/quickstart.md) | The whole life of a grant on preprod, as one TypeScript script. |
| [Devices](guides/devices.md) | Adding and removing devices, the account record, and losing every device. |
| [Grants](guides/grants.md) | Scopes, issuance, grant spends, the fee bound, revokes, sweeps and reissuance. |
| [Upgrade](guides/upgrade.md) | Moving an account to another logic, and what a signer must refuse. |
| [Signers](guides/signers.md) | What a device wallet, an agent key signer and a fee sponsor check before they sign. |
| [Off-chain library](../offchain/README.md) | How to use the TypeScript library from a checkout, its modules, builders and options, and what a port needs. |
| [Transactions](protocol/transactions.md) | The shape of every transaction the library builds. |
| [Lifecycle](protocol/lifecycle.md) | The states of an account, a device and a grant, and the transactions between them. |

## Operator

| Document | Purpose |
| --- | --- |
| [Network setup](operations/network-setup.md) | Registering a logic credential, parking the scripts and recording the network file, with preprod's record. |
| [Known issues](security/known-issues.md) | The residual risks and what a deployment should do about each. |

## Auditor

| Document | Purpose |
| --- | --- |
| [Security](security/README.md) | The audit scope and the permanent and replaceable parts. |
| [Invariants](security/invariants.md) | The numbered properties the validators enforce, each linked to its code. |
| [Trust assumptions](security/trust-assumptions.md) | What each role can and cannot do, and the ledger rules the validators rely on. |
| [Threat model](security/threat-model.md) | The assets, the attackers, and each vulnerability class as attack and mitigation. |
| [Known issues](security/known-issues.md) | The residual risks and limitations. |
| [Validators](protocol/validators.md) | Every handler and every check, linked to the source line. |
| [Datums and redeemers](protocol/datums-and-redeemers.md) | Field indexes, the stable prefix, token names, redeemer indexes and bounds. |
| [Verification](verification.md) | The test suites, the tests behind each vulnerability class, the execution budgets, the findings and the chain evidence. |
| [Preprod evidence](preprod-evidence.md) | A generated record of the flows run against preprod, up to the upgrade. |
| [Devnet evidence](devnet-evidence.md) | A generated record of every flow, the upgrade included, run on a local devnet. |
| [Security review](security-review.md) | A map from each section of the security review to its location. |

## Decision records

| Record | Decision |
| --- | --- |
| [ADR 0001](adr/0001-permanent-proxy-and-replaceable-logic.md) | A permanent proxy and a replaceable logic. |
| [ADR 0002](adr/0002-no-stake-credential-deregistration.md) | No stake credential is ever deregistered. |
| [ADR 0003](adr/0003-one-utxo-per-grant.md) | Each grant lives in its own UTxO. |
| [ADR 0004](adr/0004-creation-gated-by-stake-registration.md) | Creation is gated by the registration of the stake credential. |
| [ADR 0005](adr/0005-scripts-parked-at-the-logic-address.md) | Reference scripts are parked at the logic's script address. |
| [ADR 0006](adr/0006-a-custom-contract-rather-than-bullet.md) | A custom contract rather than Bullet. |

## Contributor

| Document | Purpose |
| --- | --- |
| [CONTRIBUTING](../CONTRIBUTING.md) | The repository layout, the toolchain, building and testing, the flow script, the devnet, the upgrade fixture, the evidence documents and the documentation rules. |
| [Logic v2 design notes](logic-v2-design-notes.md) | The changes planned for a later logic version, each with what changes, why, and what it saves or fixes. |
