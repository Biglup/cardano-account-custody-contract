# 4. Creation gated by stake registration

- Status: Accepted
- Date: 2026-10

## Context and Problem

Every rule of an account hangs on its single control UTxO. A second
control UTxO for the same account would carry a second state, a second
device list and a second logic. The proxy has no parameters and keeps no
registry, so it cannot prove that no other state NFT of an account
exists.

The owner key must also authorise the creation, and must be able to use
the account it creates.

## Considered Options

1. The proxy's mint handler finds a registration of the account's
   credential in the transaction's certificate list.
2. The proxy's mint handler requires a publish redeemer for a
   certificate registering the account's credential. The stake script's
   registration arms accept the owner's signature alone.
3. As option 2, with the stake script's registration arms also
   requiring the mint of exactly one state NFT of the credential and the
   owner among the devices of the control output.

## Decision

Option 3.

The ledger registers a stake credential at most once while it is
registered, and the stake script refuses deregistration; see
[ADR 0002](0002-no-stake-credential-deregistration.md). A mint that needs
the registration therefore happens once per account.

Option 1 is unsound. A registration in the legacy certificate format
carries no witness and runs no script. A certificate in the list does not
prove the stake script approved anything. A publish redeemer exists only
when the ledger ran the stake script on the certificate.

Option 2 lets a registration happen without the mint. A builder mistake
is enough to leave the credential registered with no control UTxO. The
creation can then never run, since the ledger refuses a second
registration. It also lets a builder create the account with a device
list that leaves out the owner, under the owner's own signature.

Under option 3 the two handlers depend on each other. The stake script
refuses a registration without the mint, and the mint handler refuses a
mint without the registration.

## Consequences

- Each account has exactly one control UTxO from creation on. No key, the
  owner's included, can mint a second.
- The owner signs the creation and is among the initial devices. After
  creation it is one device among the others.
- The proxy does not read the stake script's code. An account created
  under another script's credential is that script's own account, with
  its own name and address, and touches no other.
- Until the Dijkstra era, anyone who learns an account's stake credential
  before creation can register it with the legacy certificate. Creation
  at that address is then blocked for good. The mitigation is at the key
  layer: the credential is unknown until the creation registers it. See
  [known issues](../security/known-issues.md) and
  [signers](../guides/signers.md#keys-and-networks).
- An account must be created before its address is shared or funded.
