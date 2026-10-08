# Security review

An adversarial review of the account proxy, the first logic version and
the account stake validator, organised by the vulnerability classes of
the Cardano developer portal's smart contract security curriculum, with
one class added for the split between the proxy and the logic. Every
class was attacked with concrete transactions written as Aiken tests in
`validators/attacks.test.ak`; each `attack_` test asserts that a
validator refuses the transaction. The document only claims what those
tests and the reasoning below establish.

## Scope and versions

- Validators: `validators/account.ak`, the account proxy, a multi
  purpose validator with no parameters, with the mint handler
  (`CreateAccount`, `IssueGrants`, `BurnGrants`) and the spend handler
  (`Device`, `SpendWithGrant`, `SweepGrant`, `Fund`), script hash
  `ed61963ac94d12c0b320be5a336c36af66bc02c380e0aa3001899253` in
  `plutus.json`; `validators/logic_v1.ak`, the first logic version, a
  validator parameterised by the proxy hash with the `withdraw` and
  `publish` handlers, whose blueprint entry (hash
  `7cf7daa6c0a5825e23a9dadece990d5a602fa1508d01f061eacaed52`) is the
  unapplied code and whose applied hash, the logic credential every
  account on this version names, is
  `2cd68e398bdf9fbc8d257614b54403451ee722520ec785fe14f8df5a`; and
  `validators/account_stake.ak`, the parameterised stake validator with
  the `withdraw` and `publish` handlers, whose blueprint entry (hash
  `edcfa41389b7b924916ad7408cd2d0f75a7a3dae8717f9bbf1a668c6`) is the
  unapplied code, so every account's stake credential is the hash of
  that code applied to its `owner` and `proxy_hash`.
- Libraries:
  `lib/cardano_account_custody_contract/{types,state,account,grant,rules}.ak`.
  `rules.ak` holds the path rules of logic v1; `account.ak` the helpers
  the proxy, the stake script and the logic share.
- Toolchain: Aiken v1.1.24, Plutus V3, aiken-lang/stdlib v4.0.0,
  aiken-lang/fuzz v3.0.0.
- Tests: 2354 checks under `aiken check -D`, from 869 tests of which 15
  are property tests run 100 times each. `validators/attacks.test.ak`
  holds 170 of the tests: 110 `attack_` tests and 60 `budget_` tests, of
  which 16 are baselines and one bounds the datum size.
  `validators/logic_v1.test.ak` holds 218, the functional suite of the
  logic over the whole transaction; `validators/account.test.ak` 104,
  the proxy's; `validators/account_stake.test.ak` 40, the stake
  script's; the `lib/**/*.test.ak` files hold the remaining 337 (166 for
  `account.ak` including 3 property tests, 89 for `grant.ak` including
  12 property tests over the cap arithmetic, the time rules and the
  token names, 31 for `rules.ak`, 31 for `state.ak`, 20 for the test
  helpers). Functional tests are cited below where they already cover an
  attack variant.
- Out of scope: the off-chain transaction builder, key management, the
  signer's list of known logic hashes, the sponsor service, the network
  setup that registers the logic credential and parks the reference
  scripts, and the ledger rules the validators rely on (balance,
  witnesses, datum availability, validity interval enforcement, single
  registration of a stake credential, which script runs on which
  certificate or withdrawal, one redeemer per mint policy per
  transaction). Those rules are named where a mitigation depends on them.

Conventions for the tests: an `attack_` test asserts `!handler(...)`
when the handler returns False, and is declared `fail` when the handler
aborts on an `expect`. Both outcomes make the ledger reject the
transaction in phase two. The `!handler` form is preferred and used
wherever the attack reaches a returned False. The wrappers in
`validators/attacks.test.ak` call the handlers with the fixtures' proxy
hash, stake credential and owner key: `proxy_spend`, `proxy_spend_grant`
and `proxy_mint` run the proxy; `run` runs logic v1 under the hash the
fixtures' control datum names and `run_as` runs the same code under
another credential, which is how a next version is played; `register`,
`withdraw` and `delegate` run the stake script. The upgrade tests
therefore prove the handover between two instances of logic v1 under
different credentials; a later version brings its own arrival branch and
its own tests.

## Threat model

Keys and who holds them:

- The owner key, the verification key hash the account's stake script is
  applied to. In the intended deployment it is the first device, derived
  from a passkey. On its own it authorises exactly one thing: publishing
  the registration of the account's stake credential, which is the act of
  creation, and only together with the mint of the state NFT and a
  control output that lists the owner as a device. After creation it has
  no authority beyond its place in `AccountState.devices`, from which a
  device rewrite may remove it.
- Device keys (`AccountState.devices`, up to eight under logic v1). Held
  by the owner. Any one device key has full authority: it can spend
  every deposit and reserve, rewrite the state (add or remove devices,
  revoke one slot or every grant), issue grants into new grant UTxOs,
  sweep dead grant UTxOs, withdraw the account's staking rewards,
  delegate its stake credential and point the account at another logic.
  Nothing bounds a device spend except well formedness of the new state,
  counters that follow the grant tokens minted and burned, and, on an
  upgrade, the rules of the logic the account arrives at.
- Grantee keys (`Grant.grantee`). An Ed25519 key hash held by an agent or
  by a custody service on its behalf. A grantee can spend only within its
  grant's scope: the per call cap and the remaining cap of one asset, the
  lovelace per call cap and the remaining lovelace cap when that asset is
  not lovelace, nothing of any other asset, before the expiry, only to the
  listed recipients when the list is non empty, only while the referenced
  control UTxO carries the grant's generation without its slot revoked,
  and only by recreating its own grant UTxO with its remaining caps
  reduced. A grantee cannot change devices, grants or the logic, cannot
  withdraw rewards or delegate, cannot spend the control UTxO, a reserve
  or another grant UTxO, cannot mint or burn, and cannot create a control
  UTxO.
- A sponsor, a wallet that pays the fee, the collateral, the registration
  deposit and the control output's lovelace in place of the account or
  the device wallet. It holds no authority: every path still needs one of
  the keys above, and the sponsor only sees a transaction it could not
  alter without invalidating those signatures.
- A dApp or transaction builder with no key. It can assemble and submit
  transactions, add inputs from its own wallet and choose which deposits
  of the account to include, but every path needs one of the keys above,
  and a creation it assembles cannot leave the owner out of the device
  list.
- The logic a control datum names. It is code, not a key: the proxy runs
  it on every spend but a plain fund spend and every mint but a creation,
  and leaves it every rule it does not keep itself. The proxy admits any
  28 byte hash whose credential withdraws, so a device that signs an
  upgrade to an unknown hash hands the account to that code; the signer's
  list of known logic hashes is the gate against it, outside this
  review. What a logic can never do, whatever it approves, is bounded by
  the proxy and listed below; what logic v1 does is the rest of this
  document.

There is no stake key: the account's stake credential is the hash of its
own stake script, and the only authority over the reward account and the
certificates is the device rule the script enforces. There is no
deletion: no redeemer burns the state NFT and the stake script refuses
every deregistration, so the account, its credential and its control UTxO
are permanent. The logic credential is permanent too: `logic_v1.publish`
accepts the registration of a script credential and refuses every other
certificate.

Single registration. The ledger registers a stake credential at most once
and refuses a second registration while it is registered. `CreateAccount`
requires a publish redeemer for a certificate registering the account's
credential, which exists only when the stake script ran on that
certificate and checked the owner's signature, the mint and the device
list. While the account exists the credential is registered, the stake
script refuses to deregister it, and so no transaction can carry the
registration a second `CreateAccount` would need. A parallel control UTxO
is therefore impossible for anyone, the owner key included, and the
proxy never has to prove a negative about its own tokens.

The properties the proxy enforces, whatever logic any account runs:

- Naming and quantity. A state NFT name is 28 bytes, a grant token name
  32: the account's stake script hash followed by the slot as four big
  endian bytes (`account.grant_token_name`, `is_state_nft_name`,
  `is_grant_name`). `CreateAccount` mints exactly one 28 byte name in
  quantity one; `IssueGrants` and `BurnGrants` admit only 32 byte names
  prefixed by one account, in quantity one and minus one
  (`account.mints_grants_of`). No redeemer burns a 28 byte name.
- Placement. A state NFT named N only ever sits at the account address of
  N (payment script plus stake script N), in exactly one control UTxO,
  and a grant token prefixed by N only ever sits at that same address, in
  quantity one (`account.tokens_sit_at_their_own_addresses`, checked on
  the outputs of every creation and issuance and on the outputs of every
  spend of a UTxO holding a token of the policy). When the state NFT is
  spent, the control output is found by the NFT and pinned
  (`account.keeps_control_output`): one holder, at the same address,
  lovelace and the NFT alone, an inline datum, no reference script.
- The logic named runs. Every spend but a plain `Fund` and every mint but
  `CreateAccount` requires the control UTxO of the account present
  exactly once among the inputs and the reference inputs
  (`account.find_present_control`) and a withdrawal from the hash in the
  first field of its datum (`account.logic_of`, `account.withdraws_from`).
  At creation the control output's first field must be a 28 byte script
  hash and the transaction must withdraw from it.
- `Fund`. A UTxO holding no account token rides on an account token of
  its own account among the inputs, at its own full address
  (`account.has_account_token_input`), and under any datum on the control
  UTxO spent (`account.has_control_input`).
- Single creation, as above.

The properties logic v1 enforces for its accounts:

- One account per transaction. The logic finds the control UTxOs naming
  it among the inputs and the reference inputs and accepts exactly one,
  spent or referenced, or none for an arrival; two are refused.
- Agent confinement. A grant spend runs on a grant UTxO holding only
  lovelace and its token, which must be the only input holding an account
  token (`grant.spends_one_account_token`); the control UTxO is
  referenced, which is the logic's agent arm; every other input at the
  address is a plain deposit, since a deposit with a datum needs the
  control UTxO spent (`Fund` on the proxy). An agent spend therefore never
  spends the control UTxO, a reserve or another grant UTxO.
- Revocation kills. A grant spend requires `grant.is_current` against the
  referenced control state: the same generation and a slot outside the
  revoked list. A revoke rewrites the control UTxO, so every spend built
  against the previous control UTxO loses its reference input, and every
  spend built against the new one finds the grant dead. An upgrade bumps
  the generation and kills every grant the same way.
- Owner liveness. A revoke or a generation bump is one `Device` spend of
  the control UTxO; with its fee drawn from a reserve or paid by a
  sponsor it shares no UTxO with any agent transaction. A sweep is judged
  against the state the spent control UTxO held, so a revoke and the
  sweep of the grant it kills are two transactions, and `IssueGrants` and
  `BurnGrants` cannot share a transaction since the mint handler runs
  once per policy with one redeemer; an owner at the outstanding bound
  who bumps the generation sweeps the dead grants before reissuing the
  survivors. None of that delays the revoke itself.
- No stranded value. The counters follow the mint field
  (`account.grant_mint_delta`), a dead grant UTxO is swept by a device
  with its token burned and its lovelace freed, and a grant output must
  hold exactly the value the grant UTxO held, so a grant UTxO neither
  drains nor accumulates value through agent spends. The sweep reads the
  grant through the stable prefix of its datum (`account.grant_slot_of`,
  `account.grant_generation_of`), so a grant of another datum shape is
  swept once its generation is older than the control's or its slot is
  revoked; expiry counts only when the datum decodes as a full `Grant`
  (`grant.is_dead`).
- The upgrade path. Only a device changes the logic: the control UTxO is
  spent under `Device`, which needs a device signature, and a grantee
  never spends it. A stranger with both logics running and no device
  signature is refused. The logic the account leaves requires the
  arriving one to run and nothing minted; the logic the account arrives
  at validates the arrival in every arm: on its owner path every control
  output naming it sits at the spent account's address, on its agent
  path no control output names it, and on its arrival arm exactly one
  does, well formed, with the generation past the one left, the devices
  equal and nothing minted. Every grant issued before is dead and is
  reissued, never migrated.

## Double satisfaction

Attack. Two accounts grant the same agent under open recipient lists and
the agent spends through both at once, returning each deposit 2 ADA
short. One 2 ADA output to the recipient is offered as the payout of both
spends and recorded against the first account's grant only, the other
2 ADA riding out to the attacker, which an open list allows. A second
variant takes 2 ADA out of the first account for the recipient and puts
2 ADA of the agent's own into the second, so that across the two
accounts, which share the payment script, nothing leaves, and hands both
grants back unchanged. A third spends a deposit of account B with `Fund`
while only account A's control UTxO, or a grant UTxO of account A, is in
the transaction.

Mitigation. The grant accounting never matches outputs against a claim:
`grant.leaving_value` sums every input at the account's full address,
stake part included, and subtracts every output paid back to it, so each
account's logic sees its own net outflow whatever the other outputs
are, and `grant.carries_grant_within` requires the grant output to
record that outflow: its remaining caps may sit anywhere from zero up to
the spent caps less the net outflow of each asset, never above. A grant
handed back unchanged beside a positive outflow fails that rule alone.
Any surplus has to appear in an output, which `grant.pays_only_recipients`
refuses when it is not a listed recipient, or in the fee, which still
counts as leaving. The two accounts of these tests run under different
logic credentials, since one logic refuses two control UTxOs naming it;
each finds its own control UTxO and nets its own address. `Fund` looks
for an account token of the deposit's own stake credential
(`account.has_account_token_input` with no datum,
`account.has_control_input` with one), so another account's control or
grant UTxO never authorises it.

Tests. `attack_double_satisfaction_one_recipient_output_for_two_accounts`:
the first account's logic passes, since its grant records the 2 ADA
that left it, and the second's returns False on the cap rule, since
2 ADA left it against an unchanged grant.
`attack_double_satisfaction_a_deposit_into_another_account_offsets_the_outflow`:
the second account's logic sees a net deposit and passes, the first's
returns False on the cap rule.
`attack_double_satisfaction_fund_of_another_account_rides_on_this_control`
and `attack_double_satisfaction_fund_of_another_account_rides_on_this_grant`
(`!`). The companions are
`spend_with_grant_accepts_two_accounts_under_different_logics` and
`spend_with_grant_rejects_two_accounts_under_one_logic_in_one_transaction`
in `validators/logic_v1.test.ak`, and
`fund_rejects_the_control_utxo_of_another_account` and
`fund_rejects_a_grant_utxo_of_another_account` in
`validators/account.test.ak`.

## Missing UTxO authentication

Attack. A deposit at the account address carries an inline state naming
the attacker as the only device and is spent on the owner path; a deposit
carries a grant datum with a huge cap, without the grant token or beside
the real grant UTxO, and is spent on the agent path. Other variants: the
control UTxO is only a reference input of a fund spend; a token of
another policy named after the stake credential poses as the state NFT,
or one named like a grant token poses as a grant token; the mint handler
is asked to burn an NFT or a grant token whose input sits at a key
address.

Mitigation. The control UTxO and the grant UTxOs are identified by their
tokens, not by their datums. The proxy looks for the control UTxO by the
state NFT at the account address under an inline datum
(`account.find_present_control`) and refuses before any logic runs when
none is present; the logic finds its control UTxOs the same way
(`is_own_control`). `rules.device_rule` requires `account.holds_state_nft`
on the spent input, and `rules.grant_spend_rule` and `rules.sweep_rule`
require `account.holds_only_lovelace_and_grant_token` of the datum's
slot, with the policy id equal to the proxy's own hash. `Fund` requires
an account token among `inputs`, where the ledger runs its handler, never
among `reference_inputs`. The mint handler refuses every burn but a
`BurnGrants` of grant names with the control UTxO of that account
present, and the placement rule refuses a token of the account at a key
address among the inputs of a device spend. The stake script's device
rule (`account.is_authorised_by_a_device`, through
`account.find_control_input`) accepts a control UTxO from the inputs or
the reference inputs, since it only reads the device list, and
recognises it by the state NFT of its own account at its own address; a
grant UTxO does not pass for it. The tokens cannot be forged (see token
forgery) and by the placement invariant never sit at a key address.

Tests.
`attack_missing_utxo_authentication_forged_control_without_the_nft_device`
(`!`, the proxy finds no control UTxO),
`attack_missing_utxo_authentication_forged_grant_without_the_token`
(`fail`: the token is in no input, so no single grant output of its slot
exists and the logic aborts),
`attack_missing_utxo_authentication_forged_grant_beside_the_real_one`
(`!`),
`attack_missing_utxo_authentication_fund_with_the_control_as_a_reference_input`
(`!`), `attack_missing_utxo_authentication_lookalike_nft_from_another_policy`
(`!`),
`attack_missing_utxo_authentication_lookalike_grant_token_from_another_policy`
(`!`), `attack_missing_utxo_authentication_burn_with_the_nft_at_a_key_address`
(`!`),
`attack_missing_utxo_authentication_burn_grants_with_the_nft_at_a_key_address`
(`!`, the account the name denotes has no control UTxO present). For the
stake script: `withdraw_rejects_a_deposit_posing_as_the_control`,
`withdraw_rejects_a_control_that_lacks_the_state_nft`,
`withdraw_rejects_a_grant_utxo_posing_as_the_control`,
`withdraw_rejects_another_accounts_control`,
`publish_rejects_a_delegation_over_a_grant_utxo` and
`publish_rejects_a_delegation_over_another_accounts_control` (all `fail`,
since the device rule aborts when no control UTxO of the account is
found) in `validators/account_stake.test.ak`.

## Datum hijacking

Attack. A grant spend recreates its grant UTxO with a raised cap, a
later generation, another grantee, or at another account's address, or
gives the grant by hash; a device rewrite stores a state padded with an
extra constructor field; an issuance writes a padded grant datum.

Mitigation. On the agent path `grant.carries_grant_within` decodes the
grant output's inline datum and compares it with
`grant.grant_after_spend` applied to the spent grant: slot, grantee,
generation, asset, per call caps, expiry and recipients must be equal,
and the remaining caps may only sit between zero and the expected
reduction. `account.find_grant_output` locates the single output holding
the grant token, and the rule requires that output at the spent
input's own address with the same value. `account.state_datum`,
`account.grant_datum` and the `expect` in `rules.issues_grant` decode
datums strictly, so a datum with trailing fields aborts under logic v1
on the owner path, the agent path and at issuance. The sweep is the one
rule that reads a grant positionally, by its stable prefix, so that a
grant of another shape can be swept once dead; a padded grant datum
therefore dies and is swept like any other and is never spent. The
proxy reads only the first field of a control datum and the stake
script only the second, so the shape after the stable prefix is each
logic's own; a control output naming another logic is that logic's to
decode (see Logic substitution).

Tests. `attack_datum_hijacking_grant_spend_raises_its_own_cap` (`!`),
`attack_datum_hijacking_grant_spend_advances_its_own_generation` (`!`),
`attack_datum_hijacking_grant_spend_rewrites_its_grantee` (`!`),
`attack_datum_hijacking_grant_spend_relocates_the_grant_to_another_account_address`
(`!`), `attack_datum_hijacking_grant_spend_grant_datum_given_by_hash`
(`!`), `attack_datum_hijacking_padded_state_datum_on_a_device_rewrite`
(`fail`), `attack_datum_hijacking_padded_grant_datum_at_issuance`
(`fail`). Functional companions in `validators/logic_v1.test.ak`:
`spend_with_grant_rejects_a_changed_generation`,
`spend_with_grant_rejects_a_changed_grantee`,
`spend_with_grant_rejects_a_changed_slot_in_the_datum`,
`spend_with_grant_rejects_a_changed_per_call_cap`,
`spend_with_grant_rejects_a_changed_expiry`,
`spend_with_grant_rejects_changed_recipients`,
`spend_with_grant_rejects_the_grant_output_at_another_accounts_address`,
`sweep_grant_burns_a_grant_of_another_shape_under_an_older_generation`,
`sweep_grant_burns_a_revoked_grant_of_another_shape`,
`sweep_grant_rejects_an_expired_grant_of_another_shape`;
`device_accepts_a_control_output_with_a_datum_of_any_shape` and
`spend_rejects_a_control_whose_datum_has_no_logic_field` in
`validators/account.test.ak`; and the `carries_grant_within_*` and
`is_dead_*` unit tests in
`lib/cardano_account_custody_contract/grant.test.ak` with the
`grant_slot_of_*` and `grant_generation_of_*` tests in
`lib/cardano_account_custody_contract/account.test.ak`.

The datum hijacking of the account's own deposits, where a grant spend
returned the balance to the account address under a datum hash, is the
finding recorded under Locked value.

## Token forgery and other token names

Attack. Create an account at the victim's address, under the attacker's
device, with only the attacker's signature; sign the creation as the
owner but leave the owner out of the device list; mint an NFT named after
the attacker's credential into the victim's address; mint a second state
NFT, or a grant token, during a grant spend; issue grants over a
referenced control UTxO, with the grantee's signature, named after
another account, reusing an issued slot, or without moving the counters;
create the control output at an address whose stake part is a
verification key credential with the stake credential's bytes; park a
token of another policy named after the stake credential on the control
output; mint a parallel control UTxO for an existing account with a
device signature but no registration; the same with a registration
listed among the certificates in the legacy format, which runs no
script; mint a state NFT name under `IssueGrants`.

Then the attacks of an attacker who owns an account under a logic of
their own that approves anything: mint a grant token of the victim's
account beside their own, into a forged grant UTxO at the victim's
address naming the attacker as grantee under the victim's generation;
mint the victim's state NFT name beside the attacker's grant token into
a second control UTxO of the victim under the attacker's devices and
logic; burn the attacker's own state NFT under `BurnGrants` to recreate
the account later under new terms; mint a grant token under
`BurnGrants`, where no placement rule runs, into an output at the
victim's address, and burn one under `IssueGrants`; mint two tokens
under one grant name; issue the attacker's own grant token into an
output at the victim's address; spend the attacker's control UTxO and
send the state NFT to the victim's address, to a key address, into an
output carrying a reference script or beside another token; spend the
attacker's control UTxO and grant UTxO, burn nothing and send the grant
token into an output at the victim's address, and the same on the agent
path with the attacker's control UTxO referenced.

Mitigation. Under `CreateAccount` the proxy accepts exactly one
asset name of 28 bytes in quantity one, requires a publish redeemer for a
certificate registering `Script(stake_script_hash)`
(`account.registers_stake_credential`), and requires exactly one control
output at `account.account_address(policy, name)`, whose stake part is an
inline script credential only, holding lovelace and the NFT alone with
no reference script, and a withdrawal from the logic that output names.
The registration is where the owner is checked: the stake script's
`publish` handler accepts a `RegisterCredential` or
`RegisterAndDelegateCredential` only with `owner` among the required
signers, the mint of exactly one state NFT of its own credential and
`owner` in the device list of the control output (`creates_the_account`,
`lists_the_owner_as_a_device`), and the proxy only accepts a creation
the stake script ran on, by looking for its redeemer rather than for the
certificate. A second creation of an existing account is refused because
the ledger will not register a registered credential, so the transaction
cannot carry the registration the proxy demands. Under `IssueGrants`
and `BurnGrants` every minted name must be a 32 byte grant name of the
account the first name denotes, in quantity one or minus one
(`account.mints_grants_of`), that account's control UTxO must be present
and its logic must withdraw; under `IssueGrants` every account token
among the outputs sits at its own account address. A 28 byte name is
never a grant name, so no logic can have a state NFT minted or burned
through the grant redeemers, and no mint touches another account's
tokens whatever the logic approves. On every spend of a UTxO holding a
token of the policy the proxy requires every account token among the
outputs at its own account address, and when the state NFT is spent
`account.keeps_control_output` pins the control output. Under logic v1
the owner path additionally requires each minted name to be the grant
name of the next slot in order, landing in one output at the account
address holding only that token, with a grant of that slot and the
recreated generation (`rules.issue_grants_rule`, `rules.issues_grant`),
and `rules.recreates_control_output` requires the counters to move by
the mint delta; the agent path requires `account.holds_no_account_token`
of the mint.

Tests. `attack_token_forgery_victims_address_with_the_attackers_signature`
(the proxy and the logic accept and `register` refuses, so the
transaction fails),
`attack_token_forgery_owner_signed_creation_without_the_owner_as_a_device`
(the same),
`attack_token_forgery_attackers_name_into_the_victims_address` (`fail`),
`attack_token_forgery_second_nft_minted_during_a_grant_spend` (`!`),
`attack_token_forgery_grant_token_minted_during_a_grant_spend` (`!`),
`attack_token_forgery_issue_grants_without_the_control_utxo_spent` (`!`,
the proxy accepts the referenced control UTxO and the logic's agent path
admits no mint),
`attack_token_forgery_issue_grants_with_the_grantee_signature` (`!`),
`attack_token_forgery_grant_token_named_after_another_account` (`!`),
`attack_token_forgery_grant_token_reusing_an_issued_slot` (`!`),
`attack_token_forgery_issue_grants_without_moving_the_counters` (`!`),
`attack_token_forgery_create_account_with_a_key_stake_credential`
(`fail`),
`attack_token_forgery_lookalike_token_named_after_the_stake_credential_on_the_control`
(`!`), `attack_token_forgery_parallel_control_utxo_without_a_registration`
(`!`),
`attack_token_forgery_parallel_control_utxo_with_an_unwitnessed_registration`
(`!`), `attack_token_forgery_state_nft_minted_as_a_grant` (`!`). Under
the attacker's own logic, all refused by the proxy alone (`!`):
`attack_token_forgery_victims_grant_token_minted_beside_the_attackers_own`,
`attack_token_forgery_victims_state_nft_minted_beside_the_attackers_grant`,
`attack_token_forgery_state_nft_burned_under_burn_grants`,
`attack_token_forgery_grant_token_minted_under_burn_grants`,
`attack_token_forgery_grant_token_burned_under_issue_grants`,
`attack_token_forgery_grant_token_minted_in_quantity_two`,
`attack_token_forgery_attackers_grant_token_placed_at_the_victims_address`,
`attack_token_forgery_control_nft_relocated_under_the_attackers_logic`,
`attack_token_forgery_reference_script_on_the_control_under_the_attackers_logic`,
`attack_token_forgery_extra_token_on_the_control_under_the_attackers_logic`,
`attack_token_forgery_attackers_grant_token_swept_to_the_victims_address`,
`attack_token_forgery_attackers_grant_token_spent_to_the_victims_address`.
Functional companions in `validators/account.test.ak`:
`create_account_rejects_a_missing_registration`,
`create_account_rejects_a_reference_script_on_the_control_output`,
`spend_places_every_account_token_under_every_redeemer`,
`create_account_rejects_a_registration_of_another_credential`,
`create_account_rejects_a_registration_the_stake_script_did_not_run_on`,
`create_account_rejects_a_quantity_of_two`,
`create_account_rejects_two_asset_names_under_the_policy`,
`create_account_rejects_a_grant_token_beside_the_state_nft`,
`create_account_rejects_a_burn_beside_the_mint`,
`create_account_rejects_a_burn`,
`create_account_rejects_a_name_shorter_than_a_stake_script_hash`,
`issue_grants_rejects_another_accounts_grant_token_beside_its_own`,
`issue_grants_rejects_another_accounts_state_nft_beside_its_own_grant`,
`issue_grants_rejects_the_accounts_own_state_nft_beside_its_grant`,
`issue_grants_rejects_its_own_grant_token_at_another_accounts_address`,
`issue_grants_rejects_its_own_grant_token_at_a_key_address`,
`burn_grants_rejects_the_state_nft_name`,
`burn_grants_rejects_a_positive_quantity`,
`device_rejects_the_state_nft_sent_to_another_address`,
`device_rejects_a_reference_script_on_the_control_output`,
`device_rejects_extra_tokens_on_the_control_output`,
`device_rejects_the_state_nft_in_two_outputs`; in
`validators/logic_v1.test.ak`: `issue_grants_rejects_a_skipped_slot`,
`issue_grants_rejects_a_reused_slot`,
`issue_grants_rejects_a_quantity_of_two`,
`issue_grants_rejects_the_state_nft_name`,
`spend_with_grant_rejects_the_grant_token_sent_to_another_accounts_address`; in
`validators/account_stake.test.ak`:
`publish_rejects_a_registration_without_the_owner_signature`,
`publish_rejects_a_registration_signed_by_a_device_over_the_control`,
`publish_rejects_a_registration_without_the_mint`,
`publish_rejects_a_registration_minting_two_state_nfts`,
`publish_rejects_a_registration_minting_another_accounts_state_nft`,
`publish_rejects_a_registration_with_the_owner_outside_the_devices`; and
the `registers_credential_*`, `registers_stake_credential_*`,
`mints_grants_of_*`, `keeps_control_output_*` and `grant_mint_delta_*`
unit tests in `lib/cardano_account_custody_contract/account.test.ak`,
among them `registers_stake_credential_ignores_a_certificate_without_a_redeemer`.

## Logic substitution and the upgrade path

Attack. A grantee attaches a withdrawal from a logic of its own instead
of the logic the control UTxO names, on the agent path and, signing as
the attacker, on the owner path; an account is created under the
attacker's logic with a withdrawal from the logic the owner expects, or
the other way round; a grantee rewrites the logic field, on the owner
path without a device signature and on the agent path with the control
UTxO referenced and a control output naming the new logic beside its
spend; a stranger offers the upgrade with both logics running and no
device signature; the owner moves the account without the old logic
running, or to a logic whose withdrawal is absent, or keeping the
generation so that old grants stay current under rules that never
issued them, or swapping the devices on the way; the owner moves the
account with the devices swapped, the generation kept and the counters
past their bound while referencing another account's control UTxO under
the new logic, or spending and recreating a second account already
under the new logic, so that the new logic runs its agent or owner path
over the other account instead of validating the arrival; two accounts
under one logic are operated, leave it or arrive at it in one
transaction; the logic credential is deregistered.

Mitigation. The proxy reads the logic from the control datum of the
account being spent and requires a withdrawal from that hash
(`runs_the_logic`), so a withdrawal from any other script is never
asked anything; at creation it requires the withdrawal from the hash the
control output names. The logic field changes only on a `Device` spend
of the control UTxO, which `rules.device_rule` accepts on a device
signature alone; the agent path never spends the control UTxO and
refuses any control output naming the logic, so a grantee cannot offer
an arrival beside its spend. `rules.recreates_control_output` requires,
when the control output names another logic, a withdrawal from that
logic and nothing minted under the policy, and reads nothing else of the
arriving state. The arriving logic's `validates_arrival` runs when no
control UTxO names it: exactly one control output names it, holding
lovelace and the NFT alone, with a well formed state; with a control
input of that account it requires a withdrawal from the logic the spent
datum names, a generation strictly greater than `account.generation_of`
the spent datum, devices equal to `account.devices_of` it, and nothing
minted; without one it requires the state NFT as the only mint and zero
counters. An arrival can hide behind no other account: on the owner
path `validates_owner_transaction` requires every control output naming
the logic to sit at the spent account's address, and on the agent path
`validates_agent_transaction` admits no control output naming the logic
at all. Two control UTxOs naming one logic, spent, referenced or one of
each, fall to the refusing arm; two accounts arriving at one logic abort
on the single output `expect`. `logic_v1.publish` accepts the
registration of a script credential and refuses every other
certificate, deregistration included.

Tests. `attack_logic_substitution_grant_spend_under_the_attackers_logic`
(`!`), `attack_logic_substitution_device_spend_under_the_attackers_logic`
(`!`), `attack_logic_substitution_creation_under_a_logic_that_does_not_run`
(`!` both ways), `attack_logic_substitution_grantee_rewrites_the_logic_pointer`
(`!` on both paths), `attack_logic_substitution_stranger_rewrites_the_logic_pointer`
(`!`), `attack_logic_substitution_upgrade_without_the_old_logic` (`!`,
refused by the proxy and by the arriving logic),
`attack_locked_value_upgrade_to_a_logic_that_does_not_run` (`!`),
`attack_logic_substitution_upgrade_keeps_the_generation` (`!`),
`attack_logic_substitution_upgrade_swaps_the_devices` (`!`),
`attack_logic_substitution_arrival_hidden_behind_a_referenced_control`
and `attack_logic_substitution_arrival_hidden_behind_a_spent_control`
(the leaving logic accepts, the arriving logic returns False),
`attack_logic_substitution_two_accounts_under_one_logic` (`!`),
`attack_other_redeemer_logic_deregistration` (`!`),
`attack_utxo_contention_grant_spend_after_an_upgrade` (`!` under either
logic). Functional companions, the upgrade suite in
`validators/logic_v1.test.ak`: `upgrade_is_accepted_by_a_device`,
`upgrade_keeps_the_counters_the_owner_writes`,
`sweep_grant_burns_a_grant_issued_before_an_upgrade`,
`spend_with_grant_rejects_a_grant_issued_before_an_upgrade`,
`upgrade_rejects_a_grantee_on_the_owner_path`,
`upgrade_rejects_a_grantee_on_the_grant_path`,
`upgrade_rejects_a_grantee_that_only_references_the_control`,
`upgrade_rejects_a_stranger`,
`upgrade_rejects_a_missing_new_logic_withdrawal`,
`upgrade_rejects_a_missing_old_logic_withdrawal`,
`upgrade_rejects_an_output_pointing_at_a_logic_whose_withdrawal_is_absent`,
`upgrade_rejects_an_unchanged_generation`,
`upgrade_rejects_a_lowered_generation`,
`upgrade_rejects_changed_devices`,
`upgrade_rejects_an_ill_formed_arriving_state`,
`upgrade_rejects_extra_tokens_on_the_control_output`,
`upgrade_rejects_a_state_nft_sent_outside_the_account`,
`upgrade_rejects_a_control_output_at_another_stake_credential`,
`upgrade_rejects_a_mint_under_the_policy`,
`upgrade_rejects_a_burn_under_the_policy`,
`upgrade_leaves_the_arriving_state_to_the_new_logic`,
`upgrade_reads_the_stable_prefix_of_the_leaving_state`,
`upgrade_accepts_a_downgrade_with_both_withdrawals`,
`upgrade_rejects_an_arrival_beside_a_referenced_control_under_the_new_logic`,
`upgrade_rejects_an_arrival_beside_a_spent_control_under_the_new_logic`,
`upgrade_rejects_two_accounts_leaving_the_same_logic`,
`upgrade_rejects_two_accounts_arriving_at_the_same_logic` (`fail`),
`upgrade_accepts_two_accounts_under_different_logics`,
`withdraw_rejects_the_control_spent_and_referenced`,
`withdraw_rejects_two_accounts_under_the_same_logic_spent`,
`withdraw_rejects_two_accounts_under_the_same_logic_referenced`,
`withdraw_ignores_redeemers_of_other_scripts`,
`publish_accepts_a_registration_of_the_credential`,
`publish_rejects_a_deregistration`, `publish_rejects_a_delegation`,
`publish_rejects_a_registration_with_a_delegation`; in
`validators/account.test.ak`: `device_requires_the_logic_the_control_names`,
`device_rejects_a_withdrawal_from_a_logic_the_control_does_not_name`,
`spend_with_grant_requires_the_logic_the_referenced_control_names`,
`create_account_rejects_a_missing_logic_withdrawal`,
`create_account_rejects_a_withdrawal_from_a_logic_the_datum_does_not_name`,
`create_account_rejects_a_logic_pointer_shorter_than_a_script_hash`,
`device_rejects_the_control_spent_and_referenced`,
`device_rejects_two_control_utxos_of_the_account_spent`; and the
`recreates_control_output_*` tests in
`lib/cardano_account_custody_contract/rules.test.ak` and the
`logic_of_*`, `devices_of_*`, `generation_of_*`,
`find_present_control_*` and `withdraws_from_*` tests in
`lib/cardano_account_custody_contract/account.test.ak`.

## Other redeemer

Attack. Withdraw the account's rewards with a grantee signature over a
referenced control UTxO, or over a grant UTxO; spend the control UTxO or
a grant UTxO with `Fund`, the redeemer that carries no authorisation;
spend a plain deposit with `Device`; spend the control UTxO with
`SpendWithGrant`; sweep a grant with the grantee's signature; spend a
grant with its token burned; burn grant tokens over a referenced control
UTxO; use `CreateAccount` on a burn with everything a creation needs
beside it; run a validator under a purpose it has no handler for.

Mitigation. The stake script's `withdraw` handler applies the device
rule, which reads the devices from the control UTxO and ignores grantees,
and aborts over a grant UTxO. `Fund` requires that the spent input holds
no token of the account; under logic v1 `rules.device_rule` requires that
the spent input holds the state NFT and `rules.grant_spend_rule` and
`rules.sweep_rule` that it holds only lovelace and the grant token of
its datum's slot, read from the datum's first field by the sweep, so
each redeemer is tied to one kind of UTxO; the
owner path requires `Device` on the control UTxO and admits no
`SpendWithGrant`, the agent path admits only `SpendWithGrant` and
`Fund`. `account.state_datum` and `account.grant_datum` decode the datum
each rule needs. `rules.sweep_rule` requires a device signature read
from the spent control UTxO, and `BurnGrants` needs the control UTxO
spent, since the agent path admits no mint, and a device signature. The
proxy matches the mint redeemer against the minted quantities and
accepts `CreateAccount` with one name in quantity one, `IssueGrants`
with every name in quantity one and `BurnGrants` with every name in
quantity minus one; the agent path additionally requires that nothing
is minted or burned under the policy and that a single output holds the
grant token, which a burn makes impossible. All three validators fail in
their `else` handler.

Tests. `attack_other_redeemer_withdraw_rewards_with_a_grantee_signature`
(`!`), `attack_other_redeemer_withdraw_rewards_over_a_grant_utxo`
(`fail`), `attack_other_redeemer_fund_on_the_control_utxo` (`!`, the
proxy and the logic both refuse), `attack_other_redeemer_fund_on_a_grant_utxo`
(`!`), `attack_other_redeemer_device_on_a_plain_deposit` (`!`),
`attack_other_redeemer_grant_on_the_control_utxo` (`!`),
`attack_other_redeemer_sweep_with_the_grantee_signature` (`!`),
`attack_other_redeemer_grant_spend_with_its_token_burned` (`!`),
`attack_other_redeemer_burn_grants_without_the_control_utxo_spent` (`!`),
`attack_other_redeemer_create_account_on_a_burn` (`!`),
`attack_other_redeemer_logic_deregistration` (`!`). Functional
companions: `mint_rejects_a_burn_of_the_state_nft_from_the_control_utxo`,
`mint_rejects_a_burn_of_two`, `fund_rejects_the_control_utxo_itself`,
`fund_rejects_a_grant_utxo_itself` in `validators/account.test.ak`;
`burn_grants_rejects_the_state_nft`,
`burn_grants_rejects_a_mint_among_the_burns`,
`sweep_grant_rejects_the_control_utxo`,
`spend_with_grant_rejects_the_control_utxo`,
`device_rejects_a_grant_utxo_as_the_control`,
`device_rejects_a_missing_control_output_even_when_the_state_nft_is_burned`
in `validators/logic_v1.test.ak`; `else_fails_for_any_other_purpose`
for the stake script and for the logic.

## Missed input validation

Attack. The grantee pays exactly the per call cap and lets the account
pay the fee; drains lovelace from the grant UTxO on top of the cap; uses
a grant scoped to one asset name to move a sibling asset name under the
same policy; spends a token grant's whole remaining lovelace cap in one
transaction above its lovelace per call cap; pays part of a spend within
the per call cap to the bare script address to dodge the recipient list;
an issuance writes grants with a negative cap, no expiry, a lovelace cap
on a lovelace scope or nine recipients; a device rewrite moves the
counters without a mint, or decreases the generation.

Mitigation. `grant.leaving_value` is a net sum over the full account
address, so the fee and the grant UTxO's own lovelace count as leaving
and the per call cap in `grant.stays_within_scope` is the rule that
refuses both the fee and the grant drain attempts; the grant output in
those tests carries the correct cap decrement, so nothing else refuses
them, and the grant output's value is further pinned to the spent value.
For a token scope `stays_within_scope` bounds lovelace by both the
lovelace per call cap and the remaining lovelace cap. The scoped asset is
compared as a full asset class, policy id and asset name, and
`nothing_else_leaves` refuses any other class with a positive outflow.
The bare script address differs from the account address, so an output
there counts as leaving and must be a listed recipient; the test keeps
the outflow within the per call cap, so `grant.pays_only_recipients` is
the only rule that refuses it. `state.is_grant_well_formed` is applied to
every grant at issuance and `state.is_well_formed` to every state written
on the owner path and at arrival, with `rules.recreates_control_output`
tying the counters to the mint delta and the generation to its
predecessor.

Tests.
`attack_missed_input_validation_fee_paid_by_the_account_beyond_the_cap`
(`!`),
`attack_missed_input_validation_grant_lovelace_drained_beyond_the_cap`
(`!`),
`attack_missed_input_validation_token_grant_leaks_a_sibling_asset_name`
(`!`),
`attack_missed_input_validation_token_grant_burns_its_lovelace_budget_in_one_call`
(`!`), `attack_missed_input_validation_change_to_the_bare_script_address`
(`!`), `attack_missed_input_validation_ill_formed_grants_at_issuance`
(`!` for each scope),
`attack_missed_input_validation_ill_formed_counters_on_a_device_rewrite`
(`!` for each state). Functional companions in
`validators/logic_v1.test.ak`:
`spend_with_grant_rejects_one_lovelace_above_the_per_call_cap`,
`spend_with_grant_rejects_spending_above_the_remaining_cap`,
`spend_with_grant_charges_a_fee_paid_by_the_account_against_the_cap`,
`spend_with_grant_rejects_a_cap_decrement_that_leaves_out_the_fee`,
`spend_with_grant_rejects_one_lovelace_above_the_lovelace_per_call_cap`,
`spend_with_grant_rejects_lovelace_above_the_remaining_lovelace_cap_on_a_token_grant`,
`spend_with_grant_rejects_a_foreign_asset_leaving`,
`spend_with_grant_rejects_a_cap_raised_by_a_net_deposit`,
`spend_with_grant_rejects_lovelace_drained_from_the_grant_output`,
`spend_with_grant_rejects_lovelace_added_to_the_grant_output`,
`device_rejects_a_next_slot_edit_without_a_mint`,
`device_rejects_an_outstanding_edit_without_a_mint`,
`device_rejects_a_decreased_grant_generation`, and the
`stays_within_scope_*` and `grant_after_spend_*` unit and property tests
in `lib/cardano_account_custody_contract/grant.test.ak`.

## Time handling

Attack. A grant spend with no upper bound; a lower bound past the expiry
and no upper bound; an exclusive upper bound one past the expiry, which
covers the same instants as an inclusive bound at the expiry; a
degenerate range whose upper bound is negative infinity; a sweep of a
live grant with a lower bound at, not past, its expiry.

Mitigation. `grant.ends_before_expiry` accepts only a `Finite` upper
bound whose value is at most `expires_at`, regardless of inclusiveness,
so an exclusive bound at `expires_at + 1` is refused although it is
equivalent; this is the conservative reading. The lower bound is not
consulted on a spend: it cannot extend the range past the upper bound,
and the ledger refuses any transaction whose range does not contain the
current slot. On a sweep, `grant.starts_after_expiry` accepts only a
`Finite` lower bound strictly past `expires_at`, so a grant that is
neither revoked nor of an older generation can only be swept once it has
expired; `grant.is_dead` consults the expiry only when the datum decodes
as a full `Grant`, so a grant of another shape never dies by time. Both
bounds are compared in POSIX milliseconds, the unit of `expires_at`.

Tests. `attack_time_handling_no_upper_bound` (`!`),
`attack_time_handling_lower_bound_past_expiry_with_no_upper_bound` (`!`),
`attack_time_handling_exclusive_upper_bound_one_past_expiry` (`!`),
`attack_time_handling_negative_infinity_upper_bound` (`!`),
`attack_time_handling_sweep_of_a_live_grant` (`!`). Functional
companions: `spend_with_grant_rejects_a_validity_range_ending_after_the_expiry`,
`spend_with_grant_accepts_a_validity_range_ending_at_the_expiry`,
`sweep_grant_rejects_a_live_grant`,
`sweep_grant_rejects_a_lower_bound_at_the_expiry`,
`sweep_grant_burns_an_expired_grant`, and the `ends_before_expiry_*`,
`starts_after_expiry_*`, `is_current_*` and `is_dead_*` unit and property
tests.

## Unbounded datum, inputs and value

Attack. A device rewrite or an account creation storing a seventeenth
outstanding grant, nine devices, thirty three revoked slots or
outstanding grants at creation; an issuance with nine recipients; a
bundle of tokens under twenty policies parked on the control output at
creation or on a grant output at issuance; twenty deposits spent at once
without an account token.

Mitigation. `state.is_well_formed` bounds the state to `max_devices`
(8), `max_grants` (16) outstanding and `max_revoked` (32) and is applied
on every write of the state under logic v1, arrival included;
`state.is_scope_well_formed` bounds a grant to `max_recipients` (8) at
issuance, and a grant's scope cannot grow afterwards. The proxy keeps
every token but the state NFT off the control output on every path
(`assets.has_nft_strict` in `account.keeps_control_output` and at
creation) and logic v1 every token but the grant token off a grant
output. Deposits are not bounded in number, but every one of them needs
an account token in the same transaction and pays for its own proxy
execution; the cost of many deposits is quantified under Resource
exhaustion.

Tests. `attack_unbounded_datum_seventeenth_outstanding_grant`,
`attack_unbounded_datum_nine_devices_on_a_device_rewrite`,
`attack_unbounded_datum_thirty_three_revoked_slots_on_a_device_rewrite`,
`attack_unbounded_datum_outstanding_grants_at_creation`,
`attack_unbounded_value_token_bundle_on_the_control_at_creation`,
`attack_unbounded_value_token_bundle_on_a_grant_at_issuance`,
`attack_unbounded_inputs_deposits_spent_without_an_account_token` (all
`!`). Functional companions:
`device_rejects_extra_tokens_on_the_control_output` (proxy and logic
suites), `issue_grants_rejects_extra_tokens_on_the_grant_output`,
`spend_with_grant_rejects_extra_tokens_on_the_grant_output`,
`device_rejects_a_seventeenth_outstanding_grant`,
`device_rejects_a_thirty_third_revoked_slot`,
`issue_grants_rejects_an_ill_formed_scope`, and the bound tests in
`lib/cardano_account_custody_contract/state.test.ak`.

## UTxO contention

Attack. A grantee spends the control UTxO in its grant spend, or spends
and references it, or spends a second grant UTxO beside its own, to put
the owner's revoke in a race with its transactions; a grantee submits a
spend against the control state as it was before a revoke, a generation
bump or an upgrade.

Mitigation. With the control UTxO spent the logic is on its owner path,
which admits no `SpendWithGrant` and needs a device signature; with it
spent and referenced the proxy's `account.find_present_control` finds
two and refuses, and the logic's refusing arm does the same; a second
grant UTxO fails `grant.spends_one_account_token`. An agent transaction
therefore never spends the control UTxO or another grant UTxO; a
reserve, a deposit with a datum, needs the control UTxO spent under
`Fund`, so an agent transaction never spends one either. Two agents of
one account, and an agent and the owner, contend only when they pick
the same plain deposit, which the ledger refuses as a double spend and
the loser rebuilds; the owner avoids even that by paying the fee from a
reserve or through a sponsor. A revoke is one `Device` spend of the
control UTxO, whatever is outstanding, and once it lands every grant
spend sees it: a spend referencing the old control UTxO fails as the
ledger no longer has that input, and a spend referencing the new one
fails `grant.is_current`. An upgrade lands the same way and kills every
grant under either logic. A grantee may still fragment the plain
deposits at zero outflow or run no-op spends against its own grant UTxO;
neither touches the control UTxO, and the owner's remedy is a revoke and
a sweep.

Tests. `attack_utxo_contention_grant_spend_spends_the_control_utxo`
(`!`),
`attack_utxo_contention_grant_spend_spends_and_references_the_control_utxo`
(`!`), `attack_utxo_contention_grant_spend_spends_a_second_grant_utxo`
(`!`), `attack_utxo_contention_grant_spend_after_a_revoke` (`!`),
`attack_utxo_contention_grant_spend_after_a_generation_bump` (`!`),
`attack_utxo_contention_grant_spend_after_an_upgrade` (`!`).
Functional companions:
`spend_with_grant_rejects_a_spent_control_in_place_of_a_reference`,
`spend_with_grant_rejects_the_control_spent_beside_the_reference`,
`spend_with_grant_rejects_two_grant_utxos_of_the_account`,
`spend_with_grant_rejects_a_revoked_slot`,
`spend_with_grant_rejects_a_grant_of_an_older_generation`, and the
`spends_one_account_token_*` and `find_present_control_*` unit tests.

## Locked value

Attack. A grant spend pays the whole balance back to the account address
under a datum hash, or under an inline datum; a grant spend sends the
balance to the bare script address; a grant spend strands its grant
token on a plain deposit; a device rewrite removes every device; an
account is created without devices; a registration is published without
the state NFT mint, which would leave a credential registered with no
account to create; a sweep burns a grant token without lowering the
outstanding count, which would wedge the account at the bound; an
account is pointed at a logic that never ran.

Mitigation. The datum hash case was a live finding, fixed by
`grant.deposits_are_plain`: on the agent path every output at the account
address that does not hold an account token must carry `NoDatum` and no
reference script. A script output under a datum hash can only be spent
by whoever supplies the preimage, and none of it counts as leaving, so
without the rule a grantee with any cap at all could put the entire
balance beyond reach. Inline datums are refused by the same rule: on the
agent path a deposit has no use for one, and a deposit with a datum
would become a reserve the owner alone can spend. The Device path is
deliberately exempt: the owner has unrestricted authority over the
account and may tag deposits with a datum to make reserves. The bare
script address is not the account address, so sending the whole balance
there counts as leaving and the per call cap is what refuses it; with a
recipient list the destination is refused as well, and through an open
grant the loss stays bounded by the caps. A grant token on a plain
deposit fails `account.find_grant_output`'s strict placement and the
grant output rules. `state.is_well_formed` requires at least one device
on every write and at arrival. The stake script's registration arms
require the mint of the state NFT, and `rules.recreates_control_output`
requires the outstanding count to follow the burns. A control output
naming a logic whose withdrawal is absent is refused by the leaving
logic, and the proxy would require that withdrawal on every later spend
regardless, so no account can end up under a logic that cannot run; a
logic that is registered but defective is the signer's concern, see the
residual risks.

Permanence is the structural mitigation for the rest of this class.
Every plain deposit needs an account token in the same transaction and
every reserve the control UTxO, and the control UTxO always exists: it
is created with the account, every spend recreates it under the proxy's
rule, no redeemer burns the NFT and the stake script refuses the
deregistration that a second creation would need. A deposit that arrives
at any time after creation is therefore spendable through the normal
paths, with no window in which the account is absent. A dead grant UTxO
is swept by a device, which burns its token and frees its lovelace, so
nothing stays locked in a grant. The logic credential cannot be
deregistered, so the withdrawal every spend needs is always available.
The cost is that the registration deposit and the control UTxO's minimum
lovelace are locked for the life of the account.

What remains possible and is accepted: a grant with an empty recipient
list may send up to its caps to any address, including unspendable ones;
a device may send anything anywhere; a deposit made by a third party
under a datum hash without a known preimage is that party's own loss, and
one with a known preimage is a reserve. Deposits sent to the script
address with no stake part or with a stake part other than an inline
script credential can never be spent, on any path, because
`account.stake_script_hash_of` aborts (tests
`stake_script_hash_of_fails_without_a_stake_credential`,
`stake_script_hash_of_fails_for_a_key_stake_credential`,
`stake_script_hash_of_fails_for_a_pointer_stake_credential`,
`spend_rejects_an_input_without_a_stake_credential`); that is an
off-chain obligation (see recommendations). Funds deposited to an address
whose credential a third party registered before the account existed
are locked, since the account can never be created there; see the
residual risks.

Tests. `attack_locked_value_grant_spend_deposits_under_a_datum_hash`
(`!`), `attack_locked_value_grant_spend_deposits_under_an_inline_datum`
(`!`),
`attack_locked_value_grant_spend_sends_the_balance_to_the_bare_script_address`
(`!`), `attack_locked_value_grant_spend_strands_its_token_on_a_plain_deposit`
(`!`), `attack_locked_value_device_rewrite_removes_every_device` (`!`),
`attack_locked_value_account_created_without_devices` (`!`),
`attack_locked_value_registration_without_the_state_nft_mint` (`!`),
`attack_locked_value_sweep_without_the_outstanding_decrement` (the sweep
rule accepts and the owner path refuses on the control output),
`attack_locked_value_upgrade_to_a_logic_that_does_not_run` (`!`).
Unit tests of the datum rule: `deposits_are_plain_*` in
`lib/cardano_account_custody_contract/grant.test.ak`.

## Staking and certificates

Attack. Withdraw the account's rewards with a grantee signature, with the
owner's signature alone and no control UTxO, with no device signature,
over another account's control UTxO, over a deposit or a grant UTxO
posing as the control UTxO, over a control UTxO without the NFT or
without an inline state; delegate under the same variants; register the
credential without the owner, with a device signature over the control
UTxO instead of the owner's, without the mint, minting two state NFTs or
another account's, with the owner outside the device list, without a
control output, with the control output at another account, without an
inline state, under a datum hash, or carrying a grant; deregister the
credential with a device over the control UTxO, without a device, or
with the owner alone; register a delegate representative under the
credential; run the stake script under a purpose other than withdraw and
publish.

Mitigation. The account's stake credential is the hash of its own stake
script, so the ledger runs that script on every withdrawal from the
reward account and on every certificate naming the credential, and on
nothing else. The `withdraw` handler and the `DelegateCredential` arm of
`publish` apply the device rule, `account.is_authorised_by_a_device`: a
control UTxO of the account must be among the inputs or the reference
inputs, found by its state NFT at its own address, and one of the devices
in its inline datum's second field must be a required signer; the rule
aborts when no such control UTxO is present and reads nothing of the
state after the devices, so it holds under every logic version. A
withdrawal of zero runs the same rule. The `RegisterCredential` and
`RegisterAndDelegateCredential` arms apply `creates_the_account`: `owner`
among the required signers, exactly one token of the certificate's
credential minted under `proxy_hash`, and `owner` in the device list of
the single control output holding that token, read positionally from the
inline datum's second field, since the logic the control output names
checks the whole state in the same transaction. No control UTxO exists
before creation, so the arms read nothing else. The handler does not
compare the certificate's credential with its own hash, which the ledger
makes redundant by running a credential's script only on certificates
naming that credential, and a key credential falls through to the
refusing arm. `UnregisterCredential` and every other certificate kind,
including delegate representative and pool certificates, fall through to
`False`. The `else` handler fails. A `DelegateCredential` covers pool,
vote and combined delegations alike, so a vote delegation needs a device
like any other. A withdrawal from an unrelated reward account added to
an agent transaction only adds value that must balance into the outputs
or the fee, both of which the grant accounting covers, and an Ed25519
grantee signs the whole body anyway. The logic's zero withdrawal and the
account's reward withdrawal are two entries of one map keyed by
credential and never collide.

Tests. In `validators/account_stake.test.ak`:
`publish_accepts_a_registration_signed_by_the_owner`,
`publish_accepts_a_registration_with_a_delegation_signed_by_the_owner`,
`publish_accepts_a_registration_with_the_owner_among_several_devices`,
`publish_rejects_a_registration_without_the_owner_signature`,
`publish_rejects_a_registration_signed_by_a_device_over_the_control`,
`publish_rejects_a_registration_without_the_mint`,
`publish_rejects_a_registration_minting_two_state_nfts`,
`publish_rejects_a_registration_minting_another_accounts_state_nft`,
`publish_rejects_a_registration_with_the_owner_outside_the_devices`,
`publish_rejects_a_registration_with_a_delegation_without_the_mint`,
`publish_rejects_a_registration_with_a_delegation_with_the_owner_outside_the_devices`,
`publish_rejects_a_registration_without_a_control_output`,
`publish_rejects_a_registration_with_the_control_output_at_another_account`,
`publish_rejects_a_registration_with_a_control_output_without_an_inline_state`,
`publish_rejects_a_registration_with_a_control_output_under_a_datum_hash`,
`publish_rejects_a_registration_with_a_control_output_carrying_a_grant`
(the last five `fail`),
`publish_accepts_a_second_nft_beside_the_mint_that_the_mint_handler_refuses`,
`publish_rejects_a_registration_of_a_key_credential`,
`publish_accepts_a_delegation_signed_by_a_device_over_a_referenced_control`,
`publish_accepts_a_delegation_signed_by_a_device_over_a_spent_control`,
`publish_rejects_a_delegation_without_a_device_signature`,
`publish_rejects_a_delegation_signed_by_the_owner_alone_without_the_control`
(`fail`), `publish_rejects_a_delegation_over_another_accounts_control`
(`fail`), `publish_rejects_a_delegation_over_a_grant_utxo` (`fail`),
`publish_rejects_a_deregistration_signed_by_a_device_over_the_control`,
`publish_rejects_a_deregistration_without_a_device_signature`,
`publish_rejects_a_deregistration_signed_by_the_owner_without_the_control`,
`publish_rejects_a_delegate_representative_registration`,
`withdraw_accepts_a_device_signature_over_a_referenced_control`,
`withdraw_accepts_a_device_signature_over_a_spent_control`,
`withdraw_accepts_a_withdrawal_of_zero`,
`withdraw_rejects_a_missing_device_signature`,
`withdraw_rejects_the_owner_signature_alone_without_the_control` (`fail`),
`withdraw_rejects_another_accounts_control` (`fail`),
`withdraw_rejects_a_control_that_lacks_the_state_nft` (`fail`),
`withdraw_rejects_a_control_without_an_inline_state` (`fail`),
`withdraw_rejects_a_grant_utxo_posing_as_the_control` (`fail`),
`withdraw_rejects_a_deposit_posing_as_the_control` (`fail`),
`withdraw_rejects_a_key_credential` (`fail`),
`else_fails_for_any_other_purpose` (`fail`). In the attack suite,
`attack_other_redeemer_withdraw_rewards_with_a_grantee_signature` (`!`),
`attack_token_forgery_owner_signed_creation_without_the_owner_as_a_device`
and `attack_locked_value_registration_without_the_state_nft_mint`. Unit
tests of the rule: `is_authorised_by_a_device_*`, among them
`is_authorised_by_a_device_reads_the_devices_of_a_state_of_another_shape`,
and `find_control_input_*` in
`lib/cardano_account_custody_contract/account.test.ak`.

## Evaluation order

Reasoning plus tests. Every check in every handler is a conjunction
(`and { .. }`) or a `when` arm preceded by `expect` bindings; `and` short
circuits on the first False and `expect` aborts, so no later check can
rescue an earlier failure and there is no path on which a check is
skipped. The dependences between handlers are these. The proxy's `Fund`
arm and its other spend arms rely on the logic for every rule of
authorisation and accounting: `attack_evaluation_order_fund_passes_only_together_with_the_control_spend`
shows `Fund` returning True while the logic refuses the transaction for
lack of a device signature, and
`attack_evaluation_order_fund_passes_only_together_with_the_grant_spend`
shows `Fund` and the proxy's `SpendWithGrant` arm returning True while
the logic refuses for lack of the grantee's signature;
`device_leaves_the_rules_to_the_logic` and
`create_account_leaves_the_state_to_the_logic` in
`validators/account.test.ak` show the proxy accepting what the logic
refuses. The logic relies on the proxy for `Fund`, for the naming and
quantity of the mint and for placement under a foreign logic: a reserve
relies on `Fund` demanding the control UTxO under a datum, and
`attack_evaluation_order_reserve_spent_beside_a_grant_utxo` shows the
logic accepting while the reserve's `Fund` handler refuses. The proxy
relies on the stake script's `publish` handler for the owner's signature
and the device list on creation, and the stake script relies on the
logic for the single control output's full state:
`attack_token_forgery_victims_address_with_the_attackers_signature` and
`attack_token_forgery_owner_signed_creation_without_the_owner_as_a_device`
show the proxy and the logic accepting while `register` refuses, and
`publish_accepts_a_second_nft_beside_the_mint_that_the_mint_handler_refuses`
the converse. The sweep rule relies on the owner path's control output
rule for the outstanding count:
`attack_locked_value_sweep_without_the_outstanding_decrement`. The
leaving logic relies on the arriving logic for the arriving state, and
the arriving logic on the leaving one for the device signature:
`attack_logic_substitution_arrival_hidden_behind_a_referenced_control`
and `attack_logic_substitution_stranger_rewrites_the_logic_pointer`
show each refusing what the other accepts. The ledger accepts a
transaction only when every script passes, so the order in which they
run is irrelevant.

## Signature replay across transactions, accounts and networks

Attack. An Ed25519 key granted by one account signs a spend from another
account's grant UTxO under the same slot number.

Mitigation. A grantee is an Ed25519 key hash and authorises a spend by
signing the transaction itself (`grant.is_authorised_by_grantee` looks
for it among `extra_signatories`). The ledger binds every witness to the
hash of the transaction body, which includes the inputs being spent, so a
witness authorises exactly one transaction and can be reused neither for
a later state of the same grant UTxO nor on another network, where no
input of the transaction exists. The grant is read from the grant UTxO
being spent and checked against the control UTxO of that same account,
so the same key granted by two accounts spends under each account's own
scope and nothing else. There is no signature carried in a redeemer and
therefore no message of the validator's own to replay.

Tests. `attack_signature_replay_ed25519_grantee_of_another_account`
(`!`). Functional companions:
`spend_with_grant_rejects_a_grantee_that_did_not_sign`,
`spend_with_grant_rejects_another_accounts_control_reference`,
`is_authorised_by_grantee_accepts_a_required_signer`,
`is_authorised_by_grantee_rejects_a_grantee_that_did_not_sign`.

## Dust attacks

Attack. An attacker dusts the account with tokens under three policies.
A grant spend over the dusted deposit returns all but one unit of dust,
or pushes the dust onto the grant output.

Mitigation. `grant.stays_within_scope` refuses a positive outflow of any
asset class but the scoped one and lovelace, down to a single unit, and
the grant output must hold exactly the spent grant UTxO's value, which
`assets.has_nft_strict` already pins to lovelace and the token. Dust can
therefore only be moved by a device, and a grantee that includes a
dusted deposit must return every unit of it. The owner's cost is the fee
of sweeping; the attacker's cost is the minimum lovelace of every dust
UTxO, which the owner recovers. Dust deposits carrying a state shaped or
grant shaped datum are the forged UTxO cases under Missing UTxO
authentication.

Tests. `attack_dust_attack_grant_spend_keeps_one_unit_of_dust` (`!`),
`attack_dust_attack_dust_pushed_onto_the_grant_output` (`!`).

## Resource exhaustion

The `budget_` tests in `validators/attacks.test.ak` build the largest
state logic v1 admits and run every handler of every path over it. The
largest control state has eight devices, `max_revoked` revoked slots,
sixteen outstanding grants and a generation past zero; the largest grant
lists eight recipients; every key is 28 bytes. The largest control datum
and the largest grant datum together serialise to under 2 KiB of CBOR, as
`budget_largest_state_datums_stay_within_the_transaction_size_limit`
asserts, far inside the 16 KiB transaction size limit.

Method. `aiken check -D` reports the execution units of every test as
the memory units and CPU steps its evaluator charged. Each `budget_`
figure includes the cost of building the fixture; the `budget_baseline_`
test of the same fixture builds it without running a handler, and the
net figures subtract it. The runner does not charge the ledger's
decoding of the script context, which every script execution pays on
chain in proportion to the size of the transaction, so the net figures
understate the on-chain cost of every execution, and the more so the
more inputs the transaction has; the on-chain figures below come from
the preprod run and are the ones to size by. Every share of a limit
below is a share of preprod's limits, the ones the runs read back from
the chain: 17,500,000 memory units and 10,000,000,000 CPU steps per
transaction and 77,500,000 memory units and 20,000,000,000 steps per
block. A transaction pays the sum over every handler it runs, one per
script input, mint policy, certificate and withdrawal. Under the split
a transaction runs the proxy once per script input and once for the
mint, and the logic once through its withdrawal, twice on an upgrade.
The tests are named `budget_proxy_<fixture>_<handler>`,
`budget_logic_<fixture>` and, for the upgrade, `budget_old_logic_` and
`budget_new_logic_`; `largest_state` fills its revoked list with slots
1 to `max_revoked`, puts the largest token grant and the largest
lovelace grant at `max_revoked` plus 6 and plus 7 and its next slot at
`max_revoked` plus 8.

Net memory units and CPU steps per execution over the largest state, in
millions and billions:

| Transaction (baseline mem) | Proxy executions, net mem / net cpu | Logic execution, net mem / net cpu |
| --- | --- | --- |
| Creation (0.40 M) | `CreateAccount` 0.15 M / 0.06 G | arrival 0.44 M / 0.13 G |
| Device revoke (0.67 M) | `Device` 0.22 M / 0.08 G | owner path 1.11 M / 0.33 G |
| Device rewrite (0.57 M) | `Device` 0.22 M / 0.08 G | owner path 1.11 M / 0.33 G |
| Upgrade (0.50 M) | `Device` 0.24 M / 0.08 G | leaving 0.61 M / 0.19 G; arriving 0.77 M / 0.23 G |
| Reserve spent beside the control (0.58 M) | `Fund` 0.08 M / 0.03 G | owner path 1.21 M / 0.36 G |
| Issue one grant (0.53 M) | `Device` 0.28 M / 0.10 G; `IssueGrants` 0.15 M / 0.05 G | owner path 1.99 M / 0.60 G |
| Issue eight grants (1.91 M) | `Device` 0.61 M / 0.21 G; `IssueGrants` 0.39 M / 0.14 G | owner path 6.71 M / 2.07 G |
| Issue sixteen grants (3.75 M) | `Device` 1.00 M / 0.34 G; `IssueGrants` 0.66 M / 0.23 G | owner path 14.78 M / 4.50 G |
| Sweep one grant (0.79 M) | `Device` 0.28 M / 0.10 G; `SweepGrant` 0.21 M / 0.07 G; `BurnGrants` 0.11 M / 0.04 G | owner path 1.54 M / 0.48 G |
| Sweep eight grants (2.92 M) | `Device` 0.48 M / 0.15 G; `SweepGrant`, last of eight 0.43 M / 0.14 G; `BurnGrants` 0.34 M / 0.10 G | owner path 3.84 M / 1.30 G |
| Sweep sixteen grants (5.61 M) | `Device` 0.70 M / 0.22 G; `SweepGrant`, last of sixteen 0.68 M / 0.23 G; `BurnGrants` 0.59 M / 0.18 G | owner path 7.14 M / 2.52 G |
| Agent spend, lovelace scope, eight deposits (1.35 M) | `SpendWithGrant` 0.34 M / 0.11 G; `Fund`, last of eight 0.16 M / 0.06 G | agent path 2.58 M / 0.86 G |
| Agent spend, token scope, one deposit (0.83 M) | `SpendWithGrant` 0.24 M / 0.08 G | agent path 1.96 M / 0.66 G |
| Agent spend over forty deposits (3.99 M) | `SpendWithGrant` 0.78 M / 0.24 G; `Fund`, last of forty 0.46 M / 0.19 G | agent path 5.94 M / 1.97 G |

The stake script, measured on its own: the registration over the
creation 0.14 M / 0.04 G, a withdrawal over the largest control UTxO
referenced 0.15 M / 0.04 G, a delegation 0.16 M / 0.05 G. The
`SweepGrant` and `Fund` rows measure the proxy on the last such input,
which scans every input before it to find itself, so they bound the
executions on the earlier inputs from above.

Per transaction, summing the executions each path runs, in net memory
units:

- Creation: the proxy's mint, the logic's arrival and the registration,
  0.73 M.
- Revoke, revoke all or device rewrite: the proxy and the logic, 1.33 M.
- Upgrade: the proxy, the leaving logic and the arriving logic, 1.62 M.
- Issuance of one grant: 2.41 M. Eight grants with eight recipients
  each: 7.71 M, 44 percent of the limit. Sixteen at once: 16.44 M, 94
  percent, since the logic's issuance grows with the count, which leaves
  less margin than the context decoding the runner does not charge, so
  sixteen does not fit on chain. The off-chain builder issues at most
  eight grants per transaction (`MAX_GRANT_BATCH`); grants with fewer
  recipients are cheaper.
- Sweep of one dead grant: 2.14 M. Eight at once, with eight proxy
  executions at the last input's figure: 8.08 M, 46 percent. Sixteen at
  once: 19.34 M, over the limit. The builder sweeps at most eight per
  transaction.
- Agent spend over eight deposits: 4.17 M; over the token scope with one
  deposit, 2.21 M plus one `Fund` execution. Over forty deposits: 6.72 M
  for the grant UTxO and the logic plus forty `Fund` executions of
  between 0.16 M and 0.46 M each, 13 M to 25 M, which is beside the
  point on chain, where the bound is twelve inputs, below.
- Reserve spend, withdrawal and delegation: 0.08 M, 0.15 M and 0.16 M
  beside the owner spend that carries them.

On chain. The preprod run of `offchain/scripts/preprod-e2e.ts` read the
execution units of every confirmed transaction back from the chain. The
differences from the figures above are the context decoding: an eight
grant issue measured 38 to 41 percent of the memory limit, an eight
grant sweep 40 to 56 percent depending on the order of its inputs, and a
device rewrite or revoke over the largest state 6 to 7 percent. The
agent spend over many deposits is where the method matters most, since
every `Fund` execution decodes the whole transaction: a grant spend over
one fund input measured about 1.13 M memory units, over thirteen about
7.28 M, and over twenty five about 20.6 M, which the node refused, so
the per input cost on chain is roughly 0.5 M more than the local rows on
a transaction of that size. The library bounds a checked grant spend at
`MAX_FUND_INPUTS` (12) fund UTxOs and splits a larger sweep into batches
(`fundBatches`); the builder evaluates every grant spend through the
provider, so a spend over the limit is refused before submission. The
sizes of the proxy and the logic set the fee of a grant spend over a
handful of inputs at about 0.76 M lovelace with both referenced from
their parked UTxOs and about 1.05 M lovelace with both embedded
(`DEFAULT_GRANT_FEE_BOUND` is 1.5 M lovelace).

Observations.

- The heaviest single execution of a transaction that fits is the logic
  over an eight grant issuance at 6.71 M, 38 percent of the limit; the
  14.78 M over sixteen only occurs in a transaction that does not fit.
  The heaviest owner transaction that fits is the eight grant sweep at
  8.08 M. The proxy's executions are small, 0.08 M to 1.00 M, and
  bounded by the scans of the inputs and the outputs they make, the
  placement scan over the outputs among them. No path of the owner is
  near the limit at the committed bounds, and the levers if a later run
  shows otherwise are `max_grants`, `max_recipients` and `max_revoked`
  in `state.ak`, which belong to the logic and change with it.
- Complexity. `grant.leaving_value` folds `assets.merge` over the
  inputs and outputs at the address; each merge is linear in the number
  of asset entries of both operands, so the whole fold is linear in the
  total number of entries, not quadratic. `account.own_input`,
  `account.has_account_token_input`, `account.has_control_input` and
  `account.find_present_control` are linear scans of the inputs run once
  per proxy execution, so the proxy's total work in a transaction with n
  deposits grows with n squared; the measured growth is from 0.16 M to
  0.46 M memory units per `Fund` execution between 9 and 41 inputs. The
  placement scan a spend of an account token adds is one dictionary
  lookup per output. The logic's `validates_spends` walks the redeemers
  once and runs a rule per spend redeemer other than `Fund`;
  `SpendWithGrant` decodes the grant output's datum once to bound its
  caps, and each `SweepGrant` reads two fields of its grant and decodes
  it fully only for the expiry. `rules.issue_grants_rule` runs `account.find_token_output`
  over the outputs once per minted token and
  `rules.recreates_control_output` reads the mint once, so an issuance of
  k grants grows with k squared in the output scans and linearly in the
  grant datums decoded. `state.is_well_formed` uses `list.unique`, which
  is quadratic, over the device list bounded at 8, and `list.length`
  over the revoked list bounded at `max_revoked`. `grant.is_current` and
  `grant.is_dead` scan the revoked list once. `grant.pays_only_recipients`
  is linear in outputs times at most 8 recipients.
  `account.tokens_sit_at_their_own_addresses` is one dictionary lookup
  per input or output. `account.registers_stake_credential` is a linear
  scan of the redeemers. No helper is unbounded in anything the attacker
  controls except the number of inputs, outputs and redeemers, which the
  transaction size limit bounds and the submitter pays for.

Reference scripts. Every transaction that spends a UTxO pays a fee for
the size of the reference script the UTxO holds. A grantee could attach
a large reference script to the grant output it recreates, raising the
cost of its own later spends and of the owner's sweep, or to a deposit it
pays back to the account, raising the cost of every later spend of that
deposit by the owner or by another agent; the owner could only shed such
a UTxO by paying that fee once. `grant.carries_no_reference_script`,
called from `rules.grant_spend_rule`, requires the recreated grant output
to carry no reference script, and `grant.deposits_are_plain` requires the
same of every deposit paid back. An issuance is held to the same rule on
each grant output through `rules.issues_grant`, so no grant UTxO ever
carries one, and the proxy refuses a reference script on the control
output at creation and on every spend of the state NFT, whatever the
logic. Tests:
`attack_resource_exhaustion_reference_script_on_the_grant_output` (`!`),
`attack_resource_exhaustion_reference_script_on_a_returned_deposit`
(`!`),
`attack_token_forgery_reference_script_on_the_control_under_the_attackers_logic`
(`!`), `spend_with_grant_rejects_a_reference_script_on_the_grant_output`,
`spend_with_grant_rejects_a_deposit_with_a_reference_script`,
`issue_grants_rejects_a_reference_script_on_the_grant_output`,
`device_rejects_a_reference_script_on_the_control_output`, and the
`carries_no_reference_script_*` and `deposits_are_plain_*` unit tests in
`lib/cardano_account_custody_contract/grant.test.ak`. The owner's own
path is not constrained beyond the control output: a device may attach a
reference script to any other output it creates.

## Findings and how each was closed

1. A grantee could lock the whole balance. `SpendWithGrant` exempted
   every output at the account address from the recipient check and
   counted it as returned, whatever its datum. A grant spend could
   therefore pay every deposit back to the account address under a
   datum hash with no known preimage: nothing counted as leaving, the
   caps stayed untouched, and the funds became unspendable on every
   path, because the ledger refuses to run a script on an input whose
   datum hash has no preimage in the witness set. The exploit was
   reproduced against the validator before the fix. Closed by
   `grant.deposits_are_plain`, now called from `rules.grant_spend_rule`,
   which requires every output at the account address that does not
   hold an account token to carry `NoDatum`. Tests:
   `attack_locked_value_grant_spend_deposits_under_a_datum_hash`,
   `attack_locked_value_grant_spend_deposits_under_an_inline_datum`, and
   the `deposits_are_plain_*` unit tests.
2. A grantee could raise the owner's fees through the state. The agent
   path accepted the UTxO it recreated with a reference script attached,
   and every later spend of that UTxO would have paid for the script's
   size. Closed by `grant.carries_no_reference_script` on the output the
   agent path recreates, now the grant output. Tests:
   `attack_resource_exhaustion_reference_script_on_the_grant_output`,
   `spend_with_grant_rejects_a_reference_script_on_the_grant_output` and
   the `carries_no_reference_script_*` unit tests.
3. A grantee could raise the owner's fees through deposits. The rule
   above left the deposits a grant spend pays back unconstrained, so a
   grant spend could consolidate the balance into one deposit carrying a
   large reference script and tax every later spend of it. Closed by
   extending `grant.deposits_are_plain` to refuse a reference script on
   every deposit paid back. Tests:
   `attack_resource_exhaustion_reference_script_on_a_returned_deposit`,
   `spend_with_grant_rejects_a_deposit_with_a_reference_script`,
   `deposits_are_plain_rejects_a_deposit_with_a_reference_script`.
4. A grantee could keep the owner from revoking. When every grant lived
   in the control UTxO's datum and every agent spend recreated it, a
   grantee resubmitting a zero outflow spend on every block kept the
   control UTxO moving, and the owner's revoke, which spends that same
   UTxO, lost the race for as long as the grant lived: a loss of
   availability of the whole balance, not bounded by the caps. Closed by
   moving each grant into its own grant UTxO under a grant token and
   making the agent path take the control UTxO as a reference input, so
   an agent transaction never spends anything a revoke spends. Tests:
   the `attack_utxo_contention_*` tests and their functional companions
   under UTxO contention.
5. A registration could strand a credential. The stake script's
   registration arms accepted the owner's signature alone, while the
   mint handler required the registration: a transaction that registered
   without minting, which a builder mistake suffices for, left the
   credential registered with no control UTxO, after which
   `CreateAccount` could never run, since the ledger refuses a second
   registration, and deregistration needed a control UTxO that could not
   exist. Closed by requiring, in both registration arms, the mint of
   exactly one state NFT of the credential in the same transaction
   (`creates_the_account`). Tests:
   `attack_locked_value_registration_without_the_state_nft_mint`,
   `publish_rejects_a_registration_without_the_mint`,
   `publish_rejects_a_registration_with_a_delegation_without_the_mint`,
   `publish_rejects_a_registration_minting_two_state_nfts`,
   `publish_rejects_a_registration_minting_another_accounts_state_nft`.
6. A creation could leave the owner out. The mint handler checked only
   that the initial state was well formed, so a builder could create the
   account, with the owner's signature on the registration, under a
   device list that excluded the owner, and a signer that cannot inspect
   the datum would approve it. Closed by the registration arms requiring
   the owner among the devices of the control output
   (`lists_the_owner_as_a_device`). Tests:
   `attack_token_forgery_owner_signed_creation_without_the_owner_as_a_device`,
   `publish_rejects_a_registration_with_the_owner_outside_the_devices`,
   `publish_rejects_a_registration_with_a_delegation_with_the_owner_outside_the_devices`,
   `publish_accepts_a_registration_with_the_owner_among_several_devices`.
7. The agent path could not be evaluated. The recreated datum had to
   carry the exact caps after the fee, and the fee depends on the
   execution units, so the builder assigned fixed budgets instead of
   evaluating, and its default was below the cost of a spend over the
   largest state. Closed by `grant.carries_grant_within`: the grant
   output's remaining caps may sit anywhere between zero and the exact
   reduction, so the builder decrements by a fee bound, writes the datum
   once and lets the provider evaluate the scripts. Tests:
   `spend_with_grant_accepts_a_cap_decrement_beyond_the_fee`,
   `spend_with_grant_accepts_a_cap_decremented_below_the_outflow`,
   `spend_with_grant_accepts_a_cap_decremented_to_zero`,
   `spend_with_grant_rejects_a_cap_one_lovelace_above_the_outflow_decrement`,
   `spend_with_grant_rejects_a_negative_cap`, their token and lovelace
   cap variants, and the `carries_grant_within_*` unit and property
   tests.
8. One attack test refused for the wrong reason. The two account double
   satisfaction test was refused by the recipient list of the first
   account, which tolerated no foreign output, not by the net
   accounting. Closed by rebuilding the test under open recipient lists
   so that only the cap rule refuses it, as recorded under Double
   satisfaction; no validator change.

Closed in this revision:

9. The deposit batch bound was wrong. The previous review put the batch
   size of an agent spend at around thirty deposits from the local
   figures, pending on-chain measurement. On preprod a spend over twenty
   five deposits cost about 20.6 M memory units and was refused, since
   every `Fund` execution pays to decode the whole transaction context,
   which the local runner does not charge. Closed in the library by
   `MAX_FUND_INPUTS` (12), which a checked `spendWithGrant` enforces, and
   `fundBatches`, which splits a larger sweep; no validator change. The
   method difference is recorded under Resource exhaustion.
10. A foreign logic could park tokens. The proxy checked the placement of
    account tokens on creation and issuance only, and pinned the control
    output on a spend of the state NFT, so an account under a permissive
    logic could send a grant token of its own into an output at another
    account's address on a device or grant spend, where that account's
    `Fund` handler refuses the UTxO and the owner's logic never spends
    it: an unspendable UTxO at the victim's address that a builder may
    select. Closed by the proxy requiring, on every spend of a UTxO
    holding a token of the policy, every account token among the outputs
    at its own account address, and by refusing a reference script on
    the control output at creation as it already did on every spend.
    Tests: `attack_token_forgery_attackers_grant_token_swept_to_the_victims_address`,
    `attack_token_forgery_attackers_grant_token_spent_to_the_victims_address`,
    `attack_token_forgery_attackers_grant_token_placed_at_the_victims_address`,
    `attack_token_forgery_control_nft_relocated_under_the_attackers_logic`,
    `attack_token_forgery_reference_script_on_the_control_under_the_attackers_logic`,
    `spend_places_every_account_token_under_every_redeemer` and
    `create_account_rejects_a_reference_script_on_the_control_output`.

No other attack succeeded.

## Residual risks and recommendations

- Audit before mainnet. This review is internal and test driven; an
  independent audit should precede any mainnet deployment. The contract
  is testnet only at this stage. The scope of that audit is set out
  below.
- Pre registration of a credential. Until the Dijkstra era a stake
  registration in the legacy certificate format carries no deposit field
  and needs no witness
  (`eras/conway/impl/src/Cardano/Ledger/Conway/TxCert.hs`,
  `getScriptWitnessConwayTxCert`; `eras/conway/impl/cddl/data/conway.cddl`,
  `account_registration_cert`, in the cardano-ledger repository), the
  ledger runs no script on it
  (`eras/shelley/impl/src/Cardano/Ledger/Shelley/UTxO.hs`,
  `eras/conway/impl/src/Cardano/Ledger/Conway/UTxO.hs`) and records
  nothing about which form registered a credential
  (`eras/conway/impl/src/Cardano/Ledger/Conway/Rules/Deleg.hs`), so
  anyone who learns an account's stake credential before the account
  exists can register it. The owner's registration then fails as already
  registered, `CreateAccount` cannot run without it, a deregistration
  always needs the script witness and the stake script refuses it, and
  the address is unusable for good: a denial of service, with funds at
  risk only if something was deposited there before creation. The
  attacker's cost is the deposit, locked with the credential. The
  Dijkstra era removes the legacy certificates and requires the witness
  on every registration
  (`eras/dijkstra/impl/src/Cardano/Ledger/Dijkstra/TxCert.hs`,
  `DijkstraRegCert` with a mandatory deposit and the decoder refusing
  tags 0 and 1; `eras/dijkstra/impl/cddl/data/dijkstra.cddl`), which
  closes the squat for new registrations; squats placed before the fork
  remain. Until then the mitigation is at the key layer: the owner key
  of a custody account is derived on a path that differs per network
  class, mainnet and testnets using distinct account index ranges by
  convention of the signer and the SDK, so a key used on a testnet never
  corresponds to a mainnet credential, signers refuse custody operations
  outside their network class, and the stake script hash of an account
  becomes public only in the creation transaction that registers it.
  Nobody can learn a credential before its registration, so a squat
  requires guessing an owner key, which is not feasible. The residual
  case is a user who exposes their custody owner key elsewhere before
  creating the account, which the signer prevents by refusing to use the
  custody key for anything else. Off-chain rules: create the account
  before ever sharing the address, never deposit to an address whose
  control UTxO does not exist, and when creation fails with an already
  registered credential use the next account index, which gives a new
  owner key and a new address. The preprod script applies the last rule
  by scanning owner indices for an unregistered credential.
- Unknown logic. The proxy admits any 28 byte hash whose credential
  withdraws as a logic; nothing on chain says which hashes are versions
  of this contract. An upgrade to unknown code is the one thing a device
  signature can do under this design that it could not before, and it
  is lasting: the proxy will run that code on every later spend. The
  signer must show the logic by a known name and refuse an unknown hash
  on the control output of any transaction that changes the first field,
  and the list of known hashes is itself something the signer ships and
  must protect. The library attaches only logics from the blueprint or
  those given to it. A downgrade to an earlier version with a known
  defect is allowed by the mechanism and is the signer's to refuse.
- Reference script availability. Accounts transact only while the proxy
  and their logic can be attached. The parked UTxOs sit at an always
  fail script address nobody can spend from; if a network records none,
  the builders embed the scripts at a higher fee. Anyone can park them
  again from the blueprint.
- Logic credential registration. A zero withdrawal needs the credential
  registered; `logic_v1.publish` refuses deregistration, so once
  registered on a network the credential stays. Registration costs the
  2 ADA deposit once per network and per version, and anyone may pay it.
- One account per logic version per transaction. A logic validates
  exactly one control UTxO naming it, so two accounts on one version
  cannot share a transaction, and two on different versions cannot when
  either mints. No builder does either.
- Later versions. A logic an account arrives at validates the arrival
  under its own rules and reads only the stable prefix of the state it
  leaves; a logic an account leaves reads only the first field of the
  arriving state. Each version is therefore self contained, and each
  must be reviewed on its own before the signer lists its hash: its
  rules, its arrival branch, and that it keeps the stable prefixes.
- Foreign stake scripts. The proxy does not read the stake script's
  code; it accepts any script credential whose script published the
  registration. An account created under some other script's credential
  is simply that creator's own account: its NFT has its own name, its
  address is its own, and the placement invariant keeps it away from
  every other account. Its reward account answers to whatever that
  script allows, which concerns no one else.
- Off-chain obligations. The library never spends a UTxO at the address
  that carries only a datum hash, and refuses to build a creation whose
  devices omit the owner. Only ever pay to the account's full address,
  with the inline script stake part; funds at the bare script address or
  under any other stake part are unspendable. Batch sweeps of many
  deposits at twelve fund inputs per grant spend, and issue or sweep at
  most eight grants per transaction. Validate that a grantee hash and
  every device hash are 28 bytes when issuing or adding them; the
  validators do not check lengths, and an ill sized key only makes the
  grant or device unusable. Keep a reserve, or a sponsor, for the owner's
  operations so that a revoke never depends on a fund UTxO an agent may
  be spending. After an upgrade sweep the dead grants and issue the
  survivors again before the agents need them.
- Sponsor policy. A sponsor pays and gains no authority, but it does see
  and co-sign the transaction and provides the collateral, so it should
  check what it sponsors: the fee, the deposit and the control output's
  lovelace are the only value it should contribute, and the builders
  return its change to it. A sponsor that refuses withdrawals from
  scripts it does not know must allow the logic the control input's
  datum names, and both logics on an upgrade.
- Parameter choices. `max_grants` 16, `max_recipients` 8 and
  `max_revoked` 32 put the heaviest single execution that fits, the
  logic over eight largest grants, at 38 percent of the memory budget in
  the `aiken check` runner, and the heaviest owner transaction that
  fits, an eight grant sweep, at 46 percent locally and 40 to 56 percent
  on preprod. Lower a bound or the batch size if a later measurement
  approaches the limit; the bounds belong to the logic and move with a
  version. Grant caps and expiries are the owner's choice; a grant with
  an empty recipient list lets the grantee send up to its caps anywhere,
  including unspendable addresses, and a recipient that is a script
  address makes the funds subject to that script's datum, so prefer key
  addresses as recipients.
- Fund contention and fragmentation. Every path draws from the same
  plain deposits, so an owner operation paid from a fund UTxO can lose it
  to an agent spend and must be rebuilt; a reserve or a sponsor removes
  the owner from that race. A grantee may split the balance into many
  deposits at zero outflow, or run no-op spends against its own grant
  UTxO, raising the owner's sweeping cost; caps do not bound this since
  nothing leaves, neither touches the control UTxO, and the owner's
  remedy is to revoke the grant and sweep.
- Fee bound. The caps lose the fee bound the builder decrements by, not
  the fee the transaction ends up paying, on every spend; size caps with
  that margin, and raise the bound only for spends over many inputs.
- No rolling period caps. A grant has per call caps, cumulative caps and
  an expiry, nothing per day or per epoch. A grantee can exhaust the
  cumulative cap at once, in as many transactions as the per call cap
  requires. Issue grants with the cumulative cap sized to the tolerable
  loss, and short expiries, and re-issue rather than over-grant.
- Accepted and harmless. A grantee may create its own account in the
  same transaction as a grant spend: the proxy demands a registration
  the grantee's own stake script authorised and a control output at the
  grantee's own account address, and this account's accounting is
  unaffected. An output to the proxy with a pointer stake credential is
  not the account address, so it counts as leaving and is refused by a
  recipient list; under an empty list it is bounded by the caps like any
  other destination, and it can never be spent. An inverted validity
  range, with a lower bound above a finite upper bound no later than the
  expiry, is accepted by the logic but can never apply on the ledger,
  since no slot lies within it. A grantee may decrement its own caps
  further than the outflow, which costs it headroom and nothing else. A
  withdrawal of a non zero amount from the logic credential runs the
  logic like a zero one; the reward account is the logic's own and earns
  nothing.

## Audit scope

The permanent part, which no upgrade can change and which every account
on every version depends on:

- The proxy, `validators/account.ak`, with the helpers it calls in
  `lib/cardano_account_custody_contract/account.ak`: the naming and the
  quantity of the tokens, the placement of every account token on every
  path, the control output pinned on every spend of the state NFT, the
  single creation under a witnessed registration, the `Fund` rule, and
  that the logic named by the first field of the control datum runs on
  every other spend and mint.
- The stake script, `validators/account_stake.ak`: the registration arms,
  the device rule read from the second field of the control datum, and
  the refusal of every other certificate.
- The stable prefixes in `lib/cardano_account_custody_contract/types.ak`:
  `AccountState` fields 0 to 2 and `Grant` fields 0 to 2, and the
  positional readers `account.logic_of`, `account.devices_of`,
  `account.generation_of`, `account.grant_slot_of` and
  `account.grant_generation_of`.
- The invariant that no transaction changes the first field of a control
  datum without both the logic it leaves and the logic it arrives at
  running: the proxy's withdrawal rule on the spent datum, and every
  version's leaving rule on the arriving datum.

The first version, `validators/logic_v1.ak` with
`lib/cardano_account_custody_contract/{rules,grant,state}.ak`: the owner,
agent and arrival arms, the one control UTxO per transaction rule, the
rules of each path, the bounds, the upgrade branch of
`rules.recreates_control_output` and the arrival branch's checks on a
state it did not write, and the `publish` handler.

A later version is audited on its own: its rules, its arrival branch,
that it keeps the stable prefixes and that its leaving rule requires the
arriving logic to run. The proxy and the stake script are not reopened
by it.
