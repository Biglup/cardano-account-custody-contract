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
  with the mint handler (`CreateAccount`, `IssueGrants`, `BurnGrants`) and
  the spend handler (`Device`, `SpendWithGrant`, `SweepGrant`, `Fund`),
  script hash `6f275cca0cc4433e6a798d78a2db2934df60dc4fd989274a2d9bb434`
  in `plutus.json`; and `validators/account_stake.ak`, the parameterised
  stake validator with the `withdraw` and `publish` handlers, whose
  blueprint entry (hash
  `8a19b7d8fc4ea0808f48b10b76c92f31e2ec2cd8325ea5485e113623`) is the
  unapplied code, so every account's stake credential is the hash of that
  code applied to its `owner` and `account_hash`.
- Libraries: `lib/cardano_account_custody_contract/{types,state,account,grant}.ak`.
- Toolchain: Aiken v1.1.24, Plutus V3, aiken-lang/stdlib v4.0.0,
  aiken-lang/fuzz v3.0.0.
- Tests: 2092 checks under `aiken check -D`, from 607 tests of which 15
  are property tests run 100 times each. `validators/attacks.test.ak`
  holds 127 of the tests: 84 `attack_` tests and 43 `budget_` tests.
  `validators/account_stake.test.ak` holds 40 and
  `validators/account.test.ak` 198, the functional suites of the two
  validators; the `lib/**/*.test.ak` files hold the remaining 242 (108 for
  `account.ak`, 89 for `grant.ak` including 12 property tests over the
  cap arithmetic, the time rules and the token names, 31 for `state.ak`,
  14 for the test helpers). Functional tests are cited below where they
  already cover an attack variant.
- Out of scope: the off-chain transaction builder, key management, and
  the ledger rules the validators rely on (balance, witnesses, datum
  availability, validity interval enforcement, single registration of a
  stake credential, which script runs on which certificate, one redeemer
  per mint policy per transaction). Those rules are named where a
  mitigation depends on them.

Two conventions for the tests: an `attack_` test asserts `!handler(...)`
when the handler returns False, and is declared `fail` when the handler
aborts on an `expect`. Both outcomes make the ledger reject the
transaction in phase two. The `!handler` form is preferred and used
wherever the attack reaches a returned False. The wrappers `mint`, `spend`,
`spend_grant`, `register` and `withdraw` in `validators/attacks.test.ak`
call the handlers of the two validators with the fixtures' script hash,
stake credential and owner key.

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
- Device keys (`AccountState.devices`, up to eight). Held by the owner.
  Any one device key has full authority: it can spend every deposit and
  reserve, rewrite the state (add or remove devices, revoke one slot or
  every grant), issue grants into new grant UTxOs, sweep dead grant
  UTxOs, withdraw the account's staking rewards and delegate its stake
  credential. Nothing bounds a device spend except well formedness of the
  new state and counters that follow the grant tokens minted and burned.
- Grantee keys (`Grant.grantee`). An Ed25519 key hash held by an agent or
  by a custody service on its behalf. A grantee can spend only within its
  grant's scope: the per call cap and the remaining cap of one asset, the
  lovelace per call cap and the remaining lovelace cap when that asset is
  not lovelace, nothing of any other asset, before the expiry, only to the
  listed recipients when the list is non empty, only while the referenced
  control UTxO carries the grant's generation without its slot revoked,
  and only by recreating its own grant UTxO with its remaining caps
  reduced. A grantee cannot change devices or grants, cannot withdraw
  rewards or delegate, cannot spend the control UTxO, a reserve or
  another grant UTxO, cannot mint or burn, and cannot create a control
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
certificate and checked the owner's signature, the mint and the device
list. While the account exists the credential is registered, the stake
script refuses to deregister it, and so no transaction can carry the
registration a second `CreateAccount` would need. A parallel control UTxO
is therefore impossible for anyone, the owner key included, and the
account validator never has to prove a negative about its own tokens.

The properties the account validator enforces about its UTxOs:

- Placement. A state NFT named N only ever sits at the account address of
  N (payment script plus stake script N), in exactly one control UTxO,
  and a grant token prefixed by N only ever sits at that same address, in
  quantity one (`account.tokens_sit_at_their_own_addresses`, checked on
  the outputs of every creation and on the inputs and outputs of every
  device and grant spend; `issues_grant` on each grant output at
  issuance). The state NFT is never burned; a grant token is burned only
  by a sweep.
- Naming. A state NFT name is 28 bytes, a grant token name 32: the
  account's stake script hash followed by the slot as four big endian
  bytes (`account.grant_token_name`, `is_state_nft_name`,
  `is_grant_name`). Slots come from the control UTxO's `next_slot`, which
  only grows, so a slot is never issued twice; `IssueGrants` requires the
  minted names to be exactly the next slots in order.
- Agent confinement. A grant spend runs on a grant UTxO holding only
  lovelace and its token, which must be the only input holding an account
  token (`grant.spends_one_account_token`); the control UTxO is a
  reference input, found exactly once (`grant.referenced_control`); every
  other input at the address is a plain deposit, since a deposit with a
  datum needs the control UTxO spent (`account.has_control_input` under
  `Fund`). An agent spend therefore never spends the control UTxO, a
  reserve or another grant UTxO.
- Revocation kills. A grant spend requires `grant.is_current` against the
  referenced control state: the same generation and a slot outside the
  revoked list. A revoke rewrites the control UTxO, so every spend built
  against the previous control UTxO loses its reference input, and every
  spend built against the new one finds the grant dead.
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
  drains nor accumulates value through agent spends.

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
account's handler sees its own net outflow whatever the other outputs
are, and `grant.carries_grant_within` requires the grant output to
record that outflow: its remaining caps may sit anywhere from zero up to
the spent caps less the net outflow of each asset, never above. A grant
handed back unchanged beside a positive outflow fails that rule alone.
Any surplus has to appear in an output, which `grant.pays_only_recipients`
refuses when it is not a listed recipient, or in the fee, which still
counts as leaving. `Fund` looks for an account token of the deposit's
own stake credential (`account.has_account_token_input` with no datum,
`account.has_control_input` with one), so another account's control or
grant UTxO never authorises it.

Tests. `attack_double_satisfaction_one_recipient_output_for_two_accounts`:
the first account's handler passes, since its grant records the 2 ADA
that left it, and the second's returns False on the cap rule, since
2 ADA left it against an unchanged grant.
`attack_double_satisfaction_a_deposit_into_another_account_offsets_the_outflow`:
the second account's handler sees a net deposit and passes, the first's
returns False on the cap rule.
`attack_double_satisfaction_fund_of_another_account_rides_on_this_control`
and `attack_double_satisfaction_fund_of_another_account_rides_on_this_grant`
(`!`). The companions in the functional suite are
`spend_with_grant_accepts_two_accounts_each_paying_their_own_recipient_output`,
`fund_rejects_the_control_utxo_of_another_account` and
`fund_rejects_a_grant_utxo_of_another_account`.

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
tokens, not by their datums: `Device` requires `account.holds_state_nft`
on the spent input and `SpendWithGrant` and `SweepGrant` require
`account.holds_only_lovelace_and_grant_token` of the datum's slot, with
the policy id equal to the validator's own script hash. `Fund` requires
an account token among `inputs`, where the ledger runs its handler, never
among `reference_inputs`. The mint handler refuses every burn but a
`BurnGrants` of grant names with the control UTxO spent, and the placement
rule refuses a token of the account at a key address among the inputs of
a device spend. The stake script's device rule
(`account.is_authorised_by_a_device`, through `account.find_control_input`)
accepts a control UTxO from the inputs or the reference inputs, since it
only reads the device list, and recognises it by the state NFT of its own
account at its own address; a grant UTxO does not pass for it. The tokens
cannot be forged (see token forgery) and by the placement invariant never
sit at a key address.

Tests.
`attack_missing_utxo_authentication_forged_control_without_the_nft_device`
(`!`), `attack_missing_utxo_authentication_forged_grant_without_the_token`
(`fail`: the spent input lacks the token, so no single grant output of
its slot exists and the handler aborts),
`attack_missing_utxo_authentication_forged_grant_beside_the_real_one`
(`!`),
`attack_missing_utxo_authentication_fund_with_the_control_as_a_reference_input`
(`!`), `attack_missing_utxo_authentication_lookalike_nft_from_another_policy`
(`!`),
`attack_missing_utxo_authentication_lookalike_grant_token_from_another_policy`
(`!`), `attack_missing_utxo_authentication_burn_with_the_nft_at_a_key_address`
(`!`),
`attack_missing_utxo_authentication_burn_grants_with_the_nft_at_a_key_address`
(`fail`). For the stake script:
`withdraw_rejects_a_deposit_posing_as_the_control`,
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
the grant token, and the handler requires that output at the spent
input's own address with the same value. `account.state_datum`, the
`expect grant: Grant` in the handler and the `expect` in `issues_grant`
decode datums strictly, so a datum with trailing fields aborts.

Tests. `attack_datum_hijacking_grant_spend_raises_its_own_cap` (`!`),
`attack_datum_hijacking_grant_spend_advances_its_own_generation` (`!`),
`attack_datum_hijacking_grant_spend_rewrites_its_grantee` (`!`),
`attack_datum_hijacking_grant_spend_relocates_the_grant_to_another_account_address`
(`!`), `attack_datum_hijacking_grant_spend_grant_datum_given_by_hash`
(`!`), `attack_datum_hijacking_padded_state_datum_on_a_device_rewrite`
(`fail`), `attack_datum_hijacking_padded_grant_datum_at_issuance`
(`fail`). Functional companions:
`spend_with_grant_rejects_a_changed_generation`,
`spend_with_grant_rejects_a_changed_grantee`,
`spend_with_grant_rejects_a_changed_slot_in_the_datum`,
`spend_with_grant_rejects_a_changed_per_call_cap`,
`spend_with_grant_rejects_a_changed_expiry`,
`spend_with_grant_rejects_changed_recipients`,
`spend_with_grant_rejects_the_grant_output_at_another_accounts_address`,
and the `carries_grant_within_*` unit tests in
`lib/cardano_account_custody_contract/grant.test.ak`.

The datum hijacking of the account's own deposits, where a grant spend
returned the balance to the account address under a datum hash, is the
finding recorded under Locked value.

## Token forgery and other token names

Attack. Create an account at the victim's address, under the attacker's
device, with only the attacker's signature; sign the creation as the
owner but leave the owner out of the device list; mint an NFT named after
the attacker's credential into the victim's address; mint a second state
NFT, or a grant token, during a grant spend; issue grants without the
control UTxO, with the grantee's signature, named after another account,
reusing an issued slot, or without moving the counters; create the
control output at an address whose stake part is a verification key
credential with the stake credential's bytes; park a token of another
policy named after the stake credential on the control output; mint a
parallel control UTxO for an existing account with a device signature but
no registration; the same with a registration listed among the
certificates in the legacy format, which runs no script; mint a state NFT
name under `IssueGrants`.

Mitigation. Under `CreateAccount` the mint handler accepts exactly one
asset name of 28 bytes in quantity one, requires a publish redeemer for a
certificate registering `Script(stake_script_hash)`
(`account.registers_stake_credential`), and requires exactly one control
output at `account.account_address(policy, name)`, whose stake part is an
inline script credential only, with zero counters. The registration is
where the owner is checked: the stake script's `publish` handler accepts
a `RegisterCredential` or `RegisterAndDelegateCredential` only with
`owner` among the required signers, the mint of exactly one state NFT of
its own credential and `owner` in the device list of the control output
(`creates_the_account`, `lists_the_owner_as_a_device`), and the mint
handler only accepts a creation the stake script ran on, by looking for
its redeemer rather than for the certificate. The control output's value
must satisfy `account.holds_only_lovelace_and_state_nft`
(`assets.has_nft_strict`), which refuses any other token whatever its
name or policy. A second creation of an existing account is refused
because the ledger will not register a registered credential, so the
transaction cannot carry the registration the mint handler demands.
Under `IssueGrants` the control UTxO must be spent, a device must sign,
and each minted name must be the grant name of the next slot in order,
in quantity one, landing in one output at the account address holding
only that token, with a grant of that slot and the recreated generation;
the `Device` handler on the control UTxO requires the counters to move by
the mint delta, and `account.grant_mint_delta` aborts on a state NFT name
or on another account's token. `SpendWithGrant` requires
`account.holds_no_account_token` of the mint.

Tests. `attack_token_forgery_victims_address_with_the_attackers_signature`
(the mint handler accepts and `register` refuses, so the transaction
fails),
`attack_token_forgery_owner_signed_creation_without_the_owner_as_a_device`
(the same),
`attack_token_forgery_attackers_name_into_the_victims_address` (`fail`),
`attack_token_forgery_second_nft_minted_during_a_grant_spend` (`!`),
`attack_token_forgery_grant_token_minted_during_a_grant_spend` (`!`),
`attack_token_forgery_issue_grants_without_the_control_utxo` (`fail`),
`attack_token_forgery_issue_grants_with_the_grantee_signature` (`!`),
`attack_token_forgery_grant_token_named_after_another_account` (`fail`),
`attack_token_forgery_grant_token_reusing_an_issued_slot` (`!`),
`attack_token_forgery_issue_grants_without_moving_the_counters` (`!`),
`attack_token_forgery_create_account_with_a_key_stake_credential`
(`fail`),
`attack_token_forgery_lookalike_token_named_after_the_stake_credential_on_the_control`
(`!`), `attack_token_forgery_parallel_control_utxo_without_a_registration`
(`!`),
`attack_token_forgery_parallel_control_utxo_with_an_unwitnessed_registration`
(`!`), `attack_token_forgery_state_nft_minted_as_a_grant` (`fail`).
Functional companions: `create_account_rejects_a_missing_registration`,
`create_account_rejects_a_registration_of_another_credential`,
`create_account_rejects_a_registration_the_stake_script_did_not_run_on`,
`create_account_rejects_a_quantity_of_two`,
`create_account_rejects_two_asset_names_under_the_policy`,
`create_account_rejects_a_grant_token_beside_the_state_nft`,
`create_account_rejects_a_burn_beside_the_mint`,
`create_account_rejects_a_burn`,
`create_account_rejects_a_name_shorter_than_a_stake_script_hash`,
`issue_grants_rejects_a_skipped_slot`, `issue_grants_rejects_a_reused_slot`,
`issue_grants_rejects_a_quantity_of_two`,
`issue_grants_rejects_the_state_nft_name`,
`publish_rejects_a_registration_without_the_owner_signature`,
`publish_rejects_a_registration_signed_by_a_device_over_the_control`,
`publish_rejects_a_registration_without_the_mint`,
`publish_rejects_a_registration_minting_two_state_nfts`,
`publish_rejects_a_registration_minting_another_accounts_state_nft`,
`publish_rejects_a_registration_with_the_owner_outside_the_devices`, and
the `registers_credential_*`, `registers_stake_credential_*` and
`grant_mint_delta_*` unit tests in
`lib/cardano_account_custody_contract/account.test.ak`, among them
`registers_stake_credential_ignores_a_certificate_without_a_redeemer`.

## Other redeemer

Attack. Withdraw the account's rewards with a grantee signature over a
referenced control UTxO, or over a grant UTxO; spend the control UTxO or
a grant UTxO with `Fund`, the redeemer that carries no authorisation;
spend a plain deposit with `Device`; spend the control UTxO with
`SpendWithGrant`; sweep a grant with the grantee's signature; spend a
grant with its token burned; burn grant tokens without the control UTxO;
use `CreateAccount` on a burn with everything a creation needs beside it;
run either validator under a purpose it has no handler for.

Mitigation. The stake script's `withdraw` handler applies the device
rule, which reads the devices from the control UTxO and ignores grantees,
and aborts over a grant UTxO. `Fund` requires that the spent input holds
no token of the account; `Device` requires that it holds the state NFT;
`SpendWithGrant` and `SweepGrant` require that it holds only lovelace and
the grant token of its datum's slot, so each redeemer is tied to one kind
of UTxO. `Device` requires a datum that decodes as `AccountState`,
`SpendWithGrant` and `SweepGrant` one that decodes as `Grant`.
`SweepGrant` requires a device signature read from the spent control
UTxO, and `BurnGrants` requires the control UTxO spent and a device
signature. The mint handler matches the redeemer against the minted
quantities and accepts `CreateAccount` with one name in quantity one,
`IssueGrants` with every name in quantity one and `BurnGrants` with every
name in quantity minus one; `SpendWithGrant` additionally requires that
nothing is minted or burned under the policy and that a single output
holds the grant token, which a burn makes impossible. Both validators
fail in their `else` handler.

Tests. `attack_other_redeemer_withdraw_rewards_with_a_grantee_signature`
(`!`), `attack_other_redeemer_withdraw_rewards_over_a_grant_utxo`
(`fail`), `attack_other_redeemer_fund_on_the_control_utxo` (`!`),
`attack_other_redeemer_fund_on_a_grant_utxo` (`!`),
`attack_other_redeemer_device_on_a_plain_deposit` (`fail`),
`attack_other_redeemer_grant_on_the_control_utxo` (`fail`),
`attack_other_redeemer_sweep_with_the_grantee_signature` (`!`),
`attack_other_redeemer_grant_spend_with_its_token_burned` (`fail`),
`attack_other_redeemer_burn_grants_without_the_control_utxo` (`fail`),
`attack_other_redeemer_create_account_on_a_burn` (`!`). Functional
companions: `mint_rejects_a_burn_of_the_state_nft_from_the_control_utxo`,
`mint_rejects_a_burn_of_two`, `burn_grants_rejects_the_state_nft`,
`burn_grants_rejects_a_mint_among_the_burns`,
`fund_rejects_the_control_utxo_itself`, `fund_rejects_a_grant_utxo_itself`,
`sweep_grant_rejects_the_control_utxo`,
`spend_with_grant_rejects_the_control_utxo`,
`device_rejects_a_grant_utxo_as_the_control`,
`device_rejects_a_missing_control_output_even_when_the_state_nft_is_burned`,
`else_fails_for_any_other_purpose` for the stake script.

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
on the owner path and at creation, with `recreates_control_output` tying
the counters to the mint delta and the generation to its predecessor.

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
(`!` for each of the six states). Functional companions:
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
expired. Both bounds are compared in POSIX milliseconds, the unit of
`expires_at`.

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
on every write of the state; `state.is_scope_well_formed` bounds a grant
to `max_recipients` (8) at issuance, and a grant's scope cannot grow
afterwards. `assets.has_nft_strict` keeps every token but the state NFT
off the control output and every token but the grant token off a grant
output, on every path. Deposits are not bounded in number, but every one
of them needs an account token in the same transaction and pays for its
own handler execution; the cost of many deposits is quantified under
Resource exhaustion.

Tests. `attack_unbounded_datum_seventeenth_outstanding_grant`,
`attack_unbounded_datum_nine_devices_on_a_device_rewrite`,
`attack_unbounded_datum_thirty_three_revoked_slots_on_a_device_rewrite`,
`attack_unbounded_datum_outstanding_grants_at_creation`,
`attack_unbounded_value_token_bundle_on_the_control_at_creation`,
`attack_unbounded_value_token_bundle_on_a_grant_at_issuance`,
`attack_unbounded_inputs_deposits_spent_without_an_account_token` (all
`!`). Functional companions:
`device_rejects_extra_tokens_on_the_control_output`,
`issue_grants_rejects_extra_tokens_on_the_grant_output`,
`spend_with_grant_rejects_extra_tokens_on_the_grant_output`,
`device_rejects_a_seventeenth_outstanding_grant`,
`device_rejects_a_thirty_third_revoked_slot`,
`issue_grants_rejects_an_ill_formed_scope`, and the bound tests in
`lib/cardano_account_custody_contract/state.test.ak`.

## UTxO contention

Attack. A grantee spends the control UTxO in its grant spend, or spends
and references it, or spends a second grant UTxO beside its own, to put
the owner's revoke in a race with its transactions; a grantee submits a
spend against the control state as it was before a revoke or a
generation bump.

Mitigation. `SpendWithGrant` requires the control UTxO among the
reference inputs exactly once (`grant.referenced_control`) and exactly
one input holding an account token (`grant.spends_one_account_token`),
so an agent transaction never spends the control UTxO or another grant
UTxO; a reserve, a deposit with a datum, needs the control UTxO spent
under `Fund`, so an agent transaction never spends one either. Two
agents of one account, and an agent and the owner, contend only when
they pick the same plain deposit, which the ledger refuses as a double
spend and the loser rebuilds; the owner avoids even that by paying the
fee from a reserve or through a sponsor. A revoke is one `Device` spend
of the control UTxO, whatever is outstanding, and once it lands every
grant spend sees it: a spend referencing the old control UTxO fails as
the ledger no longer has that input, and a spend referencing the new one
fails `grant.is_current`. A grantee may still fragment the plain deposits
at zero outflow or run no-op spends against its own grant UTxO; neither
touches the control UTxO, and the owner's remedy is a revoke and a sweep.

Tests. `attack_utxo_contention_grant_spend_spends_the_control_utxo`
(`fail`: with the control UTxO spent rather than referenced
`referenced_control` finds nothing),
`attack_utxo_contention_grant_spend_spends_and_references_the_control_utxo`
(`!`), `attack_utxo_contention_grant_spend_spends_a_second_grant_utxo`
(`!`), `attack_utxo_contention_grant_spend_after_a_revoke` (`!`),
`attack_utxo_contention_grant_spend_after_a_generation_bump` (`!`).
Functional companions:
`spend_with_grant_rejects_a_spent_control_in_place_of_a_reference`,
`spend_with_grant_rejects_the_control_spent_beside_the_reference`,
`spend_with_grant_rejects_two_grant_utxos_of_the_account`,
`spend_with_grant_rejects_a_revoked_slot`,
`spend_with_grant_rejects_a_grant_of_an_older_generation`, and the
`spends_one_account_token_*` and `referenced_control_*` unit tests.

## Locked value

Attack. A grant spend pays the whole balance back to the account address
under a datum hash, or under an inline datum; a grant spend sends the
balance to the bare script address; a grant spend strands its grant
token on a plain deposit; a device rewrite removes every device; an
account is created without devices; a registration is published without
the state NFT mint, which would leave a credential registered with no
account to create; a sweep burns a grant token without lowering the
outstanding count, which would wedge the account at the bound.

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
on every write and at creation. The stake script's registration arms
require the mint of the state NFT, and the `Device` handler requires the
outstanding count to follow the burns.

Permanence is the structural mitigation for the rest of this class.
Every plain deposit needs an account token in the same transaction and
every reserve the control UTxO, and the control UTxO always exists: it
is created with the account, every spend recreates it, no redeemer burns
the NFT and the stake script refuses the deregistration that a second
creation would need. A deposit that arrives at any time after creation
is therefore spendable through the normal paths, with no window in which
the account is absent. A dead grant UTxO is swept by a device, which
burns its token and frees its lovelace, so nothing stays locked in a
grant. The cost is that the registration deposit and the control UTxO's
minimum lovelace are locked for the life of the account.

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
handler accepts and the `Device` handler on the control UTxO refuses).
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
in its inline state must be a required signer; the rule aborts when no
such control UTxO is present. A withdrawal of zero runs the same rule. The
`RegisterCredential` and `RegisterAndDelegateCredential` arms apply
`creates_the_account`: `owner` among the required signers, exactly one
token of the certificate's credential minted under `account_hash`, and
`owner` in the device list of the single control output holding that
token, read positionally from the inline datum's first field, since the
account validator checks the whole state in the same transaction. No
control UTxO exists before creation, so the arms read nothing else. The
handler does not compare the certificate's credential with its own hash,
which the ledger makes redundant by running a credential's script only on
certificates naming that credential, and a key credential falls through
to the refusing arm. `UnregisterCredential` and every other certificate
kind, including delegate representative and pool certificates, fall
through to `False`. The `else` handler fails. A `DelegateCredential`
covers pool, vote and combined delegations alike, so a vote delegation
needs a device like any other. A withdrawal from an unrelated reward
account added to an agent transaction only adds value that must balance
into the outputs or the fee, both of which the grant accounting covers,
and an Ed25519 grantee signs the whole body anyway.

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
tests of the rule: `is_authorised_by_a_device_*` and
`find_control_input_*` in
`lib/cardano_account_custody_contract/account.test.ak`.

## Evaluation order

Reasoning plus three tests. Every check in every handler is a conjunction
(`and { .. }`) or a `when` arm preceded by `expect` bindings; `and` short
circuits on the first False and `expect` aborts, so no later check can
rescue an earlier failure and there is no path on which a check is
skipped. The dependences between handlers are these. `Fund` relies on the
handler of the account token spent beside it to do the accounting: the
tests `attack_evaluation_order_fund_passes_only_together_with_the_control_spend`
and `attack_evaluation_order_fund_passes_only_together_with_the_grant_spend`
show `Fund` returning True while the `Device` handler on the control UTxO
returns False for lack of a device signature, and while the
`SpendWithGrant` handler returns False. A reserve relies on `Fund`
demanding the control UTxO under a datum:
`attack_evaluation_order_reserve_spent_beside_a_grant_utxo` shows the
grant handler accepting while the reserve's `Fund` handler refuses. The
mint handler relies on the stake script's `publish` handler for the
owner's signature and the device list on creation, and the stake script
relies on the mint handler for the single control output's full state:
`attack_token_forgery_victims_address_with_the_attackers_signature` and
`attack_token_forgery_owner_signed_creation_without_the_owner_as_a_device`
show the mint handler accepting while `register` refuses, and
`publish_accepts_a_second_nft_beside_the_mint_that_the_mint_handler_refuses`
the converse. `SweepGrant` relies on the `Device` handler on the control
UTxO for the outstanding count:
`attack_locked_value_sweep_without_the_outstanding_decrement`. The ledger
accepts a transaction only when every script passes, so the order in
which they run is irrelevant.

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
state the validators admit and run every handler of every path over it.
The largest control state has eight devices, `max_revoked` revoked
slots, sixteen outstanding grants and a generation past zero; the largest
grant lists eight recipients; every key is 28 bytes. The largest control datum
and the largest grant datum together serialise to under 2 KiB of CBOR, and
`budget_largest_state_datums_stay_within_the_transaction_size_limit`
asserts that the two together stay under 2 KiB, far inside the 16 KiB
transaction size limit.

Method. `aiken check -D` reports the execution units of every test as
the memory units and CPU steps its evaluator charged. Each `budget_`
figure includes the cost of building the fixture; the `budget_baseline_`
test of the same fixture builds it without running a handler, and the
net column subtracts it. The runner does not charge the ledger's decoding
of the script context, so the net figures understate the on-chain cost
by that amount and must be confirmed on preprod with the real
transaction builder. The mainnet limits are 14,000,000 memory units and
10,000,000,000 CPU steps per transaction and 62,000,000 memory units and
20,000,000,000 steps per block; a transaction pays the sum over every
handler it runs, one per script input, mint policy, certificate and
withdrawal. The last column repeats the net memory with `max_revoked`
set to 64 in `state.ak` and nothing else changed: `largest_state` in
`validators/attacks.test.ak` fills its revoked list with slots 1 to
`max_revoked`, puts the largest token grant and the largest lovelace
grant at `max_revoked` plus 6 and plus 7 and its next slot at
`max_revoked` plus 8, and the revoke fixture drops slot 1 to append the
lovelace grant's slot, so every budget fixture follows the constant; at
64 the three tests that pin the bound at thirty three revoked slots fail
and every other check passes. The committed bound is 32.

| Test | mem | cpu | baseline mem | net mem | net cpu | net mem, 64 revoked |
| --- | --- | --- | --- | --- | --- | --- |
| `budget_largest_state_account_creation` | 792,442 | 234,571,371 | 298,294 | 0.49 M | 0.15 G | 0.49 M |
| `budget_largest_state_registration` | 441,442 | 126,807,016 | 298,294 | 0.14 M | 0.04 G | 0.14 M |
| `budget_largest_state_device_revoke` | 1,644,307 | 469,382,024 | 545,997 | 1.10 M | 0.32 G | 1.49 M |
| `budget_largest_state_device_rewrite` | 1,551,090 | 441,600,196 | 447,680 | 1.10 M | 0.32 G | 1.50 M |
| `budget_largest_state_fund_spend_of_a_reserve_beside_the_control` | 487,544 | 141,133,515 | 410,269 | 0.08 M | 0.03 G | 0.06 M |
| `budget_largest_state_withdrawal` | 540,842 | 148,502,543 | 232,903 | 0.31 M | 0.08 G | 0.44 M |
| `budget_largest_state_delegation` | 550,260 | 152,566,332 | 230,083 | 0.32 M | 0.09 G | 0.46 M |
| `budget_largest_state_device_issue` | 1,584,717 | 459,126,657 | 387,566 | 1.20 M | 0.35 G | 1.60 M |
| `budget_largest_state_issue_grants` | 1,378,357 | 403,077,891 | 387,566 | 0.99 M | 0.29 G | 1.26 M |
| `budget_largest_state_device_issue_eight_grants` | 3,459,117 | 1,042,511,505 | 1,768,883 | 1.69 M | 0.52 G | 2.10 M |
| `budget_largest_state_issue_eight_grants` | 6,985,885 | 2,136,542,565 | 1,768,883 | 5.22 M | 1.61 G | 5.48 M |
| `budget_largest_state_device_issue_sixteen_grants` | 5,860,581 | 1,785,502,697 | 3,606,595 | 2.25 M | 0.71 G | 2.66 M |
| `budget_largest_state_issue_sixteen_grants` | 16,327,261 | 4,936,209,161 | 3,606,595 | 12.72 M | 3.86 G | 12.99 M |
| `budget_largest_state_device_sweep` | 1,739,468 | 501,375,896 | 546,324 | 1.19 M | 0.35 G | 1.59 M |
| `budget_largest_state_sweep_grant` | 1,286,577 | 376,123,490 | 546,324 | 0.74 M | 0.22 G | 0.86 M |
| `budget_largest_state_burn_grants` | 863,536 | 241,290,260 | 546,324 | 0.32 M | 0.09 G | 0.44 M |
| `budget_largest_state_device_sweep_eight_grants` | 3,435,564 | 1,024,407,304 | 1,948,809 | 1.49 M | 0.45 G | 1.89 M |
| `budget_largest_state_sweep_grant_among_eight` | 2,752,350 | 825,430,830 | 1,948,809 | 0.80 M | 0.25 G | 0.93 M |
| `budget_largest_state_burn_eight_grants` | 2,290,615 | 670,883,547 | 1,948,809 | 0.34 M | 0.10 G | 0.47 M |
| `budget_largest_state_device_sweep_sixteen_grants` | 5,633,252 | 1,698,423,136 | 3,810,713 | 1.82 M | 0.57 G | 2.22 M |
| `budget_largest_state_sweep_grant_among_sixteen` | 4,683,726 | 1,414,696,870 | 3,810,713 | 0.87 M | 0.28 G | 1.00 M |
| `budget_largest_state_burn_sixteen_grants` | 4,180,855 | 1,238,112,955 | 3,810,713 | 0.37 M | 0.11 G | 0.49 M |
| `budget_largest_state_grant_spend_lovelace_scope` (9 inputs) | 3,102,459 | 1,011,928,445 | 721,596 | 2.38 M | 0.81 G | 2.61 M |
| `budget_largest_state_fund_spend_among_eight_deposits` | 823,982 | 249,588,248 | 721,596 | 0.10 M | 0.04 G | 0.10 M |
| `budget_largest_state_grant_spend_token_scope` (2 inputs) | 2,477,681 | 802,274,693 | 599,416 | 1.88 M | 0.63 G | 2.11 M |
| `budget_grant_spend_over_forty_deposits` | 6,722,235 | 2,206,147,581 | 1,502,780 | 5.22 M | 1.78 G | 5.45 M |
| `budget_fund_spend_among_forty_deposits` | 1,707,310 | 535,844,216 | 1,502,780 | 0.20 M | 0.11 G | 0.20 M |

The baselines are the `budget_baseline_` tests named after the fixture
each row builds: `largest_state_creation_transaction` for the creation
and the registration, `largest_state_device_revoke_transaction`,
`largest_state_rewrite_transaction`,
`largest_state_reserve_transaction`,
`largest_state_withdrawal_transaction`,
`largest_state_delegation_transaction`,
`largest_state_issue_transaction` and the `eight_grant_issue` and
`sixteen_grant_issue` variants for the issuances, the
`sweep_transaction` and its `eight_grant_sweep` and
`sixteen_grant_sweep` variants for the sweeps,
`largest_state_grant_transaction` for the lovelace grant spend and the
`Fund` beside it, `largest_state_token_grant_transaction` and
`forty_deposit_transaction`. The sweep rows measure the handler of the
last grant UTxO, which scans every input before it. The stake script
rows measure its device rule on its own, decoding the largest state once
from the referenced control UTxO.

Per transaction, summing the handlers each path runs, in net memory
units at 32 revoked slots, with the 64 figure in brackets:

- Creation: the mint handler and the registration, 0.64 M (0.63 M).
- Revoke, revoke all or device rewrite: one `Device` execution, 1.10 M
  (1.50 M).
- Issuance of one grant: `Device` and `IssueGrants`, 2.19 M (2.86 M).
  Eight grants with eight recipients each: 6.91 M (7.58 M), 49 percent of
  the limit. Sixteen at once: 14.97 M (15.65 M), over the limit, since
  `IssueGrants` grows with the count: (5.22 - 0.99) / 7 = 0.60 M per
  grant from one grant to eight and (12.72 - 5.22) / 8 = 0.94 M per grant
  from eight to sixteen. The off-chain builder issues at most eight
  grants per transaction (`MAX_GRANT_BATCH`); grants with fewer
  recipients are cheaper.
- Sweep of one dead grant: `Device`, `SweepGrant` and `BurnGrants`,
  2.25 M (2.90 M). Eight at once: 8.26 M (9.77 M), 59 percent. Sixteen at
  once: 16.16 M (18.66 M), over the limit, because every `SweepGrant`
  execution decodes the control state again, about 0.80 M to 0.87 M
  each. The builder sweeps at most eight per transaction.
- Agent spend over eight deposits: `SpendWithGrant` and eight `Fund`
  executions, 3.20 M (3.38 M); over the token scope with one deposit,
  1.98 M. Over forty deposits: 5.22 M plus forty `Fund` executions of
  0.20 M, 13.40 M (13.37 M), 96 percent of the limit, so around thirty
  deposits per grant spend is the provisional batch size pending on-chain
  measurement. The builder evaluates every grant spend through the
  provider, so a spend over the limit is refused before submission.
- Reserve spend, withdrawal and delegation: 0.08 M, 0.31 M and 0.32 M
  beside the owner spend that carries them.

Observations.

- Raising `max_revoked` to 64 adds between 0.1 M and 0.4 M to every
  handler that decodes or scans the control state and about 1.5 M to the
  eight grant sweep, the heaviest owner transaction that fits. Every path
  that fits at 32 still fits at 64, but with a smaller margin, so the
  bound stays at 32; the owner bumps the generation once thirty two slots
  are revoked.
- The heaviest single execution of a transaction that fits is
  `IssueGrants` over eight largest grants at 5.22 M, 37 percent of the
  limit; the 12.72 M of `IssueGrants` over sixteen only occurs in a
  transaction over the limit. The heaviest owner execution over the
  largest state is a `Device` spend at 1.10 M to 2.25 M. No path of the
  owner is near the limit at the committed bounds, and the levers if
  on-chain measurement shows otherwise are `max_grants`,
  `max_recipients` and `max_revoked` in `state.ak`.
- Complexity. `grant.leaving_value` folds `assets.merge` over the
  inputs and outputs at the address; each merge is linear in the number
  of asset entries of both operands, so the whole fold is linear in the
  total number of entries, not quadratic. `account.own_input`,
  `account.has_account_token_input` and `account.has_control_input` are
  linear scans of the inputs run once per `Fund` execution, so the total
  work of a transaction with n deposits grows with n squared; the
  measured growth is from 0.10 M to 0.20 M memory units per `Fund`
  execution between 9 and 41 inputs. `SpendWithGrant` and `SweepGrant`
  each decode the control state once, from the reference input or the
  spent input, and `SpendWithGrant` decodes the grant output's datum
  once to bound its caps. `IssueGrants` runs `account.find_token_output` over the
  outputs once per minted token and `recreates_control_output` reads the
  mint once, so an issuance of k grants grows with k squared in the
  output scans and linearly in the grant datums decoded.
  `state.is_well_formed` uses `list.unique`, which is quadratic, over
  the device list bounded at 8, and `list.length` over the revoked list
  bounded at `max_revoked`. `grant.is_current` and `grant.is_dead` scan
  the revoked list once. `grant.pays_only_recipients` is linear in
  outputs times at most 8 recipients.
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
called from the `SpendWithGrant` branch of `validators/account.ak`,
requires the recreated grant output to carry no reference script, and
`grant.deposits_are_plain` requires the same of every deposit paid back.
An issuance is held to the same rule on each grant output through
`issues_grant`, so no grant UTxO ever carries one. Tests:
`attack_resource_exhaustion_reference_script_on_the_grant_output` (`!`),
`attack_resource_exhaustion_reference_script_on_a_returned_deposit`
(`!`), `spend_with_grant_rejects_a_reference_script_on_the_grant_output`,
`spend_with_grant_rejects_a_deposit_with_a_reference_script`,
`issue_grants_rejects_a_reference_script_on_the_grant_output`, and the
`carries_no_reference_script_*` and `deposits_are_plain_*` unit tests in
`lib/cardano_account_custody_contract/grant.test.ak`. The owner's own
path is not constrained: a device may attach a reference script to any
output it creates.

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
   `grant.deposits_are_plain`, called from the `SpendWithGrant` branch of
   `validators/account.ak`, which requires every output at the account
   address that does not hold an account token to carry `NoDatum`.
   Tests: `attack_locked_value_grant_spend_deposits_under_a_datum_hash`,
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
   making the agent path take the control UTxO as a reference input
   (`grant.referenced_control`, `grant.spends_one_account_token`), so an
   agent transaction never spends anything a revoke spends. Tests: the
   `attack_utxo_contention_*` tests and their functional companions under
   UTxO contention.
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

No other attack succeeded.

## Residual risks and recommendations

- Audit before mainnet. This review is internal and test driven; an
  independent audit should precede any mainnet deployment. The contract
  is testnet only at this stage.
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
  `eras/dijkstra/impl/cddl/data/dijkstra.cddl`), which closes the squat
  for new registrations; squats placed before the fork remain. Until
  then the mitigation is at the key layer: the owner key of a custody
  account is derived on a path that differs per network class, mainnet
  and testnets using distinct account index ranges by convention of the
  signer and the SDK, so a key used on a testnet never corresponds to a
  mainnet credential, signers refuse custody operations outside their
  network class, and the stake script hash of an account becomes public
  only in the creation transaction that registers it. Nobody can learn a
  credential before its registration, so a squat requires guessing an
  owner key, which is not feasible. The residual case is a user who
  exposes their custody owner key elsewhere before creating the account,
  which the signer prevents by refusing to use the custody key for
  anything else. Off-chain rules: create the account before ever sharing
  the address, never deposit to an address whose control UTxO does not
  exist, and when creation fails with an already registered credential
  use the next account index, which gives a new owner key and a new
  address. The preprod script applies the last rule by scanning owner
  indices for an unregistered credential.
- Foreign stake scripts. The mint handler does not read the stake
  script's code; it accepts any script credential whose script published
  the registration. An account created under some other script's
  credential is simply that creator's own account: its NFT has its own
  name, its address is its own, and the placement invariant keeps it
  away from every other account. Its reward account answers to whatever
  that script allows, which concerns no one else.
- Off-chain obligations. The library never spends a UTxO at the address
  that carries only a datum hash, and refuses to build a creation whose
  devices omit the owner. Only ever pay to the account's full address,
  with the inline script stake part; funds at the bare script address or
  under any other stake part are unspendable. Batch sweeps of many
  deposits to stay within the execution budget, and issue or sweep at
  most eight grants per transaction. Validate that a grantee hash and
  every device hash are 28 bytes when issuing or adding them; the
  validators do not check lengths, and an ill sized key only makes the
  grant or device unusable. Keep a reserve, or a sponsor, for the owner's
  operations so that a revoke never depends on a fund UTxO an agent may
  be spending.
- Sponsor policy. A sponsor pays and gains no authority, but it does see
  and co-sign the transaction and provides the collateral, so it should
  check what it sponsors: the fee, the deposit and the control output's
  lovelace are the only value it should contribute, and the builders
  return its change to it.
- Parameter choices. `max_grants` 16, `max_recipients` 8 and
  `max_revoked` 32 put the heaviest single execution that fits,
  `IssueGrants` over eight largest grants, at 37 percent of the memory
  budget in the `aiken check` runner, and the heaviest owner transaction
  that fits, an eight grant sweep, at 59 percent. Measure on preprod with
  real transactions; lower a bound or the batch size if the on-chain
  figure, which includes context decoding, approaches the limit. Grant
  caps and expiries are the owner's choice; a grant with an empty
  recipient list lets the grantee send up to its caps anywhere, including
  unspendable addresses, and a recipient that is a script address makes
  the funds subject to that script's datum, so prefer key addresses as
  recipients.
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
  same transaction as a grant spend: the mint handler demands a
  registration the grantee's own stake script authorised and a control
  output at the grantee's own account address, and this account's
  accounting is unaffected. An output to the account script with a
  pointer stake credential is not the account address, so it counts as
  leaving and is refused by a recipient list; under an empty list it is
  bounded by the caps like any other destination, and it can never be
  spent. An inverted validity range, with a lower bound above a finite
  upper bound no later than the expiry, is accepted by the validator but
  can never apply on the ledger, since no slot lies within it. A grantee
  may decrement its own caps further than the outflow, which costs it
  headroom and nothing else.
