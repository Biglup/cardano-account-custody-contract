# Known issues

The residual risks and limitations of the contract. Each entry states the
issue, its consequence, and what a deployment or a device wallet should
do about it. Terms are defined in the [glossary](../glossary.md). The numbered
properties cited are in [Invariants](invariants.md).

## No independent audit

Issue. The contract has no independent audit. How it is verified is in
[Verification](../verification.md).

Consequence. Undetected defects may exist in the deployed validators,
whose compiled code is final.

What to do. Treat the contract as unaudited and testnet only. Commission
an independent audit of the [scope](README.md#scope) before any mainnet
deployment.

## Stake credential squat

Issue. Until the Dijkstra era, a stake registration in the legacy
certificate format carries no deposit field and needs no witness. The
ledger runs no script on it, and records nothing about which form
registered a credential. Anyone who learns an account's stake credential
before the account exists can register it. References in the
cardano-ledger repository:

- No witness and no deposit field:
  `eras/conway/impl/src/Cardano/Ledger/Conway/TxCert.hs`,
  `getScriptWitnessConwayTxCert`;
  `eras/conway/impl/cddl/data/conway.cddl`, `account_registration_cert`.
- No script run: `eras/shelley/impl/src/Cardano/Ledger/Shelley/UTxO.hs`,
  `eras/conway/impl/src/Cardano/Ledger/Conway/UTxO.hs`.
- No record of the form: `eras/conway/impl/src/Cardano/Ledger/Conway/Rules/Deleg.hs`.
- The Dijkstra era removes the legacy certificates and requires the
  witness on every registration:
  `eras/dijkstra/impl/src/Cardano/Ledger/Dijkstra/TxCert.hs`,
  `DijkstraRegCert` with a mandatory deposit and the decoder refusing
  tags 0 and 1; `eras/dijkstra/impl/cddl/data/dijkstra.cddl`.

Consequence. The owner's registration then fails as already registered.
`CreateAccount` cannot run without it (INV-5). A deregistration always
needs the script witness, and the stake script refuses it (INV-16). The
address is unusable for good. This is a denial of service. Funds are at
risk only if something was deposited there before creation. The
attacker's cost is the deposit, locked with the credential. The Dijkstra
era closes the squat for new registrations. Squats placed before it
remain.

What to do. Prevent it at the key layer:

- Derive the owner's key on a path that differs per network class. By
  convention of the device wallet and the library, mainnet and testnets
  use distinct account index ranges, so a key used on a testnet never
  corresponds to a mainnet credential.
- Refuse account operations outside the device wallet's network class.
- Never use the owner's key for anything else. The stake script hash of
  an account then becomes public only in the creation that registers
  it, and a squat requires guessing the owner.
- Create the account before sharing the address.
- Never deposit to an address whose control UTxO does not exist.
- When creation fails with an already registered credential, use the
  next account index. That gives a new owner and a new address.

## Permanence

Issue. An account is never deleted. No redeemer burns the state NFT
(INV-4), and the stake script refuses the deregistration of the
credential (INV-16).

Consequence. Creation locks lovelace for the life of the account.
[Permanence](../architecture.md#permanence) names the amounts. There is
no close, no delete and no rescue path. A dormant account remains.

What to do. Tell users that creation locks these amounts for good. Keep
the control UTxO at its minimum lovelace.

## Device availability and compromise

Issue. Under `logic_v1` any one device has full authority over the
account, and only a device can spend the control UTxO (INV-20). The
contract has no recovery path that bypasses the devices.

Consequence. One compromised device can take every deposit and reserve,
point the account at any logic, and remove the other devices. Losing
every device locks the account's deposits for good. Without an available
device, nobody can revoke a grant, so each grant stays live until its
expiry.

What to do. Register more than one device, held apart. Remove a lost or
compromised device at once from another one. Issue grants with short
expiries, so that their exposure ends without a revoke.

## Unknown logic

Issue. The proxy admits any 28 byte hash whose credential withdraws as a
logic (INV-10). Nothing on chain says which hashes are versions of this
contract. An upgrade to unknown code is lasting: the proxy runs that code
on every later spend. A downgrade to an earlier version with a known
defect is allowed by the mechanism. The account's own stake script hash
is the credential a device holder would reach for first, since it needs
no deployment. It is already registered, and its withdraw handler accepts
any withdrawal a device signed (INV-15). An account whose logic field
names it transacts on a device signature and under no other rule.

Consequence. A device that signs an upgrade to an unknown hash hands the
account to that code. Naming the stake script is owner self harm with no
escalation, since a device already authorises the rewrite. Recovery is
clean: arriving at a real logic again imposes that version's arrival
rule on the state.

What to do. The device wallet shows the logic by a known name and refuses
an unknown hash in field 0 of a control output it signs. It protects the
list of known hashes it ships. It refuses a downgrade to a version with a
known defect. Each logic version is reviewed on its own before its hash
joins the list: its rules, its arrival path, and that it keeps the stable
prefixes. The library attaches only the blueprint's logic and the logics
given to it.

## Logic reward account

Issue. Every account transaction withdraws from the logic credential.
The ledger requires a withdrawal to equal the reward account's whole
balance. The contract accepts any amount (INV-10, INV-7), but the
library's builders draw zero. A third party can credit the logic's
reward account without the logic's consent: a pool registration naming
it as the reward address, whose refund and leader rewards land there; a
governance proposal naming it as the return address; or a treasury
withdrawal paying it. `logic_v1`'s refusal of delegation does not prevent
any of these.

Consequence. Once the balance is not zero, every transaction the
library builds for any account on that logic fails phase one. Nothing is
lost and no collateral is taken, but the accounts cannot transact
through the library until a transaction withdraws the whole balance. A
transaction that does is accepted on every path. Lovelace withdrawn this
way is not account funds, and the grant accounting does not count it.

What to do. Draw the balance the provider reports for the logic's reward
address, once per logic per transaction, both logics on an upgrade.
Return the withdrawn lovelace to the account address. Rebuild once if the
balance changes between build and submission. See the contract's
[issue #1](https://github.com/Biglup/cardano-account-custody-contract/issues/1).

## Logic certificates are fixed

Issue. `logic_v1` accepts the registration of its credential and refuses
every other certificate, delegations included (INV-19). Its compiled
code is final.

Consequence. If the ledger ever required a vote delegation before a
script credential could withdraw, as it does for key credentials, no
account on `logic_v1` could transact, and no on-chain change could
recover them.

What to do. Decide for each later logic version whether its `publish`
should accept a vote delegation of its own credential.

## Counters written on arrival

Issue. When an account arrives at `logic_v1` by an upgrade, `logic_v1`
checks that the new state is well formed, that the generation grows and
that the devices are unchanged (INV-43, INV-44). It does not check the
next slot, the revoked list or the outstanding count against the
account's grant UTxOs. The device that signs the upgrade writes them.
The library's `upgradeLogic` carries the next slot and the outstanding
count over and clears the revoked list. `rewriteState` naming another
logic checks none of the three.

Consequence. Only a device can trigger any of these.

- An outstanding count below the number of grant UTxOs strands lovelace.
  Each sweep lowers the count by one. A sweep that would take it below
  zero is refused (INV-24, INV-44). The grant UTxOs beyond the count
  cannot be swept under `logic_v1`, and their minimum lovelace stays
  locked. No device rewrite under `logic_v1` restores the count: a
  control output that stays under `logic_v1` moves the count only with
  the grant tokens minted and burned (INV-24), so issuance and sweeps
  move the count and the grant UTxOs together and the shortfall stays.
  Only another upgrade rewrites it: leaving `logic_v1` for a logic that
  accepts the change, then arriving again with the true count.
- An outstanding count above the number of grant UTxOs lowers the number
  of grants the account can issue for as long as it stays under
  `logic_v1`, for the same reason.
- A lowered next slot makes new grants reuse the slots of older ones. The
  older grants are dead by generation, but two grant UTxOs then carry the
  same token name.
- A revoked list naming slots not yet issued makes those grants revoked
  at issuance. A device rewrite can drop the slots (INV-24).

What to do. The device wallet that signs an upgrade checks that the next
slot and the outstanding count are carried over unchanged, and refuses
an upgrade that keeps any revoked slot, since the library clears the
revoked list. Every arriving logic should
check its counters against the state it leaves, or document what it
leaves open.

## Upgrades kill every grant

Issue. Arriving at `logic_v1` raises the generation (INV-43), which
kills every grant issued before. Grants are issued again, never carried
over.

Consequence. Agents cannot spend between the upgrade and the reissue.
Dead grant UTxOs hold their lovelace until swept.

What to do. After an upgrade, sweep the dead grants and issue the
surviving ones again before the agents need them. The library's
`survivingGrantRequests` lists the grants to reissue.

## Reference script availability

Issue. Accounts transact only while the proxy and their logic can be
attached, parked or embedded. Where the scripts are parked and when the
library embeds them is in
[Reference scripts](../architecture.md#reference-scripts).

Consequence. Embedding raises the fee. An upgrade between two logics the
size of `logic_v1` fails while neither is parked.

What to do. Anyone can park the scripts again from the blueprint. Record
the parked UTxOs in the network file.

## Logic credential registration

Issue. A withdrawal needs the logic credential registered. `logic_v1`
refuses deregistration (INV-19), so once registered on a network the
credential stays.

Consequence. Registration costs the registration deposit once per
network and per logic version, locked for good. Anyone may pay it.

What to do. Register each logic version once per network as part of its
network setup.

## One account per logic version per transaction

Issue. `logic_v1` validates exactly one control UTxO naming it (INV-18).
The proxy requires only that every name minted or burned under one
redeemer belongs to one account (INV-3). `logic_v1` validates every
grant mint on its owner path as its own account's (INV-26, INV-27), and
its agent path admits no mint under the policy (INV-30). An account
under `logic_v1` therefore cannot share a transaction with another
account's mint or burn.

Consequence. Two accounts on one version cannot share a transaction.

What to do. Operate one account per transaction. The library's builders
do.

## Funds outside the account address

Issue. Only the account's full address, with the inline script stake
part, is spendable (INV-12). A deposit to the bare script address, or to
the proxy under a key, pointer or other stake part, is unspendable on
every path.

Consequence. Such funds are lost. An output to the proxy with a pointer
stake credential is not the account address, so a grant spend counts it
as leaving. A recipient list refuses it, and under an empty list the
caps bound it like any other destination.

What to do. Only ever pay to the account's full address. Derive it from
the owner or the account record, never from the proxy hash alone.

## Deposits under a datum hash

Issue. A deposit at the account address under a datum hash is a reserve
only to whoever holds the preimage. The proxy's `Fund` rule accepts it
beside the spent control UTxO, but the ledger needs the datum in the
witness set.

Consequence. A third party's deposit under a datum hash without a known
preimage is that party's own loss. One with a known preimage is a
reserve.

What to do. Never select a UTxO that carries only a datum hash. The
library lists such UTxOs among the reserves and never spends them, so a
UTxO parked there cannot make an owner transaction unsubmittable.

## Open recipient lists and script recipients

Issue. A grant with an empty recipient list lets the grantee send up to
its caps to any address, unspendable ones included (INV-36). A recipient
that is a script address makes the funds subject to that script.

Consequence. The loss through an open grant is bounded by its caps, not
by its destinations.

What to do. List recipients whenever the destinations are known. Prefer
key addresses as recipients.

## No rolling period caps

Issue. A grant has per call caps, remaining caps and an expiry. It has
no cap per day or per epoch.

Consequence. A grantee can exhaust the remaining cap at once, in as many
transactions as the per call cap requires.

What to do. Size the remaining cap to the tolerable loss, use short
expiries, and issue a new grant rather than an oversized one.

## Fee bound

Issue. The library reduces a grant's remaining caps by the
[fee bound](../glossary.md#fee-bound), not by the fee, as
[Reserves and fee payment](../architecture.md#reserves-and-fee-payment)
describes. The contract accepts the result (INV-39).

Consequence. On every spend the caps lose the fee bound, not the fee the
transaction pays.

What to do. Size caps with that margin. Raise the bound only for spends
over many inputs.

## Fund contention and fragmentation

Issue. Every path draws from the same plain deposits. A grantee may split
the balance into many deposits at zero outflow, or run no-op spends
against its own grant UTxO.

Consequence. An owner transaction paid from a fund UTxO can lose it to a
grant spend and must be rebuilt. Fragmentation and no-op spends raise the
owner's cost of sweeping. Caps do not bound either, since nothing leaves.
Neither touches the control UTxO, so the revoke still lands.

What to do. Keep a reserve, or use a fee sponsor, for the owner's
operations, so that a revoke never depends on a fund UTxO an agent may
be spending. Revoke and sweep a grant that fragments the deposits.

## Batch limits

Issue. `logic_v1` sets no limit on the grants issued or swept in one
transaction, nor on the fund UTxOs of a grant spend. The execution
budget is the limit. The library sets limits of its own, listed in
[Bounds](../protocol/datums-and-redeemers.md#bounds).

Consequence. A builder that ignores these limits can build transactions
that exceed the execution budget and fail.

What to do. Keep issuance, sweeps and grant spends within the library's
limits. `fundBatches` splits a larger set of deposits. Evaluate every
transaction before submission.

## Key hash lengths are not checked

Issue. The validators do not check that a grantee hash or a device hash
is 28 bytes. The library does not either.

Consequence. An ill sized key makes its grant or device unusable. It
grants nothing to anyone.

What to do. Check that every grantee and device hash is 28 bytes when
issuing a grant or adding a device.

## Revoked slots can be dropped

Issue. A device rewrite may remove a slot from the revoked list (INV-24).
See [rewriteState](../protocol/transactions.md#rewritestate). A raised
generation cannot be undone.

Consequence. Dropping a revoked slot makes that grant current again
while its generation is current.

What to do. The device wallet shows any change to the revoked list
before it signs. Revoke with a generation bump when the revoke must be
final.

## Accounts under other stake scripts

Issue. The proxy does not read the stake script's code. It accepts any
script credential whose script ran on the registration (INV-5).

Consequence. An account created under another script's credential is its
creator's own account. Its NFT has its own name and its address is its
own. Placement keeps its tokens away from every other account (INV-8).
Its reward account answers to whatever that script allows, which
concerns no one else.

What to do. Nothing for other accounts. Derive an account only from the
blueprint's stake script.

## Accepted behaviours

These are accepted and harmless.

- An inverted validity range, with a lower bound above a finite upper
  bound no later than the expiry, passes `logic_v1` but never applies on
  the ledger, since no slot lies within it.
- A non-zero withdrawal from the logic credential runs the logic like a
  zero one.
