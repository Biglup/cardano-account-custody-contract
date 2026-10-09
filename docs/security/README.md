# Security

These documents state what the contract guarantees, whom an account
trusts, how each class of attack is stopped and what risk remains. They
use the terms of the [glossary](../glossary.md) and the structure of the
[architecture](../architecture.md). How each claim is tested and measured
is in [Verification](../verification.md).

## The two parts under audit

The contract has a permanent part and a replaceable part. They are
audited separately because they fail differently.

The **permanent part** is the proxy and the stake script. No upgrade can
change them, and every account on every logic version depends on them.
They guarantee the naming, quantity and placement of account tokens, the
pinned control output, the single creation, the `Fund` rule, the device
rule on rewards and delegation, and that the logic named in the control
datum runs. Together with every version's leaving rule, the proxy also
guarantees that no transaction changes field 0 of a control datum unless
both the leaving logic and the arriving logic run.

The **replaceable part** is the logic. It is trusted code. Each account
names its logic by hash, and every rule beyond the permanent part is a
rule of that logic. `logic_v1` is the one version that exists. Its rules
hold only while an account names it. A later version is audited on its
own and does not reopen the permanent part.

## Scope

In scope, the three validators of [plutus.json](../../plutus.json),
compiled with Aiken v1.1.24 for Plutus V3 against aiken-lang/stdlib
v4.0.0:

| Validator | Source | Part | Blueprint hash |
| --- | --- | --- | --- |
| Proxy, `account` | [validators/account.ak](../../validators/account.ak) | Permanent | `ed61963ac94d12c0b320be5a336c36af66bc02c380e0aa3001899253` |
| Stake script, `account_stake` | [validators/account_stake.ak](../../validators/account_stake.ak) | Permanent | unapplied `edcfa41389b7b924916ad7408cd2d0f75a7a3dae8717f9bbf1a668c6` |
| Logic, `logic_v1` | [validators/logic_v1.ak](../../validators/logic_v1.ak) | Replaceable | unapplied `7cf7daa6c0a5825e23a9dadece990d5a602fa1508d01f061eacaed52`, applied to the proxy hash `2cd68e398bdf9fbc8d257614b54403451ee722520ec785fe14f8df5a` |

The stake script hash of an account is the unapplied code applied to
its `owner` and `proxy_hash`. The applied logic hash is the logic
credential every `logic_v1` account names.

In scope, the library modules the validators compile from, in
[lib/cardano_account_custody_contract](../../lib/cardano_account_custody_contract):

| Module | Part | Holds |
| --- | --- | --- |
| [types.ak](../../lib/cardano_account_custody_contract/types.ak) | Permanent | The datums and redeemers. Fields 0 to 2 of `AccountState` and of `Grant` are the stable prefix. |
| [account.ak](../../lib/cardano_account_custody_contract/account.ak) | Permanent | The helpers the proxy, the stake script and the logic share, among them the positional readers `logic_of`, `devices_of`, `generation_of`, `grant_slot_of` and `grant_generation_of`. |
| [logic.ak](../../lib/cardano_account_custody_contract/logic.ak) | Replaceable | The dispatch, `is_own_control`, the owner, agent and arrival paths, and the `publish` handler. |
| [rules.ak](../../lib/cardano_account_custody_contract/rules.ak) | Replaceable | The rules of each path: device, grant spend, sweep, issue and burn. |
| [grant.ak](../../lib/cardano_account_custody_contract/grant.ak) | Replaceable | The grant accounting and the time rules. |
| [state.ak](../../lib/cardano_account_custody_contract/state.ak) | Replaceable | The bounds and well formedness. |

`logic_v1` writes the dispatch of `logic.validates_withdrawal` out in its
own handler. The two are one piece of code under audit. The
compiled code of `logic_v1` is final, because its applied hash is the
credential its accounts name.

Out of scope:

- `fixtures/upgrade-logic`, a separate Aiken project holding a second
  logic. No account runs it, the blueprint does not carry it and nothing
  ships it.
- The evidence scripts in `offchain/scripts`.
- The off-chain library in `offchain/src`, key management, a device
  wallet's [known logic list](../glossary.md#known-logic-list), a fee
  sponsor service, and the network
  setup. Where the contract's safety depends on them, the
  [trust assumptions](trust-assumptions.md) say so.
- The Cardano ledger rules the validators rely on. The
  [trust assumptions](trust-assumptions.md#the-ledger) name each one.

A later logic version is audited on its own: its rules, its arrival
path, that it keeps the stable prefixes, and that its leaving rule
requires the arriving logic to run. See
[obligations of every logic](invariants.md#obligations-of-every-logic).

## Documents

- [Invariants](invariants.md): the numbered properties the validators
  enforce, each linked to the code that enforces it.
- [Trust assumptions](trust-assumptions.md): what each role can do, what
  it cannot, and what an account trusts it for.
- [Threat model](threat-model.md): the assets, the attackers, and each
  vulnerability class as attack and mitigation.
- [Known issues](known-issues.md): residual risks and limitations, with
  what a deployment or a device wallet should do about each.
- [Verification](../verification.md): the test suites, the tests behind
  each vulnerability class, the execution budgets, the findings and how
  each was closed, and the chain evidence.
