# Upgrade

An [upgrade](../glossary.md#upgrade) points an account at another logic.
The address, the tokens and the stake script stay. The
[architecture](../architecture.md#upgrades) explains how the two logics
share the transaction, and
[ADR 0001](../adr/0001-permanent-proxy-and-replaceable-logic.md) why the
logic is replaceable. This guide covers the steps, what dies, what
survives, and what a signer must refuse. It assumes the setup of the
[quickstart](quickstart.md); the snippets extend that script.

One logic version exists, `logic_v1`. An upgrade becomes possible when
another version is built, reviewed and deployed.

## Before the upgrade

The arriving logic must be ready on the network and known to every party
that builds or signs for the account:

1. It is reviewed on its own: its rules, its arrival branch, that it keeps
   the [stable prefix](../glossary.md#stable-prefix) of each datum, and
   that as a leaving logic it requires the arriving logic to run.
2. Its credential is registered on the network. The proxy demands a
   withdrawal from it on every later spend.
3. At least one of the two logics is parked as a reference script.
   [Reference scripts](../architecture.md#reference-scripts) explains
   why. Parking is covered in
   [network setup](../operations/network-setup.md#add-a-logic-version).
4. Every device wallet and fee sponsor that lists known logic hashes
   lists the new hash.

## Load the arriving logic

The library attaches only the logic of its blueprint and the scripts
passed as `logics`. Apply the new version to the proxy hash. Its
blueprint must carry exactly one logic validator, titled `logic_*`.

```ts
const proxyHash = accountScriptHash(accountScript());
const nextLogic = logicScript(logicValidator(loadBlueprint('/path/to/next/plutus.json')), proxyHash);
const nextHash = logicScriptHash(nextLogic);
```

## Upgrade

Read the grants before the upgrade. The list of grants to issue again is
computed from the state the account leaves.

```ts
const before = await findAccountUtxos(provider, device);
const next = { ...device, logics: [nextLogic] };
await submit(await upgradeLogic({ ...next, newLogic: nextHash }), [owner, sponsor]);
```

The transaction's shape and the builder's refusals are in
[upgradeLogic](../protocol/transactions.md#upgradelogic).

## What dies and what survives

| Dies | Survives |
| --- | --- |
| Every grant issued before the upgrade, dead by generation | The account address and the state NFT |
| The revoked list, cleared by the library | The stake credential, the reward account, its rewards and its delegation |
| The leaving logic's rules for this account | The devices |
| | Fund UTxOs and reserves |
| | The next slot and the outstanding count, as the library writes them |
| | The dead grant UTxOs and their lovelace, until swept |

No script keeps the counters. As the arriving logic, `logic_v1` checks
only that the leaving logic withdraws, that the generation grows, that
the devices are equal, that nothing is minted, and that the control
output holds only lovelace and the state NFT under a well formed state.
As the leaving logic, it checks nothing about the next slot, the
outstanding count or the revoked list. The device that signs writes
them. `upgradeLogic` keeps the two counters and clears the list. See
[counters written on arrival](../security/known-issues.md#counters-written-on-arrival).

The arriving logic sets every rule the proxy does not keep. That covers
spends, devices, grants and later upgrades.

## After the upgrade

Every later transaction for the account needs the new logic in `logics`,
for owners and agents alike. A builder refuses an account whose logic it
cannot attach.

1. Sweep the dead grants, at most eight per transaction. A sweep reads
   only the stable prefix of each grant.
2. Issue the survivors again, at most eight per transaction:

```ts
const requests = survivingGrantRequests(before.grants, before.state);
await submit(await issueGrant({ ...next, grants: requests.slice(0, 8) }), [owner, sponsor]);
```

Grants are issued again, never carried over. No grant is ever interpreted
by a logic that did not issue it. Agents need the new slots before they
can spend again.

Whether a sweep, an issuance or a spend passes is decided by the arriving
logic. The library builds them in the shape `logic_v1` accepts.
`spendWithGrant` refuses a grant whose datum does not decode as the
library's `Grant`.

## Downgrades

The mechanism accepts a move to any registered logic, an earlier version
included. The library refuses only the logic the account already runs.
The device wallet decides whether a downgrade is acceptable.

## What a signer must refuse

The proxy accepts any registered script as a logic. A device that signs an
upgrade to an unknown hash hands the account to that code for every later
spend. A device wallet therefore:

- shows the logic of every transaction that changes field 0 of a control
  datum by a known name;
- refuses a hash outside its list of known logic hashes, and protects that
  list as part of the wallet;
- refuses a downgrade to a version with a known defect;
- refuses the account's own stake script hash as a logic. That script is
  registered already and accepts any withdrawal a device signs, so an
  account naming it runs under no rules;
- refuses an upgrade whose control output changes the next slot or the
  outstanding count, or keeps slots in the revoked list. No script checks
  them; see
  [counters written on arrival](../security/known-issues.md#counters-written-on-arrival).

During an upgrade window, accounts sit on both versions. A device wallet
or fee sponsor that lists the logics it serves lists both the leaving and
the arriving hash for as long as any account runs either. Listing only
the new hash strands the accounts that have not moved. Listing only the
old one refuses the upgrade itself.

The other checks a device wallet makes are in [signers](signers.md).
