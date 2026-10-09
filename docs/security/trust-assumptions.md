# Trust assumptions

What each role can do, what it cannot, and what an account trusts it
for. Terms are defined in the [glossary](../glossary.md). The numbered
properties cited are in [Invariants](invariants.md).

The proxy and the stake script bind every role whatever logic the
account names. The logic is trusted code: the limits below that come
from the logic are rules of `logic_v1`, and hold only while the account
names it.

## Summary

| Role | Authority | Trusted for |
| --- | --- | --- |
| Owner | Creation of the account; then one device like any other | Creating the account with itself among the devices |
| Device | Everything, under `logic_v1` | The whole account |
| Agent | Spends within one grant's scope while the grant is current | Nothing beyond its grant's caps |
| Agent key signer | The agent's authority, nothing more | Signing only what the agent's policy allows, keeping the key |
| Fee sponsor | None | Paying, and liveness of the operations it sponsors |
| Provider | None | Accurate chain data, evaluation and submission; liveness |
| Anyone | Deposits, setup, reading | Nothing |

## Owner

The owner is the verification key hash the account's stake script is
applied to. In the intended deployment it is the first device, derived
from a passkey.

Can:

- Sign the creation. On its own it authorises one thing: registering the
  account's stake credential, together with the mint of the state NFT
  and a control output that lists the owner as a device (INV-14).
- Act as a device while it is listed in the account state.

Cannot:

- Create an account that leaves itself out of the device list
  (INV-14). The library also refuses to build such a creation.
- Create a second account at the same address, or a second control UTxO
  (INV-17).
- Do anything after a device removes it from the state. Its place in
  the device list is its only authority after creation.

Trusted for: staying unknown to others until the account exists.
Anyone who learns the stake credential before creation can block the
address. See [stake credential squat](known-issues.md#stake-credential-squat).

## Device

A device is a verification key hash listed in the account state. The
account lists one to 8 of them (INV-44). The device wallet holds the key
and signs owner transactions.

Can, through the permanent part:

- Withdraw the account's staking rewards and delegate its stake
  credential to a pool, a DRep or both, whatever logic the account names
  (INV-15).

Can, under `logic_v1`, with any one device signature:

- Point the account at another logic (INV-25). The proxy admits any 28
  byte hash whose credential withdraws (INV-10).
- Spend every deposit and reserve to any destination (INV-20, INV-11).
- Rewrite the state: add or remove devices, revoke one slot, or raise
  the generation to revoke every grant (INV-24).
- Drop a slot from the revoked list (INV-24). See
  [revoked slots can be dropped](known-issues.md#revoked-slots-can-be-dropped).
- Issue grants into new grant UTxOs and sweep dead ones (INV-26,
  INV-28).
- Attach a datum or a reference script to any output it creates, except
  the control output and grant outputs (INV-9, INV-26).

Cannot, under `logic_v1`:

- Write an ill formed state: no device, more than 8 devices, more than
  16 outstanding grants or more than 32 revoked slots (INV-44).
- Lower the generation, or move the next slot or the outstanding count
  except by the grant tokens minted and burned (INV-24).
- Sweep a grant that is not dead against the spent state (INV-28).

Cannot, whatever the logic: relocate, duplicate, burn or encumber the
control UTxO (INV-4, INV-9), misplace an account token (INV-8), or
deregister the account's stake credential (INV-16).

Trusted for: the whole account. Under `logic_v1` one compromised device
can take every deposit and reserve. A device that signs an upgrade to an
unknown logic hands the account to that code. See
[unknown logic](known-issues.md#unknown-logic). The device wallet must
keep a list of known logic hashes and refuse any other hash in field 0 of
a control output it signs.

## Agent

An agent spends under a grant through its grantee key, an Ed25519 key
hash. Every bound below is a rule of `logic_v1`.

Can:

- Spend its own grant UTxO and plain fund UTxOs of the same account, with
  the control UTxO referenced (INV-30, INV-31).
- Move at most the per call cap and the remaining cap of one asset, and,
  when that asset is not lovelace, lovelace within the lovelace per call
  cap and the remaining lovelace cap (INV-35). The fee counts as leaving.
- Pay any destination when the grant lists no recipient, and only listed
  recipients otherwise (INV-36).
- Spend before the expiry, while the grant is current (INV-32, INV-34).
- Pay plain deposits back to the account and split them at zero outflow
  (INV-37).
- Lower its own remaining caps further than the outflow (INV-39), which
  costs it headroom and nothing else.

Cannot:

- Move any other asset class (INV-35).
- Raise a cap, change any other field of its grant, or move the grant
  UTxO to another address (INV-38, INV-39).
- Spend the control UTxO, a reserve or another grant UTxO (INV-21,
  INV-11, INV-31).
- Mint or burn under the policy, or write a control output (INV-30).
- Change devices, grants or the logic, withdraw rewards or delegate
  (INV-15, INV-20).
- Pay back a deposit carrying a datum or a reference script (INV-37).
- Spend after a revoke confirms (INV-32).

Trusted for: nothing beyond the grant's caps, until the grant is revoked
or expires.

## Agent key signer

The agent key signer holds the grantee key and signs grant spends on the
agent's behalf. On chain it is indistinguishable from the grantee. The
logic sees only a required signer that matches the grant. A service that
cannot produce an Ed25519 witness over the transaction body cannot act
as a grantee.

Can: everything the agent can, for every grant naming its key.

Cannot: anything the agent cannot. The caps, the expiry and the
recipients bind every transaction it signs, and a revoke cuts it off.

Trusted for: keeping the grantee key, applying the agent's policy
before it signs, and using the key for nothing else. A signature it
gives cannot be reused; see
[signature replay](threat-model.md#signature-replay).

## Fee sponsor

A fee sponsor pays the fee and collateral of a creation or an owner
transaction. At creation it also pays the control UTxO's lovelace and the
registration deposit.

Can:

- See and co-sign the transactions it pays for.
- Refuse to sponsor, which delays the operation until another payer
  steps in.

Cannot:

- Authorise anything. Every path still needs the owner, a device or a
  grantee, and the sponsor holds none of them.
- Change a transaction a device signed. The device witness covers the
  whole body.

The library refuses a sponsor on a grant spend, since the account pays
for its own grant spends. That is a rule of the library, not of the
contract.

Trusted for: liveness of the operations it sponsors. An owner who keeps
a reserve or a device wallet with collateral does not depend on it.

What a sponsor should check before it signs, since it sees and co-signs
the transaction and backs it with its collateral:

- It contributes only the fee, the collateral and, at creation, the
  deposit and the control output's lovelace. The library returns the
  sponsor's change to it.
- A sponsor that refuses withdrawals from scripts it does not know must
  allow the withdrawal from the logic the control input's datum names,
  from both logics on an upgrade, and from the account's stake
  credential on a reward withdrawal.
- A sponsor that refuses certificates of scripts it does not know must
  allow the delegation certificate of the account's stake credential. A
  delegation runs the stake script through that certificate, not
  through a withdrawal.

## Provider

The provider is the chain data service the library queries and submits
through: UTxOs, protocol parameters, reward balances, the parked
reference scripts, script evaluation and submission.

Can:

- Withhold or misreport chain data, which shows a user a wrong state or
  makes a build fail.
- Report inflated execution units. On a grant spend the library refuses
  a fee above the fee bound, so the cost stays within the grant's caps.
- Delay or censor submission.

Cannot:

- Move funds or change what a validator accepts. The ledger runs every
  script over the real UTxOs the transaction names, and a transaction
  built from false data fails to balance or to validate.

Trusted for: accurate reads and liveness. A wallet that displays an
account state should read it from a provider it trusts.

## Anyone

Anyone includes a dApp or a transaction builder without a key, the owner
of another account, and a party with no relation to the account.

Can:

- Deposit to the account address, plain or as a reserve, and dust it
  with tokens.
- Register a logic credential and park reference scripts.
- Read every account's state and grants. The control datum is public.
- Credit the reward account of a logic credential. See
  [logic reward account](known-issues.md#logic-reward-account).
- Before the account exists, register its stake credential with the
  legacy certificate. See
  [stake credential squat](known-issues.md#stake-credential-squat).
- Assemble and submit transactions, add inputs from its own wallet, and
  choose which deposits of an account to include. Every path still needs
  one of the keys above.
- Create its own account under any stake script and any logic.

Cannot:

- Spend a deposit without an account token of the same account in the
  transaction (INV-11).
- Mint, burn or place a token of another account (INV-3, INV-8).
- Leave the owner out of a creation it assembles (INV-14).

Trusted for: nothing.

## Trusted code: the logic

The logic is code, not a key. The proxy runs it on every spend except
`Fund` and on every grant mint, and leaves it every rule the proxy does
not keep (INV-10). An account trusts its logic with everything outside
the proxy's invariants. What any logic must enforce is in
[obligations of every logic](invariants.md#obligations-of-every-logic).

There is no stake key. The account's stake credential is the hash of its
own stake script. The only authority over the reward account and the
certificates is the device rule that script enforces (INV-15).

## The ledger

The validators rely on these Cardano ledger rules:

- Balance: every transaction's inputs, withdrawals and mint equal its
  outputs, fee and deposits.
- Witnesses: every required signer signs the transaction body, and a
  witness binds that one body.
- Datum availability: an input under a datum hash is spendable only with
  the datum in the witness set.
- Validity intervals: a transaction applies only within its validity
  range.
- Single registration: a stake credential is registered at most once at
  a time.
- Script purposes: a credential's script runs on every withdrawal from
  its reward account and every certificate naming it, and on nothing
  else. The exception is the legacy stake registration certificate,
  which needs no witness and runs no script. See
  [stake credential squat](known-issues.md#stake-credential-squat).
- One redeemer per mint policy per transaction.
- A withdrawal equals the reward account's whole balance.

The invariants that depend on a ledger rule say so, and the
[threat model](threat-model.md) names the rule where a mitigation relies
on it.
