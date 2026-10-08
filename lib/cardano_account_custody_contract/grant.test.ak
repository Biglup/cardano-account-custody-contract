//
// Copyright 2026 IOG.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// USINGS **********************************************************************

use aiken/interval
use cardano/address
use cardano/assets.{Assets}
use cardano/transaction.{DatumHash, InlineDatum, NoDatum, Output}
use cardano_account_custody_contract/grant.{
  carries_grant, carries_no_reference_script, deposits_are_plain,
  ends_before_expiry, grant_after_spend, is_authorised_by_grantee, is_current,
  is_dead, leaving_value, pays_only_recipients, quantity_of_asset,
  referenced_control, spends_one_account_token, starts_after_expiry,
  stays_within_scope,
}
use cardano_account_custody_contract/test_helpers.{
  account_address, control_output, control_value, device_key, fund_output,
  grant_output, grant_value, input, other_account_address,
  other_stake_script_hash, output, recipient_address, script_hash,
  stake_script_hash, state_datum, stranger_key,
}
use cardano_account_custody_contract/types.{AccountState, Asset, Grant, Scope}

// FUNCTIONS *******************************************************************

/// Lovelace as a scoped asset.
fn lovelace_asset() -> Asset {
  Asset { policy_id: assets.ada_policy_id, asset_name: assets.ada_asset_name }
}

/// A native asset under a policy that is not the account policy.
fn token_asset() -> Asset {
  Asset {
    policy_id: #"00000000000000000000000000000000000000000000000000000099",
    asset_name: "token",
  }
}

/// `quantity` units of the native asset.
fn token(quantity: Int) -> Assets {
  assets.from_asset(token_asset().policy_id, token_asset().asset_name, quantity)
}

/// `quantity` units of another asset under the native asset's policy.
fn other_token(quantity: Int) -> Assets {
  assets.from_asset(token_asset().policy_id, "other", quantity)
}

/// A scope over the native asset with a per call cap of 10, a cap of 50,
/// lovelace caps of 1 and 2 ADA and no recipient restriction, expiring at
/// 1000.
fn token_scope() -> Scope {
  Scope {
    asset: token_asset(),
    per_call_cap: 10,
    cap: 50,
    lovelace_per_call_cap: 1_000_000,
    lovelace_cap: 2_000_000,
    expires_at: 1_000,
    recipients: [],
  }
}

/// The token scope moved onto lovelace with a per call cap of 3 ADA, a
/// cap of 5 ADA and no lovelace caps.
fn lovelace_scope() -> Scope {
  Scope {
    ..token_scope(),
    asset: lovelace_asset(),
    per_call_cap: 3_000_000,
    cap: 5_000_000,
    lovelace_per_call_cap: 0,
    lovelace_cap: 0,
  }
}

/// The state of the account under test: one device, generation 1 and two
/// issued grants.
fn state() -> AccountState {
  AccountState {
    devices: [device_key],
    grant_generation: 1,
    next_slot: 2,
    revoked: [],
    outstanding: 2,
  }
}

/// The grant of slot 0 to the stranger under the lovelace scope, issued
/// under generation 1.
fn lovelace_grant() -> Grant {
  Grant {
    slot: 0,
    grantee: stranger_key,
    generation: 1,
    scope: lovelace_scope(),
  }
}

/// The grant of slot 1 to the stranger under the token scope, issued
/// under generation 1.
fn token_grant() -> Grant {
  Grant { slot: 1, grantee: stranger_key, generation: 1, scope: token_scope() }
}

/// A leaving value of `lovelace` and `tokens` units of the native asset.
fn leaving(lovelace: Int, tokens: Int) -> Assets {
  assets.merge(assets.from_lovelace(lovelace), token(tokens))
}

// TESTS ***********************************************************************

test is_authorised_by_grantee_accepts_a_required_signer() {
  is_authorised_by_grantee(stranger_key, [device_key, stranger_key])
}

test is_authorised_by_grantee_rejects_a_grantee_that_did_not_sign() {
  !is_authorised_by_grantee(stranger_key, [device_key])
}

test ends_before_expiry_accepts_an_upper_bound_before_the_expiry() {
  ends_before_expiry(interval.before(999), 1_000)
}

test ends_before_expiry_accepts_an_upper_bound_at_the_expiry() {
  ends_before_expiry(interval.before(1_000), 1_000) && ends_before_expiry(
    interval.entirely_before(1_000),
    1_000,
  )
}

test ends_before_expiry_rejects_an_upper_bound_after_the_expiry() {
  !ends_before_expiry(interval.before(1_001), 1_000)
}

test ends_before_expiry_rejects_an_unbounded_range() {
  !ends_before_expiry(interval.everything, 1_000) && !ends_before_expiry(
    interval.after(0),
    1_000,
  )
}

test starts_after_expiry_accepts_a_lower_bound_after_the_expiry() {
  starts_after_expiry(interval.after(1_001), 1_000) && starts_after_expiry(
    interval.entirely_after(1_001),
    1_000,
  )
}

test starts_after_expiry_rejects_a_lower_bound_at_the_expiry() {
  !starts_after_expiry(interval.after(1_000), 1_000) && !starts_after_expiry(
    interval.entirely_after(1_000),
    1_000,
  )
}

test starts_after_expiry_rejects_an_unbounded_range() {
  !starts_after_expiry(interval.everything, 1_000) && !starts_after_expiry(
    interval.before(2_000),
    1_000,
  )
}

test is_current_accepts_a_grant_of_the_generation_not_revoked() {
  is_current(lovelace_grant(), state())
}

test is_current_rejects_an_older_generation() {
  !is_current(Grant { ..lovelace_grant(), generation: 0 }, state())
}

test is_current_rejects_a_newer_generation() {
  !is_current(Grant { ..lovelace_grant(), generation: 2 }, state())
}

test is_current_rejects_a_revoked_slot() {
  !is_current(lovelace_grant(), AccountState { ..state(), revoked: [3, 0] })
}

test is_dead_rejects_a_live_grant() {
  !is_dead(lovelace_grant(), state(), interval.before(999))
}

test is_dead_accepts_an_older_generation() {
  is_dead(
    Grant { ..lovelace_grant(), generation: 0 },
    state(),
    interval.everything,
  )
}

test is_dead_accepts_a_revoked_slot() {
  is_dead(
    lovelace_grant(),
    AccountState { ..state(), revoked: [0] },
    interval.everything,
  )
}

test is_dead_accepts_a_range_starting_after_the_expiry() {
  is_dead(lovelace_grant(), state(), interval.after(1_001))
}

test is_dead_rejects_a_range_starting_at_the_expiry() {
  !is_dead(lovelace_grant(), state(), interval.after(1_000))
}

test referenced_control_returns_the_single_referenced_control() {
  let control = control_output(state(), 2_000_000)
  referenced_control(
    [input(1, grant_output(lovelace_grant(), 1)), input(0, control)],
    script_hash,
    stake_script_hash,
  ) == Some(control)
}

test referenced_control_returns_none_without_a_control() {
  referenced_control(
    [input(1, grant_output(lovelace_grant(), 1))],
    script_hash,
    stake_script_hash,
  ) == None
}

test referenced_control_returns_none_for_two_controls() {
  let control = control_output(state(), 2_000_000)
  referenced_control(
    [input(0, control), input(2, control)],
    script_hash,
    stake_script_hash,
  ) == None
}

test referenced_control_ignores_another_accounts_control() {
  let other = output(
    other_account_address(),
    control_value(other_stake_script_hash, 1),
    state_datum(state()),
  )
  referenced_control([input(0, other)], script_hash, stake_script_hash) == None
}

test leaving_value_subtracts_what_returns_to_the_address() {
  let inputs = [
    input(0, grant_output(lovelace_grant(), 2_000_000)),
    input(1, fund_output(leaving(10_000_000, 20))),
    input(2, output(recipient_address(), assets.from_lovelace(1), NoDatum)),
  ]
  let outputs = [
    grant_output(lovelace_grant(), 2_000_000),
    fund_output(leaving(7_000_000, 15)),
    output(recipient_address(), leaving(3_000_000, 5), NoDatum),
  ]
  leaving_value(inputs, outputs, account_address()) == leaving(3_000_000, 5)
}

test leaving_value_is_negative_for_a_deposit() {
  let outputs = [fund_output(assets.from_lovelace(5))]
  leaving_value([], outputs, account_address()) == assets.from_lovelace(-5)
}

test leaving_value_ignores_the_other_accounts_address() {
  let inputs = [
    input(0, output(other_account_address(), assets.from_lovelace(9), NoDatum)),
  ]
  leaving_value(inputs, [], account_address()) == assets.zero
}

test quantity_of_asset_reads_lovelace_and_tokens() {
  let value = leaving(7, 3)
  quantity_of_asset(value, lovelace_asset()) == 7 && quantity_of_asset(
    value,
    token_asset(),
  ) == 3
}

test stays_within_scope_accepts_the_per_call_cap_exactly() {
  stays_within_scope(token_scope(), leaving(1_000_000, 10))
}

test stays_within_scope_rejects_one_above_the_per_call_cap() {
  !stays_within_scope(token_scope(), leaving(0, 11))
}

test stays_within_scope_rejects_more_than_the_remaining_cap() {
  let nearly_spent = Scope { ..token_scope(), cap: 5 }
  !stays_within_scope(nearly_spent, leaving(0, 6))
}

test stays_within_scope_accepts_the_lovelace_per_call_cap_exactly() {
  stays_within_scope(token_scope(), leaving(1_000_000, 0))
}

test stays_within_scope_rejects_one_above_the_lovelace_per_call_cap() {
  !stays_within_scope(token_scope(), leaving(1_000_001, 0))
}

test stays_within_scope_rejects_lovelace_above_the_remaining_lovelace_cap() {
  let nearly_spent = Scope { ..token_scope(), lovelace_cap: 500_000 }
  !stays_within_scope(nearly_spent, leaving(500_001, 0))
}

test stays_within_scope_ignores_the_lovelace_caps_for_a_lovelace_scope() {
  stays_within_scope(lovelace_scope(), assets.from_lovelace(3_000_000))
}

test stays_within_scope_rejects_a_foreign_asset_leaving() {
  !stays_within_scope(
    lovelace_scope(),
    assets.merge(assets.from_lovelace(1), other_token(1)),
  )
}

test stays_within_scope_accepts_a_foreign_asset_entering() {
  stays_within_scope(
    lovelace_scope(),
    assets.merge(assets.from_lovelace(1), other_token(-1)),
  )
}

test stays_within_scope_accepts_a_deposit() {
  stays_within_scope(token_scope(), leaving(-1, -1))
}

test pays_only_recipients_allows_any_destination_when_empty() {
  pays_only_recipients(
    [output(recipient_address(), assets.from_lovelace(1), NoDatum)],
    account_address(),
    [],
  )
}

test pays_only_recipients_accepts_listed_destinations_and_the_account() {
  pays_only_recipients(
    [
      output(recipient_address(), assets.from_lovelace(1), NoDatum),
      fund_output(assets.from_lovelace(1)),
    ],
    account_address(),
    [recipient_address()],
  )
}

test pays_only_recipients_rejects_an_unlisted_destination() {
  !pays_only_recipients(
    [
      output(
        address.from_verification_key(device_key),
        assets.from_lovelace(1),
        NoDatum,
      ),
    ],
    account_address(),
    [recipient_address()],
  )
}

test pays_only_recipients_compares_the_full_address() {
  let staked = recipient_address() |> address.with_delegation_key(device_key)
  !pays_only_recipients(
    [output(staked, assets.from_lovelace(1), NoDatum)],
    account_address(),
    [recipient_address()],
  )
}

test deposits_are_plain_accepts_account_token_outputs_and_plain_deposits() {
  deposits_are_plain(
    [
      control_output(state(), 2_000_000),
      grant_output(lovelace_grant(), 2_000_000),
      fund_output(assets.from_lovelace(1)),
      output(
        recipient_address(),
        assets.from_lovelace(1),
        DatumHash(device_key),
      ),
    ],
    account_address(),
    script_hash,
    stake_script_hash,
  )
}

test deposits_are_plain_rejects_a_deposit_under_a_datum_hash() {
  !deposits_are_plain(
    [
      grant_output(lovelace_grant(), 2_000_000),
      output(account_address(), assets.from_lovelace(1), DatumHash(device_key)),
    ],
    account_address(),
    script_hash,
    stake_script_hash,
  )
}

test deposits_are_plain_rejects_a_deposit_under_an_inline_datum() {
  let data: Data = 42
  !deposits_are_plain(
    [output(account_address(), assets.from_lovelace(1), InlineDatum(data))],
    account_address(),
    script_hash,
    stake_script_hash,
  )
}

test deposits_are_plain_rejects_a_deposit_with_a_reference_script() {
  let weighted = Output {
    ..fund_output(assets.from_lovelace(1)),
    reference_script: Some(script_hash),
  }
  !deposits_are_plain(
    [weighted],
    account_address(),
    script_hash,
    stake_script_hash,
  )
}

test deposits_are_plain_rejects_another_accounts_token_under_a_datum() {
  let data: Data = 42
  let foreign = output(
    account_address(),
    grant_value(other_stake_script_hash, 0, 1),
    InlineDatum(data),
  )
  !deposits_are_plain(
    [foreign],
    account_address(),
    script_hash,
    stake_script_hash,
  )
}

test spends_one_account_token_accepts_a_single_grant_input() {
  spends_one_account_token(
    [
      input(0, grant_output(lovelace_grant(), 2_000_000)),
      input(1, fund_output(assets.from_lovelace(1))),
    ],
    script_hash,
    stake_script_hash,
  )
}

test spends_one_account_token_rejects_a_grant_and_the_control() {
  !spends_one_account_token(
    [
      input(0, grant_output(lovelace_grant(), 2_000_000)),
      input(1, control_output(state(), 2_000_000)),
    ],
    script_hash,
    stake_script_hash,
  )
}

test spends_one_account_token_rejects_two_grant_inputs() {
  !spends_one_account_token(
    [
      input(0, grant_output(lovelace_grant(), 2_000_000)),
      input(1, grant_output(token_grant(), 2_000_000)),
    ],
    script_hash,
    stake_script_hash,
  )
}

test spends_one_account_token_rejects_no_account_token_input() {
  !spends_one_account_token(
    [input(1, fund_output(assets.from_lovelace(1)))],
    script_hash,
    stake_script_hash,
  )
}

test spends_one_account_token_ignores_another_accounts_control_input() {
  !spends_one_account_token(
    [
      input(
        0,
        output(
          other_account_address(),
          control_value(other_stake_script_hash, 1),
          state_datum(state()),
        ),
      ),
    ],
    script_hash,
    stake_script_hash,
  )
}

test grant_after_spend_reduces_the_remaining_caps_only() {
  grant_after_spend(token_grant(), leaving(500_000, 7)) == Grant {
    ..token_grant(),
    scope: Scope { ..token_scope(), cap: 43, lovelace_cap: 1_500_000 },
  }
}

test grant_after_spend_keeps_the_lovelace_cap_of_a_lovelace_grant() {
  grant_after_spend(lovelace_grant(), assets.from_lovelace(1_000_000)) == Grant {
    ..lovelace_grant(),
    scope: Scope { ..lovelace_scope(), cap: 4_000_000 },
  }
}

test grant_after_spend_keeps_the_scope_on_a_net_deposit() {
  grant_after_spend(token_grant(), leaving(-500_000, -7)) == token_grant()
}

test grant_after_spend_ignores_a_lovelace_deposit_beside_a_token_withdrawal() {
  grant_after_spend(token_grant(), leaving(-500_000, 7)) == Grant {
    ..token_grant(),
    scope: Scope { ..token_scope(), cap: 43, lovelace_cap: 2_000_000 },
  }
}

test carries_grant_accepts_the_matching_inline_datum() {
  carries_grant(grant_output(lovelace_grant(), 1), lovelace_grant())
}

test carries_grant_rejects_a_different_grant() {
  let changed = Grant { ..lovelace_grant(), generation: 2 }
  !carries_grant(grant_output(lovelace_grant(), 1), changed)
}

test carries_grant_rejects_a_datum_given_by_hash() {
  let hashed = output(
    account_address(),
    grant_value(stake_script_hash, 0, 1),
    DatumHash(stranger_key),
  )
  !carries_grant(hashed, lovelace_grant())
}

test carries_no_reference_script_accepts_a_plain_grant_output() {
  carries_no_reference_script(grant_output(lovelace_grant(), 1))
}

test carries_no_reference_script_rejects_a_reference_script() {
  let weighted = Output {
    ..grant_output(lovelace_grant(), 1),
    reference_script: Some(script_hash),
  }
  !carries_no_reference_script(weighted)
}
