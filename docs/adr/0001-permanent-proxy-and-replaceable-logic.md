# 1. Permanent proxy and replaceable logic

- Status: Accepted
- Date: 2026-10

## Context and Problem

A user needs one address that never changes. Funds stay there while
devices rotate. On Cardano the payment credential of a script address is
the hash of the script. Any change to a script that holds the rules
changes its hash, and with it every address that pays to it. Moving an
account's funds to a new address means spending every UTxO and telling
every payer.

The rules themselves will change. A bound may move, a grant shape may
grow, a defect may need a fix. The account must take new rules without a
new address, and no rule change may let a party bypass what keeps funds
safe whatever the rules are.

## Considered Options

1. One validator holding every rule as the payment script of the
   address.
2. A permanent proxy as the payment script that keeps a small set of
   invariants, and a replaceable logic that the account names by hash in
   its state and that runs once per transaction through a withdrawal.

## Decision

Option 2.

Option 1 fixes the rules in the address. Every rule change would move
every account.

Under option 2 the proxy has no parameters, so its hash is the payment
credential of every account on a network and the policy of every account
token. It keeps the token naming and placement rules, the pinned control
output, the creation gate and the `Fund` rule. For everything else it
requires the transaction to withdraw from the logic credential named in
field 0 of the control datum. The ledger runs that logic once, over the
whole transaction. A device moves an account to another logic with one
transaction in which both logics run. See
[architecture](../architecture.md#division-of-work).

## Consequences

- The address, the state NFT, the reward account and the token names
  never change, through device rotation and upgrades alike.
- The logic is trusted code. The proxy admits any registered script as a
  logic, so the device wallet's list of known logic hashes is the gate
  against unknown code; see [upgrade](../guides/upgrade.md#what-a-signer-must-refuse).
- Every version must keep the stable prefix of each datum, because the
  proxy, the stake script, an arriving logic and a sweep read those
  fields by position.
- An arriving logic must kill the grants issued before it. `logic_v1`
  does so by requiring the generation to grow. Grants are issued again,
  never carried over.
- Every transaction but a plain deposit carries a logic withdrawal, so
  each logic credential must be registered once per network; see
  [network setup](../operations/network-setup.md).
- An audit of the proxy and the stake script covers every account, on
  every logic. Each logic version needs an audit of its own.
- The compiled bytes of the deployed validators never change. A change
  that alters the bytes of the proxy or the stake script is a different
  contract, with new addresses. Only a change to a logic is a new
  version.
