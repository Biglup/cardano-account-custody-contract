# 3. One UTxO per grant

- Status: Accepted
- Date: 2026-10

## Context and Problem

An agent spends under its grant without the owner. The owner must be able
to revoke any grant at any time, in one transaction, whatever the agents
do.

A grant's remaining caps change on every spend, so a spend must rewrite
the place the grant lives. Whatever UTxO holds the grant is spent by
every agent transaction under it. On Cardano a UTxO is spent once: two
transactions that spend the same UTxO race, and only one confirms.

## Considered Options

1. Every grant lives in the control UTxO's datum. Every agent spend
   recreates the control UTxO with the grant's caps reduced.
2. Every grant lives in its own grant UTxO, marked by a grant token.
   An agent spend recreates its grant UTxO and references the control
   UTxO without spending it.

## Decision

Option 2.

Under option 1 the control UTxO moves on every agent spend. A revoke
spends the same UTxO. A grantee that resubmits a spend of zero outflow on
every block keeps the control UTxO moving, and the owner's revoke loses
the race for as long as the grant lives. The result is a loss of
availability of the whole balance, not bounded by any cap.

Under option 2 an agent transaction never spends anything a revoke
spends. The grant token, named after the account and the slot, marks the
grant UTxO, and the proxy pins it to its account's address.

## Consequences

- A revoke is one owner transaction on the control UTxO, whatever the
  number of grants outstanding. Paid by a reserve or a fee sponsor, it
  shares no UTxO with any agent transaction.
- Once a revoke confirms, a spend built against the old control UTxO
  fails for its spent reference input, and a spend built against the new
  one finds the grant dead.
- Agents of one account contend only on fund UTxOs, never on the control
  UTxO or on each other's grants. A grant spend spends exactly one
  account token, its own grant UTxO.
- Grant tokens are minted at issuance and burned at the sweep of a dead
  grant. The account state counts them as outstanding, bounded at 16.
- Each grant UTxO holds its minimum lovelace, paid by the account at
  issuance and returned at the sweep.
- A dead grant UTxO stays at the address until a device sweeps it.
- An issuance and a sweep cannot share a transaction: the mint handler
  runs once per policy with one redeemer.
