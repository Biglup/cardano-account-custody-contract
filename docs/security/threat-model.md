# Threat model

The assets an account holds, the attackers it faces, and each class of
vulnerability as attack and mitigation. The classes follow the smart
contract security curriculum of the Cardano developer portal, with one
class added for the split between the proxy and the logic. Terms are
defined in the [glossary](../glossary.md). Mitigations cite the numbered
properties in [Invariants](invariants.md). The roles are described in
[Trust assumptions](trust-assumptions.md).

Mitigations that cite INV-1 to INV-17 hold whatever logic the account
names. Those that cite INV-18 onwards are rules of `logic_v1`.

## Assets

- **Deposits.** The fund UTxOs and reserves at the account address.
- **Grant lovelace.** The minimum lovelace each grant UTxO holds.
- **Authority.** The control UTxO: the device list, the grant
  bookkeeping and the logic the account names.
- **Staking.** The reward account and the delegation of the account's
  stake credential.
- **Locked deposits.** The registration deposit of the account's stake
  credential and the control UTxO's minimum lovelace.
- **Availability.** The owner's ability to revoke and to transact, and
  each agent's ability to spend within its grant.
- **The logic credential.** The registered credential every transaction
  of a logic's accounts withdraws from.

## Attackers

- **A grantee**, or an agent key signer holding its key, trying to move
  more than its grant allows, to keep the owner from revoking, or to lock
  the account's funds.
- **An outsider** with no key: a dApp, a transaction builder, a party
  dusting the account, or one who registers a credential first.
- **The owner of another account**, possibly under a logic of their own
  that approves anything, trying to reach this account through the
  shared proxy.
- **A fee sponsor or a provider** acting in bad faith.

A device is trusted with the whole account under `logic_v1`, and the
logic the account names is trusted code. Neither is an attacker in this
model. The risks they carry are in [known issues](known-issues.md).

## Double satisfaction

Attack. Two accounts grant the same agent under open recipient lists. The
agent spends through both at once and returns each deposit 2 ADA short.
One 2 ADA output to the recipient is offered as the payout of both spends
and recorded against the first account's grant only. The other 2 ADA
rides out to the attacker. A second variant takes 2 ADA out of the first
account and puts 2 ADA of the agent's own into the second, so that across
the two accounts, which share the payment script, nothing leaves, and
hands both grants back unchanged. A third spends a deposit of account B
with `Fund` while only account A's control UTxO or grant UTxO is in the
transaction.

Mitigation. The grant accounting never matches outputs against a claim.
It sums every input at the account's full address, stake part included,
and subtracts every output paid back to it (INV-35). Each account's logic
sees its own net outflow whatever the other outputs are. The grant output
must record that outflow: its remaining caps sit between zero and the
spent caps less the positive part of each asset's net outflow (INV-39).
A net deposit leaves a cap unchanged. A grant handed back unchanged
beside a positive outflow fails that rule alone. Any
surplus appears in an output, which a recipient list refuses when the
output pays no listed recipient (INV-36), or in the fee, which counts as
leaving. Two accounts under one logic cannot share a transaction
(INV-18), so two accounts in one transaction run under different logics,
and each logic finds its own control UTxO and nets its own address.
`Fund` looks for an account token of the deposit's own stake credential,
so another account's control UTxO or grant UTxO never authorises it
(INV-11).

## Missing UTxO authentication

Attack. A deposit at the account address carries an inline state naming
the attacker as the only device and is spent on the owner path. A deposit
carries a grant datum with a huge cap, without the grant token or beside
the real grant UTxO, and is spent on the agent path. Other variants: the
control UTxO is only a reference input of a fund spend; a token of
another policy named after the stake credential poses as the state NFT,
or one named like a grant token poses as a grant token; the mint handler
is asked to burn a state NFT or a grant token whose input sits at a key
address; a deposit or a grant UTxO poses as the control UTxO to the
stake script.

Mitigation. The control UTxO and grant UTxOs are identified by their
tokens, not by their datums. The proxy finds the control UTxO by the
state NFT at the account address under an inline datum, and refuses
before any logic runs when none is present (INV-10). `logic_v1` finds its
control UTxOs the same way. The owner path requires the state NFT on the
spent control UTxO (INV-20). A grant spend and a sweep require the grant
UTxO to hold only lovelace and the grant token of its datum's slot, under
the proxy's own policy id (INV-28, INV-31). `Fund` requires an account
token among the inputs, never the reference inputs (INV-11). The mint
handler refuses every burn but a `BurnGrants` of grant names with that
account's control UTxO present (INV-3, INV-10). Placement refuses a token
of the account at a key address among the inputs of an owner transaction
(INV-23). The stake script accepts the control UTxO from the inputs or
the reference inputs, since it reads only the device list. It recognises
the control UTxO by the state NFT of its own account at its own address,
so a grant UTxO or a deposit does not pass for it (INV-15). The tokens
cannot be forged (see [token forgery](#token-forgery-and-other-token-names)),
and by placement they never sit at a key address (INV-8).

## Datum hijacking

Attack. A grant spend recreates its grant UTxO with a raised cap, a later
generation or another grantee, or at another account's address, or gives
the grant by hash. A device rewrite stores a state padded with an extra
constructor field. An issuance writes a padded grant datum. A grant spend
offers a padded redeemer. A grant spend pays the account's balance back
to its address under a datum hash.

Mitigation. On the agent path the grant output's inline datum must equal
the spent grant in every field but its remaining caps: slot, grantee,
generation, asset, per call caps, expiry and recipients. Each remaining
cap sits between zero and the spent cap less the positive part of the net
outflow of its asset (INV-39). Exactly one
output holds the grant token, at the spent grant UTxO's address, with the
same value (INV-38). A datum given by hash never passes. `logic_v1`
decodes the state and every grant it spends or issues strictly, so a
datum with trailing fields is refused on the owner path, the agent path
and at issuance (INV-46). The sweep is the one rule that reads a grant by
its stable prefix, so that a grant of another shape is swept once dead. A
padded grant datum therefore dies and is swept like any other, and is
never spent. The proxy reads only field 0 of a control datum, and the
stake script only field 1. The shape after the stable prefix is each
logic's own, and a control output naming another logic is that logic's
to decode (see [logic substitution](#logic-substitution-and-the-upgrade-path)).

`logic_v1` reads the proxy's redeemers back from the transaction through
a soft cast that skips a value it cannot read. A padded redeemer the
proxy accepted would therefore carry a spend past the grant rule. The
proxy's redeemer is a typed parameter, and its compiled handler refuses a
constructor with an extra field before the handler body runs. The proxy's
cast is no laxer than the logic's.

The account's own deposits are covered too: on the agent path every
output at the account address without an account token carries no datum
(INV-37). See [locked value](#locked-value).

## Token forgery and other token names

Attack. Create an account at the victim's address, under the attacker's
device, with only the attacker's signature. Sign the creation as the
owner but leave the owner out of the device list. Mint an NFT named after
the attacker's credential into the victim's address. Mint a second state
NFT, or a grant token, during a grant spend. Issue grants over a
referenced control UTxO, with the grantee's signature, named after
another account, reusing an issued slot, or without moving the counters.
Create the control output at an address whose stake part is a key
credential with the stake credential's bytes. Park a token of another
policy named after the stake credential on the control output. Mint a
parallel control UTxO for an existing account with a device signature but
no registration, or with a registration in the legacy certificate format,
which runs no script. Mint a state NFT name under `IssueGrants`.

An attacker who owns an account under a logic that approves anything
tries more. Mint a grant token of the victim's account beside their own,
into a forged grant UTxO at the victim's address naming the attacker as
grantee under the victim's generation. Mint the victim's state NFT name
beside the attacker's grant token, into a second control UTxO of the
victim under the attacker's devices and logic. Burn the attacker's own
state NFT under `BurnGrants`, to recreate the account later under new
terms. Mint a grant token under `BurnGrants` into an output at the
victim's address, and burn one under `IssueGrants`. Mint two tokens under
one grant name. Issue the attacker's own grant token into an output at
the victim's address. Spend the attacker's control UTxO and send the
state NFT to the victim's address, to a key address, into an output
carrying a reference script, or beside another token. Spend the
attacker's control UTxO and grant UTxO, burn nothing, and send the grant
token into an output at the victim's address, on the owner path or on the
agent path.

Mitigation. Under `CreateAccount` the proxy accepts one 28 byte name in
quantity one (INV-2). It requires a publish redeemer for a certificate
registering that stake credential, which exists only when the stake
script ran on it (INV-5). It requires exactly one control output at the
account address, whose stake part is an inline script credential,
holding only lovelace and the NFT with no reference script, and a
withdrawal from the logic that output names (INV-6, INV-7). The owner is
checked at the registration: the stake script needs the owner's
signature, the mint of exactly one state NFT of its own credential, and
the owner in the device list of the control output (INV-14). The proxy
looks for the stake script's redeemer, not for the certificate, so a
legacy registration that runs no script does not count. A second
creation of an existing account fails, because the ledger refuses to
register a registered credential (INV-17).

Under `IssueGrants` and `BurnGrants` every name is a 32 byte grant name of
the account the first name denotes, in quantity one or minus one
(INV-3). That account's control UTxO must be present and its logic must
withdraw (INV-10). Under `IssueGrants` every account token among the
outputs sits at its own account address (INV-8). A 28 byte name is never
a grant name. No logic can therefore have a state NFT minted or burned
through the grant redeemers (INV-4), and no mint touches another
account's tokens, whatever the logic approves. On every spend of a UTxO
holding a token of the policy, every account token among the outputs
sits at its own account address (INV-8). When the state NFT is spent, the
control output is pinned (INV-9).

Under `logic_v1` the owner path also requires each minted name to be the
grant token of the next slot in order, in one output at the account
address holding only that token, with a grant of that slot and the
recreated generation (INV-26). The counters move by the mint (INV-24).
The agent path admits no mint (INV-30).

## Logic substitution and the upgrade path

Attack. A grantee attaches a withdrawal from a logic of its own instead
of the logic the control UTxO names, on the agent path, and, signing as
the attacker, on the owner path. An account is created under the
attacker's logic with a withdrawal from the logic the owner expects, or
the other way round. A grantee rewrites the logic field, on the owner
path without a device signature, and on the agent path with the control
UTxO referenced and a control output naming the new logic beside its
spend. A stranger offers the upgrade with both logics running and no
device signature. The owner moves the account without the old logic
running, to a logic whose withdrawal is absent, keeping the generation so
that old grants stay current under rules that never issued them, or
swapping the devices on the way. The owner moves the account with the
devices swapped, the generation kept and the counters past their bound,
while referencing another account's control UTxO under the new logic, or
spending and recreating a second account already under the new logic, so
that the new logic runs its agent or owner path over the other account
instead of validating the arrival. Two accounts under one logic are
operated, leave it or arrive at it in one transaction. The logic
credential is deregistered. A grantee spends a grant issued before an
upgrade.

Mitigation. The proxy reads the logic from the control datum of the
account being spent and requires a withdrawal from that hash (INV-10). A
withdrawal from any other script is never asked anything. At creation the
proxy requires the withdrawal from the hash the control output names
(INV-7).

The logic field changes only on a `Device` spend of the control UTxO,
which needs a device signature (INV-20). The agent path never spends the
control UTxO and refuses any control output naming the logic, so a
grantee cannot offer an arrival beside its spend (INV-30). As the leaving
logic, `logic_v1` requires a withdrawal from the arriving logic and
nothing minted, and reads nothing else of the arriving state (INV-25). As
the arriving logic, `logic_v1` runs its arrival path when no control UTxO
names it. It requires exactly one control output naming it, holding only
lovelace and the NFT, with a well formed state (INV-41). With a control
input of that account, it requires a withdrawal from the logic the spent
datum names, a strictly greater generation, the same devices and nothing
minted (INV-43). Without one, it requires the state NFT as the only mint
and zero counters (INV-42).

An arrival cannot hide behind another account. On the owner path every
control output naming the logic sits at the spent account's address
(INV-22). On the agent path no control output names the logic at all
(INV-30). Two control UTxOs naming one logic, spent, referenced or one of
each, are refused (INV-18). Two accounts arriving at one logic fail on
the single output rule (INV-41). After an upgrade, every spend routes to
the new logic, and the generation bump kills every grant issued before
under either logic (INV-32, INV-43). `logic_v1` refuses the
deregistration of its credential (INV-19).

## Other redeemer

Attack. Withdraw the account's rewards with a grantee signature over a
referenced control UTxO, or over a grant UTxO. Spend the control UTxO or
a grant UTxO with `Fund`, the redeemer that carries no authorisation.
Spend a plain deposit with `Device`. Spend the control UTxO with
`SpendWithGrant`. Sweep a grant with the grantee's signature. Spend a
grant with its token burned. Burn grant tokens over a referenced control
UTxO. Use `CreateAccount` on a burn with everything a creation needs
beside it. Run a validator under a purpose it has no handler for.

Mitigation. The stake script's `withdraw` applies the device rule, which
reads the devices from the control UTxO, ignores grantees, and fails over
a grant UTxO (INV-15). `Fund` requires that the spent UTxO holds no token
of the policy (INV-11). Under `logic_v1` each redeemer is tied to one
kind of UTxO. `Device` needs the state NFT on the spent UTxO (INV-20).
`SpendWithGrant` and `SweepGrant` need only lovelace and the grant token
of the datum's slot, which the sweep reads from the datum's first field
(INV-28, INV-31). The owner path requires `Device` on the control UTxO
and admits no `SpendWithGrant` (INV-21). The agent path admits only
`SpendWithGrant` and `Fund` (INV-30). A sweep needs a device signature
read from the spent control UTxO (INV-28). `BurnGrants` needs the control
UTxO spent, since the agent path admits no mint, and a device signature
(INV-27). The proxy matches the mint redeemer against the minted
quantities: one name in quantity one for `CreateAccount`, every name in
quantity one for `IssueGrants` and minus one for `BurnGrants` (INV-2,
INV-3). The agent path also needs a single output holding the grant
token, which a burn makes impossible (INV-38). All three validators fail
in their `else` handler (INV-13, INV-16; `logic_v1`'s `else` in
[validators/logic_v1.ak](../../validators/logic_v1.ak)).

## Missed input validation

Attack. The grantee pays exactly the per call cap and lets the account
pay the fee. It drains lovelace from the grant UTxO on top of the cap. It
uses a grant scoped to one asset name to move a sibling asset name under
the same policy. It spends a token grant's whole remaining lovelace cap
in one transaction above its lovelace per call cap. It pays part of a
spend within the per call cap to the bare script address to dodge the
recipient list. An issuance writes grants with a negative cap, no
expiry, a lovelace cap on a lovelace scope, or 9 recipients. A device
rewrite moves the counters without a mint, or lowers the generation.

Mitigation. The outflow is a net sum over the full account address, so
the fee and the grant UTxO's own lovelace count as leaving, and the per
call cap refuses both the fee and the grant drain (INV-35). The grant
output's value is pinned to the spent value as well (INV-38). For a token
scope, lovelace is bounded by both lovelace caps. The scoped asset is
compared as a full asset class, policy id and asset name, and any other
class with a positive outflow is refused (INV-35). The bare script address
differs from the account address, so an output there counts as leaving
and must pay a listed recipient (INV-36). Every grant is checked at
issuance (INV-45), and every state written on the owner path and at
arrival (INV-44). The counters follow the mint and the generation never
falls below its predecessor (INV-24).

## Time handling

Attack. A grant spend with no upper bound. A lower bound past the expiry
and no upper bound. An exclusive upper bound one past the expiry, which
covers the same instants as an inclusive bound at the expiry. A
degenerate range whose upper bound is negative infinity. A sweep of a
live grant with a lower bound at, not past, its expiry.

Mitigation. A grant spend needs a finite upper bound no later than the
expiry, regardless of inclusiveness (INV-34). An exclusive bound at the
expiry plus one is therefore refused although it is equivalent. This is
the conservative reading. The lower bound is not consulted on a spend: it
cannot extend the range past the upper bound, and the ledger refuses any
transaction whose range does not contain the current slot. On a sweep,
expiry counts only with a finite lower bound strictly past the expiry
(INV-29). A grant that is neither revoked nor of an older generation is
swept only once it has expired. Expiry counts only when the datum
decodes as a full grant, so a grant of another shape never dies by time.
Both bounds are compared in POSIX milliseconds, the unit of `expires_at`.

## Unbounded datum, inputs and value

Attack. A device rewrite or a creation stores a seventeenth outstanding
grant, 9 devices, 33 revoked slots, or outstanding grants at creation.
An issuance writes 9 recipients. A bundle of tokens under many policies
is parked on the control output at creation or on a grant output at
issuance. Many deposits are spent at once without an account token.

Mitigation. `logic_v1` bounds the state to 8 devices, 16 outstanding
grants and 32 revoked slots on every write, arrival included (INV-44,
INV-42). A grant lists at most 8 recipients at issuance (INV-45), and its
scope cannot grow afterwards (INV-39). The proxy keeps every token but
the state NFT off the control output on every path (INV-6, INV-9).
`logic_v1` keeps every token but the grant token off a grant output
(INV-26, INV-38). Deposits are not bounded in number, but each needs an
account token of its account in the same transaction (INV-11), and each
pays for its own proxy execution.

## UTxO contention

Attack. A grantee spends the control UTxO in its grant spend, or spends
and references it, or spends a second grant UTxO beside its own, to put
the owner's revoke in a race with its transactions. A grantee submits a
spend against the control state as it was before a revoke, a generation
bump or an upgrade.

Mitigation. With the control UTxO spent, `logic_v1` is on its owner path,
which admits no `SpendWithGrant` and needs a device signature (INV-20,
INV-21). With it spent and referenced, the proxy finds two and refuses
(INV-10), and so does `logic_v1` (INV-18). A second grant UTxO is refused
(INV-31). An agent transaction therefore never spends the control UTxO or
another grant UTxO. A reserve needs the control UTxO spent (INV-11), so
an agent transaction never spends one either.

Two agents of one account, or an agent and the owner, contend only when
they pick the same plain deposit. The ledger refuses the double spend and
the loser rebuilds. The owner avoids even that by paying from a reserve
or through a fee sponsor. A revoke is one `Device` spend of the control
UTxO, whatever is outstanding. Once it lands every grant spend sees it. A
spend referencing the old control UTxO fails, as that input no longer
exists. A spend referencing the new one fails the currency check
(INV-32). An upgrade lands the same way. A sweep is judged against the
state the spent control UTxO held, so a revoke and the sweep of the grant
it kills are two transactions. `IssueGrants` and `BurnGrants` cannot share
a transaction, since the mint handler runs once per policy with one
redeemer. An owner at the outstanding bound who raises the generation
sweeps the dead grants before reissuing the survivors. None of this
delays the revoke itself.

A grantee may still split the plain deposits at zero outflow, or run
no-op spends against its own grant UTxO. Neither touches the control
UTxO. See [fund contention](known-issues.md#fund-contention-and-fragmentation).

## Locked value

Attack. A grant spend pays the whole balance back to the account address
under a datum hash, or under an inline datum. A grant spend sends the
balance to the bare script address. A grant spend strands its grant token
on a plain deposit. A device rewrite removes every device. An account is
created without devices. A registration is published without the state
NFT mint, which would leave a credential registered with no account to
create. A sweep burns a grant token without lowering the outstanding
count, which would wedge the account at the bound. An account is pointed
at a logic that never runs.

Mitigation. On the agent path every output at the account address that
holds no account token carries no datum and no reference script
(INV-37). A script output under a datum hash is spendable only by whoever
supplies the preimage, and none of it counts as leaving. Without the rule
a grantee with any cap could put the whole balance beyond reach. An
inline datum is refused by the same rule: a deposit with a datum is a
reserve, which only the owner can spend. The owner path is exempt: a
device has full authority and may tag deposits with a datum to make
reserves. The bare script address is not the account address, so
sending the balance there counts as leaving and the per call cap refuses
it (INV-35). A recipient list refuses the destination as well (INV-36).
Through an open grant the loss stays bounded by the caps. A grant token
on a plain deposit fails the single grant output rule (INV-38). Every
written state lists at least one device (INV-44). Both registration arms
require the state NFT mint (INV-14). The outstanding count follows the
burns (INV-24). A control output naming a logic whose withdrawal is
absent is refused by the leaving logic (INV-25), and the proxy requires
that withdrawal on every later spend (INV-10). No account can end up
under a logic that cannot run. A logic that is registered but defective
is the device wallet's concern; see [unknown logic](known-issues.md#unknown-logic).

Permanence is the structural mitigation for the rest of this class.
Every plain deposit needs an account token in the same transaction, and
every reserve the control UTxO (INV-11). The control UTxO always exists:
it is created with the account, every spend recreates it (INV-9), no
redeemer burns the NFT (INV-4), and the stake script refuses the
deregistration a second creation would need (INV-16). A deposit that
arrives at any time after creation is spendable through the normal
paths, with no window in which the account is absent. A dead grant UTxO
is swept by a device, which burns its token and frees its lovelace
(INV-28). The logic credential cannot be deregistered (INV-19), so the
withdrawal every spend needs stays available. What remains locked or
unspendable is in [known issues](known-issues.md).

## Staking and certificates

Attack. Withdraw the account's rewards with a grantee signature, with the
owner's signature alone and no control UTxO, with no device signature,
over another account's control UTxO, over a deposit or a grant UTxO
posing as the control UTxO, or over a control UTxO without the NFT or
without an inline state. Delegate under the same variants. Register the
credential without the owner, with a device signature over the control
UTxO instead of the owner's, without the mint, minting two state NFTs or
another account's, with the owner outside the device list, without a
control output, with the control output at another account, without an
inline state, under a datum hash, or carrying a grant. Deregister the
credential with a device over the control UTxO, without a device, or with
the owner alone. Register a DRep under the credential. Run the stake
script under a purpose other than withdraw and publish.

Mitigation. The account's stake credential is the hash of its own stake
script. The ledger runs that script on every withdrawal from the reward
account and on every certificate naming the credential, and on nothing
else. The exception is the legacy stake registration certificate, which
needs no witness and runs no script. See
[stake credential squat](known-issues.md#stake-credential-squat). A
withdrawal and a delegation apply the device rule: a control
UTxO of the account among the inputs or reference inputs, found by its
state NFT at its own address, with one of the devices in field 1 of its
inline datum among the required signers (INV-15). The rule fails when no
such control UTxO is present, and reads nothing of the state after the
devices, so it holds under every logic. A withdrawal of zero runs the
same rule. A registration, alone or with a delegation, needs the owner's
signature, exactly one token of the credential minted under the proxy,
and the owner in the device list of the single control output holding
it, read from field 1 of its inline datum (INV-14). The logic the control
output names checks the whole state in the same transaction. No control
UTxO exists before creation, so the registration reads nothing else.

The stake script does not compare the certificate's credential with its
own hash. The ledger makes that redundant by running a credential's
script only on certificates naming that credential. A key credential
falls through to refusal. A deregistration and every other certificate
kind, DRep and pool certificates included, are refused, and the `else`
handler fails (INV-16). A delegation covers pool, vote and combined
delegations alike, so a vote delegation needs a device like any other.

A withdrawal from an unrelated reward account added to an agent
transaction only adds value. That value must balance into the outputs or
the fee, both of which the grant accounting covers (INV-35), and an
Ed25519 grantee signs the whole body anyway. The logic's withdrawal and
the account's reward withdrawal are two entries of one map keyed by
credential, and never collide.

## Evaluation order

Attack. A check is skipped, or one validator accepts what another must
refuse, and the transaction passes because of the order the scripts run
in.

Mitigation. Most checks of every handler are conjunctions, or `when`
arms preceded by `expect` bindings. A conjunction stops at the first
false check and an `expect` aborts, so no later check rescues an earlier
failure. Some checks are disjunctions, among them the proxy's spend
arm, `grant.is_dead`, `grant.deposits_are_plain`, the output rule of
`logic.validates_owner_transaction`, and parts of
`logic.validates_spends`, `grant.pays_only_recipients` and
`grant.stays_within_scope`. A
disjunction only chooses between alternatives that each satisfy the
rule, so no path skips a check. The ledger accepts a transaction only
when every script passes, so the order in which they run does not
matter. The validators depend on one another as follows:

- The proxy's `Fund` arm and its other spend arms rely on the logic for
  every rule of authorisation and accounting. A spend the proxy accepts
  on its own is refused by the logic.
- `logic_v1` relies on the proxy for `Fund`, for the naming and quantity
  of the mint, and for placement under a foreign logic. A reserve relies
  on `Fund` demanding the spent control UTxO under a datum.
- The proxy relies on the stake script for the owner's signature and the
  device list at creation. The stake script relies on the logic for the
  full state of the single control output.
- The sweep rule relies on the owner path's control output rule for the
  outstanding count.
- The leaving logic relies on the arriving logic for the arriving state,
  and the arriving logic on the leaving one for the device signature.

## Signature replay

Attack. An Ed25519 key granted by one account signs a spend from another
account's grant UTxO under the same slot number. A witness is reused for
a later state of the same grant UTxO, or on another network.

Mitigation. A grantee authorises a spend by signing the transaction
itself as a required signer (INV-33). The ledger binds every witness to
the hash of the transaction body, which includes the inputs spent. A
witness therefore authorises exactly one transaction. It cannot be reused
for a later state of the same grant UTxO, nor on another network, where
no input of the transaction exists. The grant is read from the grant UTxO
spent and checked against the control UTxO of that same account
(INV-32). The same key granted by two accounts spends under each
account's own scope and nothing else. No signature travels in a
redeemer, so the validators have no message of their own to replay.

## Dust attacks

Attack. An attacker dusts the account with tokens under several
policies. A grant spend over the dusted deposit returns all but one unit
of dust, or pushes the dust onto the grant output.

Mitigation. A positive outflow of any asset class but the scoped one and
lovelace is refused, down to a single unit (INV-35). The grant output
holds exactly the spent grant UTxO's value, which holds only lovelace and
the grant token (INV-38, INV-31). Only a device can move dust. A grantee
that includes a dusted deposit returns every unit of it. The owner's cost
is the fee of sweeping. The attacker's cost is the minimum lovelace of
every dust UTxO, which the owner recovers. Dust carrying a state shaped
or grant shaped datum is the forged UTxO case of
[missing UTxO authentication](#missing-utxo-authentication).

## Resource exhaustion

Attack. Grow the state, the grants or the transaction until a path no
longer fits the execution budget, so that the owner cannot revoke or
sweep. Attach a large reference script to an output the account later
spends, to raise the fee of every later spend.

Mitigation. The state and each grant are bounded (INV-44, INV-45). The
owner's revoke and device rewrite are one control spend whatever is
outstanding. An issuance or a sweep of many grants, and a grant spend
over many fund UTxOs, is split into batches; see
[batch limits](known-issues.md#batch-limits). No helper is unbounded in anything an
attacker controls except the number of inputs, outputs and redeemers,
which the transaction size limit bounds and the submitter pays for:

- The grant accounting folds the inputs and outputs at the address once,
  linear in the total number of asset entries.
- Each proxy execution scans the inputs a fixed number of times, so the
  proxy's total work grows with the square of the number of deposits.
  Placement is one lookup per input or output.
- `logic_v1` walks the redeemers once and runs one rule per spend
  redeemer other than `Fund`. A grant spend decodes the grant output's
  datum once. A sweep reads two fields of its grant and decodes it fully
  only for the expiry.
- An issuance of k grants scans the outputs once per minted token, so
  it grows with k squared in output scans and linearly in grant datums
  decoded. The counters read the mint once.
- Well formedness is quadratic over the device list, bounded at 8, and
  linear over the revoked list, bounded at 32. The currency and death
  checks scan the revoked list once. The recipient check is linear in
  outputs times at most 8 recipients. The registration check is one scan
  of the redeemers.

A reference script raises the fee of every transaction that spends the
UTxO carrying it. Under `logic_v1` a grantee cannot attach one to the
grant output it recreates (INV-38) or to a deposit it pays back
(INV-37). An issuance cannot attach one to a grant output (INV-26), so no
grant UTxO ever carries one. The proxy refuses a reference script on the
control output at creation and on every spend of the state NFT, whatever
the logic (INV-6, INV-9). What a device may attach to other outputs is in
[Trust assumptions](trust-assumptions.md).
