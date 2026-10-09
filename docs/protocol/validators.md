# Validators

This document lists every handler of the three validators and every
check each one makes. Each validator follows the same template:
purpose, parameters, datum, redeemers and checks. Every check links to
the line of source that makes it. The
[architecture](../architecture.md) explains how the validators divide
the work. Terms are defined in the [glossary](../glossary.md). Field
indexes, constructor indexes and bounds are in
[Datums and redeemers](datums-and-redeemers.md).

## Two kinds of rule

The [proxy](#proxy-account) and the [stake script](#stake-script-account_stake)
are permanent. Their checks hold for every account, whatever logic it
names.

The [logic](#logic-logic_v1) is replaceable, trusted code. An account
names its logic by hash in field 0 of its
[control datum](../glossary.md#control-datum), and a device can name
another one. The checks listed under `logic_v1` are rules of `logic_v1`.
They hold only while an account names `logic_v1`. Another logic sets
its own rules for every check the proxy and the stake script leave to
it. See [Upgrades](../architecture.md#upgrades).

## How the scripts recognise a control UTxO

Two recognisers find a [control UTxO](../glossary.md#control-utxo). The
proxy and the stake script use
[`is_control`](../../lib/cardano_account_custody_contract/account.ak#L162):

- The output carries an inline datum.
- It holds exactly one state NFT of the account.
- It sits at the account address.

The logic uses
[`is_own_control`](../../lib/cardano_account_custody_contract/logic.ak#L85):

- The output carries an inline datum.
- Its payment credential is the proxy hash and its stake credential is
  an inline script credential.
- It holds exactly one state NFT named after that stake credential.
- Field 0 of the datum equals the logic's own hash.

Neither recogniser decodes the datum beyond what it reads by position.

## Proxy: `account`

Source: [validators/account.ak](../../validators/account.ak#L85).

### Purpose

The proxy holds every account's funds and mints every account token.
It owns the naming, quantity and [placement](../glossary.md#placement)
of account tokens, and the creation gate. For every other rule it
requires the logic the account names to run.

### Parameters

None. Its hash is therefore the same for every account on a network.
That hash is the payment credential of every account address and the
policy id of every account token. The blueprint's hash is listed under
[scope](../security/README.md#scope).

### Datum

The spend handler takes `Option<Data>`. The proxy reads only whether a
datum is present, on the `Fund` arm. The datums found at an account
address are:

| UTxO | Datum |
| --- | --- |
| Control UTxO | Inline [`AccountState`](datums-and-redeemers.md#accountstate) |
| Grant UTxO | Inline [`Grant`](datums-and-redeemers.md#grant) |
| Fund UTxO | None |
| Reserve | Any datum, inline or by hash |

### Redeemers

| Handler | Redeemer | Constructors |
| --- | --- | --- |
| `mint` | [`MintRedeemer`](datums-and-redeemers.md#mintredeemer) | `CreateAccount`, `IssueGrants`, `BurnGrants` |
| `spend` | [`AccountRedeemer`](datums-and-redeemers.md#accountredeemer) | `Device`, `SpendWithGrant`, `SweepGrant`, `Fund` |

### Checks

Two helper rules recur below.

The **logic rule**,
[`runs_the_logic`](../../validators/account.ak#L201), holds when:

- The account's control UTxO is present exactly once among the inputs
  and the reference inputs taken together
  ([L207](../../validators/account.ak#L207),
  [find_present_control](../../lib/cardano_account_custody_contract/account.ak#L213)).
  A control UTxO both spent and referenced counts twice and fails.
- The transaction withdraws from the script credential named in field 0
  of that control datum ([L215](../../validators/account.ak#L215),
  [logic_of](../../lib/cardano_account_custody_contract/account.ak#L457),
  [withdraws_from](../../lib/cardano_account_custody_contract/account.ak#L579)).
  The amount is not read.

The **placement rule**,
[`tokens_sit_at_their_own_addresses`](../../lib/cardano_account_custody_contract/account.ak#L337),
holds when every token under the proxy policy in the outputs is held in
quantity one by an output at the account address its name denotes. The
first 28 bytes of a name denote the account
([account_of_name](../../lib/cardano_account_custody_contract/account.ak#L99)).

#### `mint` with `CreateAccount`

- The mint under the policy is exactly one entry, in quantity 1
  ([L91](../../validators/account.ak#L91)). Its name is taken as the
  stake script hash.
- Exactly one output is a control output of that account
  ([L92](../../validators/account.ak#L92),
  [find_control_output](../../lib/cardano_account_custody_contract/account.ak#L191)).
- The name is 28 bytes long ([L99](../../validators/account.ak#L99)).
- The redeemers hold a publish entry for a certificate that registers
  that stake credential, alone or with a delegation
  ([L100](../../validators/account.ak#L100),
  [registers_stake_credential](../../lib/cardano_account_custody_contract/account.ak#L629)).
  Such an entry exists only when the stake script ran on the
  certificate.
- The control output holds only lovelace and the state NFT
  ([L104](../../validators/account.ak#L104)).
- The control output carries no reference script
  ([L109](../../validators/account.ak#L109)).
- The placement rule holds over the outputs
  ([L110](../../validators/account.ak#L110)).
- Field 0 of the control datum is 28 bytes long
  ([L111](../../validators/account.ak#L111)).
- The transaction withdraws from that hash
  ([L112](../../validators/account.ak#L112)). The logic it names then
  validates the initial state.

#### `mint` with `IssueGrants`

- The mint is not empty. The first name's 28 byte prefix selects the
  account ([L190](../../validators/account.ak#L190)).
- Every entry is a 32 byte grant token name of that account, in
  quantity 1 ([L193](../../validators/account.ak#L193),
  [mints_grants_of](../../lib/cardano_account_custody_contract/account.ak#L365)).
- The logic rule holds for that account
  ([L194](../../validators/account.ak#L194)).
- The placement rule holds over the outputs
  ([L119](../../validators/account.ak#L119)).

#### `mint` with `BurnGrants`

- The mint is not empty. The first name's prefix selects the account
  ([L190](../../validators/account.ak#L190)).
- Every entry is a 32 byte grant token name of that account, in
  quantity -1 ([L193](../../validators/account.ak#L193)).
- The logic rule holds for that account
  ([L194](../../validators/account.ak#L194)).

A 28 byte name is never a grant name. Only `CreateAccount` mints a state
NFT, and no redeemer burns one.

#### `spend`, every arm

- The spent UTxO's address has a script payment credential
  ([L132](../../validators/account.ak#L132)).
- Its stake credential is an inline script credential
  ([L133](../../validators/account.ak#L133),
  [stake_script_hash_of](../../lib/cardano_account_custody_contract/account.ak#L72)).
  A UTxO under the proxy with any other stake part belongs to no
  account and cannot be spent.

#### `spend` with `Fund`

- The spent UTxO holds no token under the proxy policy
  ([L136](../../validators/account.ak#L136)).
- With no datum, some input at the same account address holds a token
  of that account: its control UTxO or one of its grant UTxOs
  ([L138](../../validators/account.ak#L138),
  [has_account_token_input](../../lib/cardano_account_custody_contract/account.ak#L291)).
- With any datum, the account's control UTxO is among the inputs
  ([L144](../../validators/account.ak#L144),
  [has_control_input](../../lib/cardano_account_custody_contract/account.ak#L320)).

#### `spend` with `Device`, `SpendWithGrant` or `SweepGrant`

The three arms make the same checks
([L152](../../validators/account.ak#L152)). The logic tells them apart.

- The logic rule holds for the spent UTxO's account
  ([L153](../../validators/account.ak#L153)).
- If the spent UTxO holds any token under the proxy policy, the
  placement rule holds over the outputs
  ([L154](../../validators/account.ak#L154)).
- If the spent UTxO holds the account's state NFT, exactly one output
  holds that NFT. That output sits at the same address, holds only
  lovelace and the NFT, carries an inline datum and carries no
  reference script ([L158](../../validators/account.ak#L158),
  [keeps_control_output](../../lib/cardano_account_custody_contract/account.ak#L388)).
  The datum is not decoded.

#### `else`

Every other script purpose fails
([L174](../../validators/account.ak#L174)).

## Stake script: `account_stake`

Source: [validators/account_stake.ak](../../validators/account_stake.ak#L54).

### Purpose

The stake script gives each account its own address, reward account and
token names. It gates the account's creation, and it puts reward
withdrawals and delegation under the devices whatever logic the account
names.

### Parameters

| Parameter | Type | Why it exists |
| --- | --- | --- |
| `owner` | `VerificationKeyHash` | Makes the script, and so the address, unique to one key. The owner must sign the registration that creates the account and must be among its first devices. |
| `proxy_hash` | `ScriptHash` | Locates the account's state NFT, which is named after this script's hash under the proxy policy. |

The blueprint holds the unapplied script, whose hash is listed under
[scope](../security/README.md#scope). The hash of the script applied to
both parameters is the account's stake credential.

### Datum

None of its own. It reads field 1, `devices`, of the control datum by
position ([devices_of](../../lib/cardano_account_custody_contract/account.ak#L465)).
It reads nothing else of the state.

### Redeemers

[`StakeRedeemer`](datums-and-redeemers.md#stakeredeemer), whose only
constructor is `Operate`. Both handlers learn what they authorise from
the script context.

### Checks

#### Stake device rule

The stake device rule,
[`is_authorised_by_a_device`](../../lib/cardano_account_custody_contract/account.ak#L558),
holds when:

- A control UTxO of the account is among the reference inputs or the
  inputs. The first one found is used
  ([L565](../../lib/cardano_account_custody_contract/account.ak#L565)).
  Without one the rule fails.
- One of the devices in field 1 of its datum is among the required
  signers ([L570](../../lib/cardano_account_custody_contract/account.ak#L570)).

#### `withdraw`

- The credential is a script credential
  ([L56](../../validators/account_stake.ak#L56)).
- The [stake device rule](#stake-device-rule) holds ([L57](../../validators/account_stake.ak#L57)).
  This applies to a withdrawal of any amount, zero included.

#### `publish` with `RegisterCredential` or `RegisterAndDelegateCredential`

Both certificate kinds run
[`creates_the_account`](../../validators/account_stake.ak#L102)
([L62](../../validators/account_stake.ak#L62),
[L64](../../validators/account_stake.ak#L64)):

- `owner` is among the required signers
  ([L109](../../validators/account_stake.ak#L109)).
- The transaction mints exactly one state NFT named after the credential
  under `proxy_hash` ([L110](../../validators/account_stake.ak#L110)).
- Exactly one output is a control output of the account, and `owner` is
  in field 1 of its inline datum
  ([L132](../../validators/account_stake.ak#L132),
  [L137](../../validators/account_stake.ak#L137)).

A registration in the legacy certificate format needs no witness. The
ledger runs no script on it, the stake script included. Anyone who
knows the credential can register it that way without creating the
account. See
[Stake credential squat](../security/known-issues.md#stake-credential-squat).

#### `publish` with `DelegateCredential`

- The [stake device rule](#stake-device-rule) holds ([L68](../../validators/account_stake.ak#L68)).
  This covers delegation to a pool, to a DRep, or both.

#### `publish` with any other certificate

- Refused ([L70](../../validators/account_stake.ak#L70)). This includes
  deregistration, so the credential stays registered for the life of
  the account.

#### `else`

Every other script purpose fails
([L74](../../validators/account_stake.ak#L74)).

## Logic: `logic_v1`

Source: [validators/logic_v1.ak](../../validators/logic_v1.ak#L78). The
path functions it calls live in
[logic.ak](../../lib/cardano_account_custody_contract/logic.ak) and
[rules.ak](../../lib/cardano_account_custody_contract/rules.ak).

Every check in this section is a rule of `logic_v1`. It holds only while
an account names `logic_v1`.

### Purpose

The logic holds the account's rules beyond the proxy's. The proxy
requires a withdrawal from the logic credential, so the ledger runs the
logic once with the whole transaction as context. The logic reads the
proxy redeemers back from the transaction and validates device
signatures, grant scopes, issuance, sweeps and the state written back.

### Parameters

| Parameter | Type | Why it exists |
| --- | --- | --- |
| `proxy_hash` | `ScriptHash` | Identifies the account addresses, the state NFTs and the token policy the logic governs. |

The applied hash is the [logic credential](../glossary.md#logic-credential)
that a control datum names in field 0. The unapplied hash and the hash
applied to the proxy hash are listed under
[scope](../security/README.md#scope).

### Datum

None of its own. It decodes the control datum as
[`AccountState`](datums-and-redeemers.md#accountstate) and a grant
UTxO's datum as [`Grant`](datums-and-redeemers.md#grant). A sweep and an
upgrade read only the [stable prefix](datums-and-redeemers.md#stable-prefix).

### Redeemers

[`LogicRedeemer`](datums-and-redeemers.md#logicredeemer), whose only
constructor is `Run`. The logic reads the proxy's `AccountRedeemer` and
`MintRedeemer` entries from the transaction's redeemers.

### Checks

#### `withdraw`: dispatch

- The credential is a script credential. Its hash is the logic's own
  hash ([L80](../../validators/logic_v1.ak#L80)).
- The logic filters the inputs and the reference inputs for control
  UTxOs that name it ([L84](../../validators/logic_v1.ak#L84)).
- Exactly one among the inputs and none among the reference inputs: the
  [owner path](#owner-path) ([L90](../../validators/logic_v1.ak#L90)).
- None among the inputs and exactly one among the reference inputs: the
  [agent path](#agent-path) ([L92](../../validators/logic_v1.ak#L92)).
- None in either: the [arrival](#arrival)
  ([L99](../../validators/logic_v1.ak#L99)).
- Anything else is refused ([L100](../../validators/logic_v1.ak#L100)).
  `logic_v1` accepts one account that names it per transaction.

#### Owner path

[`validates_owner_transaction`](../../lib/cardano_account_custody_contract/logic.ak#L113),
over the spent control UTxO and its state:

- The control UTxO's proxy redeemer is `Device`
  ([L123](../../lib/cardano_account_custody_contract/logic.ak#L123)).
- Every output that is a control output naming this logic sits at the
  spent account's address
  ([L124](../../lib/cardano_account_custody_contract/logic.ak#L124)).
- If anything is minted under the policy, the mint redeemer is
  `IssueGrants` and the [issue rule](#issue-rule) holds, or it is
  `BurnGrants` and the [burn rule](#burn-rule) holds. `CreateAccount` is
  refused ([L134](../../lib/cardano_account_custody_contract/logic.ak#L134)).
- Every input at the account address spent under a proxy redeemer other
  than `Fund` passes the rule of its redeemer
  ([L156](../../lib/cardano_account_custody_contract/logic.ak#L156)):
  `Device` the [device rule](#device-rule), `SweepGrant` the
  [sweep rule](#sweep-rule). `SpendWithGrant` is refused
  ([L172](../../lib/cardano_account_custody_contract/logic.ak#L172)).
  `Fund` is left to the proxy.

The walk over the redeemers is
[`validates_spends`](../../lib/cardano_account_custody_contract/logic.ak#L226).
It skips redeemers that do not decode as `AccountRedeemer`, and inputs
at other addresses.

#### Device rule

[`device_rule`](../../lib/cardano_account_custody_contract/rules.ak#L42),
on an input spent with `Device`, against the spent state:

- The input holds the account's state NFT
  ([L51](../../lib/cardano_account_custody_contract/rules.ak#L51)).
- A device of the spent state is among the required signers
  ([L52](../../lib/cardano_account_custody_contract/rules.ak#L52)).
- The placement rule holds over the inputs and over the outputs
  ([L53](../../lib/cardano_account_custody_contract/rules.ak#L53),
  [L57](../../lib/cardano_account_custody_contract/rules.ak#L57)).
- Exactly one output is a control output of the account
  ([L233](../../lib/cardano_account_custody_contract/rules.ak#L233)), and
  [`recreates_control_output`](../../lib/cardano_account_custody_contract/rules.ak#L226)
  holds for it:
  - If its field 0 names this logic
    ([L240](../../lib/cardano_account_custody_contract/rules.ak#L240)):
    it holds only lovelace and the state NFT
    ([L248](../../lib/cardano_account_custody_contract/rules.ak#L248)),
    its state is a well formed `AccountState`
    ([L253](../../lib/cardano_account_custody_contract/rules.ak#L253)),
    the generation does not decrease
    ([L254](../../lib/cardano_account_custody_contract/rules.ak#L254)),
    `next_slot` grows by the grant tokens minted
    ([L255](../../lib/cardano_account_custody_contract/rules.ak#L255)),
    and `outstanding` moves by those minted minus those burned
    ([L256](../../lib/cardano_account_custody_contract/rules.ak#L256)).
    The mint count comes from
    [`grant_mint_delta`](../../lib/cardano_account_custody_contract/account.ak#L422).
  - If it names another logic, the account is leaving
    ([L258](../../lib/cardano_account_custody_contract/rules.ak#L258)):
    the transaction withdraws from that logic
    ([L260](../../lib/cardano_account_custody_contract/rules.ak#L260)),
    and nothing is minted under the policy
    ([L261](../../lib/cardano_account_custody_contract/rules.ak#L261)).
    `logic_v1` reads nothing else of the new state. The arriving logic
    validates it.

The devices, the revoked list and the generation, upward only, are
otherwise free. A device can add or remove devices, revoke or restore a
slot, and raise the generation in one rewrite.

#### Issue rule

[`issue_grants_rule`](../../lib/cardano_account_custody_contract/rules.ak#L159),
over the minted entries in ledger order, against the spent state:

- Exactly one control output of the account exists. Its state gives the
  generation of the new grants
  ([L166](../../lib/cardano_account_custody_contract/rules.ak#L166)).
- A device of the spent state signs
  ([L173](../../lib/cardano_account_custody_contract/rules.ak#L173)).
- The entry at index `i` passes
  [`issues_grant`](../../lib/cardano_account_custody_contract/rules.ak#L271)
  for slot `next_slot + i`
  ([L174](../../lib/cardano_account_custody_contract/rules.ak#L174)):
  - Exactly one output holds one of the token
    ([L280](../../lib/cardano_account_custody_contract/rules.ak#L280)).
  - The quantity minted is 1
    ([L287](../../lib/cardano_account_custody_contract/rules.ak#L287)).
  - The name is the grant token name of that slot
    ([L288](../../lib/cardano_account_custody_contract/rules.ak#L288)).
    A slot that does not fit 4 bytes fails.
  - The output sits at the account address
    ([L289](../../lib/cardano_account_custody_contract/rules.ak#L289)).
  - It holds only lovelace and the token
    ([L293](../../lib/cardano_account_custody_contract/rules.ak#L293)).
  - It carries no reference script
    ([L294](../../lib/cardano_account_custody_contract/rules.ak#L294)).
  - Its inline datum decodes as a `Grant`
    ([L285](../../lib/cardano_account_custody_contract/rules.ak#L285)),
    with that slot
    ([L295](../../lib/cardano_account_custody_contract/rules.ak#L295)),
    the new control state's generation
    ([L296](../../lib/cardano_account_custody_contract/rules.ak#L296)),
    and a well formed scope
    ([L297](../../lib/cardano_account_custody_contract/rules.ak#L297),
    [is_scope_well_formed](../../lib/cardano_account_custody_contract/state.ak#L47)).

The ledger sorts the mint by name, and a grant token name ends in its
slot as big endian bytes. The minted slots are therefore exactly the
next ones, consecutive and in order. The rule reads no field of the new
grant beyond its slot, generation and scope, so any key can be the
grantee.

#### Burn rule

[`burn_grants_rule`](../../lib/cardano_account_custody_contract/rules.ak#L194),
against the spent state:

- A device of the spent state signs
  ([L201](../../lib/cardano_account_custody_contract/rules.ak#L201)).
- Every entry is a grant token name of the account in quantity -1
  ([L202](../../lib/cardano_account_custody_contract/rules.ak#L202)).

#### Sweep rule

[`sweep_rule`](../../lib/cardano_account_custody_contract/rules.ak#L127),
on an input spent with `SweepGrant`, against the spent control state:

- The slot is read from field 0 of the inline datum
  ([L135](../../lib/cardano_account_custody_contract/rules.ak#L135)).
- The input holds only lovelace and the grant token of that slot
  ([L137](../../lib/cardano_account_custody_contract/rules.ak#L137)).
- A device of the spent state signs
  ([L143](../../lib/cardano_account_custody_contract/rules.ak#L143)).
- The grant is dead
  ([L144](../../lib/cardano_account_custody_contract/rules.ak#L144),
  [is_dead](../../lib/cardano_account_custody_contract/grant.ak#L71)).
  One of these holds:
  - Its generation, field 2, is lower than the state's
    ([L77](../../lib/cardano_account_custody_contract/grant.ak#L77)).
  - Its slot is in the state's revoked list
    ([L78](../../lib/cardano_account_custody_contract/grant.ak#L78)).
  - The datum decodes as a full `Grant`, and the validity range has a
    finite lower bound later than `expires_at`
    ([L79](../../lib/cardano_account_custody_contract/grant.ak#L79),
    [starts_after_expiry](../../lib/cardano_account_custody_contract/grant.ak#L54)).
- The transaction burns exactly one of that grant token
  ([L145](../../lib/cardano_account_custody_contract/rules.ak#L145)).

Deadness is judged against the state the spent control UTxO holds, not
the state written back.

#### Agent path

[`validates_agent_transaction`](../../lib/cardano_account_custody_contract/logic.ak#L185),
over the referenced control UTxO and its state:

- Nothing is minted under the policy
  ([L195](../../lib/cardano_account_custody_contract/logic.ak#L195)).
- No output is a control output naming this logic
  ([L196](../../lib/cardano_account_custody_contract/logic.ak#L196)).
- Every input at the account address spent under a proxy redeemer other
  than `Fund` carries `SpendWithGrant` and passes the
  [grant spend rule](#grant-spend-rule)
  ([L200](../../lib/cardano_account_custody_contract/logic.ak#L200)).
  `Device` and `SweepGrant` are refused
  ([L213](../../lib/cardano_account_custody_contract/logic.ak#L213)).

#### Grant spend rule

[`grant_spend_rule`](../../lib/cardano_account_custody_contract/rules.ak#L77),
on an input spent with `SpendWithGrant`, against the referenced control
state. It takes the [leaving value](../glossary.md#leaving-value) at
the account address
([L86](../../lib/cardano_account_custody_contract/rules.ak#L86),
[leaving_value](../../lib/cardano_account_custody_contract/grant.ak#L99)).

- The input's inline datum decodes as a full `Grant`
  ([L84](../../lib/cardano_account_custody_contract/rules.ak#L84),
  [grant_datum](../../lib/cardano_account_custody_contract/account.ak#L504)).
  A grant of another shape cannot be spent under `logic_v1`.
- Exactly one output holds one of the grant token
  ([L87](../../lib/cardano_account_custody_contract/rules.ak#L87)).
- The input holds only lovelace and the grant token of the slot in its
  datum ([L94](../../lib/cardano_account_custody_contract/rules.ak#L94)).
- It is the only input that holds a token of the account
  ([L100](../../lib/cardano_account_custody_contract/rules.ak#L100)).
  The control UTxO and other grant UTxOs cannot be spent beside it.
- The grant is current: its generation equals the state's, and its slot
  is not revoked
  ([L101](../../lib/cardano_account_custody_contract/rules.ak#L101),
  [is_current](../../lib/cardano_account_custody_contract/grant.ak#L90)).
- The grantee is among the required signers
  ([L102](../../lib/cardano_account_custody_contract/rules.ak#L102)).
- The validity range has a finite upper bound no later than
  `expires_at`
  ([L103](../../lib/cardano_account_custody_contract/rules.ak#L103),
  [ends_before_expiry](../../lib/cardano_account_custody_contract/grant.ak#L41)).
- The leaving value stays within the scope
  ([L104](../../lib/cardano_account_custody_contract/rules.ak#L104),
  [stays_within_scope](../../lib/cardano_account_custody_contract/grant.ak#L137)):
  - The net outflow of the scoped asset is at most `per_call_cap` and
    at most `cap`.
  - For a token scope, the net outflow of lovelace is at most
    `lovelace_per_call_cap` and at most `lovelace_cap`.
  - No other asset class has a net outflow
    ([nothing_else_leaves](../../lib/cardano_account_custody_contract/grant.ak#L156)).
- With a non empty recipient list, every output is at the account
  address or at a listed recipient
  ([L105](../../lib/cardano_account_custody_contract/rules.ak#L105),
  [pays_only_recipients](../../lib/cardano_account_custody_contract/grant.ak#L169)).
  Change outside the account must go to a recipient too.
- Every output to the account address that holds no account token has
  no datum and no reference script
  ([L106](../../lib/cardano_account_custody_contract/rules.ak#L106),
  [deposits_are_plain](../../lib/cardano_account_custody_contract/grant.ak#L185)).
- The placement rule holds over the inputs and over the outputs
  ([L107](../../lib/cardano_account_custody_contract/rules.ak#L107),
  [L111](../../lib/cardano_account_custody_contract/rules.ak#L111)).
- The grant output sits at the same address
  ([L112](../../lib/cardano_account_custody_contract/rules.ak#L112)) and
  holds exactly the value the grant UTxO held
  ([L113](../../lib/cardano_account_custody_contract/rules.ak#L113)).
- Its inline datum is the spent grant with only `cap` and
  `lovelace_cap` changed
  ([L114](../../lib/cardano_account_custody_contract/rules.ak#L114),
  [carries_grant_within](../../lib/cardano_account_custody_contract/grant.ak#L242)).
  Each new cap is at least zero and at most the old cap minus the net
  outflow of its asset
  ([scope_after_spend](../../lib/cardano_account_custody_contract/grant.ak#L221)).
  For a lovelace scope, `lovelace_cap` stays as it was.
- The grant output carries no reference script
  ([L115](../../lib/cardano_account_custody_contract/rules.ak#L115)).
- Nothing is minted under the policy
  ([L116](../../lib/cardano_account_custody_contract/rules.ak#L116)).

#### Arrival

[`validates_arrival`](../../lib/cardano_account_custody_contract/logic.ak#L265):

- Exactly one output is a control output naming this logic
  ([L270](../../lib/cardano_account_custody_contract/logic.ak#L270)).
  Its stake credential selects the account.
- It holds only lovelace and the state NFT
  ([L277](../../lib/cardano_account_custody_contract/logic.ak#L277)).
- Its state is a well formed `AccountState`
  ([L282](../../lib/cardano_account_custody_contract/logic.ak#L282),
  [is_well_formed](../../lib/cardano_account_custody_contract/state.ak#L74)).
- Without a control UTxO of that account among the inputs, this is a
  creation ([L295](../../lib/cardano_account_custody_contract/logic.ak#L295)):
  - The mint under the policy is exactly the account's state NFT, in
    quantity 1 ([L296](../../lib/cardano_account_custody_contract/logic.ak#L296)).
  - `next_slot` and `outstanding` are zero and the revoked list is empty
    ([L299](../../lib/cardano_account_custody_contract/logic.ak#L299),
    [has_zero_counters](../../lib/cardano_account_custody_contract/state.ak#L90)).
    The generation may be any non negative value.
- With a control UTxO of that account among the inputs, this is an
  upgrade into `logic_v1`
  ([L286](../../lib/cardano_account_custody_contract/logic.ak#L286)).
  The leaving state is read by position only:
  - The transaction withdraws from the logic named in field 0 of the
    leaving state ([L289](../../lib/cardano_account_custody_contract/logic.ak#L289)).
  - The new generation is strictly greater than field 2 of the leaving
    state ([L290](../../lib/cardano_account_custody_contract/logic.ak#L290)).
    Every grant issued under the leaving state's generation or an older
    one is therefore dead under `logic_v1`.
  - The new device list equals field 1 of the leaving state, in the same
    order ([L291](../../lib/cardano_account_custody_contract/logic.ak#L291)).
  - Nothing is minted under the policy
    ([L292](../../lib/cardano_account_custody_contract/logic.ak#L292)).

The arrival does not check a signature. At creation the stake script
requires the owner's. At an upgrade the leaving logic decides.

#### `publish`

- A `RegisterCredential` of a script credential is accepted from anyone
  ([L74](../../lib/cardano_account_custody_contract/logic.ak#L74)).
- Every other certificate is refused
  ([L75](../../lib/cardano_account_custody_contract/logic.ak#L75)). The
  logic credential can never be deregistered.

#### `else`

Every other script purpose fails
([L112](../../validators/logic_v1.ak#L112)).
