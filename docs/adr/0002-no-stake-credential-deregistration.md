# 2. No stake credential deregistration

- Status: Accepted
- Date: 2026-10

## Context and Problem

Two kinds of script stake credential carry the contract.

- An account's stake credential is the hash of its own stake script. Its
  registration is the act of creation; see
  [ADR 0004](0004-creation-gated-by-stake-registration.md). Deregistering
  it would return the registration deposit.
- A logic credential is the hash of a logic applied to the proxy hash.
  Every spend but a plain fund spend withdraws from it, and the ledger
  accepts a withdrawal only from a registered credential.

Deregistration is the one way to recover those deposits. It also undoes
what the contract relies on:

- The ledger registers a credential at most once while it is registered.
  That is what makes creation happen once and a second control UTxO
  impossible. A deregistered account credential could be registered
  again, and a new state NFT minted beside a registration.
- Every deposit at an account address is spendable only beside an account
  token of that account, and every reserve only beside its control UTxO.
  An account without its control UTxO strands every deposit sent to it.
- A deregistered logic credential stops every account that names it.

## Considered Options

1. A device may deregister the account's stake credential, closing the
   account and recovering the deposit.
2. The stake script refuses every deregistration, and so does the logic's
   `publish` handler.

## Decision

Option 2. The account stake script accepts a registration under the
creation rules and a delegation signed by a device. It refuses a
deregistration and every other certificate. The `publish` handler of
`logic_v1` accepts the registration of its credential from anyone and
refuses every other certificate.

## Consequences

- An account is never deleted. No redeemer burns the state NFT, and the
  credential stays registered for the life of the account.
- Exactly one control UTxO exists for each account from creation on.
  Every deposit that arrives after creation stays spendable through the
  normal paths. There is no window in which the account is absent.
- The registration deposit and the control UTxO's minimum lovelace stay
  locked for the life of the account. A dormant account remains. There is
  no close, no delete and no rescue path.
- An owner key creates one account, once. A client that needs another
  account uses another owner key.
- A logic credential, once registered on a network, stays registered. Its
  deposit stays locked, and the withdrawal every spend needs is always
  available.
