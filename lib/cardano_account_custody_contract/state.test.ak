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

use aiken/collection/list
use aiken/primitive/bytearray
use cardano/address
use cardano/assets.{ada_asset_name, ada_policy_id}
use cardano_account_custody_contract/state.{
  has_zero_counters, is_grant_well_formed, is_scope_well_formed, is_well_formed,
}
use cardano_account_custody_contract/types.{AccountState, Asset, Grant, Scope}

// FUNCTIONS *******************************************************************

/// A one byte key hash holding `n`.
fn key(n: Int) -> ByteArray {
  bytearray.push(#"", n)
}

/// `count` distinct device keys.
fn devices(count: Int) -> List<ByteArray> {
  list.range(1, count) |> list.map(key)
}

/// `count` distinct key addresses.
fn recipients(count: Int) -> List<address.Address> {
  list.range(1, count)
    |> list.map(fn(n) { address.from_verification_key(key(100 + n)) })
}

/// Lovelace as a scoped asset.
fn lovelace() -> Asset {
  Asset { policy_id: ada_policy_id, asset_name: ada_asset_name }
}

/// A native asset under a foreign policy.
fn other_asset() -> Asset {
  Asset { policy_id: #"ab", asset_name: #"" }
}

/// A well formed scope over the native asset with every cap set and no
/// recipient restriction.
fn valid_scope() -> Scope {
  Scope {
    asset: other_asset(),
    per_call_cap: 100,
    cap: 1_000,
    lovelace_per_call_cap: 250,
    lovelace_cap: 500,
    expires_at: 2_000_000_000_000,
    recipients: [],
  }
}

/// A well formed grant of slot 0 under the valid scope.
fn valid_grant() -> Grant {
  Grant { slot: 0, grantee: key(50), generation: 0, scope: valid_scope() }
}

/// A well formed state with one device and one issued grant.
fn valid_state() -> AccountState {
  AccountState {
    logic: #"00000000000000000000000000000000000000000000000000000008",
    devices: devices(1),
    grant_generation: 0,
    next_slot: 1,
    revoked: [],
    outstanding: 1,
  }
}

// TESTS ***********************************************************************

test is_well_formed_accepts_a_valid_state() {
  is_well_formed(valid_state())
}

test is_well_formed_rejects_empty_devices() {
  let state = AccountState { ..valid_state(), devices: [] }
  !is_well_formed(state)
}

test is_well_formed_accepts_eight_devices() {
  let state = AccountState { ..valid_state(), devices: devices(8) }
  is_well_formed(state)
}

test is_well_formed_rejects_nine_devices() {
  let state = AccountState { ..valid_state(), devices: devices(9) }
  !is_well_formed(state)
}

test is_well_formed_rejects_a_duplicate_device() {
  let state = AccountState { ..valid_state(), devices: [key(1), key(1)] }
  !is_well_formed(state)
}

test is_well_formed_rejects_a_negative_grant_generation() {
  let state = AccountState { ..valid_state(), grant_generation: -1 }
  !is_well_formed(state)
}

test is_well_formed_rejects_a_negative_next_slot() {
  let state = AccountState { ..valid_state(), next_slot: -1 }
  !is_well_formed(state)
}

test is_well_formed_rejects_a_negative_outstanding_count() {
  let state = AccountState { ..valid_state(), outstanding: -1 }
  !is_well_formed(state)
}

test is_well_formed_accepts_sixteen_outstanding_grants() {
  let state = AccountState { ..valid_state(), outstanding: 16 }
  is_well_formed(state)
}

test is_well_formed_rejects_seventeen_outstanding_grants() {
  let state = AccountState { ..valid_state(), outstanding: 17 }
  !is_well_formed(state)
}

test is_well_formed_accepts_thirty_two_revoked_slots() {
  let state = AccountState { ..valid_state(), revoked: list.range(1, 32) }
  is_well_formed(state)
}

test is_well_formed_rejects_thirty_three_revoked_slots() {
  let state = AccountState { ..valid_state(), revoked: list.range(1, 33) }
  !is_well_formed(state)
}

test has_zero_counters_accepts_an_initial_state() {
  has_zero_counters(
    AccountState { ..valid_state(), next_slot: 0, outstanding: 0 },
  )
}

test has_zero_counters_rejects_an_issued_slot() {
  !has_zero_counters(AccountState { ..valid_state(), outstanding: 0 })
}

test has_zero_counters_rejects_an_outstanding_grant() {
  !has_zero_counters(AccountState { ..valid_state(), next_slot: 0 })
}

test has_zero_counters_rejects_a_revoked_slot() {
  !has_zero_counters(
    AccountState { ..valid_state(), next_slot: 0, outstanding: 0, revoked: [0] },
  )
}

test has_zero_counters_ignores_the_grant_generation() {
  has_zero_counters(
    AccountState {
      ..valid_state(),
      next_slot: 0,
      outstanding: 0,
      grant_generation: 3,
    },
  )
}

test is_grant_well_formed_accepts_a_valid_grant() {
  is_grant_well_formed(valid_grant())
}

test is_grant_well_formed_rejects_an_ill_formed_scope() {
  !is_grant_well_formed(
    Grant { ..valid_grant(), scope: Scope { ..valid_scope(), cap: -1 } },
  )
}

test is_scope_well_formed_accepts_zero_caps_for_a_non_lovelace_asset() {
  is_scope_well_formed(
    Scope {
      ..valid_scope(),
      per_call_cap: 0,
      cap: 0,
      lovelace_per_call_cap: 0,
      lovelace_cap: 0,
    },
  )
}

test is_scope_well_formed_rejects_a_negative_per_call_cap() {
  !is_scope_well_formed(Scope { ..valid_scope(), per_call_cap: -1 })
}

test is_scope_well_formed_rejects_a_negative_cap() {
  !is_scope_well_formed(Scope { ..valid_scope(), cap: -1 })
}

test is_scope_well_formed_rejects_a_negative_lovelace_per_call_cap() {
  !is_scope_well_formed(Scope { ..valid_scope(), lovelace_per_call_cap: -1 })
}

test is_scope_well_formed_rejects_a_negative_lovelace_cap() {
  !is_scope_well_formed(Scope { ..valid_scope(), lovelace_cap: -1 })
}

test is_scope_well_formed_rejects_a_zero_expiry() {
  !is_scope_well_formed(Scope { ..valid_scope(), expires_at: 0 })
}

test is_scope_well_formed_accepts_an_expiry_of_one() {
  is_scope_well_formed(Scope { ..valid_scope(), expires_at: 1 })
}

test is_scope_well_formed_accepts_eight_recipients() {
  is_scope_well_formed(Scope { ..valid_scope(), recipients: recipients(8) })
}

test is_scope_well_formed_rejects_nine_recipients() {
  !is_scope_well_formed(Scope { ..valid_scope(), recipients: recipients(9) })
}

test is_scope_well_formed_rejects_lovelace_with_a_non_zero_lovelace_per_call_cap() {
  !is_scope_well_formed(
    Scope {
      ..valid_scope(),
      asset: lovelace(),
      lovelace_per_call_cap: 1,
      lovelace_cap: 0,
    },
  )
}

test is_scope_well_formed_rejects_lovelace_with_a_non_zero_lovelace_cap() {
  !is_scope_well_formed(
    Scope {
      ..valid_scope(),
      asset: lovelace(),
      lovelace_per_call_cap: 0,
      lovelace_cap: 1,
    },
  )
}

test is_scope_well_formed_accepts_lovelace_with_zero_lovelace_caps() {
  is_scope_well_formed(
    Scope {
      ..valid_scope(),
      asset: lovelace(),
      lovelace_per_call_cap: 0,
      lovelace_cap: 0,
    },
  )
}
