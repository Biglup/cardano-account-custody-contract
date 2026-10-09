# Datums and redeemers

This document gives the on-chain data of the contract: the datums, the
token names, the redeemers and the bounds. The types are declared in
[types.ak](../../lib/cardano_account_custody_contract/types.ak) and the
bounds in [state.ak](../../lib/cardano_account_custody_contract/state.ak).
The checks that use them are in [Validators](validators.md). Terms are
defined in the [glossary](../glossary.md).

## Encoding

Every type is Plutus data. A record is constructor 0 with its fields in
declaration order. A variant without fields is the constructor whose
index is its position in the declaration, starting at 0. Integers are
Plutus integers and hashes are byte strings. An address is the standard
Plutus `Address`, which carries no network id. The library writes every
datum inline.

## AccountState

The datum of the control UTxO
([types.ak#L84](../../lib/cardano_account_custody_contract/types.ak#L84)).
Constructor 0, six fields.

| Index | Field | Type | Meaning |
| --- | --- | --- | --- |
| 0 | `logic` | `ScriptHash`, 28 bytes | The logic the account names. The proxy requires a withdrawal from it. |
| 1 | `devices` | `List<VerificationKeyHash>` | The device keys. Under `logic_v1`, one to 8 distinct keys. |
| 2 | `grant_generation` | `Int` | The [generation](../glossary.md#generation). A grant whose generation is lower is dead. |
| 3 | `next_slot` | `Int` | The slot the next issued grant takes. |
| 4 | `revoked` | `List<Int>` | The slots of the current generation revoked one by one. |
| 5 | `outstanding` | `Int` | Grant tokens minted and not yet burned. |

Under `logic_v1` a [well formed state](../glossary.md#well-formed-state)
has one to 8 distinct devices, non negative `grant_generation`,
`next_slot` and `outstanding`, `outstanding` at most 16 and at most 32
revoked slots
([state.ak#L74](../../lib/cardano_account_custody_contract/state.ak#L74)).
A new account has zero `next_slot`, zero `outstanding` and an empty
revoked list
([state.ak#L90](../../lib/cardano_account_custody_contract/state.ak#L90)).

## Grant

The datum of a grant UTxO
([types.ak#L61](../../lib/cardano_account_custody_contract/types.ak#L61)).
Constructor 0, four fields.

| Index | Field | Type | Meaning |
| --- | --- | --- | --- |
| 0 | `slot` | `Int` | The grant's [slot](../glossary.md#slot). It ends the grant token's name. |
| 1 | `grantee` | `VerificationKeyHash`, 28 bytes | The Ed25519 key that must sign every spend under the grant. |
| 2 | `generation` | `Int` | The account's generation at issuance. |
| 3 | `scope` | [`Scope`](#scope) | The grant's bounds. |

A grant spend rewrites only `scope.cap` and `scope.lovelace_cap`. Every
other field stays as issued.

## Scope

The bounds of a grant
([types.ak#L34](../../lib/cardano_account_custody_contract/types.ak#L34)).
Constructor 0, seven fields.

| Index | Field | Type | Meaning |
| --- | --- | --- | --- |
| 0 | `asset` | [`Asset`](#asset) | The one asset class the caps cover. |
| 1 | `per_call_cap` | `Int` | The most of `asset` that may leave the account in one transaction. Never changes. |
| 2 | `cap` | `Int` | The `asset` that may still leave over the grant's life. Each spend lowers it. |
| 3 | `lovelace_per_call_cap` | `Int` | For a token scope, the most lovelace that may leave in one transaction. Zero for a lovelace scope. Never changes. |
| 4 | `lovelace_cap` | `Int` | For a token scope, the lovelace that may still leave over the grant's life. Each spend lowers it. Zero for a lovelace scope. |
| 5 | `expires_at` | `Int` | POSIX time in milliseconds. A spend's validity range must end no later than it. |
| 6 | `recipients` | `List<Address>` | The addresses a spend may pay. Empty allows any destination. |

Under `logic_v1` a well formed scope has non negative caps, `expires_at`
greater than zero, at most 8 recipients, and both lovelace caps zero
when `asset` is lovelace
([state.ak#L47](../../lib/cardano_account_custody_contract/state.ak#L47)).
No value of `expires_at` means "never expires". A recipient is compared
as a Plutus `Address`, so the network id plays no part.

## Asset

An asset class
([types.ak#L26](../../lib/cardano_account_custody_contract/types.ak#L26)).
Constructor 0, two fields.

| Index | Field | Type | Meaning |
| --- | --- | --- | --- |
| 0 | `policy_id` | `PolicyId` | The policy. Empty for lovelace. |
| 1 | `asset_name` | `AssetName` | The token name. Empty for lovelace. |

## Stable prefix

Some scripts read a datum by position without decoding the rest of it.
The fields they read form the [stable prefix](../glossary.md#stable-prefix):

| Datum | Prefix | Read by |
| --- | --- | --- |
| `AccountState` | 0 `logic` | The proxy, to find the logic that must run ([account.ak#L457](../../lib/cardano_account_custody_contract/account.ak#L457)) |
| `AccountState` | 1 `devices` | The stake script, for its [stake device rule](validators.md#stake-device-rule) and the creation gate ([account.ak#L465](../../lib/cardano_account_custody_contract/account.ak#L465)) |
| `AccountState` | 0 `logic`, 1 `devices`, 2 `grant_generation` | An arriving `logic_v1`, from the state the account leaves ([logic.ak#L289](../../lib/cardano_account_custody_contract/logic.ak#L289), [logic.ak#L290](../../lib/cardano_account_custody_contract/logic.ak#L290), [logic.ak#L291](../../lib/cardano_account_custody_contract/logic.ak#L291)) |
| `Grant` | 0 `slot`, 2 `generation` | A sweep under `logic_v1` ([account.ak#L482](../../lib/cardano_account_custody_contract/account.ak#L482), [account.ak#L490](../../lib/cardano_account_custody_contract/account.ak#L490)) |
| `Grant` | 1 `grantee` | Kept in place with the other two fields |

The proxy and the stake script never change. An account that moves
between logics carries datums one logic wrote and another reads. A
future logic version must therefore keep these fields first, in this
order, with these types. It may change or append only the fields after
them. A logic that moves them breaks the proxy, the stake script, or the
upgrade and sweep of its accounts.

`logic_v1` reads the expiry of a grant only when the whole datum decodes
as a `Grant`. A grant of another shape is swept by generation or
revocation, never by expiry
([grant.ak#L71](../../lib/cardano_account_custody_contract/grant.ak#L71)).

## Token names

Every account token is under the proxy policy, whose id is the proxy
hash. A name's first 28 bytes are the account's stake script hash. They
denote the account the token belongs to
([account.ak#L99](../../lib/cardano_account_custody_contract/account.ak#L99)).

| Token | Name | Length | Quantity |
| --- | --- | --- | --- |
| State NFT | The stake script hash | 28 bytes ([account.ak#L109](../../lib/cardano_account_custody_contract/account.ak#L109)) | 1, minted once, never burned |
| Grant token | The stake script hash, then the slot as 4 big endian bytes | 32 bytes ([account.ak#L90](../../lib/cardano_account_custody_contract/account.ak#L90), [account.ak#L114](../../lib/cardano_account_custody_contract/account.ak#L114)) | 1, minted at issuance, burned in a sweep |

The 4 byte suffix limits a slot to the range 0 to 4,294,967,295. A
grant token name for any other slot cannot be built, so no grant can be
issued in it.

## Deposit datums

A [deposit](../glossary.md#deposit) holds no account token. The proxy
reads only whether it has a datum:

| Deposit | Datum | Spent beside |
| --- | --- | --- |
| [Fund UTxO](../glossary.md#fund-utxo) | None | An input of the same account that holds an account token |
| [Reserve](../glossary.md#reserve) | Any datum, inline or by hash | The account's control UTxO, spent |

The library writes the reserve datum as constructor 0 with no fields,
inline ([data.ts#L372](../../offchain/src/data.ts#L372)). The datum
carries no information. The library spends only reserves whose datum is
inline. A reserve under a datum hash needs the datum as a witness to be
spent, and the library leaves it alone.

## Redeemers

Each redeemer is a constructor without fields. The table gives its
index.

### AccountRedeemer

The proxy's spend redeemer
([types.ak#L105](../../lib/cardano_account_custody_contract/types.ak#L105)).
The logic reads it back from the transaction.

| Index | Constructor | Put on | Under `logic_v1` |
| --- | --- | --- | --- |
| 0 | `Device` | The control UTxO, in an [owner transaction](../glossary.md#owner-transaction) | The device rule |
| 1 | `SpendWithGrant` | A grant UTxO, in a [grant spend](../glossary.md#grant-spend) | The grant spend rule |
| 2 | `SweepGrant` | A dead grant UTxO, in a [sweep](../glossary.md#sweep) | The sweep rule |
| 3 | `Fund` | A deposit | Left to the proxy |

### MintRedeemer

The proxy's mint redeemer
([types.ak#L117](../../lib/cardano_account_custody_contract/types.ak#L117)).
One transaction carries one, for the whole mint under the policy.

| Index | Constructor | Mints | Under `logic_v1` |
| --- | --- | --- | --- |
| 0 | `CreateAccount` | One state NFT | The arrival, as a creation |
| 1 | `IssueGrants` | Grant tokens of one account, 1 each | The issue rule |
| 2 | `BurnGrants` | Grant tokens of one account, -1 each | The burn rule |

An issuance and a burn cannot share a transaction.

### StakeRedeemer

The stake script's redeemer
([types.ak#L128](../../lib/cardano_account_custody_contract/types.ak#L128)).

| Index | Constructor | Put on |
| --- | --- | --- |
| 0 | `Operate` | Every withdrawal from the account's reward account and every certificate naming its stake credential, except a legacy stake registration, which runs no script |

### LogicRedeemer

The logic's redeemer
([types.ak#L136](../../lib/cardano_account_custody_contract/types.ak#L136)).

| Index | Constructor | Put on |
| --- | --- | --- |
| 0 | `Run` | Every withdrawal from a logic credential, and its registration |

## Bounds

The bounds of `logic_v1` are constants in
[state.ak](../../lib/cardano_account_custody_contract/state.ak). They are
rules of `logic_v1`. Another logic may set its own.

| Bound | Value | Constant |
| --- | --- | --- |
| Devices per account | 1 to 8, distinct | `max_devices` ([state.ak#L25](../../lib/cardano_account_custody_contract/state.ak#L25)) |
| Outstanding grants per account | 16 | `max_grants` ([state.ak#L28](../../lib/cardano_account_custody_contract/state.ak#L28)) |
| Revoked slots in the state | 32 | `max_revoked` ([state.ak#L32](../../lib/cardano_account_custody_contract/state.ak#L32)) |
| Recipients per grant | 8 | `max_recipients` ([state.ak#L35](../../lib/cardano_account_custody_contract/state.ak#L35)) |

The library adds bounds of its own on the transactions it builds:

| Bound | Value | Constant |
| --- | --- | --- |
| Grants issued or swept per transaction | 8 | `MAX_GRANT_BATCH` ([transactions.ts#L100](../../offchain/src/transactions.ts#L100)) |
| Fund UTxOs per grant spend | 12 | `MAX_FUND_INPUTS` ([transactions.ts#L114](../../offchain/src/transactions.ts#L114)) |
| Lovelace a grant spend reserves against the caps for its fee | 1,500,000 by default | `DEFAULT_GRANT_FEE_BOUND` ([transactions.ts#L125](../../offchain/src/transactions.ts#L125)) |
| Lovelace of a new control UTxO | 2,000,000, or the minimum UTxO value if higher | `DEFAULT_CONTROL_LOVELACE` ([transactions.ts#L93](../../offchain/src/transactions.ts#L93)) |
