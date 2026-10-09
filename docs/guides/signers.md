# Signers

A signature on an account transaction is authority. Under `logic_v1` a
device signature controls the whole account, and a grantee signature
moves value within a grant. The chain enforces the contract's rules, but
it cannot tell a transaction the user meant from one a compromised app
assembled. This guide lists what a [device wallet](../glossary.md#device-wallet)
and an [agent key signer](../glossary.md#agent-key-signer) check and show
before they sign. What each role is trusted with is in
[trust assumptions](../security/trust-assumptions.md).

## Reading a transaction

`transactionBodyParts(tx, slotConfig)` returns the inputs, outputs, fee,
validity range, mint, required signers, reference inputs and withdrawals
of a built transaction. Resolve the inputs and reference inputs through
the provider to see which UTxOs they are. `decodeAccountState` and
`decodeGrant` read the control datum and a grant datum. Certificates are
not among the parts; read them with cometa.

An input is a control UTxO when it holds the account's state NFT, and a
grant UTxO when it holds one of its grant tokens. `classifyAccountUtxos`
sorts UTxOs of an account address this way.

## Device wallet

### Keys and networks

The account's stake credential must stay unknown until the creation
registers it. The device wallet applies every key layer measure listed
under [stake credential squat](../security/known-issues.md#stake-credential-squat).

### Creation

The owner key signs the [creation](../glossary.md#creation). Before
signing:

- Show the account address and the initial devices. The stake script
  refuses a creation that leaves the owner out of the devices.
- Refuse a logic hash outside the wallet's
  [known logic list](../glossary.md#known-logic-list).

### Every owner transaction

- Show which account the transaction acts on, by address or by a name
  the user gave it.
- Confirm the wallet's key is a device of the state the control input
  carries.
- Compare the state of the control output with the state of the control
  input, and show every difference.
- Prefer a validity end. A transaction that loses the control UTxO to
  another device then leaves the mempool.

### State changes

| Change | What to show or refuse |
| --- | --- |
| A device added | The key hash, checked to be 56 hex characters. |
| A device removed | The key hash. Warn when it is the signing key or when one device would remain. |
| A slot added to the revoked list | The grant it revokes. |
| A slot dropped from the revoked list | That the grant becomes current again. |
| The generation raised | That every grant of the account dies. `revokeGrant` raises it when the revoked list is full. |
| The logic changed | Apply [the upgrade rules](upgrade.md#what-a-signer-must-refuse). |

### Grants issued

For each new grant UTxO, show:

- the grantee key hash, checked to be 56 hex characters;
- the asset, the per call cap and the remaining cap;
- the lovelace caps of a token scope;
- the expiry as a date and time;
- the recipients. Warn when the list is empty, since the grantee may then
  pay any address. Warn when a recipient is a script address.

A sweep burns grant tokens. Show the slots swept.

### Payments

- Show every output that leaves the account address, with its value.
- Pay an account only at its full account address. Funds sent to the
  proxy's payment credential under any other stake part can never be
  spent.
- An output to the account address under a datum becomes a reserve. Show
  it as such.

### Stake operations

- Show the amount of a reward withdrawal and where it goes.
- Refuse a reward withdrawal a fee sponsor pays for. The library sends
  the withdrawn rewards to the sponsor's change.
- Show the target of a delegation certificate. The stake script accepts
  any delegation a device signs: to a pool, to a DRep, or both.

### Fee sponsor and collateral wallet

A device signature covers the whole body. A fee sponsor or a collateral
wallet adds its own inputs, change and collateral, and signs for them. It
cannot alter what the device signed without invalidating the signature.
The device wallet checks the account's side of the transaction, as above.

## Agent key signer

An agent key signer holds a grantee key. It signs grant spends and
nothing else.

### What it signs

Sign only a transaction that:

- spends exactly one grant UTxO, whose grant names the signer's key as
  grantee;
- references the account's control UTxO and does not spend it;
- spends no reserve and no other grant UTxO;
- mints and burns nothing under the proxy policy;
- has a finite validity end no later than the grant's expiry.

Refuse any transaction that spends a control UTxO. A grantee key that is
also a device of the account carries full authority, and the signer holds
the grantee's authority only.

### What it shows or enforces

- The payees and amounts of every output that leaves the account.
- Any policy beyond the grant. A grant has no rolling period cap, so a
  daily or per counterparty limit is the signer's to enforce.

The chain bounds every spend by the grant whatever the signer accepts:
the caps, the recipients, the expiry and the grant's liveness.

### Keys

- A grantee is an Ed25519 key hash. A service that cannot produce an
  Ed25519 witness over the transaction body cannot be a grantee.
- A witness covers the hash of one transaction body. It cannot be
  replayed on another transaction, another account or another network.
  The signer keeps no nonce.

## Fee sponsor

A [fee sponsor](../glossary.md#fee-sponsor) gains no authority, but it
sees and co-signs what it pays for and backs it with its collateral. It
checks that:

- it contributes only the fee, the collateral, the control output's
  growth (the lovelace it holds beyond the control input) and, at
  creation, the control UTxO's lovelace and the registration deposit;
- its change returns to it;
- the transaction is a creation or an owner transaction, never a grant
  spend.

A sponsor that refuses withdrawals from scripts it does not know allows
the withdrawal from the logic the control output's datum names at
creation, from the logic the control input's datum names otherwise,
from both logics on an upgrade, and from the account's stake
credential on a reward withdrawal.

A sponsor that refuses certificates of scripts it does not know allows
the registration certificate of the account's stake credential at
creation and its delegation certificate. A delegation runs the stake
script through that certificate, not through a withdrawal.
