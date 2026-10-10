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

use aiken/builtin
use aiken/collection/list
use aiken/fuzz
use aiken/interval
use cardano/address
use cardano/assets.{Assets}
use cardano/transaction.{DatumHash, InlineDatum, NoDatum, Output}
use cardano_account_custody_contract/grant.{
  carries_grant_within, carries_no_reference_script, deposits_are_plain,
  ends_before_expiry, grant_after_spend, is_authorised_by_grantee, is_current,
  is_dead, leaving_value, pays_only_recipients, quantity_of_asset,
  spends_one_account_token, starts_after_expiry, stays_within_scope,
}
use cardano_account_custody_contract/state
use cardano_account_custody_contract/test_helpers.{
  account_address, control_output, control_value, device_key, fund_output,
  grant_output, grant_value, granted_state, input, lovelace_asset,
  lovelace_grant, lovelace_scope, other_account_address, other_fund_output,
  other_stake_script_hash, output, recipient_address, script_hash,
  stake_script_hash, state_datum, stranger_key, token, token_asset, token_grant,
  token_scope,
}
use cardano_account_custody_contract/types.{AccountState, Asset, Grant, Scope}

// CONSTANTS *******************************************************************

/// The first slot above the range the revoked slots are drawn from, which
/// runs from zero to `max_revoked` plus seven so that a full revoked list
/// always has room.
const first_live_slot = state.max_revoked + 8

// FUNCTIONS *******************************************************************

/// `quantity` units of another asset under the native asset's policy.
fn sibling_token(quantity: Int) -> Assets {
  assets.from_asset(token_asset().policy_id, "other", quantity)
}

/// The token scope expiring at 1000, with a lovelace per call cap of 1
/// ADA below its 2 ADA lovelace cap and no recipient restriction, so that
/// the time and lovelace rules run over small numbers.
fn early_token_scope() -> Scope {
  Scope {
    ..token_scope(),
    lovelace_per_call_cap: 1_000_000,
    expires_at: 1_000,
    recipients: [],
  }
}

/// The lovelace scope expiring at 1000.
fn early_lovelace_scope() -> Scope {
  Scope { ..lovelace_scope(), expires_at: 1_000 }
}

/// The early token scope with every cap at zero.
fn empty_scope() -> Scope {
  Scope {
    ..early_token_scope(),
    per_call_cap: 0,
    cap: 0,
    lovelace_per_call_cap: 0,
    lovelace_cap: 0,
  }
}

/// The granted state with its generation raised to 1.
fn bumped_state() -> AccountState {
  AccountState { ..granted_state(), grant_generation: 1 }
}

/// The lovelace grant issued under generation 1 over the early lovelace
/// scope.
fn bumped_lovelace_grant() -> Grant {
  Grant { ..lovelace_grant(), generation: 1, scope: early_lovelace_scope() }
}

/// The token grant issued under generation 1 over the early token scope.
fn bumped_token_grant() -> Grant {
  Grant { ..token_grant(), generation: 1, scope: early_token_scope() }
}

/// A leaving value of `lovelace` and `tokens` units of the native asset.
fn leaving(lovelace: Int, tokens: Int) -> Assets {
  assets.merge(assets.from_lovelace(lovelace), token(tokens))
}

/// A well formed scope over lovelace or the native asset with every cap
/// drawn from 0 to 100, so that random outflows fall on either side.
fn scope_fuzzer() -> Fuzzer<Scope> {
  let over_lovelace <- fuzz.and_then(fuzz.bool())
  let per_call_cap <- fuzz.and_then(fuzz.int_between(0, 100))
  let cap <- fuzz.and_then(fuzz.int_between(0, 100))
  let lovelace_per_call_cap <- fuzz.and_then(fuzz.int_between(0, 100))
  let lovelace_cap <- fuzz.map(fuzz.int_between(0, 100))
  if over_lovelace {
    Scope {
      ..early_lovelace_scope(),
      per_call_cap,
      cap,
      lovelace_per_call_cap: 0,
      lovelace_cap: 0,
    }
  } else {
    Scope {
      ..early_token_scope(),
      per_call_cap,
      cap,
      lovelace_per_call_cap,
      lovelace_cap,
    }
  }
}

/// A quantity drawn from -150 to 150, or exactly one of `caps` half of
/// the time, so that the boundaries fall under the properties.
fn quantity_fuzzer(caps: List<Int>) -> Fuzzer<Int> {
  fuzz.either(fuzz.int_between(-150, 150), fuzz.one_of(caps))
}

/// A leaving value whose lovelace and native asset quantities each land
/// anywhere from a deposit to beyond the caps of `scope`, or exactly on
/// one of the caps that bound that asset.
fn outflow_fuzzer(scope: Scope) -> Fuzzer<Assets> {
  let lovelace_caps = if state.is_lovelace(scope.asset) {
    [scope.per_call_cap, scope.cap]
  } else {
    [scope.lovelace_per_call_cap, scope.lovelace_cap]
  }
  let lovelace <- fuzz.and_then(quantity_fuzzer(lovelace_caps))
  let tokens <- fuzz.map(quantity_fuzzer([scope.per_call_cap, scope.cap]))
  leaving(lovelace, tokens)
}

/// A scope and an outflow drawn against it.
fn scope_and_outflow_fuzzer() -> Fuzzer<(Scope, Assets)> {
  let scope <- fuzz.and_then(scope_fuzzer())
  let outflow <- fuzz.map(outflow_fuzzer(scope))
  (scope, outflow)
}

/// A scope, an outflow and a second outflow with no more of either asset
/// leaving than the first.
fn smaller_outflow_fuzzer() -> Fuzzer<(Scope, Assets, Assets)> {
  let scope <- fuzz.and_then(scope_fuzzer())
  let outflow <- fuzz.and_then(outflow_fuzzer(scope))
  let less_lovelace <- fuzz.and_then(fuzz.int_between(0, 50))
  let less_tokens <- fuzz.map(fuzz.int_between(0, 50))
  (
    scope,
    outflow,
    leaving(
      assets.lovelace_of(outflow) - less_lovelace,
      quantity_of_asset(outflow, token_asset()) - less_tokens,
    ),
  )
}

/// A grant after a spend and the same grant with each remaining cap
/// lowered to anywhere from zero up to the expected value.
fn lowered_grant_fuzzer() -> Fuzzer<(Grant, Grant)> {
  let scope <- fuzz.and_then(scope_fuzzer())
  let cap <- fuzz.and_then(fuzz.int_between(0, scope.cap))
  let lovelace_cap <- fuzz.map(fuzz.int_between(0, scope.lovelace_cap))
  let expected = Grant { ..bumped_token_grant(), scope }
  (expected, Grant { ..expected, scope: Scope { ..scope, cap, lovelace_cap } })
}

/// A grant after a spend and the same grant with one remaining cap moved
/// above the expected value or below zero.
fn strayed_grant_fuzzer() -> Fuzzer<(Grant, Grant)> {
  let scope <- fuzz.and_then(scope_fuzzer())
  let on_lovelace <- fuzz.and_then(fuzz.bool())
  let stray <- fuzz.map(
    fuzz.either(fuzz.int_between(1, 50), fuzz.int_between(-50, -1)),
  )
  let expected = Grant { ..bumped_token_grant(), scope }
  let strayed = if on_lovelace {
    Scope {
      ..scope,
      lovelace_cap: if stray > 0 {
        scope.lovelace_cap + stray
      } else {
        stray
      },
    }
  } else {
    Scope {
      ..scope,
      cap: if stray > 0 {
        scope.cap + stray
      } else {
        stray
      },
    }
  }
  (expected, Grant { ..expected, scope: strayed })
}

/// A value of some lovelace and up to five tokens under random policies
/// and names.
fn value_fuzzer() -> Fuzzer<Assets> {
  let lovelace <- fuzz.and_then(fuzz.int_between(1, 1_000_000))
  let tokens <- fuzz.map(
    fuzz.list_between(
      fuzz.tuple3(
        fuzz.bytearray_fixed(28),
        fuzz.bytearray_between(0, 32),
        fuzz.int_between(1, 1_000),
      ),
      0,
      5,
    ),
  )
  list.foldl(
    tokens,
    assets.from_lovelace(lovelace),
    fn(entry, value) {
      let (policy_id, asset_name, quantity) = entry
      assets.add(value, policy_id, asset_name, quantity)
    },
  )
}

/// A state of a random generation with one to `max_revoked` distinct
/// revoked slots below `first_live_slot`, and a grant of one of those
/// slots issued under that generation or an older one.
fn revoked_grant_fuzzer() -> Fuzzer<(AccountState, Grant)> {
  let grant_generation <- fuzz.and_then(fuzz.int_between(0, 5))
  let revoked <- fuzz.and_then(
    fuzz.set_between(
      fuzz.int_between(0, first_live_slot - 1),
      1,
      state.max_revoked,
    ),
  )
  let picked <- fuzz.and_then(fuzz.pick(revoked))
  let generation <- fuzz.map(fuzz.int_between(0, grant_generation))
  let (_, slot) = picked
  (
    AccountState {
      ..bumped_state(),
      grant_generation,
      next_slot: first_live_slot,
      revoked,
      outstanding: 16,
    },
    Grant { ..bumped_lovelace_grant(), slot, generation },
  )
}

/// A state of a random generation with up to `max_revoked` distinct
/// revoked slots below `first_live_slot`, and a grant of a slot from
/// `first_live_slot` up issued under that generation, so that nothing
/// makes it dead but time.
fn live_grant_fuzzer() -> Fuzzer<(AccountState, Grant)> {
  let grant_generation <- fuzz.and_then(fuzz.int_between(0, 5))
  let revoked <- fuzz.and_then(
    fuzz.set_between(
      fuzz.int_between(0, first_live_slot - 1),
      0,
      state.max_revoked,
    ),
  )
  let slot <- fuzz.map(fuzz.int_between(first_live_slot, first_live_slot + 20))
  (
    AccountState {
      ..bumped_state(),
      grant_generation,
      next_slot: first_live_slot + 21,
      revoked,
      outstanding: 16,
    },
    Grant { ..bumped_lovelace_grant(), slot, generation: grant_generation },
  )
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
  is_current(bumped_lovelace_grant(), bumped_state())
}

test is_current_rejects_an_older_generation() {
  !is_current(
    Grant { ..bumped_lovelace_grant(), generation: 0 },
    bumped_state(),
  )
}

test is_current_rejects_a_newer_generation() {
  !is_current(
    Grant { ..bumped_lovelace_grant(), generation: 2 },
    bumped_state(),
  )
}

test is_current_rejects_a_revoked_slot() {
  !is_current(
    bumped_lovelace_grant(),
    AccountState { ..bumped_state(), revoked: [3, 0] },
  )
}

/// Whether `grant`, as an inline datum, is dead against `state` within
/// `validity_range`.
fn dead(
  grant: Grant,
  state: AccountState,
  validity_range: interval.Interval,
) -> Bool {
  let data: Data = grant
  is_dead(data, state, validity_range)
}

/// The lovelace grant of `generation` as a datum of another shape: its
/// four fields followed by a fifth.
fn padded_lovelace_grant(generation: Int) -> Data {
  let slot: Data = bumped_lovelace_grant().slot
  let grantee: Data = bumped_lovelace_grant().grantee
  let generation: Data = generation
  let scope: Data = bumped_lovelace_grant().scope
  let extra_field: Data = 7
  builtin.constr_data(0, [slot, grantee, generation, scope, extra_field])
}

test is_dead_rejects_a_live_grant() {
  !dead(bumped_lovelace_grant(), bumped_state(), interval.before(999))
}

test is_dead_accepts_an_older_generation() {
  dead(
    Grant { ..bumped_lovelace_grant(), generation: 0 },
    bumped_state(),
    interval.everything,
  )
}

test is_dead_accepts_a_revoked_slot() {
  dead(
    bumped_lovelace_grant(),
    AccountState { ..bumped_state(), revoked: [0] },
    interval.everything,
  )
}

test is_dead_accepts_a_range_starting_after_the_expiry() {
  dead(bumped_lovelace_grant(), bumped_state(), interval.after(1_001))
}

test is_dead_rejects_a_range_starting_at_the_expiry() {
  !dead(bumped_lovelace_grant(), bumped_state(), interval.after(1_000))
}

/// A grant of another shape dies by its prefix alone: an older generation
/// or a revoked slot kills it, and a range past the expiry its scope would
/// carry does not, since that scope cannot be read.
test is_dead_accepts_an_older_generation_of_a_grant_of_another_shape() {
  is_dead(padded_lovelace_grant(0), bumped_state(), interval.everything)
}

test is_dead_accepts_a_revoked_slot_of_a_grant_of_another_shape() {
  is_dead(
    padded_lovelace_grant(1),
    AccountState { ..bumped_state(), revoked: [0] },
    interval.everything,
  )
}

test is_dead_ignores_the_expiry_of_a_grant_of_another_shape() {
  !is_dead(padded_lovelace_grant(1), bumped_state(), interval.after(1_001))
}

test is_dead_fails_for_a_datum_without_the_prefix() fail {
  is_dead(builtin.constr_data(0, []), bumped_state(), interval.everything)
}

test a_revoked_slot_is_never_current(case via revoked_grant_fuzzer()) {
  let (state, grant) = case
  fuzz.label_when(
    grant.generation == state.grant_generation,
    @"current generation",
    @"older generation",
  )
  !is_current(grant, state)
}

test a_revoked_slot_is_dead_whatever_the_range(case via revoked_grant_fuzzer()) {
  let (state, grant) = case
  and {
    dead(grant, state, interval.everything),
    dead(grant, state, interval.before(grant.scope.expires_at)),
  }
}

test an_unrevoked_slot_of_the_generation_is_current(
  case via live_grant_fuzzer(),
) {
  let (state, grant) = case
  is_current(grant, state) && !dead(grant, state, interval.everything)
}

test a_grant_of_an_older_generation_is_never_current(
  case via live_grant_fuzzer(),
) {
  let (state, grant) = case
  let older = AccountState {
    ..state,
    grant_generation: state.grant_generation + 1,
  }
  !is_current(grant, older) && is_dead(grant, older, interval.everything)
}

test leaving_value_subtracts_what_returns_to_the_address() {
  let inputs = [
    input(0, grant_output(bumped_lovelace_grant(), 2_000_000)),
    input(1, fund_output(leaving(10_000_000, 20))),
    input(2, output(recipient_address(), assets.from_lovelace(1), NoDatum)),
  ]
  let outputs = [
    grant_output(bumped_lovelace_grant(), 2_000_000),
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

/// What the account pays as fee comes back to no output, so it leaves
/// like a payout.
test leaving_value_counts_the_fee_the_account_pays() {
  let inputs = [
    input(0, grant_output(bumped_lovelace_grant(), 2_000_000)),
    input(1, fund_output(assets.from_lovelace(10_000_000))),
  ]
  let outputs = [
    grant_output(bumped_lovelace_grant(), 2_000_000),
    fund_output(assets.from_lovelace(7_000_000)),
    output(recipient_address(), assets.from_lovelace(2_000_000), NoDatum),
  ]
  leaving_value(inputs, outputs, account_address()) == assets.from_lovelace(
    3_000_000,
  )
}

/// Two accounts in one transaction are netted apart: the other account's
/// deposit and change never offset what leaves this one.
test leaving_value_nets_each_account_address_on_its_own() {
  let inputs = [
    input(1, fund_output(assets.from_lovelace(10_000_000))),
    input(3, other_fund_output(assets.from_lovelace(10_000_000))),
    input(
      4,
      output(recipient_address(), assets.from_lovelace(2_000_000), NoDatum),
    ),
  ]
  let outputs = [
    fund_output(assets.from_lovelace(8_000_000)),
    other_fund_output(assets.from_lovelace(12_000_000)),
    output(recipient_address(), assets.from_lovelace(2_000_000), NoDatum),
  ]
  and {
    leaving_value(inputs, outputs, account_address()) == assets.from_lovelace(
      2_000_000,
    ),
    leaving_value(inputs, outputs, other_account_address()) == assets.from_lovelace(
      -2_000_000,
    ),
  }
}

test leaving_value_nets_to_zero_for_a_value_returned_unchanged(
  value via value_fuzzer(),
) {
  let inputs = [
    input(0, fund_output(value)),
    input(1, output(recipient_address(), value, NoDatum)),
  ]
  let outputs = [
    fund_output(value),
    output(recipient_address(), assets.from_lovelace(1), NoDatum),
  ]
  leaving_value(inputs, outputs, account_address()) == assets.zero
}

test quantity_of_asset_reads_lovelace_and_tokens() {
  let value = leaving(7, 3)
  quantity_of_asset(value, lovelace_asset()) == 7 && quantity_of_asset(
    value,
    token_asset(),
  ) == 3
}

test stays_within_scope_accepts_the_per_call_cap_exactly() {
  stays_within_scope(early_token_scope(), leaving(1_000_000, 10))
}

test stays_within_scope_rejects_one_above_the_per_call_cap() {
  !stays_within_scope(early_token_scope(), leaving(0, 11))
}

test stays_within_scope_accepts_the_remaining_cap_exactly() {
  let nearly_spent = Scope { ..early_token_scope(), cap: 5 }
  stays_within_scope(nearly_spent, leaving(0, 5))
}

test stays_within_scope_rejects_more_than_the_remaining_cap() {
  let nearly_spent = Scope { ..early_token_scope(), cap: 5 }
  !stays_within_scope(nearly_spent, leaving(0, 6))
}

test stays_within_scope_accepts_the_remaining_cap_of_a_lovelace_scope_exactly() {
  let nearly_spent = Scope { ..early_lovelace_scope(), cap: 2_000_000 }
  stays_within_scope(nearly_spent, assets.from_lovelace(2_000_000))
}

test stays_within_scope_rejects_one_above_the_remaining_cap_of_a_lovelace_scope() {
  let nearly_spent = Scope { ..early_lovelace_scope(), cap: 2_000_000 }
  !stays_within_scope(nearly_spent, assets.from_lovelace(2_000_001))
}

test stays_within_scope_accepts_the_lovelace_per_call_cap_exactly() {
  stays_within_scope(early_token_scope(), leaving(1_000_000, 0))
}

test stays_within_scope_rejects_one_above_the_lovelace_per_call_cap() {
  !stays_within_scope(early_token_scope(), leaving(1_000_001, 0))
}

test stays_within_scope_accepts_the_remaining_lovelace_cap_exactly() {
  let nearly_spent = Scope { ..early_token_scope(), lovelace_cap: 500_000 }
  stays_within_scope(nearly_spent, leaving(500_000, 0))
}

test stays_within_scope_rejects_lovelace_above_the_remaining_lovelace_cap() {
  let nearly_spent = Scope { ..early_token_scope(), lovelace_cap: 500_000 }
  !stays_within_scope(nearly_spent, leaving(500_001, 0))
}

test stays_within_scope_ignores_the_lovelace_caps_for_a_lovelace_scope() {
  stays_within_scope(early_lovelace_scope(), assets.from_lovelace(3_000_000))
}

test stays_within_scope_rejects_a_foreign_asset_leaving() {
  !stays_within_scope(
    early_lovelace_scope(),
    assets.merge(assets.from_lovelace(1), sibling_token(1)),
  )
}

test stays_within_scope_accepts_a_foreign_asset_entering() {
  stays_within_scope(
    early_lovelace_scope(),
    assets.merge(assets.from_lovelace(1), sibling_token(-1)),
  )
}

test stays_within_scope_accepts_a_deposit() {
  stays_within_scope(early_token_scope(), leaving(-1, -1))
}

test stays_within_scope_is_monotone_in_the_outflow(
  case via smaller_outflow_fuzzer(),
) {
  let (scope, outflow, smaller) = case
  let within = stays_within_scope(scope, outflow)
  fuzz.label_when(within, @"within scope", @"beyond scope")
  !within || stays_within_scope(scope, smaller)
}

test stays_within_scope_with_zero_caps_admits_only_deposits(
  outflow via outflow_fuzzer(empty_scope()),
) {
  let empty = empty_scope()
  stays_within_scope(empty, outflow) == (
    assets.lovelace_of(outflow) <= 0 && quantity_of_asset(
      outflow,
      token_asset(),
    ) <= 0
  )
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
      control_output(bumped_state(), 2_000_000),
      grant_output(bumped_lovelace_grant(), 2_000_000),
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
      grant_output(bumped_lovelace_grant(), 2_000_000),
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
      input(0, grant_output(bumped_lovelace_grant(), 2_000_000)),
      input(1, fund_output(assets.from_lovelace(1))),
    ],
    script_hash,
    stake_script_hash,
  )
}

test spends_one_account_token_rejects_a_grant_and_the_control() {
  !spends_one_account_token(
    [
      input(0, grant_output(bumped_lovelace_grant(), 2_000_000)),
      input(1, control_output(bumped_state(), 2_000_000)),
    ],
    script_hash,
    stake_script_hash,
  )
}

test spends_one_account_token_rejects_two_grant_inputs() {
  !spends_one_account_token(
    [
      input(0, grant_output(bumped_lovelace_grant(), 2_000_000)),
      input(1, grant_output(bumped_token_grant(), 2_000_000)),
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
          state_datum(bumped_state()),
        ),
      ),
    ],
    script_hash,
    stake_script_hash,
  )
}

test grant_after_spend_reduces_the_remaining_caps_only() {
  grant_after_spend(bumped_token_grant(), leaving(500_000, 7)) == Grant {
    ..bumped_token_grant(),
    scope: Scope { ..early_token_scope(), cap: 43, lovelace_cap: 1_500_000 },
  }
}

test grant_after_spend_keeps_the_lovelace_cap_of_a_lovelace_grant() {
  grant_after_spend(bumped_lovelace_grant(), assets.from_lovelace(1_000_000)) == Grant {
    ..bumped_lovelace_grant(),
    scope: Scope { ..early_lovelace_scope(), cap: 4_000_000 },
  }
}

test grant_after_spend_keeps_the_scope_on_a_net_deposit() {
  grant_after_spend(bumped_token_grant(), leaving(-500_000, -7)) == bumped_token_grant()
}

test grant_after_spend_ignores_a_lovelace_deposit_beside_a_token_withdrawal() {
  grant_after_spend(bumped_token_grant(), leaving(-500_000, 7)) == Grant {
    ..bumped_token_grant(),
    scope: Scope { ..early_token_scope(), cap: 43, lovelace_cap: 2_000_000 },
  }
}

test grant_after_spend_reduces_the_caps_to_zero_on_an_exact_spend() {
  grant_after_spend(bumped_token_grant(), leaving(2_000_000, 50)) == Grant {
    ..bumped_token_grant(),
    scope: Scope { ..early_token_scope(), cap: 0, lovelace_cap: 0 },
  }
}

test grant_after_spend_never_raises_a_cap(case via scope_and_outflow_fuzzer()) {
  let (scope, outflow) = case
  let grant = Grant { ..bumped_token_grant(), scope }
  let after = grant_after_spend(grant, outflow)
  fuzz.label_when(
    after.scope.cap == scope.cap && after.scope.lovelace_cap == scope.lovelace_cap,
    @"caps unchanged",
    @"a cap reduced",
  )
  and {
    after.scope.cap <= scope.cap,
    after.scope.lovelace_cap <= scope.lovelace_cap,
  }
}

test grant_after_spend_changes_nothing_but_the_remaining_caps(
  case via scope_and_outflow_fuzzer(),
) {
  let (scope, outflow) = case
  let grant = Grant { ..bumped_token_grant(), scope }
  let after = grant_after_spend(grant, outflow)
  Grant {
    ..after,
    scope: Scope {
      ..after.scope,
      cap: scope.cap,
      lovelace_cap: scope.lovelace_cap,
    },
  } == grant
}

test grant_after_spend_keeps_the_caps_non_negative_within_scope(
  case via scope_and_outflow_fuzzer(),
) {
  let (scope, outflow) = case
  let within = stays_within_scope(scope, outflow)
  fuzz.label_when(within, @"within scope", @"beyond scope")
  let after = grant_after_spend(
    Grant { ..bumped_token_grant(), scope },
    outflow,
  )
  !within || after.scope.cap >= 0 && after.scope.lovelace_cap >= 0
}

/// The token grant with its remaining caps replaced.
fn recapped(cap: Int, lovelace_cap: Int) -> Grant {
  Grant {
    ..bumped_token_grant(),
    scope: Scope { ..early_token_scope(), cap, lovelace_cap },
  }
}

/// Whether the grant output carrying `actual` passes as the token grant
/// after a spend expecting `expected`.
fn carries_within(actual: Grant, expected: Grant) -> Bool {
  carries_grant_within(grant_output(actual, 1), expected)
}

test carries_grant_within_accepts_the_expected_grant() {
  carries_within(bumped_token_grant(), bumped_token_grant())
}

test carries_grant_within_accepts_a_lower_cap() {
  carries_within(recapped(42, 1_500_000), recapped(43, 1_500_000))
}

test carries_grant_within_accepts_a_lower_lovelace_cap() {
  carries_within(recapped(43, 1_499_999), recapped(43, 1_500_000))
}

test carries_grant_within_accepts_both_caps_lowered_to_zero() {
  carries_within(recapped(0, 0), recapped(43, 1_500_000))
}

test carries_grant_within_rejects_a_cap_one_above_the_expected() {
  !carries_within(recapped(44, 1_500_000), recapped(43, 1_500_000))
}

test carries_grant_within_rejects_a_negative_cap() {
  !carries_within(recapped(-1, 1_500_000), recapped(43, 1_500_000))
}

test carries_grant_within_rejects_a_lovelace_cap_one_above_the_expected() {
  !carries_within(recapped(43, 1_500_001), recapped(43, 1_500_000))
}

test carries_grant_within_rejects_a_negative_lovelace_cap() {
  !carries_within(recapped(43, -1), recapped(43, 1_500_000))
}

test carries_grant_within_rejects_a_lovelace_cap_on_a_lovelace_grant() {
  let lowered = Grant {
    ..bumped_lovelace_grant(),
    scope: Scope { ..early_lovelace_scope(), cap: 4_000_000 },
  }
  and {
    carries_within(lowered, lowered),
    !carries_within(
      Grant { ..lowered, scope: Scope { ..lowered.scope, lovelace_cap: 1 } },
      lowered,
    ),
  }
}

test carries_grant_within_rejects_a_changed_per_call_cap() {
  let expected = recapped(43, 1_500_000)
  and {
    !carries_within(
      Grant { ..expected, scope: Scope { ..expected.scope, per_call_cap: 9 } },
      expected,
    ),
    !carries_within(
      Grant {
        ..expected,
        scope: Scope { ..expected.scope, lovelace_per_call_cap: 999_999 },
      },
      expected,
    ),
  }
}

test carries_grant_within_rejects_a_changed_generation() {
  !carries_within(
    Grant { ..bumped_token_grant(), generation: 2 },
    bumped_token_grant(),
  )
}

test carries_grant_within_rejects_a_changed_expiry() {
  !carries_within(
    Grant {
      ..bumped_token_grant(),
      scope: Scope { ..early_token_scope(), expires_at: 999 },
    },
    bumped_token_grant(),
  )
}

test carries_grant_within_rejects_a_datum_given_by_hash() {
  let hashed = output(
    account_address(),
    grant_value(stake_script_hash, 1, 1),
    DatumHash(stranger_key),
  )
  !carries_grant_within(hashed, bumped_token_grant())
}

test carries_grant_within_rejects_a_missing_datum() {
  let bare = output(
    account_address(),
    grant_value(stake_script_hash, 1, 1),
    NoDatum,
  )
  !carries_grant_within(bare, bumped_token_grant())
}

test carries_grant_within_accepts_caps_lowered_down_to_zero(
  case via lowered_grant_fuzzer(),
) {
  let (expected, actual) = case
  fuzz.label_when(
    actual.scope.cap == expected.scope.cap && actual.scope.lovelace_cap == expected.scope.lovelace_cap,
    @"caps as expected",
    @"a cap lowered",
  )
  carries_within(actual, expected)
}

test carries_grant_within_refuses_a_cap_above_the_expected_or_below_zero(
  case via strayed_grant_fuzzer(),
) {
  let (expected, actual) = case
  fuzz.label_when(
    actual.scope.cap > expected.scope.cap || actual.scope.lovelace_cap > expected.scope.lovelace_cap,
    @"a cap above the expected",
    @"a cap below zero",
  )
  !carries_within(actual, expected)
}

test carries_no_reference_script_accepts_a_plain_grant_output() {
  carries_no_reference_script(grant_output(bumped_lovelace_grant(), 1))
}

test carries_no_reference_script_rejects_a_reference_script() {
  let weighted = Output {
    ..grant_output(bumped_lovelace_grant(), 1),
    reference_script: Some(script_hash),
  }
  !carries_no_reference_script(weighted)
}
