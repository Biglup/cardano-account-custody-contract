# 5. Scripts parked at the logic address

- Status: Accepted
- Date: 2026-10

## Context and Problem

Every transaction but a plain deposit runs the proxy and at least one
logic. Each script is embedded in the transaction or referenced from a
UTxO that carries it. Embedding raises the fee, and an upgrade between
two large logics does not fit in one transaction when it embeds both.
[Reference scripts](../architecture.md#reference-scripts) sets out the
limits.

A UTxO that carries a reference script must stay unspent for as long as
accounts reference it. If anyone could spend it, every account would fall
back to embedding, and upgrades would stop.

## Considered Options

1. Embed every script in every transaction.
2. Park the proxy and each logic version once per network, each in its
   own UTxO at the script address of `logic_v1` with no stake part.
   `logic_v1` has no spend handler, so no transaction can spend from that
   address.

## Decision

Option 2, with option 1 as the library's fallback. The library reads the
parked UTxOs from the network file and references them. It embeds a
script when the network records none.

## Consequences

- Transactions carry less and pay a lower fee, and an upgrade between
  large logics can be built.
- Nobody can spend a parked UTxO, the party that parked it included. Its
  lovelace stays locked for good.
- Anyone can park the scripts again from the blueprint. A network file
  can name any UTxO that carries the right script.
- Each new logic version is parked at the same address, beside the
  others.
- A builder given a provider checks that each recorded UTxO is unspent and
  carries the recorded script before it builds.
- The parking is part of the [network setup](../operations/network-setup.md),
  done once per network and outside the library.
