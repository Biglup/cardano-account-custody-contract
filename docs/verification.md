# Verification

How the contract is verified: the test suites and their conventions, the
tests behind each vulnerability class of the
[threat model](security/threat-model.md), the execution budgets, the
findings and how each was closed, and the chain evidence. This is the one
document that names tests and measurements. Terms are defined in the
[glossary](glossary.md).

Every figure below names the run it comes from. Three kinds of run
appear:

- **The `aiken check` run**: `aiken check -D` with Aiken v1.1.24 over the
  committed tree, which reports the checks run and the execution units of
  every test.
- **The devnet run**: the run of `offchain/scripts/preprod-e2e.ts` on the
  local devnet recorded in [devnet-evidence.md](devnet-evidence.md), dated
  2026-10-08.
- **The preprod run**: the run of the same script against preprod
  recorded in [preprod-evidence.md](preprod-evidence.md), dated
  2026-10-09.

## Commands

The contract, with Aiken v1.1.24. The property tests use aiken-lang/fuzz
v3.0.0.

```sh
aiken fmt --check
aiken check -D
aiken build
```

`aiken build` writes [plutus.json](../plutus.json). A change to the shared
modules that alters the bytes of `logic_v1` shows in the blueprint diff
and makes a new logic version.

The off-chain library, with Node 22:

```sh
cd offchain
npm ci
npm run lint
npm run typecheck
npm test
```

The upgrade fixture, a separate Aiken project outside the audit scope:

```sh
cd fixtures/upgrade-logic
aiken fmt --check
aiken check -D
aiken build
```

## Test suites

The Aiken suites, with the number of tests each file declares. The
`aiken check` run reports 2369 checks from these 884 tests, of which 15
are property tests run 100 times each.

| File | Tests | Covers |
| --- | --- | --- |
| [validators/attacks.test.ak](../validators/attacks.test.ak) | 171 | 111 `attack_` tests, one or more per vulnerability class, and 60 `budget_` tests, of which 16 are baselines and one bounds the datum size |
| [validators/logic_v1.test.ak](../validators/logic_v1.test.ak) | 218 | The logic over whole transactions, every path |
| [validators/account.test.ak](../validators/account.test.ak) | 104 | The proxy's mint and spend handlers |
| [validators/account_stake.test.ak](../validators/account_stake.test.ak) | 40 | The stake script |
| [lib/.../account.test.ak](../lib/cardano_account_custody_contract/account.test.ak) | 166 | `account.ak`, 3 property tests among them over the grant token names (`grant_token_names_*`) |
| [lib/.../grant.test.ak](../lib/cardano_account_custody_contract/grant.test.ak) | 89 | `grant.ak`, 12 property tests among them over currency, death, the net outflow, the scope and the cap arithmetic |
| [lib/.../rules.test.ak](../lib/cardano_account_custody_contract/rules.test.ak) | 31 | `rules.ak` |
| [lib/.../state.test.ak](../lib/cardano_account_custody_contract/state.test.ak) | 31 | `state.ak` |
| [lib/.../logic.test.ak](../lib/cardano_account_custody_contract/logic.test.ak) | 14 | `logic.ak` |
| [lib/.../test_helpers.test.ak](../lib/cardano_account_custody_contract/test_helpers.test.ak) | 20 | The test helpers |

The fixture project's `fixtures/upgrade-logic/validators/logic_v2.test.ak`
holds 19 tests. Its `aiken check -D` run reports 1855 checks, those tests
over the contract's library suite, which the project compiles through a
symlink.

The off-chain library's suites are in `offchain/test`, run with vitest.
Each of the modules `blueprint`, `body`, `config`, `data`, `discovery`,
`logic`, `network`, `output`, `stake-script`, `state` and `transactions`
has a file of its own. `flow-plan.test.ts` tests the evidence script's
flow plan, `offchain/scripts/flow-plan.ts`. The modules `address`,
`cometa`, `index` and `value` have no file of their own.

## Conventions

An `attack_` test mounts an attack as a whole transaction and asserts that
a validator refuses it. It asserts `!handler(...)` when the handler
returns False, and is declared `fail` when the handler aborts on an
`expect`. Both make the ledger reject the transaction in phase two. The
`!handler` form is preferred wherever the attack reaches a returned
False. Below, `!` and `fail` mark which form a test takes.

The wrappers in `validators/attacks.test.ak` call the handlers with the
fixtures' proxy hash, stake credential and owner:

- `proxy_spend`, `proxy_spend_grant` and `proxy_mint` run the proxy.
- `run` runs `logic_v1` under the hash the fixtures' control datum names.
  `run_as` runs the same code under another credential, which is how the
  attack suite plays a next version.
- `register`, `withdraw` and `delegate` run the stake script.

The upgrade tests of the attack suite and of `validators/logic_v1.test.ak`
therefore prove the handover between two instances of the logic under
different credentials. The fixture project's `validators/logic_v2.test.ak`
proves it between the deployed rules and a script whose code differs,
each under its own credential, in both directions. The devnet run proves
it on a chain.

An adversarial or scenario test, one that builds a whole transaction and
runs a handler or a shared rule over it, carries a `///` narration of the
transaction it mounts and of the rule that refuses it. A plain unit or
property test of a library function carries none: its name states the
claim. The `budget_` tests follow the scenario rule, since their fixtures
are scenarios.

Functional tests that already cover an attack variant are listed below
as companions.

## Tests by vulnerability class

### Double satisfaction

- `attack_double_satisfaction_one_recipient_output_for_two_accounts`: the
  first account's logic passes, since its grant records the 2 ADA that
  left it, and the second's returns False on the cap rule, since 2 ADA
  left it against an unchanged grant.
- `attack_double_satisfaction_a_deposit_into_another_account_offsets_the_outflow`:
  the second account's logic sees a net deposit and passes; the first's
  returns False on the cap rule.
- `attack_double_satisfaction_fund_of_another_account_rides_on_this_control` (`!`)
- `attack_double_satisfaction_fund_of_another_account_rides_on_this_grant` (`!`)

The two accounts of these tests run under different logic credentials,
since one logic refuses two control UTxOs naming it. The first test runs
under open recipient lists, so that only the cap rule refuses it.

Companions in `validators/logic_v1.test.ak`:
`spend_with_grant_accepts_two_accounts_under_different_logics`,
`spend_with_grant_rejects_two_accounts_under_one_logic_in_one_transaction`.
In `validators/account.test.ak`:
`fund_rejects_the_control_utxo_of_another_account`,
`fund_rejects_a_grant_utxo_of_another_account`.

### Missing UTxO authentication

- `attack_missing_utxo_authentication_forged_control_without_the_nft_device`
  (`!`, the proxy finds no control UTxO)
- `attack_missing_utxo_authentication_forged_grant_without_the_token`
  (`fail`: the token is in no input, so no single grant output of its
  slot exists and the logic aborts)
- `attack_missing_utxo_authentication_forged_grant_beside_the_real_one` (`!`)
- `attack_missing_utxo_authentication_fund_with_the_control_as_a_reference_input` (`!`)
- `attack_missing_utxo_authentication_lookalike_nft_from_another_policy` (`!`)
- `attack_missing_utxo_authentication_lookalike_grant_token_from_another_policy` (`!`)
- `attack_missing_utxo_authentication_burn_with_the_nft_at_a_key_address` (`!`)
- `attack_missing_utxo_authentication_burn_grants_with_the_nft_at_a_key_address`
  (`!`, the account the name denotes has no control UTxO present)

For the stake script, in `validators/account_stake.test.ak`, all `fail`,
since the device rule aborts when no control UTxO of the account is
found: `withdraw_rejects_a_deposit_posing_as_the_control`,
`withdraw_rejects_a_control_that_lacks_the_state_nft`,
`withdraw_rejects_a_grant_utxo_posing_as_the_control`,
`withdraw_rejects_another_accounts_control`,
`publish_rejects_a_delegation_over_a_grant_utxo`,
`publish_rejects_a_delegation_over_another_accounts_control`.

### Datum hijacking

- `attack_datum_hijacking_grant_spend_raises_its_own_cap` (`!`)
- `attack_datum_hijacking_grant_spend_advances_its_own_generation` (`!`)
- `attack_datum_hijacking_grant_spend_rewrites_its_grantee` (`!`)
- `attack_datum_hijacking_grant_spend_relocates_the_grant_to_another_account_address` (`!`)
- `attack_datum_hijacking_grant_spend_grant_datum_given_by_hash` (`!`)
- `attack_datum_hijacking_padded_state_datum_on_a_device_rewrite` (`fail`)
- `attack_datum_hijacking_padded_grant_datum_at_issuance` (`fail`)
- `attack_datum_hijacking_padded_grant_redeemer_on_a_grant_spend` (`fail`:
  the cast to the proxy's redeemer type refuses the padded constructor)

Companions in `validators/logic_v1.test.ak`:
`spend_with_grant_rejects_a_changed_generation`,
`spend_with_grant_rejects_a_changed_grantee`,
`spend_with_grant_rejects_a_changed_slot_in_the_datum`,
`spend_with_grant_rejects_a_changed_per_call_cap`,
`spend_with_grant_rejects_a_changed_expiry`,
`spend_with_grant_rejects_changed_recipients`,
`spend_with_grant_rejects_the_grant_output_at_another_accounts_address`,
`sweep_grant_burns_a_grant_of_another_shape_under_an_older_generation`,
`sweep_grant_burns_a_revoked_grant_of_another_shape`,
`sweep_grant_rejects_an_expired_grant_of_another_shape`. In
`validators/account.test.ak`:
`device_accepts_a_control_output_with_a_datum_of_any_shape`,
`spend_rejects_a_control_whose_datum_has_no_logic_field`. The
`carries_grant_within_*` and `is_dead_*` unit tests in
`lib/cardano_account_custody_contract/grant.test.ak`, and the
`grant_slot_of_*` and `grant_generation_of_*` tests in
`lib/cardano_account_custody_contract/account.test.ak`.

The deposits paid back under a datum hash are tested under
[locked value](#locked-value).

### Token forgery and other token names

- `attack_token_forgery_victims_address_with_the_attackers_signature`:
  the proxy and the logic accept and `register` refuses, so the
  transaction fails.
- `attack_token_forgery_owner_signed_creation_without_the_owner_as_a_device`:
  the same.
- `attack_token_forgery_attackers_name_into_the_victims_address` (`fail`)
- `attack_token_forgery_second_nft_minted_during_a_grant_spend` (`!`)
- `attack_token_forgery_grant_token_minted_during_a_grant_spend` (`!`)
- `attack_token_forgery_issue_grants_without_the_control_utxo_spent`
  (`!`: the proxy accepts the referenced control UTxO and the logic's
  agent path admits no mint)
- `attack_token_forgery_issue_grants_with_the_grantee_signature` (`!`)
- `attack_token_forgery_grant_token_named_after_another_account` (`!`)
- `attack_token_forgery_grant_token_reusing_an_issued_slot` (`!`)
- `attack_token_forgery_issue_grants_without_moving_the_counters` (`!`)
- `attack_token_forgery_create_account_with_a_key_stake_credential` (`fail`)
- `attack_token_forgery_lookalike_token_named_after_the_stake_credential_on_the_control` (`!`)
- `attack_token_forgery_parallel_control_utxo_without_a_registration` (`!`)
- `attack_token_forgery_parallel_control_utxo_with_an_unwitnessed_registration` (`!`)
- `attack_token_forgery_state_nft_minted_as_a_grant` (`!`)

Under the attacker's own logic, all refused by the proxy alone (`!`):
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

Companions in `validators/account.test.ak`:
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
`device_rejects_the_state_nft_in_two_outputs`. In
`validators/logic_v1.test.ak`: `issue_grants_rejects_a_skipped_slot`,
`issue_grants_rejects_a_reused_slot`,
`issue_grants_rejects_a_quantity_of_two`,
`issue_grants_rejects_the_state_nft_name`,
`spend_with_grant_rejects_the_grant_token_sent_to_another_accounts_address`.
In `validators/account_stake.test.ak`:
`publish_rejects_a_registration_without_the_owner_signature`,
`publish_rejects_a_registration_signed_by_a_device_over_the_control`,
`publish_rejects_a_registration_without_the_mint`,
`publish_rejects_a_registration_minting_two_state_nfts`,
`publish_rejects_a_registration_minting_another_accounts_state_nft`,
`publish_rejects_a_registration_with_the_owner_outside_the_devices`. The
`registers_credential_*`, `registers_stake_credential_*`,
`mints_grants_of_*`, `keeps_control_output_*` and `grant_mint_delta_*`
unit tests in `lib/cardano_account_custody_contract/account.test.ak`,
among them `registers_stake_credential_ignores_a_certificate_without_a_redeemer`.

### Logic substitution and the upgrade path

- `attack_logic_substitution_grant_spend_under_the_attackers_logic` (`!`)
- `attack_logic_substitution_device_spend_under_the_attackers_logic` (`!`)
- `attack_logic_substitution_creation_under_a_logic_that_does_not_run`
  (`!` both ways)
- `attack_logic_substitution_grantee_rewrites_the_logic_pointer` (`!` on
  both paths)
- `attack_logic_substitution_stranger_rewrites_the_logic_pointer` (`!`)
- `attack_logic_substitution_upgrade_without_the_old_logic` (`!`, refused
  by the proxy and by the arriving logic)
- `attack_locked_value_upgrade_to_a_logic_that_does_not_run` (`!`)
- `attack_logic_substitution_upgrade_keeps_the_generation` (`!`)
- `attack_logic_substitution_upgrade_swaps_the_devices` (`!`)
- `attack_logic_substitution_arrival_hidden_behind_a_referenced_control`
  and `attack_logic_substitution_arrival_hidden_behind_a_spent_control`:
  the leaving logic accepts, the arriving logic returns False.
- `attack_logic_substitution_two_accounts_under_one_logic` (`!`)
- `attack_other_redeemer_logic_deregistration` (`!`)
- `attack_utxo_contention_grant_spend_after_an_upgrade` (`!` under either
  logic)

Companions, the upgrade suite in `validators/logic_v1.test.ak`:
`upgrade_is_accepted_by_a_device`,
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
`publish_rejects_a_registration_with_a_delegation`.

In the fixture project's `validators/logic_v2.test.ak`, with the deployed
rules and the fixture script each run under its own credential:
`upgrade_from_the_deployed_logic_is_accepted_by_both_logics`,
`upgrade_from_the_deployed_logic_rejects_a_grantee`,
`downgrade_to_the_deployed_logic_is_accepted_by_both_logics`,
`downgrade_to_the_deployed_logic_rejects_a_grantee`,
`spend_with_grant_rejects_a_grant_issued_before_an_upgrade`,
`publish_rejects_a_deregistration`.

In `validators/account.test.ak`:
`device_requires_the_logic_the_control_names`,
`device_rejects_a_withdrawal_from_a_logic_the_control_does_not_name`,
`spend_with_grant_requires_the_logic_the_referenced_control_names`,
`create_account_rejects_a_missing_logic_withdrawal`,
`create_account_rejects_a_withdrawal_from_a_logic_the_datum_does_not_name`,
`create_account_rejects_a_logic_pointer_shorter_than_a_script_hash`,
`device_rejects_the_control_spent_and_referenced`,
`device_rejects_two_control_utxos_of_the_account_spent`. The
`recreates_control_output_*` tests in
`lib/cardano_account_custody_contract/rules.test.ak`, and the
`logic_of_*`, `devices_of_*`, `generation_of_*`,
`find_present_control_*` and `withdraws_from_*` tests in
`lib/cardano_account_custody_contract/account.test.ak`.

### Other redeemer

- `attack_other_redeemer_withdraw_rewards_with_a_grantee_signature` (`!`)
- `attack_other_redeemer_withdraw_rewards_over_a_grant_utxo` (`fail`)
- `attack_other_redeemer_fund_on_the_control_utxo` (`!`, the proxy and
  the logic both refuse)
- `attack_other_redeemer_fund_on_a_grant_utxo` (`!`)
- `attack_other_redeemer_device_on_a_plain_deposit` (`!`)
- `attack_other_redeemer_grant_on_the_control_utxo` (`!`)
- `attack_other_redeemer_sweep_with_the_grantee_signature` (`!`)
- `attack_other_redeemer_grant_spend_with_its_token_burned` (`!`)
- `attack_other_redeemer_burn_grants_without_the_control_utxo_spent` (`!`)
- `attack_other_redeemer_create_account_on_a_burn` (`!`)
- `attack_other_redeemer_logic_deregistration` (`!`)

Companions in `validators/account.test.ak`:
`mint_rejects_a_burn_of_the_state_nft_from_the_control_utxo`,
`mint_rejects_a_burn_of_two`, `fund_rejects_the_control_utxo_itself`,
`fund_rejects_a_grant_utxo_itself`. In `validators/logic_v1.test.ak`:
`burn_grants_rejects_the_state_nft`,
`burn_grants_rejects_a_mint_among_the_burns`,
`sweep_grant_rejects_the_control_utxo`,
`spend_with_grant_rejects_the_control_utxo`,
`device_rejects_a_grant_utxo_as_the_control`,
`device_rejects_a_missing_control_output_even_when_the_state_nft_is_burned`.
`else_fails_for_any_other_purpose` in `validators/account_stake.test.ak`
and in `validators/logic_v1.test.ak`.

### Missed input validation

- `attack_missed_input_validation_fee_paid_by_the_account_beyond_the_cap` (`!`)
- `attack_missed_input_validation_grant_lovelace_drained_beyond_the_cap` (`!`)
- `attack_missed_input_validation_token_grant_leaks_a_sibling_asset_name` (`!`)
- `attack_missed_input_validation_token_grant_burns_its_lovelace_budget_in_one_call` (`!`)
- `attack_missed_input_validation_change_to_the_bare_script_address` (`!`)
- `attack_missed_input_validation_ill_formed_grants_at_issuance` (`!` for
  each scope)
- `attack_missed_input_validation_ill_formed_counters_on_a_device_rewrite`
  (`!` for each state)

In the fee and grant drain tests the grant output carries the correct
cap decrement, so the per call cap is the only rule that refuses them. In
the bare script address test the outflow stays within the per call cap,
so the recipient rule is the only one that refuses it.

Companions in `validators/logic_v1.test.ak`:
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
`device_rejects_a_decreased_grant_generation`. The `stays_within_scope_*`
and `grant_after_spend_*` unit and property tests in
`lib/cardano_account_custody_contract/grant.test.ak`.

### Time handling

- `attack_time_handling_no_upper_bound` (`!`)
- `attack_time_handling_lower_bound_past_expiry_with_no_upper_bound` (`!`)
- `attack_time_handling_exclusive_upper_bound_one_past_expiry` (`!`)
- `attack_time_handling_negative_infinity_upper_bound` (`!`)
- `attack_time_handling_sweep_of_a_live_grant` (`!`)

Companions: `spend_with_grant_rejects_a_validity_range_ending_after_the_expiry`,
`spend_with_grant_accepts_a_validity_range_ending_at_the_expiry`,
`sweep_grant_rejects_a_live_grant`,
`sweep_grant_rejects_a_lower_bound_at_the_expiry`,
`sweep_grant_burns_an_expired_grant`, and the `ends_before_expiry_*`,
`starts_after_expiry_*`, `is_current_*` and `is_dead_*` unit and property
tests.

### Unbounded datum, inputs and value

All `!`:

- `attack_unbounded_datum_seventeenth_outstanding_grant`
- `attack_unbounded_datum_nine_devices_on_a_device_rewrite`
- `attack_unbounded_datum_thirty_three_revoked_slots_on_a_device_rewrite`
- `attack_unbounded_datum_outstanding_grants_at_creation`
- `attack_unbounded_value_token_bundle_on_the_control_at_creation`
- `attack_unbounded_value_token_bundle_on_a_grant_at_issuance`
- `attack_unbounded_inputs_deposits_spent_without_an_account_token`

The token bundles hold tokens under twenty policies, and the deposits
test spends twenty deposits.

Companions: `device_rejects_extra_tokens_on_the_control_output` (in the
proxy and the logic suites),
`issue_grants_rejects_extra_tokens_on_the_grant_output`,
`spend_with_grant_rejects_extra_tokens_on_the_grant_output`,
`device_rejects_a_seventeenth_outstanding_grant`,
`device_rejects_a_thirty_third_revoked_slot`,
`issue_grants_rejects_an_ill_formed_scope`, and the bound tests in
`lib/cardano_account_custody_contract/state.test.ak`.
`budget_largest_state_datums_stay_within_the_transaction_size_limit`
bounds the datum size; see [resource exhaustion](#resource-exhaustion).

### UTxO contention

- `attack_utxo_contention_grant_spend_spends_the_control_utxo` (`!`)
- `attack_utxo_contention_grant_spend_spends_and_references_the_control_utxo` (`!`)
- `attack_utxo_contention_grant_spend_spends_a_second_grant_utxo` (`!`)
- `attack_utxo_contention_grant_spend_after_a_revoke` (`!`)
- `attack_utxo_contention_grant_spend_after_a_generation_bump` (`!`)
- `attack_utxo_contention_grant_spend_after_an_upgrade` (`!`)

Companions: `spend_with_grant_rejects_a_spent_control_in_place_of_a_reference`,
`spend_with_grant_rejects_the_control_spent_beside_the_reference`,
`spend_with_grant_rejects_two_grant_utxos_of_the_account`,
`spend_with_grant_rejects_a_revoked_slot`,
`spend_with_grant_rejects_a_grant_of_an_older_generation`, and the
`spends_one_account_token_*` and `find_present_control_*` unit tests.

### Locked value

- `attack_locked_value_grant_spend_deposits_under_a_datum_hash` (`!`)
- `attack_locked_value_grant_spend_deposits_under_an_inline_datum` (`!`)
- `attack_locked_value_grant_spend_sends_the_balance_to_the_bare_script_address` (`!`)
- `attack_locked_value_grant_spend_strands_its_token_on_a_plain_deposit` (`!`)
- `attack_locked_value_device_rewrite_removes_every_device` (`!`)
- `attack_locked_value_account_created_without_devices` (`!`)
- `attack_locked_value_registration_without_the_state_nft_mint` (`!`)
- `attack_locked_value_sweep_without_the_outstanding_decrement`: the
  sweep rule accepts and the owner path refuses on the control output.
- `attack_locked_value_upgrade_to_a_logic_that_does_not_run` (`!`)

Unit tests of the deposit rule: `deposits_are_plain_*` in
`lib/cardano_account_custody_contract/grant.test.ak`. Funds outside the
account address are unspendable:
`stake_script_hash_of_fails_without_a_stake_credential`,
`stake_script_hash_of_fails_for_a_key_stake_credential`,
`stake_script_hash_of_fails_for_a_pointer_stake_credential`,
`spend_rejects_an_input_without_a_stake_credential`.

### Staking and certificates

In `validators/account_stake.test.ak`:

- Registration: `publish_accepts_a_registration_signed_by_the_owner`,
  `publish_accepts_a_registration_with_a_delegation_signed_by_the_owner`,
  `publish_accepts_a_registration_with_the_owner_among_several_devices`,
  `publish_rejects_a_registration_without_the_owner_signature`,
  `publish_rejects_a_registration_signed_by_a_device_over_the_control`,
  `publish_rejects_a_registration_without_the_mint`,
  `publish_rejects_a_registration_minting_two_state_nfts`,
  `publish_rejects_a_registration_minting_another_accounts_state_nft`,
  `publish_rejects_a_registration_with_the_owner_outside_the_devices`,
  `publish_rejects_a_registration_with_a_delegation_without_the_mint`,
  `publish_rejects_a_registration_with_a_delegation_with_the_owner_outside_the_devices`.
- Registration, all `fail`:
  `publish_rejects_a_registration_without_a_control_output`,
  `publish_rejects_a_registration_with_the_control_output_at_another_account`,
  `publish_rejects_a_registration_with_a_control_output_without_an_inline_state`,
  `publish_rejects_a_registration_with_a_control_output_under_a_datum_hash`,
  `publish_rejects_a_registration_with_a_control_output_carrying_a_grant`.
- `publish_accepts_a_second_nft_beside_the_mint_that_the_mint_handler_refuses`,
  `publish_rejects_a_registration_of_a_key_credential`.
- Delegation: `publish_accepts_a_delegation_signed_by_a_device_over_a_referenced_control`,
  `publish_accepts_a_delegation_signed_by_a_device_over_a_spent_control`,
  `publish_rejects_a_delegation_without_a_device_signature`,
  `publish_rejects_a_delegation_signed_by_the_owner_alone_without_the_control`
  (`fail`), `publish_rejects_a_delegation_over_another_accounts_control`
  (`fail`), `publish_rejects_a_delegation_over_a_grant_utxo` (`fail`).
- Deregistration and other certificates:
  `publish_rejects_a_deregistration_signed_by_a_device_over_the_control`,
  `publish_rejects_a_deregistration_without_a_device_signature`,
  `publish_rejects_a_deregistration_signed_by_the_owner_without_the_control`,
  `publish_rejects_a_delegate_representative_registration`.
- Withdrawal: `withdraw_accepts_a_device_signature_over_a_referenced_control`,
  `withdraw_accepts_a_device_signature_over_a_spent_control`,
  `withdraw_accepts_a_withdrawal_of_zero`,
  `withdraw_rejects_a_missing_device_signature`, and, all `fail`,
  `withdraw_rejects_the_owner_signature_alone_without_the_control`,
  `withdraw_rejects_another_accounts_control`,
  `withdraw_rejects_a_control_that_lacks_the_state_nft`,
  `withdraw_rejects_a_control_without_an_inline_state`,
  `withdraw_rejects_a_grant_utxo_posing_as_the_control`,
  `withdraw_rejects_a_deposit_posing_as_the_control`,
  `withdraw_rejects_a_key_credential`.
- `else_fails_for_any_other_purpose` (`fail`).

In the attack suite:
`attack_other_redeemer_withdraw_rewards_with_a_grantee_signature` (`!`),
`attack_token_forgery_owner_signed_creation_without_the_owner_as_a_device`,
`attack_locked_value_registration_without_the_state_nft_mint`. Unit tests
of the device rule: `is_authorised_by_a_device_*`, among them
`is_authorised_by_a_device_reads_the_devices_of_a_state_of_another_shape`,
and `find_control_input_*` in
`lib/cardano_account_custody_contract/account.test.ak`.

### Evaluation order

Each dependence between validators has a test showing one validator
accept what another refuses:

- `attack_evaluation_order_fund_passes_only_together_with_the_control_spend`:
  `Fund` returns True while the logic refuses for lack of a device
  signature.
- `attack_evaluation_order_fund_passes_only_together_with_the_grant_spend`:
  `Fund` and the proxy's `SpendWithGrant` arm return True while the logic
  refuses for lack of the grantee's signature.
- `device_leaves_the_rules_to_the_logic` and
  `create_account_leaves_the_state_to_the_logic` in
  `validators/account.test.ak`: the proxy accepts what the logic refuses.
- `attack_evaluation_order_reserve_spent_beside_a_grant_utxo`: the logic
  accepts while the reserve's `Fund` handler refuses.
- `attack_token_forgery_victims_address_with_the_attackers_signature` and
  `attack_token_forgery_owner_signed_creation_without_the_owner_as_a_device`:
  the proxy and the logic accept while `register` refuses.
  `publish_accepts_a_second_nft_beside_the_mint_that_the_mint_handler_refuses`
  shows the converse.
- `attack_locked_value_sweep_without_the_outstanding_decrement`: the
  sweep rule relies on the owner path's control output rule.
- `attack_logic_substitution_arrival_hidden_behind_a_referenced_control`
  and `attack_logic_substitution_stranger_rewrites_the_logic_pointer`: the
  leaving and the arriving logic each refuse what the other accepts.

### Signature replay

- `attack_signature_replay_ed25519_grantee_of_another_account` (`!`)

Companions: `spend_with_grant_rejects_a_grantee_that_did_not_sign`,
`spend_with_grant_rejects_another_accounts_control_reference`,
`is_authorised_by_grantee_accepts_a_required_signer`,
`is_authorised_by_grantee_rejects_a_grantee_that_did_not_sign`.

### Dust attacks

The account is dusted with tokens under three policies.

- `attack_dust_attack_grant_spend_keeps_one_unit_of_dust` (`!`)
- `attack_dust_attack_dust_pushed_onto_the_grant_output` (`!`)

### Reference scripts

- `attack_resource_exhaustion_reference_script_on_the_grant_output` (`!`)
- `attack_resource_exhaustion_reference_script_on_a_returned_deposit` (`!`)
- `attack_token_forgery_reference_script_on_the_control_under_the_attackers_logic` (`!`)

Companions: `spend_with_grant_rejects_a_reference_script_on_the_grant_output`,
`spend_with_grant_rejects_a_deposit_with_a_reference_script`,
`issue_grants_rejects_a_reference_script_on_the_grant_output`,
`device_rejects_a_reference_script_on_the_control_output`, and the
`carries_no_reference_script_*` and `deposits_are_plain_*` unit tests in
`lib/cardano_account_custody_contract/grant.test.ak`.

## Resource exhaustion

### Method

The `budget_` tests in `validators/attacks.test.ak` build the largest
state `logic_v1` admits and run every handler of every path over it. The
largest control state has 8 devices, 32 revoked slots, 16 outstanding
grants and a generation past zero. The largest grant lists 8 recipients.
Every key is 28 bytes. `largest_state` fills its revoked list with slots
1 to 32, puts the largest grants over a token scope and a lovelace
scope at slots 38 and 39, and its next slot at 40. The tests are named
`budget_proxy_<fixture>_<handler>`, `budget_logic_<fixture>`, and, for the
upgrade, `budget_old_logic_` and `budget_new_logic_`.

The `aiken check` run reports the memory units and CPU steps its
evaluator charged for each test. Each `budget_` figure includes the cost
of building the fixture. The `budget_baseline_` test of the same fixture
builds it without running a handler, and the net figures subtract it.

The runner does not charge the ledger's decoding of the script context.
Every script execution pays that on chain, in proportion to the size of
the transaction. The net figures therefore understate the on-chain cost
of every execution, the more so the more inputs the transaction has. The
on-chain figures, from the devnet and preprod runs, are the ones to size
by.

Every share of a limit below is a share of the per transaction limits the
devnet and preprod runs read back from the chain: 17,500,000 memory units
and 10,000,000,000 CPU steps per transaction, and 77,500,000 memory units
and 20,000,000,000 steps per block. The devnet copies these from preprod's
parameters.

A transaction pays the sum over every handler it runs: one per script
input, mint policy, certificate and withdrawal. The proxy runs once per
script input and once for the mint. The logic runs once through its
withdrawal, twice on an upgrade.

### Execution units per handler

From the `aiken check` run. `budget_largest_state_datums_stay_within_the_transaction_size_limit`
asserts that the largest control datum and the largest grant datum
together serialise to under 2 KiB of CBOR, far inside the 16 KiB
transaction size limit.

Net memory units and CPU steps per execution over the largest state, in
millions (M) and billions (G):

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

### Execution units per transaction

From the `aiken check` run, summing the executions each path runs, in
net memory units:

- Creation: the proxy's mint, the logic's arrival and the registration,
  0.73 M.
- Revoke, revoke all or device rewrite: the proxy and the logic, 1.33 M.
- Upgrade: the proxy, the leaving logic and the arriving logic, 1.62 M.
- Issuance of one grant: 2.41 M. Eight grants with eight recipients
  each: 7.71 M, 44 percent of the limit. Sixteen at once: 16.44 M, 94
  percent. The logic's issuance grows with the count, and 94 percent
  leaves less margin than the context decoding the runner does not
  charge, so sixteen does not fit on chain. This is why the library
  issues at most eight grants per transaction (`MAX_GRANT_BATCH`).
  `logic_v1` leaves the count to the execution budget. The fixture's
  second logic pins the batch on chain with `max_grant_batch`:
  `device_rejects_an_issuance_over_the_batch` and
  `device_rejects_a_sweep_over_the_batch` against
  `the_deployed_logic_issues_over_the_batch` and
  `the_deployed_logic_sweeps_over_the_batch` in
  `validators/logic_v2.test.ak`. Grants with fewer recipients are
  cheaper.
- Sweep of one dead grant: 2.14 M. Eight at once, with eight proxy
  executions at the last input's figure: 8.08 M, 46 percent. Sixteen at
  once: 19.34 M, over the limit. The library sweeps at most eight per
  transaction.
- Agent spend over eight deposits: 4.17 M. Over the token scope with one
  deposit: 2.21 M plus one `Fund` execution. Over forty deposits: 6.72 M
  for the grant UTxO and the logic, plus forty `Fund` executions of
  between 0.16 M and 0.46 M each, 13 M to 25 M. On chain the bound is
  twelve inputs, below.
- Reserve spend, withdrawal and delegation: 0.08 M, 0.15 M and 0.16 M
  beside the owner spend that carries them.

### On chain

The devnet run read the execution units of every confirmed transaction
back from the chain. The differences from the figures above are the
proxy executions and the context decoding every input pays:

- An eight grant issue measured 45.2 and 47.5 percent of the memory
  limit.
- An eight grant sweep measured 49.5 and 52.5 percent.
- A device rewrite or a revoke over the largest state measured 8.7 to
  9.9 percent.

The agent spend over many deposits is where the method matters most.
Every `Fund` execution decodes the whole transaction and scans the
inputs for the account token input. Its cost depends on where the input
carrying the account token sorts among the inputs, which follows the
transaction ids.

- The preprod run, where the grant UTxO sorted twelfth of thirteen
  inputs: a grant spend over twelve fund UTxOs, the most a checked spend
  takes, measured 6.20 M memory units and 2.12 G steps, 35.4 percent of
  the memory limit. Each `Fund` execution cost between 0.26 M and
  0.31 M, against the 0.16 M of the local row. The per input cost on
  chain is roughly 0.1 M to 0.15 M above the local rows on a transaction
  of that size. That is the figure to budget against.
- The devnet run, where the grant UTxO sorted first: the same spend
  measured 4.28 M memory units and 1.56 G steps, 24.4 percent, each
  `Fund` execution between 0.10 M and 0.14 M.

The library bounds a checked grant spend at `MAX_FUND_INPUTS`, twelve
fund UTxOs, and `fundBatches` splits a larger sweep. The library
evaluates every grant spend through the provider, so a spend over the
limit is refused before submission. Both runs show the spend over
thirteen fund UTxOs refused by the library.

The devnet run upgrades an account from `logic_v1` to the fixture's
second logic, over one device, no revoked slot and one outstanding
grant. The proxy's two spends and the two logics measured 1.27 M memory
units and 0.43 G steps on chain, 7.2 percent of the memory limit. That is
under the 1.62 M of the upgrade row above, which was measured over the
largest state: a smaller state costs the arriving logic less than the
context decoding adds.

The library's estimate of the fee of a grant spend over a handful of
inputs, stated beside `DEFAULT_GRANT_FEE_BOUND`, 1.5 M lovelace, in
`offchain/src/transactions.ts`, is about 0.76 M lovelace with the proxy
and the logic referenced from their parked UTxOs, and about 1.05 M
lovelace with both embedded. Neither run records a grant spend fee, so
the estimate is not a measurement here.

The preprod run covers the same proxy and logic over flows 1 to 42,
without the upgrade, so its figures bound the same paths. Its memory
figures equal the devnet run's for the eight grant issues, the revokes,
the device rewrite and the first eight grant sweep. They differ where the
inputs sort differently: the second eight grant sweep measured 51.0
percent on preprod against 52.5 on the devnet, and the twelve fund grant
spend differs as above.

### Observations

- The heaviest single execution of a transaction that fits is the logic
  over an eight grant issuance, 6.71 M, 38 percent of the limit, in the
  `aiken check` run. The 14.78 M over sixteen grants occurs only in a
  transaction that does not fit.
- The heaviest owner transaction that fits is the eight grant sweep:
  8.08 M, 46 percent, in the `aiken check` run, and 49.5 to 52.5 percent
  in the devnet run.
- The proxy's executions are small, 0.08 M to 1.00 M, bounded by their
  scans of the inputs and the outputs, the placement scan among them.
- No owner path is near the limit at the bounds of `logic_v1`. If a later
  measurement approaches the limit, the levers are `max_grants`,
  `max_recipients` and `max_revoked` in `state.ak`, or the batch size.
  The bounds belong to the logic and move with a version.
- The proxy's total work grows with the square of the number of deposits.
  The `aiken check` run measures 0.16 M to 0.46 M memory units per `Fund`
  execution between 9 and 41 inputs.

## Findings and how each was closed

The adversarial test suite found these. Each is closed. No other
attack in the suite succeeded.

1. **A grantee could lock the whole balance.** `SpendWithGrant` exempted
   every output at the account address from the recipient check and
   counted it as returned, whatever its datum. A grant spend could pay
   every deposit back to the account address under a datum hash with no
   known preimage. Nothing counted as leaving, the caps stayed untouched,
   and the funds became unspendable, because the ledger refuses to run a
   script on an input whose datum hash has no preimage in the witness
   set. The exploit was reproduced against the validator before the fix.
   Closed by `grant.deposits_are_plain`, called from
   `rules.grant_spend_rule`, which requires every output at the account
   address that holds no account token to carry no datum. Tests:
   `attack_locked_value_grant_spend_deposits_under_a_datum_hash`,
   `attack_locked_value_grant_spend_deposits_under_an_inline_datum`, and
   the `deposits_are_plain_*` unit tests.
2. **A grantee could raise the owner's fees through the grant UTxO.** The
   agent path accepted the grant UTxO it recreated with a reference
   script attached, and every later spend of that UTxO would pay for the
   script's size. Closed by `grant.carries_no_reference_script` on the
   grant output. Tests:
   `attack_resource_exhaustion_reference_script_on_the_grant_output`,
   `spend_with_grant_rejects_a_reference_script_on_the_grant_output` and
   the `carries_no_reference_script_*` unit tests.
3. **A grantee could raise the owner's fees through deposits.** The rule
   above left the deposits a grant spend pays back unconstrained. A grant
   spend could consolidate the balance into one deposit carrying a large
   reference script and tax every later spend of it. Closed by
   `grant.deposits_are_plain` refusing a reference script on every
   deposit paid back. Tests:
   `attack_resource_exhaustion_reference_script_on_a_returned_deposit`,
   `spend_with_grant_rejects_a_deposit_with_a_reference_script`,
   `deposits_are_plain_rejects_a_deposit_with_a_reference_script`.
4. **A grantee could keep the owner from revoking.** With every grant in
   the control UTxO's datum and every agent spend recreating it, a
   grantee resubmitting a zero outflow spend on every block kept the
   control UTxO moving. The owner's revoke, which spends that same UTxO,
   lost the race for as long as the grant lived: a loss of availability
   of the whole balance, not bounded by the caps. Closed by moving each
   grant into its own grant UTxO under a grant token, with the agent path
   taking the control UTxO as a reference input. An agent transaction
   never spends anything a revoke spends. Tests: the
   `attack_utxo_contention_*` tests and their companions under
   [UTxO contention](#utxo-contention).
5. **A registration could strand a credential.** The stake script's
   registration arms accepted the owner's signature alone, while the
   mint handler required the registration. A transaction that registered
   without minting, which a builder mistake suffices for, left the
   credential registered with no control UTxO. `CreateAccount` could then
   never run, since the ledger refuses a second registration, and
   deregistration needed a control UTxO that could not exist. Closed by
   requiring, in both registration arms, the mint of exactly one state
   NFT of the credential (`creates_the_account`). Tests:
   `attack_locked_value_registration_without_the_state_nft_mint`,
   `publish_rejects_a_registration_without_the_mint`,
   `publish_rejects_a_registration_with_a_delegation_without_the_mint`,
   `publish_rejects_a_registration_minting_two_state_nfts`,
   `publish_rejects_a_registration_minting_another_accounts_state_nft`.
6. **A creation could leave the owner out.** The mint handler checked
   only that the initial state was well formed. A builder could create
   the account, with the owner's signature on the registration, under a
   device list that excluded the owner, and a wallet that cannot inspect
   the datum would approve it. Closed by the registration arms requiring
   the owner among the devices of the control output
   (`lists_the_owner_as_a_device`). Tests:
   `attack_token_forgery_owner_signed_creation_without_the_owner_as_a_device`,
   `publish_rejects_a_registration_with_the_owner_outside_the_devices`,
   `publish_rejects_a_registration_with_a_delegation_with_the_owner_outside_the_devices`,
   `publish_accepts_a_registration_with_the_owner_among_several_devices`.
7. **The agent path could not be evaluated.** The recreated datum had to
   carry the exact caps after the fee, and the fee depends on the
   execution units. The builder assigned fixed budgets instead of
   evaluating, and its default was below the cost of a spend over the
   largest state. Closed by `grant.carries_grant_within`: the grant
   output's remaining caps may sit anywhere between zero and the exact
   reduction, so the builder reduces them by a fee bound, writes the
   datum once and lets the provider evaluate the scripts. Tests:
   `spend_with_grant_accepts_a_cap_decrement_beyond_the_fee`,
   `spend_with_grant_accepts_a_cap_decremented_below_the_outflow`,
   `spend_with_grant_accepts_a_cap_decremented_to_zero`,
   `spend_with_grant_rejects_a_cap_one_lovelace_above_the_outflow_decrement`,
   `spend_with_grant_rejects_a_negative_cap`, their token and lovelace
   cap variants, and the `carries_grant_within_*` unit and property
   tests.
8. **One attack test refused for the wrong reason.** The two account
   double satisfaction test was refused by the recipient list of the
   first account, which tolerated no foreign output, not by the net
   accounting. Closed by rebuilding the test under open recipient lists,
   so that only the cap rule refuses it. No validator change.
9. **The deposit batch bound was wrong.** A batch size of around thirty
   deposits per agent spend, derived from the `aiken check` figures,
   left out the context decoding and the proxy execution every `Fund`
   input pays on chain. The preprod run's grant spend over twelve fund
   UTxOs, under [On chain](#on-chain), shows that cost. The library
   refused a spend over thirteen before anything was evaluated or
   submitted. Closed in the library by
   `MAX_FUND_INPUTS`, twelve, which a checked `spendWithGrant` enforces,
   and `fundBatches`, which splits a larger sweep. No validator change.
10. **A foreign logic could park tokens.** The proxy checked the
    placement of account tokens on creation and issuance only, and
    pinned the control output on a spend of the state NFT. An account
    under a permissive logic could send a grant token of its own into an
    output at another account's address on a device or grant spend.
    That account's `Fund` handler refuses the UTxO and its logic never
    spends it: an unspendable UTxO at the victim's address that a builder
    may select. Closed by the proxy requiring, on every spend of a UTxO
    holding a token of the policy, every account token among the outputs
    at its own account address, and by refusing a reference script on the
    control output at creation as on every spend. Tests:
    `attack_token_forgery_attackers_grant_token_swept_to_the_victims_address`,
    `attack_token_forgery_attackers_grant_token_spent_to_the_victims_address`,
    `attack_token_forgery_attackers_grant_token_placed_at_the_victims_address`,
    `attack_token_forgery_control_nft_relocated_under_the_attackers_logic`,
    `attack_token_forgery_reference_script_on_the_control_under_the_attackers_logic`,
    `spend_places_every_account_token_under_every_redeemer`,
    `create_account_rejects_a_reference_script_on_the_control_output`.

## Chain evidence

- [devnet-evidence.md](devnet-evidence.md): every flow, the upgrade path
  included, run on a local devnet with preprod's parameters, with the
  transaction ids, the refusals, the ledger errors and the execution
  units the chain charged for every script transaction.
- [preprod-evidence.md](preprod-evidence.md): flows 1 to 42 against the
  deployed proxy and `logic_v1` on preprod, with explorer links and the
  execution units of every script transaction, stopping before the
  upgrade.

The evidence script creates each run's account for a fresh owner. It
scans the owner indices of its mnemonic for an unregistered stake
credential, which is the next account index rule of the
[stake credential squat](security/known-issues.md#stake-credential-squat).
