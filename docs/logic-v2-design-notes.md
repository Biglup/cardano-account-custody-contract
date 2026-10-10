# Logic v2 design notes

This document records the changes planned for a later logic version.
Each one is a plan, not a promise. A later version is designed, audited
and deployed on its own, and it may drop, change or add to any of these.
The name `logic_v2` stands here for whichever version first ships them.
None of the changes touches the proxy or the stake script, whose
compiled code is final, and none changes `logic_v1`, whose applied hash
is the credential its accounts name. The rules each change starts from
are those of `logic_v1` in [Validators](protocol/validators.md). What
every version must keep is in
[obligations of every logic](security/invariants.md#obligations-of-every-logic).
Terms are defined in the [glossary](glossary.md).

Each change states what changes, why, and what it saves or fixes. A
change that saves work saves walks over the transaction's lists.

## Arrival carries the counters over

What changes. On arrival from a leaving state whose datum decodes as
the `AccountState` of `logic_v1`, the arriving logic requires the new
`next_slot` and `outstanding` to equal the leaving state's and the
revoked list to be empty, beside the generation bump, the equal devices
and the empty mint it requires as `logic_v1` does. From a leaving state
of another shape it reads the stable prefix only, as `logic_v1` does.

Why. Under `logic_v1` the device that signs an upgrade writes the three
counters, and the state it writes can strand lovelace or reuse slots.
The generation bump kills every grant issued before, so an empty
revoked list loses nothing, and the outstanding count is a count of
grant tokens, which the upgrade does not mint or burn.

What it fixes. [Counters written on arrival](security/known-issues.md#counters-written-on-arrival),
for accounts arriving at that version from a `logic_v1` shaped state.
The signer's check on the counters stays for an arrival at `logic_v1`.

## Publish accepts a vote delegation of its own credential

What changes. The `publish` handler accepts a `DelegateCredential` of a
script credential whose delegate is a vote delegation. It keeps
refusing a delegation to a pool, alone or beside a vote delegation, the
deregistration of the credential and every other certificate. Who may
issue the delegation, and to which delegate representative, is an open
point of the design.

Why. `logic_v1` accepts only the registration of its credential. If the
ledger required a vote delegation before a script credential could
withdraw, as it does for key credentials, no account on `logic_v1`
could transact. A pool delegation stays refused because any stake under
the credential would then earn rewards into the logic's reward account
every epoch, and every account transaction withdraws that account's
whole balance.

What it fixes. [Logic certificates are fixed](security/known-issues.md#logic-certificates-are-fixed),
for that version. It does not change
[logic reward account](security/known-issues.md#logic-reward-account),
which a third party can credit under any version.

## The Run redeemer carries indices

What changes. `Run` gains fields: the index of the control output among
the outputs, the output index of each grant issued, and the input index
of each account input the logic validates. The logic reads the output
or input at the index and checks it, instead of searching the list for
the output that holds a token or the input a redeemer names. The proxy
reads nothing of the logic's redeemer, so the proxy is not affected.
The library builds the redeemer and fills the indices.

Why. An index tells the logic where to look; it never tells it what to
accept. Every check on the located output or input stays, and a wrong
index fails. The checks that count the occurrences of a token across
the outputs stay too, since an index locates one output and says
nothing about the others.

What it saves. One walk over the outputs per grant issued, one walk
over the outputs for the control output, and one walk over the inputs
per account redeemer on the owner and agent paths.

## Fused folds on the agent path

What changes. The grant spend rule walks the inputs once and the
outputs once. One fold over the inputs yields the value spent from the
account, whether the grant UTxO is the only account token among the
inputs, and placement over the inputs. One fold over the outputs yields
the value returned to the account, the grant output, whether every
output outside the account goes to a recipient, whether every deposit
paid back is plain, and placement over the outputs. The rule reads the
results and checks what it checks under `logic_v1`.

Why. Each of these is a separate walk over the same list under
`logic_v1`, so a grant spend over many fund UTxOs pays each walk once
per rule. Fusing them pays each list once. Nothing checked changes.

What it saves. The repeated walks over the inputs and the outputs on
every grant spend.

## The control output passed through

What changes. On the owner path the control output is found once and
handed to the device rule and to the issue rule. Under `logic_v1` the
device rule finds it and the issue rule finds it again. The owner
path's own check, that every control output naming the logic sits at
the spent account's address, is a different check and stays.

Why. The two searches find the same output, and each one walks the
outputs.

What it saves. One walk over the outputs on an owner transaction that
issues grants.

## Strict decoding of proxy redeemers

What changes. The walk over the spend redeemers locates the input
first. For an input at the account address it decodes the proxy
redeemer strictly: a redeemer that does not decode as an
`AccountRedeemer` fails the transaction. Redeemers of inputs elsewhere
belong to other scripts and are still skipped.

Why. `logic_v1` decodes every spend redeemer through a soft cast and
skips one it cannot read. The proxy's own typed parameter refuses such
a redeemer before the proxy's handler runs, so a transaction that
carries one fails at the proxy, and the soft cast is a branch that
never applies to an account input. Strict decoding makes the logic
refuse it on its own, without leaning on the proxy's cast.

What it fixes. A dependence of the logic on the proxy's decoding, with
no known exploit under `logic_v1`. The soft cast and its skip branch go.

## The output-side placement check leaves the device rule

What changes. The device rule stops checking placement over the
outputs. Its check of placement over the inputs stays.

Why. The proxy checks placement over the outputs on every spend of a
UTxO that holds an account token, and the control UTxO holds the state
NFT, so the proxy makes that check on every owner transaction. The
device rule repeats it in the same transaction. The proxy makes no
placement check over the inputs, so the device rule's input-side check
is the only one.

What it saves. One walk over the outputs on every owner transaction.

## What stays

Every obligation of a logic stays: the stable prefixes, one control
UTxO per transaction, the arrival path validating the whole state, the
leaving rule requiring the arriving logic to run, killing every grant
issued before its arrival, and the registration of the version's own
credential. `logic_v1` as the leaving logic requires only that the
arriving logic withdraws and that nothing is minted, so an account
moves to a later version with the [upgrade](guides/upgrade.md) as it
stands.
