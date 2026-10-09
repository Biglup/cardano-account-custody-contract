# Glossary

The terms the contract's documentation uses, in alphabetical order. The
[overview](overview.md) and the [architecture](architecture.md) show how
they fit together.

## Account

A script address controlled by its devices, together with the control
UTxO, grant UTxOs and deposits that sit at it. An account is created
once and never deleted.

## Account address

The address of an account: the proxy hash as payment credential and the
account's stake script hash as an inline script stake credential. It
never changes.

## Account record

The owner key hash, stake script hash and address of an account. A
device other than the owner keeps it, since it cannot derive the address
from its own key.

## Account state

The `AccountState` datum of the control UTxO: the logic hash, the
devices, the generation, the next slot, the revoked list and the
outstanding count.

## Account token

A token under the proxy policy: a state NFT or a grant token. Each one
sits, in quantity one, at the address of the account its name denotes.

## Agent

A party that spends from an account under a grant, without the owner's
involvement. It acts through its grantee key.

## Agent key signer

A service that holds a grantee key and signs grant spends on the agent's
behalf. It holds the grantee's authority and nothing more.

## Agent path

The logic's path when the control UTxO is referenced, not spent. A
grantee spends its grant UTxO, the only input that holds an account
token, and plain funds move beside it.

## Agent wallet

The wallet that builds a grant spend and, unless a collateral wallet
stands in, provides its collateral.

## Arrival

The logic's path when no control UTxO naming it is in the transaction.
An account is created under the logic, or moves to it in an upgrade.

## Arriving logic

In a creation or an upgrade, the logic the new control output names. It
takes its arrival path and validates the new state under its own rules.

## Blueprint

The file `plutus.json`, holding the compiled proxy, logic and stake
script. For the parameterised `logic_v1` and `account_stake` it holds
the unapplied code and hash. The library applies them to their
parameters before use, and the applied hashes are the credentials in
use.

## BurnGrants

The proxy mint redeemer that burns grant tokens in a sweep.

## Cap

A limit in a grant's scope. The per call cap (`per_call_cap`) bounds one
transaction. The remaining cap (`cap`) bounds the rest of the grant's
life. Under `logic_v1` each spend reduces it by at least the net amount
of its asset that leaves the account, which can be zero. It never
increases.

## Collateral wallet

A wallet that provides only the collateral of a transaction the account
pays for. The library takes it as the `collateral` option.

## Control datum

The account state as the control UTxO carries it, inline.

## Control output

The output that holds the state NFT, recreating the control UTxO. A
transaction that spends the control UTxO has exactly one.

## Control UTxO

The one UTxO at an account address that holds the state NFT and the
account state. Every spend recreates it at the same address.

## CreateAccount

The proxy mint redeemer that mints an account's state NFT at creation.

## Creation

The transaction that registers the account's stake credential, mints
the state NFT and writes the first control UTxO. The owner signs it.

## Current grant

A grant issued under the account's generation whose slot is not in the
revoked list. Under `logic_v1`, only a current grant can be spent, and only before its
expiry.

## Dead grant

A grant issued under an older generation, revoked by slot, or past its
expiry. It cannot be spent, and a device can sweep it.

## Deposit

A UTxO at an account address that holds no account token: a fund UTxO or
a reserve.

## Device

A verification key hash listed in the account state. Under `logic_v1`,
any device has full authority over the account. An account lists between
one and eight distinct devices.

## Device redeemer

The proxy spend redeemer, `Device`, on the control UTxO in an owner
transaction.

## Device wallet

The wallet holding a device key, which builds and signs owner
transactions.

## Expiry

The POSIX time in milliseconds, `expires_at`, after which a grant cannot
be spent. A grant spend's validity range must end no later than it.

## Fee bound

The lovelace the library subtracts from a grant's remaining caps, on top
of the outputs, before the fee is known. It is 1.5 ADA by default. The
library refuses a spend whose fee exceeds it.

## Fee sponsor

A wallet or service that pays the fee and collateral of a creation or an
owner transaction, and at creation the control UTxO's lovelace and the
registration deposit. It gains no authority. The library takes it as the
`sponsor` option and refuses it on a grant spend.

## Fund

The proxy spend redeemer, `Fund`, on a deposit.

## Fund UTxO

A deposit with no datum. It is spent beside the control UTxO or a grant
UTxO of its own account.

## Generation

The account's grant generation, `grant_generation`. While the account
runs `logic_v1`, it never decreases, and raising it kills every grant
issued under an older value. An account arriving at `logic_v1` from
another logic must raise it.

## Grant

A revocable permission for one grantee, held as the inline datum of a
grant UTxO. It carries a slot, a grantee, a generation and a scope.

## Grant spend

A transaction in which a grantee spends its grant UTxO and plain funds
within the grant's scope, with the control UTxO referenced.

## Grant token

The token that marks a grant UTxO. Its name is the account's stake script
hash followed by the grant's slot as 4 big endian bytes.

## Grant UTxO

A UTxO at an account address that holds one grant token, lovelace and an
inline grant.

## Grantee

The verification key hash a grant names. It must sign every spend under
the grant.

## Issuance

An owner transaction that mints grant tokens into new grant UTxOs, one
per grant, each taking the next slot. The library issues at most eight
grants per transaction.

## IssueGrants

The proxy mint redeemer that mints grant tokens at issuance.

## Leaving logic

In an upgrade, the logic the account state names before the
transaction. It takes its owner path. `logic_v1` as the leaving logic
requires only that the arriving logic runs and that nothing is minted.

## Logic

The replaceable, trusted validator that holds an account's rules beyond
the proxy's. The account state names it by hash, and the proxy requires
it to run. Its rules hold only while the account names it. One version
exists, `logic_v1`.

## Logic credential

The stake credential of a logic script applied to the proxy hash. It is
registered once per network and can never be deregistered.

## Logic withdrawal

The withdrawal from the logic credential that makes the ledger run the
logic once over the transaction. Its amount is not read and is zero in
practice.

## Lovelace caps

The caps a token grant has on lovelace: `lovelace_per_call_cap` per
transaction and `lovelace_cap` for the rest of its life. They bound the
fees and minimum UTxO lovelace that leave with the token. Both are zero
for a lovelace grant.

## Network setup

The one time setup of a network: registering each logic credential and
parking the proxy and each logic as reference scripts.

## Next slot

The field of the account state holding the slot the next issued grant
takes. It moves by the number of grants issued.

## Operate

The stake script's only redeemer.

## Outstanding

The field of the account state counting grant tokens minted and not yet
burned. It is at most 16 and zero at creation. `logic_v1` keeps the
count while the account stays under it. When an account arrives at
`logic_v1` by an upgrade, the check only bounds it at 16.

## Owner

The verification key hash the stake script is applied to. It signs the
creation and must be a device then. Afterwards it is one device like any
other and can be removed.

## Owner path

The logic's path when the control UTxO is spent. A device signs, and the
transaction may move any deposit, rewrite the state, issue grants or
sweep dead ones.

## Owner transaction

A transaction that spends the control UTxO with the `Device` redeemer
and a device signature.

## Parked reference script

A UTxO carrying the proxy or a logic as a reference script, at the
script address of `logic_v1`. Nobody can spend it. Transactions
reference it instead of embedding the script.

## Placement

The proxy rule that every account token sits, in quantity one, at the
address of the account its name denotes.

## Proxy

The permanent validator `account`. Its hash is the payment credential of
every account address and the policy id of every account token.

## Recipients

The addresses a grant may pay, at most eight. An empty list allows any
destination.

## Registration deposit

The lovelace the ledger takes when a stake credential is registered. It
returns only on deregistration. Creation pays it for the account's stake
credential, and the network setup for each logic credential. Neither
credential can be deregistered, so the deposit stays locked.

## Reserve

A deposit carrying a datum. The proxy lets it be spent only beside the
spent control UTxO. Under `logic_v1` only a device can spend that.
Owner transactions can draw their fee from it.

## Revoke

An owner transaction that adds a grant's slot to the revoked list, or
raises the generation, which revokes every grant at once.

## Revoked list

The field of the account state listing the slots of the current
generation revoked one by one. It holds at most 32 slots. The library
clears it when it raises the generation.

## Reward account

The reward account of an account's stake credential. Any device can
withdraw its rewards and delegate its stake.

## Run

The logic's only redeemer.

## Scope

The bounds of a grant: one asset, the per call cap, the remaining cap,
the lovelace caps, the expiry and the recipients.

## Slot

A grant's number within its account, taken from the next slot at
issuance. It is never reused while the account stays under `logic_v1`.
It ends the grant token's name. It is not a
chain slot.

## SpendWithGrant

The proxy spend redeemer on a grant UTxO in a grant spend.

## Stable prefix

The leading datum fields every logic version keeps in place: `logic`,
`devices` and `grant_generation` of the account state, and `slot`,
`grantee` and `generation` of a grant. Scripts that must work across
versions read them by position.

## Stake script

The validator `account_stake` applied to the owner key hash and the
proxy hash. Its hash is the account's stake credential and the name of
its state NFT. It guards the account's creation, delegation and reward
withdrawals.

## State NFT

The token that marks the control UTxO, named after the account's stake
script hash. It is minted once at creation and never burned.

## Sweep

An owner transaction that spends dead grant UTxOs, burns their tokens
and returns their lovelace to the account. The library sweeps at most
eight grants per transaction.

## SweepGrant

The proxy spend redeemer on a dead grant UTxO in a sweep.

## Upgrade

An owner transaction that points the account at another logic. Both
logics run. `logic_v1` as the arriving logic requires the generation to
grow, which kills every grant issued under the leaving state's
generation or an older one.

## Well formed state

An account state with one to eight distinct devices, non-negative
counters, at most 16 outstanding grants and at most 32 revoked slots.
