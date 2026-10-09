# 6. A custom contract rather than Bullet

- Status: Accepted
- Date: 2026-10

## Context and Problem

An account needs two kinds of key. Devices hold full authority over the
account. Agents spend under grants. Each grant is bounded per agent: a
per call cap, a cumulative cap, lovelace caps, an expiry and a recipient
list, revocable by any device at any time.

Bullet ([orbistry/bullet](https://github.com/orbistry/bullet)) is an
Aiken smart wallet with hot, cold and intention validators and a vault.
Its keys are Ed25519 keys that sign as ordinary transaction witnesses.
It is the natural starting point for an Aiken account on Cardano.

Bullet does not express per agent grants:

- It has no owner and agent distinction. Its hot keys form one set,
  counted toward `hot_quorum` by `hot_spend` and toward `wallet_quorum`
  by `wallet_spend`. No field marks a key as an agent's.
- Its intention constraints (`lib/intention_types.ak`, checked in
  `lib/constraint_utils.ak`) are equality checks on outputs, inputs,
  redeemers and mint quantities. There is no per key spending cap, no
  cumulative cap and no per key expiry. `AfterVal` and `BeforeVal` bound
  the transaction's validity interval, not a key's lifetime.
- A credential change (`change_credential_auth.cold_control`) needs a
  signature from every current cold key and from every key of the new
  hot and cold sets. Here any one device changes the devices alone.
- Its cold key, nonce, proxy and delete machinery solves problems this
  account does not have. The account's devices are a small list of keys
  with no cold tier, and the account is permanent.

## Considered Options

1. Build on Bullet: fork it and rewrite its intention validator to
   express grants.
2. Write a custom contract with the grant semantics in its own
   validators.

## Decision

Option 2.

Grants are not expressible as Bullet's intention constraints. Option 1
means rewriting the intention validator, the largest and most complex
part of Bullet, with the rest of its surface still to audit.

Option 2 gives a smaller surface, with the exact grant semantics in the
validator. Its design is set out in ADRs
[0001](0001-permanent-proxy-and-replaceable-logic.md) to
[0005](0005-scripts-parked-at-the-logic-address.md).

## Consequences

- Devices and grantees are distinct on chain. Devices are listed in the
  account state, and each grant names its grantee and its scope.
- A grant's caps, expiry and recipients are checked by the logic on every
  spend, and any device revokes a grant with one transaction.
- Under `logic_v1`, any one device acts alone. There is no quorum and no
  cold tier.
- The contract inherits no review from Bullet. It needs an independent
  audit of its own; see
  [no independent audit](../security/known-issues.md#no-independent-audit).
