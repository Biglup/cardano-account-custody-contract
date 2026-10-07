# Security review

An adversarial review of the account validator and the account stake
validator, organised by the vulnerability classes of the Cardano developer
portal's smart contract security curriculum. Every class was attacked with
concrete transactions written as Aiken tests in
`validators/attacks.test.ak`; each `attack_` test asserts that a validator
refuses the transaction. The document only claims what those tests and the
reasoning below establish.

## Scope and versions

- Validators: `validators/account.ak`, the multi purpose account validator
  with the mint handler (`CreateAccount`) and the spend handler (`Device`,
  `SpendWithGrant`, `Fund`), script hash
  `0524f57b785cf3a45b7ed6029b387dc39ffb2411bd1cb4300c58c2c3` in
  `plutus.json`; and `validators/account_stake.ak`, the parameterised stake
  validator with the `withdraw` and `publish` handlers, whose blueprint
  entry (hash `20a07577cb1e025ba228b9daba63a1fa8c2b481b6dd4b206f81d92da`)
  is the unapplied code, so every account's stake credential is the hash
  of that code applied to its `owner` and `account_hash`.
- Libraries: `lib/cardano_account_custody_contract/{types,state,account,grant}.ak`.
- Toolchain: Aiken v1.1.24, Plutus V3, aiken-lang/stdlib v4.0.0.
- Tests: 306 checks under `aiken check -D`. `validators/attacks.test.ak`
  holds 65 of them: 52 `attack_` tests and 13 `budget_` tests.
  `validators/account_stake.test.ak` holds 25 and
  `validators/account.test.ak` 83, the functional suites of the two
  validators; the `lib/**/*.test.ak` files hold the remaining 133 (61 for
  `account.ak`, 41 for `grant.ak`, 23 for `state.ak`, 8 for the test
  helpers). Functional tests are cited below where they already cover an
  attack variant.
- Out of scope: the off-chain transaction builder, key management, and
  the ledger rules the validators rely on (balance, witnesses, datum
  availability, validity interval enforcement, single registration of a
  stake credential, which script runs on which certificate). Those rules
  are named where a mitigation depends on them.

Two conventions for the tests: an `attack_` test asserts `!handler(...)`
when the handler returns False, and is declared `fail` when the handler
aborts on an `expect`. Both outcomes make the ledger reject the
transaction in phase two. The `!handler` form is preferred and used
wherever the attack reaches a returned False. The wrappers `mint`, `spend`,
`register` and `withdraw` in `validators/attacks.test.ak` call the
handlers of the two validators with the fixtures' script hash, stake
credential and owner key.

## Threat model

Keys and who holds them:

- The owner key, the verification key hash the account's stake script is
  applied to. In the intended deployment it is the first device, derived
  from a passkey. On its own it authorises exactly one thing: publishing
  the registration of the account's stake credential, which is the act of
  creation. After creation it has no authority beyond its place in
  `AccountState.devices`, from which a device rewrite may remove it.
- Device keys (`AccountState.devices`, up to eight). Held by the owner.
  Any one device key has full authority: it can spend every deposit,
  rewrite the state (add or remove devices, issue, revoke or revoke all
  grants), withdraw the account's staking rewards and delegate its stake
  credential. Nothing bounds a device spend except well formedness of the
  new state.
- Grantee keys (`Grant.grantee`). An Ed25519 key hash held by an agent or
  by a custody service on its behalf. A grantee can spend only within its
  grant's scope: the per call cap and the remaining cap of one asset, the
  lovelace per call cap and the remaining lovelace cap when that asset is
  not lovelace, nothing of any other asset, before the expiry, only to the
  listed recipients when the list is non empty, and only by recreating the
  state with its own remaining caps reduced. A grantee cannot change
  devices or grants, cannot withdraw rewards or delegate, and cannot
  create a control UTxO.
- A sponsor, a wallet that pays the fee, the collateral, the registration
  deposit and the control output's lovelace in place of the account or
  the device wallet. It holds no authority: every path still needs one of
  the keys above, and the sponsor only sees a transaction it could not
  alter without invalidating those signatures.
- A dApp or transaction builder with no key. It can assemble and submit
  transactions, add inputs from its own wallet and choose which deposits
  of the account to include, but every path needs one of the keys above.

There is no stake key: the account's stake credential is the hash of its
own stake script, and the only authority over the reward account and the
certificates is the device rule the script enforces. There is no
deletion: no redeemer burns the state NFT and the stake script refuses
every deregistration, so the account, its credential and its control UTxO
are permanent.

Single registration. The ledger registers a stake credential at most once
and refuses a second registration while it is registered. `CreateAccount`
requires a publish redeemer for a certificate registering the account's
credential, which exists only when the stake script ran on that
certificate and checked the owner's signature. While the account exists
the credential is registered, the stake script refuses to deregister it,
and so no transaction can carry the registration a second `CreateAccount`
would need. A parallel control UTxO is therefore impossible for anyone,
the owner key included, and the account validator never has to prove a
negative about its own tokens.

The invariant the account validator enforces about its tokens: a state NFT
named N only ever sits at the account address of N (payment script plus
stake script N), in exactly one control UTxO
(`account.state_nfts_sit_at_their_own_addresses`, checked on every
creation and on the inputs and outputs of every device and grant spend),
and is never burned.

## Double satisfaction

Attack. Two accounts grant the same agent and restrict it to the same
recipient. One 2 ADA output to that recipient is offered as the payout of
both grants and the other 2 ADA go to the attacker. A second variant
spends a deposit of account B with `Fund` while only account A's control
UTxO is in the transaction.

Mitigation. The grant accounting never matches outputs against a claim:
`grant.leaving_value` sums every input at the account's full address and
subtracts every output paid back to it, so each account sees its own net
outflow whatever the other outputs are. Any surplus has to appear in an
output, which `grant.pays_only_recipients` refuses when it is not a
listed recipient, or in the fee, which still counts as leaving. `Fund`
looks for a control UTxO of the deposit's own stake credential
(`account.has_control_input`), so another account's control UTxO never
authorises it.

Tests. `attack_double_satisfaction_one_recipient_output_for_two_accounts`
(both handlers return False),
`attack_double_satisfaction_fund_of_another_account_rides_on_this_control`
(`!`). The companion in the functional suite is
`fund_rejects_the_control_utxo_of_another_account`.

## Missing UTxO authentication

Attack. A deposit at the account address carries an inline state naming
the attacker as the only device, or granting the attacker a huge cap,
and is spent on the owner or the agent path. Other variants: the control
UTxO is only a reference input of a fund spend; a token of another policy
named after the stake credential poses as the state NFT; the mint handler
is asked to burn an NFT whose input sits at a key address; a deposit
posing as the control UTxO, or a control UTxO of another account, is
offered to the stake script.

Mitigation. The control UTxO is identified by the state NFT, not by its
datum: `Device` and `SpendWithGrant` require `account.holds_state_nft` on
the spent input, with the policy id equal to the validator's own script
hash. `Fund` requires the control UTxO among `inputs`, where the ledger
runs its handler, never among `reference_inputs`. The mint handler
refuses every burn. The stake script's device rule
(`account.is_authorised_by_a_device`, through `account.find_control_input`)
accepts a control UTxO from the inputs or the reference inputs, since it
only reads the device list, and recognises it by the state NFT of its own
account at its own address. The NFT cannot be forged (see token forgery)
and by the placement invariant it never sits at a key address.

Tests.
`attack_missing_utxo_authentication_forged_control_without_the_nft_device`
(`!`),
`attack_missing_utxo_authentication_forged_control_without_the_nft_grant`
(`fail`: without the NFT among the inputs no output can carry it, and
the handler aborts in `find_control_output`),
`attack_missing_utxo_authentication_fund_with_the_control_as_a_reference_input`
(`!`),
`attack_missing_utxo_authentication_lookalike_nft_from_another_policy`
(`!`),
`attack_missing_utxo_authentication_burn_with_the_nft_at_a_key_address`
(`!`). For the stake script: `withdraw_rejects_a_deposit_posing_as_the_control`,
`withdraw_rejects_a_control_that_lacks_the_state_nft`,
`withdraw_rejects_another_accounts_control` and
`publish_rejects_a_delegation_over_another_accounts_control` (all `fail`,
since the device rule aborts when no control UTxO of the account is
found) in `validators/account_stake.test.ak`.

## Datum hijacking

Attack. A grant spend recreates the control UTxO with a state that
issues the grantee a new grant, or raises its own cap; moves the NFT and
the state to another account's address; gives the state by hash; and a
device rewrite stores a state padded with an extra constructor field.

Mitigation. On the agent path `grant.carries_state` compares the control
output's inline datum, as data, with `grant.state_after_spend` applied to
the spent state, so only the used grant's remaining caps may differ, and
only downwards. `account.find_control_output` demands exactly one output
holding the NFT at the account address of the spent stake credential.
`account.state_datum` and the `expect state: AccountState` in the
validator decode the datum strictly, so a datum with trailing fields
aborts.

Tests. `attack_datum_hijacking_grant_spend_issues_itself_a_grant` (`!`),
`attack_datum_hijacking_grant_spend_raises_its_own_cap` (`!`),
`attack_datum_hijacking_grant_spend_relocates_the_state_to_another_account_address`
(`fail`),
`attack_datum_hijacking_grant_spend_control_datum_given_by_hash` (`!`),
`attack_datum_hijacking_padded_state_datum_on_a_device_rewrite` (`fail`).
Functional companions: `spend_with_grant_rejects_changed_devices`,
`spend_with_grant_rejects_another_grants_caps_changed`,
`spend_with_grant_rejects_reordered_grants`,
`spend_with_grant_rejects_a_changed_grant_generation`.

The datum hijacking of the account's own deposits, where a grant spend
returned the balance to the account address under a datum hash, is the
finding recorded under Locked value.

## Token forgery and other token names

Attack. Create an account at the victim's address, under the attacker's
device, with only the attacker's signature; mint an NFT named after the
attacker's credential into the victim's address; mint a second NFT of the
account during a grant spend to end up with a control UTxO under the
grantee's state; create the control output at an address whose stake part
is a verification key credential with the stake credential's bytes; park
a token of another policy named after the stake credential on the control
output; mint a parallel control UTxO for an existing account with a
device signature but no registration; the same with a registration listed
among the certificates in the legacy format, which runs no script.

Mitigation. The mint handler accepts exactly one asset name per
transaction (`expect [Pair(stake_script_hash, quantity)]`), requires a
publish redeemer for a certificate registering `Script(stake_script_hash)`
(`account.registers_stake_credential`), and requires exactly one control
output at `account.account_address(policy, name)`, whose stake part is an
inline script credential only. The registration is where the owner is
checked: the stake script's `publish` handler accepts a
`RegisterCredential` or `RegisterAndDelegateCredential` only with `owner`
among the required signers, and the mint handler only accepts a creation
the stake script ran on, by looking for its redeemer rather than for the
certificate. The control output's value must satisfy
`account.holds_only_lovelace_and_state_nft` (`assets.has_nft_strict`),
which refuses any other token whatever its name or policy. A second
creation of an existing account is refused because the ledger will not
register a registered credential, so the transaction cannot carry the
registration the mint handler demands; the single registration property
in the threat model replaces the trust assumption a key stake credential
needed.

Tests. `attack_token_forgery_victims_address_with_the_attackers_signature`
(the mint handler accepts and `register` refuses, so the transaction
fails), `attack_token_forgery_attackers_name_into_the_victims_address`
(`fail`), `attack_token_forgery_second_nft_minted_during_a_grant_spend`
(both handlers return False),
`attack_token_forgery_create_account_with_a_key_stake_credential`
(`fail`),
`attack_token_forgery_lookalike_token_named_after_the_stake_credential_on_the_control`
(`!`), `attack_token_forgery_parallel_control_utxo_without_a_registration`
(`!`),
`attack_token_forgery_parallel_control_utxo_with_an_unwitnessed_registration`
(`!`). Functional companions: `create_account_rejects_a_missing_registration`,
`create_account_rejects_a_registration_of_another_credential`,
`create_account_rejects_a_registration_the_stake_script_did_not_run_on`,
`create_account_rejects_a_quantity_of_two`,
`create_account_rejects_two_asset_names_under_the_policy`,
`create_account_rejects_a_burn_beside_the_mint`,
`create_account_rejects_a_burn`,
`publish_rejects_a_registration_without_the_owner_signature`,
`publish_rejects_a_registration_signed_by_a_device_over_the_control`, and
the `registers_credential_*` and `registers_stake_credential_*` unit tests
in `lib/cardano_account_custody_contract/account.test.ak`, among them
`registers_stake_credential_ignores_a_certificate_without_a_redeemer`.

## Other redeemer

Attack. Withdraw the account's rewards with a grantee signature over a
referenced control UTxO; spend the control UTxO with `Fund`, the redeemer
that carries no authorisation; spend a plain deposit with `Device`; spend
a deposit carrying a forged state with `SpendWithGrant`; burn the state
NFT with the control UTxO spent on the agent path; use `CreateAccount` on
a burn with everything a creation needs beside it; run either validator
under a purpose it has no handler for.

Mitigation. The stake script's `withdraw` handler applies the device
rule, which reads the devices from the control UTxO and ignores grantees.
`Fund` requires that the spent input does not hold the NFT and `Device`
and `SpendWithGrant` require that it does, so each redeemer is tied to one
kind of UTxO. `Device` and `SpendWithGrant` require a datum that decodes
as `AccountState`. The mint handler matches the redeemer against the
minted quantity and accepts `(CreateAccount, 1)` only, so no burn passes
on any redeemer; `SpendWithGrant` additionally requires a control output
holding the NFT, which a burn makes impossible. Both validators fail in
their `else` handler.

Tests. `attack_other_redeemer_withdraw_rewards_with_a_grantee_signature`
(`!`), `attack_other_redeemer_fund_on_the_control_utxo` (`!`),
`attack_other_redeemer_device_on_a_plain_deposit` (`fail`),
`attack_other_redeemer_grant_on_a_deposit_with_a_forged_state` (`!`),
`attack_other_redeemer_burn_with_the_control_spent_by_grant` (`!`),
`attack_other_redeemer_grant_spend_with_the_state_nft_burned` (`fail`),
`attack_other_redeemer_create_account_on_a_burn` (`!`). Functional
companions: `mint_rejects_a_burn_of_the_state_nft_from_the_control_utxo`,
`mint_rejects_a_burn_of_two`,
`device_rejects_a_missing_control_output_even_when_the_state_nft_is_burned`,
`else_fails_for_any_other_purpose` for the stake script.

## Missed input validation

Attack. The grantee pays exactly the per call cap and lets the account
pay the fee; drains lovelace from the control UTxO on top of the cap;
uses a grant scoped to one asset name to move a sibling asset name under
the same policy; spends a token grant's whole remaining lovelace cap in
one transaction above its lovelace per call cap; pays part of a spend
within the per call cap to the bare script address to dodge the recipient
list; and the owner path is asked to store grants with a negative cap, no
expiry, a lovelace cap on a lovelace scope, or two grants in one slot.

Mitigation. `grant.leaving_value` is a net sum over the full account
address, so the fee and the control UTxO's own lovelace count as leaving
and the per call cap in `grant.stays_within_scope` is the rule that
refuses both the fee and the control drain attempts; the recreated state
in those tests carries the correct cap decrement, so nothing else
refuses them. For a token scope `stays_within_scope` bounds lovelace by
both the lovelace per call cap and the remaining lovelace cap. The scoped
asset is compared as a full asset class, policy id and asset name, and
`nothing_else_leaves` refuses any other class with a positive outflow.
The bare script address differs from the account address, so an output
there counts as leaving and must be a listed recipient; the test keeps
the outflow within the per call cap, so `grant.pays_only_recipients` is
the only rule that refuses it. `state.is_well_formed` is applied to every
state written on the owner path and at creation.

Tests.
`attack_missed_input_validation_fee_paid_by_the_account_beyond_the_cap`
(`!`),
`attack_missed_input_validation_control_lovelace_drained_beyond_the_cap`
(`!`),
`attack_missed_input_validation_token_grant_leaks_a_sibling_asset_name`
(`!`),
`attack_missed_input_validation_token_grant_burns_its_lovelace_budget_in_one_call`
(`!`), `attack_missed_input_validation_change_to_the_bare_script_address`
(`!`), `attack_missed_input_validation_ill_formed_grants_on_a_device_rewrite`
(`!` for each of the four states). Functional companions:
`spend_with_grant_rejects_one_lovelace_above_the_per_call_cap`,
`spend_with_grant_rejects_spending_above_the_remaining_cap`,
`spend_with_grant_rejects_one_lovelace_above_the_lovelace_per_call_cap`,
`spend_with_grant_rejects_lovelace_above_the_remaining_lovelace_cap_on_a_token_grant`,
`spend_with_grant_rejects_a_foreign_asset_leaving`,
`spend_with_grant_rejects_a_cap_raised_by_a_net_deposit`.

## Time handling

Attack. A grant spend with no upper bound; a lower bound past the expiry
and no upper bound; an exclusive upper bound one past the expiry, which
covers the same instants as an inclusive bound at the expiry; a
degenerate range whose upper bound is negative infinity.

Mitigation. `grant.ends_before_expiry` accepts only a `Finite` upper
bound whose value is at most `expires_at`, regardless of inclusiveness,
so an exclusive bound at `expires_at + 1` is refused although it is
equivalent; this is the conservative reading. The lower bound is not
consulted: it cannot extend the range past the upper bound, and the
ledger refuses any transaction whose range does not contain the current
slot. The bound is compared in POSIX milliseconds, the unit of
`expires_at`.

Tests. `attack_time_handling_no_upper_bound` (`!`),
`attack_time_handling_lower_bound_past_expiry_with_no_upper_bound` (`!`),
`attack_time_handling_exclusive_upper_bound_one_past_expiry` (`!`),
`attack_time_handling_negative_infinity_upper_bound` (`!`). Functional
companions: `spend_with_grant_rejects_a_validity_range_ending_after_the_expiry`,
`spend_with_grant_accepts_a_validity_range_ending_at_the_expiry`.

## Unbounded datum, inputs and value

Attack. A device rewrite or an account creation storing seventeen
grants, nine devices or a grant with nine recipients; a bundle of tokens
under twenty policies parked on the control output at creation; twenty
deposits spent at once without the control UTxO.

Mitigation. `state.is_well_formed` bounds the state to `max_devices`
(8), `max_grants` (16) and `max_recipients` (8) and is applied on every
write of the state. `assets.has_nft_strict` keeps every token but the
state NFT off the control output on every path. Deposits are not bounded
in number, but every one of them needs the control UTxO in the same
transaction and pays for its own handler execution; the cost of many
deposits is quantified under Resource exhaustion.

Tests. `attack_unbounded_datum_seventeen_grants_on_a_device_rewrite`,
`attack_unbounded_datum_nine_devices_on_a_device_rewrite`,
`attack_unbounded_datum_nine_recipients_on_a_device_rewrite`,
`attack_unbounded_datum_seventeen_grants_at_creation`,
`attack_unbounded_value_token_bundle_on_the_control_at_creation`,
`attack_unbounded_inputs_deposits_spent_without_a_control` (all `!`).
Functional companions: `device_rejects_extra_tokens_on_the_control_output`,
`spend_with_grant_rejects_extra_tokens_on_the_control_output`, and the
bound tests in `lib/cardano_account_custody_contract/state.test.ak`.

## UTxO contention

Reasoning, no rejection test is possible. Every owner and agent
operation spends the one control UTxO, so two operations on the same
account cannot be in flight at once: the second is rejected by the
ledger as a double spend and must be rebuilt. A withdrawal or delegation
built with the control UTxO as a reference input would not contend, but
the off-chain builders spend it so that the account can pay the fee. This
is a liveness property, not a safety one; nothing an attacker without a
key can do causes the control UTxO to be spent. A grantee, however, may
submit a grant spend with a net outflow of zero, which leaves the state
byte for byte identical and is accepted, and may do so repeatedly to keep
the control UTxO moving and race the owner's revoke. The loss is bounded
by the caps the owner granted and ends when the owner's rewrite lands.
The validator refuses to spend two control UTxOs of one account in a
grant spend (`grant.spends_one_control_utxo`, test
`spend_with_grant_rejects_two_control_utxos_of_the_account`), so the
accounting always runs over a single state. That rule is defence in
depth and no test isolates it: a second control UTxO among the inputs
brings a second state NFT that the single control output cannot take
back, so `nothing_else_leaves` already refuses the transaction.

## Locked value

Attack. A grant spend pays the whole balance back to the account address
under a datum hash, or under an inline datum; a grant spend sends the
balance to the bare script address; a device rewrite removes every
device; an account is created without devices.

Mitigation. The datum hash case was a live finding, fixed by
`grant.deposits_carry_no_datum`: on the agent path every output at the
account address that does not hold the state NFT must carry `NoDatum`.
A script output under a datum hash can only be spent by whoever supplies
the preimage, and none of it counts as leaving, so without the rule a
grantee with any cap at all could put the entire balance beyond reach.
Inline datums are refused by the same rule: a deposit has no use for one.
The Device path is deliberately exempt from `deposits_carry_no_datum`:
the owner has unrestricted authority over the account and may tag
deposits with a datum. The bare script address is not the account
address, so sending the whole balance there counts as leaving and the
per call cap is what refuses it; with a recipient list the destination
is refused as well, and through an open grant the loss stays bounded by
the caps. `state.is_well_formed` requires at least one device on every
write and at creation.

Permanence is the structural mitigation for the rest of this class.
Every fund UTxO needs the control UTxO in the same transaction, and the
control UTxO always exists: it is created with the account, every spend
recreates it, no redeemer burns the NFT and the stake script refuses the
deregistration that a second creation would need. A deposit that arrives
at any time after creation is therefore spendable through the normal
paths, with no window in which the account is absent. The cost is that
the registration deposit and the control UTxO's minimum lovelace are
locked for the life of the account.

What remains possible and is accepted: a grant with an empty recipient
list may send up to its caps to any address, including unspendable ones;
a device may send anything anywhere; a deposit made by a third party
under a datum hash without a known preimage is that party's own loss.
Deposits sent to the script address with no stake part or with a stake
part other than an inline script credential can never be spent, on any
path, because `account.stake_script_hash_of` aborts (tests
`stake_script_hash_of_fails_without_a_stake_credential`,
`stake_script_hash_of_fails_for_a_key_stake_credential`,
`stake_script_hash_of_fails_for_a_pointer_stake_credential`,
`spend_rejects_an_input_without_a_stake_credential`); that is an
off-chain obligation (see recommendations). Funds deposited to an address
whose credential a third party pre registered before the account existed
are locked, since the account can never be created there; see the
residual risks.

Tests. `attack_locked_value_grant_spend_deposits_under_a_datum_hash`
(`!`), `attack_locked_value_grant_spend_deposits_under_an_inline_datum`
(`!`),
`attack_locked_value_grant_spend_sends_the_balance_to_the_bare_script_address`
(`!`), `attack_locked_value_device_rewrite_removes_every_device` (`!`),
`attack_locked_value_account_created_without_devices` (`!`). Unit tests
of the datum rule: `deposits_carry_no_datum_*` in
`lib/cardano_account_custody_contract/grant.test.ak`.

## Staking and certificates

Attack. Withdraw the account's rewards with a grantee signature, with the
owner's signature alone and no control UTxO, with no device signature,
over another account's control UTxO, over a deposit posing as the control
UTxO, over a control UTxO without the NFT or without an inline state;
delegate under the same variants; register the credential without the
owner, or with a device signature over the control UTxO instead of the
owner's; deregister the credential with a device over the control UTxO,
without a device, or with the owner alone; register a delegate
representative under the credential; run the stake script under a purpose
other than withdraw and publish.

Mitigation. The account's stake credential is the hash of its own stake
script, so the ledger runs that script on every withdrawal from the
reward account and on every certificate naming the credential, and on
nothing else. The `withdraw` handler and the `DelegateCredential` arm of
`publish` apply the device rule, `account.is_authorised_by_a_device`: a
control UTxO of the account must be among the inputs or the reference
inputs, found by its state NFT at its own address, and one of the devices
in its inline state must be a required signer; the rule aborts when no
such control UTxO is present. A withdrawal of zero runs the same rule. The
`RegisterCredential` and `RegisterAndDelegateCredential` arms require
`owner` among the required signers and nothing else, since no control
UTxO exists before creation; the handler does not compare the certificate's
credential with its own hash, which the ledger makes redundant by running
a credential's script only on certificates naming that credential, and a
key credential falls through to the refusing arm. `UnregisterCredential`
and every other certificate kind, including delegate representative and
pool certificates, fall through to `False`. The `else` handler fails. A
`DelegateCredential` covers pool, vote and combined delegations alike, so
a vote delegation needs a device like any other. A withdrawal from an
unrelated reward account added to an agent transaction only adds value
that must balance into the outputs or the fee, both of which the grant
accounting covers, and an Ed25519 grantee signs the whole body anyway.

Tests. In `validators/account_stake.test.ak`:
`publish_accepts_a_registration_signed_by_the_owner`,
`publish_accepts_a_registration_with_a_delegation_signed_by_the_owner`,
`publish_rejects_a_registration_without_the_owner_signature`,
`publish_rejects_a_registration_signed_by_a_device_over_the_control`,
`publish_rejects_a_registration_of_a_key_credential`,
`publish_accepts_a_delegation_signed_by_a_device_over_a_referenced_control`,
`publish_accepts_a_delegation_signed_by_a_device_over_a_spent_control`,
`publish_rejects_a_delegation_without_a_device_signature`,
`publish_rejects_a_delegation_signed_by_the_owner_alone_without_the_control`
(`fail`), `publish_rejects_a_delegation_over_another_accounts_control`
(`fail`),
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
`withdraw_rejects_a_deposit_posing_as_the_control` (`fail`),
`withdraw_rejects_a_key_credential` (`fail`),
`else_fails_for_any_other_purpose` (`fail`). In the attack suite,
`attack_other_redeemer_withdraw_rewards_with_a_grantee_signature` (`!`).
Unit tests of the rule: `is_authorised_by_a_device_*` and
`find_control_input_*` in
`lib/cardano_account_custody_contract/account.test.ak`.

## Evaluation order

Reasoning plus one test. Every check in every handler is a conjunction
(`and { .. }`) or a `when` arm preceded by `expect` bindings; `and` short
circuits on the first False and `expect` aborts, so no later check can
rescue an earlier failure and there is no path on which a check is
skipped. Two dependences exist between handlers. `Fund` relies on the
control UTxO's own handler to do the accounting: the test
`attack_evaluation_order_fund_passes_only_together_with_the_control_spend`
shows `Fund` returning True while the control UTxO's `Device` handler
returns False for lack of a device signature. The mint handler relies on
the stake script's `publish` handler for the owner's signature on
creation: `attack_token_forgery_victims_address_with_the_attackers_signature`
shows the mint handler accepting while `register` refuses. The ledger
accepts a transaction only when every script passes, so the order in
which they run is irrelevant.

## Signature replay across transactions, accounts and networks

Attack. An Ed25519 key granted by one account signs a spend from another
account's control UTxO under the same slot number.

Mitigation. A grantee is an Ed25519 key hash and authorises a spend by
signing the transaction itself (`grant.is_authorised_by_grantee` looks
for it among `extra_signatories`). The ledger binds every witness to the
hash of the transaction body, which includes the inputs being spent, so a
witness authorises exactly one transaction and can be reused neither for
a later control UTxO of the same account nor on another network, where no
input of the transaction exists. The grant is looked up in the state of
the control UTxO being spent, so the same key granted by two accounts
spends under each account's own scope and nothing else. There is no
signature carried in a redeemer and therefore no message of the
validator's own to replay.

Tests. `attack_signature_replay_ed25519_grantee_of_another_account`
(`!`). Functional companions:
`spend_with_grant_rejects_a_grantee_that_did_not_sign`,
`is_authorised_by_grantee_accepts_a_required_signer`,
`is_authorised_by_grantee_rejects_a_grantee_that_did_not_sign`.

## Dust attacks

Attack. An attacker dusts the account with tokens under three policies.
A grant spend over the dusted deposit returns all but one unit of dust,
or pushes the dust onto the control output.

Mitigation. `grant.stays_within_scope` refuses a positive outflow of any
asset class but the scoped one and lovelace, down to a single unit, and
`assets.has_nft_strict` keeps dust off the control output. Dust can
therefore only be moved by a device, and a grantee that includes a
dusted deposit must return every unit of it. The owner's cost is the fee
of sweeping; the attacker's cost is the minimum lovelace of every dust
UTxO, which the owner recovers. Dust deposits carrying a state shaped
datum are the forged control case under Missing UTxO authentication.

Tests. `attack_dust_attack_grant_spend_keeps_one_unit_of_dust` (`!`),
`attack_dust_attack_dust_pushed_onto_the_control_output` (`!`).

## Resource exhaustion

The `budget_` tests build the largest well formed state (eight devices,
sixteen grants, eight recipients each, every key 28 bytes), which
serialises to 6620 bytes of CBOR
(`budget_largest_state_datum_stays_within_the_transaction_size_limit`
asserts it stays under 16 KiB), and run the heaviest handlers over it.
`aiken check -D` reports the execution units below. Each figure includes
the cost of building the fixture, which the `budget_baseline_` tests
measure on their own, and excludes the on-chain cost of decoding the
script context, which the `aiken check` runner does not charge. The net
figures are therefore indicative and must be confirmed on preprod with
the real transaction builder. The mainnet limit per transaction is
14,000,000 memory units and 10,000,000,000 CPU steps.

| Test | mem | cpu | baseline mem | net mem |
| --- | --- | --- | --- | --- |
| `budget_largest_state_grant_spend_lovelace_scope` (9 inputs) | 6,823,833 | 2,217,481,794 | 1,062,640 | 5.8 M |
| `budget_largest_state_grant_spend_token_scope` (2 inputs) | 6,173,354 | 2,001,155,221 | 942,748 | 5.2 M |
| `budget_largest_state_device_rewrite` | 10,835,901 | 3,281,429,472 | 743,749 | 10.1 M |
| `budget_largest_state_account_creation` | 6,160,095 | 1,881,670,968 | 412,846 | 5.7 M |
| `budget_largest_state_fund_spend_among_eight_deposits` | 1,168,860 | 352,495,091 | 1,062,640 | 0.1 M |
| `budget_grant_spend_over_forty_deposits` (small state) | 5,646,839 | 1,853,829,111 | 1,143,594 | 4.5 M |
| `budget_fund_spend_among_forty_deposits` | 1,362,658 | 436,406,794 | 1,143,594 | 0.2 M |

The baselines are `budget_baseline_largest_state_grant_transaction`,
`budget_baseline_largest_state_token_grant_transaction`,
`budget_baseline_largest_state_device_rewrite_transaction`,
`budget_baseline_largest_state_creation_transaction` and
`budget_baseline_forty_deposit_transaction`. The stake script's handlers
are not measured separately: the device rule decodes one state and scans
its device list, a fraction of a `Fund` execution, and a withdrawal or
delegation rides on a device spend whose cost the table already shows.

Observations.

- The device rewrite over the largest state is the heaviest single
  execution at about 10.1 M memory units net, 72 percent of the
  transaction limit, driven by decoding the largest state twice (the
  spent datum and the recreated one) and checking well formedness. It
  fits, so the owner can always rewrite or shrink such a state, but
  only a few `Fund` executions fit beside it. This is the one budget
  concern found; the parameters `max_grants` and `max_recipients` in
  `state.ak` are the levers if on-chain measurement shows it too tight.
- A grant spend with 40 deposits costs about 4.5 M memory units for the
  control UTxO's handler plus about 0.2 M for each of the 40 `Fund`
  executions, about 12.5 M in total, which is close to the limit. Around
  30 deposits per grant spend is a provisional batch size pending
  on-chain measurement; the off-chain builder must batch larger sweeps,
  and with its default fixed budgets it stops at about 14.
- Complexity. `grant.leaving_value` folds `assets.merge` over the
  inputs and outputs at the address; each merge is linear in the number
  of asset entries of both operands, so the whole fold is linear in the
  total number of entries, not quadratic. `account.own_input` and
  `account.has_control_input` are linear scans of the inputs run once
  per `Fund` execution, so the total work of a transaction with n
  deposits grows with n squared; the measured growth is from 0.1 M to
  0.2 M memory units per `Fund` execution between 9 and 41 inputs.
  `state.is_well_formed` uses `list.unique`, which is quadratic, over
  lists bounded at 8 and 16. `grant.pays_only_recipients` is linear in
  outputs times at most 8 recipients.
  `account.state_nfts_sit_at_their_own_addresses` is one dictionary
  lookup per input or output. `account.registers_stake_credential` is a
  linear scan of the redeemers. No helper is unbounded in anything the
  attacker controls except the number of inputs, outputs and redeemers,
  which the transaction size limit bounds and the submitter pays for.

Reference scripts. Every transaction that spends a UTxO pays a fee for
the size of the reference script the UTxO holds. A grantee could attach
a large reference script to the control output it recreates and so
raise the cost of the owner's next spend; the owner could only shed it
by paying that fee once. `grant.carries_no_reference_script`, called
from the `SpendWithGrant` branch of `validators/account.ak`, requires
the recreated control output to carry no reference script. Tests:
`attack_resource_exhaustion_reference_script_on_the_control_output`
(`!`), `spend_with_grant_rejects_a_reference_script_on_the_control_output`,
and the `carries_no_reference_script_*` unit tests in
`lib/cardano_account_custody_contract/grant.test.ak`. Deposits a grant
spend pays back to the account may still carry one, since the owner
chooses which deposits to spend, and the owner's own path is not
constrained.

## Findings that required a code change

1. A grantee could lock the whole balance. `SpendWithGrant` exempted
   every output at the account address from the recipient check and
   counted it as returned, whatever its datum. A grant spend could
   therefore pay every deposit back to the account address under a
   datum hash with no known preimage: nothing counted as leaving, the
   caps stayed untouched, and the funds became unspendable on every
   path, because the ledger refuses to run a script on an input whose
   datum hash has no preimage in the witness set. The exploit was
   reproduced against the committed validator before the fix. Fix:
   `grant.deposits_carry_no_datum`, called from the `SpendWithGrant`
   branch of `validators/account.ak`, requires every output at the
   account address that does not hold the state NFT to carry `NoDatum`.
   Tests: `attack_locked_value_grant_spend_deposits_under_a_datum_hash`,
   `attack_locked_value_grant_spend_deposits_under_an_inline_datum`, and
   the `deposits_carry_no_datum_*` unit tests. `plutus.json` was
   regenerated.
2. A grantee could raise the owner's fees. `SpendWithGrant` accepted a
   control output with a reference script attached, and every later
   spend of the control UTxO would have paid for that script's size.
   Fix: `grant.carries_no_reference_script`, called from the
   `SpendWithGrant` branch of `validators/account.ak`, requires the
   recreated control output to carry no reference script. Tests:
   `attack_resource_exhaustion_reference_script_on_the_control_output`,
   `spend_with_grant_rejects_a_reference_script_on_the_control_output`
   and the `carries_no_reference_script_*` unit tests. `plutus.json` was
   regenerated.

No other attack succeeded.

## Residual risks and recommendations

- Audit before mainnet. This review is internal and test driven; an
  independent audit should precede any mainnet deployment. The contract
  is testnet only at this stage.
- Pre registration of a credential. A stake registration in the legacy
  certificate format carries no deposit field and needs no witness, so
  anyone who learns an account's stake credential before the account
  exists can register it. The owner's Conway registration then fails as
  already registered, `CreateAccount` cannot run without it, a
  deregistration needs a control UTxO that cannot exist, and the address
  is unusable for good: a denial of service, with funds at risk only if
  something was deposited there before creation. The attacker's cost is
  the deposit, locked with the credential. Off-chain rules: create the
  account before ever sharing the address, never deposit to an address
  whose control UTxO does not exist, and when creation fails with an
  already registered credential use the next account index, which gives
  a new owner key and a new address. The preprod script applies the last
  rule by scanning owner indices for an unregistered credential.
- Foreign stake scripts. The mint handler does not read the stake
  script's code; it accepts any script credential whose script published
  the registration. An account created under some other script's
  credential is simply that creator's own account: its NFT has its own
  name, its address is its own, and the placement invariant keeps it
  away from every other account. Its reward account answers to whatever
  that script allows, which concerns no one else.
- Off-chain obligations. Only ever pay to the account's full address,
  with the inline script stake part; funds at the bare script address or
  under any other stake part are unspendable. Batch sweeps of many
  deposits to stay within the execution budget. Validate that a grantee
  hash and every device hash are 28 bytes when issuing or adding them;
  the validators do not check lengths, and an ill sized key only makes
  the grant or device unusable.
- Sponsor policy. A sponsor pays and gains no authority, but it does see
  and co-sign the transaction and provides the collateral, so it should
  check what it sponsors: the fee, the deposit and the control output's
  lovelace are the only value it should contribute, and the builders
  return its change to it.
- Parameter choices. `max_grants` 16 and `max_recipients` 8 put the
  heaviest owner operation at about 72 percent of the memory budget in
  the `aiken check` runner. Measure on preprod with real transactions;
  lower one of the two bounds if the on-chain figure, which includes
  context decoding, approaches the limit. Grant caps and expiries are the
  owner's choice; a grant with an empty recipient list lets the grantee
  send up to its caps anywhere, including unspendable addresses, and a
  recipient that is a script address makes the funds subject to that
  script's datum, so prefer key addresses as recipients.
- One control UTxO serialises every operation. Owner and agent
  operations on an account cannot run concurrently, a grantee can churn
  the control UTxO with zero outflow spends, and a revoke races the
  grantee's pending spends; caps bound the exposure. If concurrency
  matters, the design would need separate per grant UTxOs, which is a
  different contract.
- No rolling period caps. A grant has per call caps, cumulative caps and
  an expiry, nothing per day or per epoch. A grantee can exhaust the
  cumulative cap at once, in as many transactions as the per call cap
  requires. Issue grants with the cumulative cap sized to the tolerable
  loss, and short expiries, and re-issue rather than over-grant.
- Deposit fragmentation. A grantee may split the balance into many
  deposits at the account address, raising the owner's sweeping cost.
  Caps do not bound this since nothing leaves; the owner's remedy is to
  revoke the grant and sweep.
- Accepted and harmless. A grantee may create its own account in the
  same transaction as a grant spend: the mint handler demands a
  registration the grantee's own stake script authorised and a control
  output at the grantee's own account address, and this account's
  accounting is unaffected. An output to the account script with a
  pointer stake credential is not the account address, so it counts as
  leaving and is refused by a recipient list; under an empty list it is
  bounded by the caps like any other destination, and it can never be
  spent. An inverted validity range, with a lower bound above a finite
  upper bound no later than the expiry, is accepted by the validator but
  can never apply on the ledger, since no slot lies within it.
