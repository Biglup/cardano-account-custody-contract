//// The bounds `logic_v1` puts on an account state and a grant scope, and
//// the predicates that check them. The rules and the arrival path call
//// these on the state a control output writes back and on the grant an
//// issuance mints. Every function here reads plain values, returns `False`
//// on a bound that does not hold and never aborts.

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
use cardano/assets.{ada_asset_name, ada_policy_id}
use cardano_account_custody_contract/types.{AccountState, Asset, Grant, Scope}

// CONSTANTS *******************************************************************

/// The most device keys a well formed state may list. `is_well_formed`
/// enforces it, with a lower bound of one, under `logic_v1` on every
/// state written back.
pub const max_devices = 8

/// The most outstanding grants a well formed state may count.
/// `is_well_formed` enforces it under `logic_v1` on every state written
/// back.
pub const max_grants = 16

/// The most grant slots the revoked list of a well formed state may hold.
/// Once it is full, a device raises the grant generation to revoke more.
/// `is_well_formed` enforces it under `logic_v1` on every state written
/// back.
pub const max_revoked = 32

/// The most recipients a well formed scope may list.
/// `is_scope_well_formed` enforces it under `logic_v1` at issuance.
pub const max_recipients = 8

// FUNCTIONS *******************************************************************

/// Whether `asset` is lovelace: the empty policy id with the empty asset
/// name. Never aborts.
pub fn is_lovelace(asset: Asset) -> Bool {
  asset.policy_id == ada_policy_id && asset.asset_name == ada_asset_name
}

/// Whether `scope` obeys the bounds of `logic_v1`: all four caps non
/// negative, `expires_at` positive, at most `max_recipients` recipients,
/// and both lovelace caps zero when `asset` is lovelace. Returns `False`
/// when any bound does not hold. Never aborts.
pub fn is_scope_well_formed(scope: Scope) -> Bool {
  let caps_ok = and {
    scope.per_call_cap >= 0,
    scope.cap >= 0,
    scope.lovelace_per_call_cap >= 0,
    scope.lovelace_cap >= 0,
  }
  let expiry_ok = scope.expires_at > 0
  let recipients_ok = list.length(scope.recipients) <= max_recipients
  let lovelace_caps_ok = if is_lovelace(scope.asset) {
    scope.lovelace_per_call_cap == 0 && scope.lovelace_cap == 0
  } else {
    True
  }

  caps_ok && expiry_ok && recipients_ok && lovelace_caps_ok
}

/// Whether the scope of `grant` is well formed. `slot`, `grantee` and
/// `generation` are not read; issuance ties them to the control UTxO.
/// Returns `False` when the scope breaks a bound. Never aborts.
pub fn is_grant_well_formed(grant: Grant) -> Bool {
  is_scope_well_formed(grant.scope)
}

/// Whether `state` obeys every bound of `logic_v1`: one to `max_devices`
/// distinct devices, non negative `grant_generation`, `next_slot` and
/// `outstanding`, at most `max_grants` outstanding grants and at most
/// `max_revoked` revoked slots. `logic` is not read; any byte string
/// passes. The revoked slots themselves are not read. Returns `False`
/// when any bound does not hold. Never aborts.
pub fn is_well_formed(state: AccountState) -> Bool {
  let device_count = list.length(state.devices)
  and {
    device_count >= 1,
    device_count <= max_devices,
    list.length(list.unique(state.devices)) == device_count,
    state.grant_generation >= 0,
    state.next_slot >= 0,
    state.outstanding >= 0,
    state.outstanding <= max_grants,
    list.length(state.revoked) <= max_revoked,
  }
}

/// Whether `state` has issued nothing yet: `next_slot` and `outstanding`
/// zero and the revoked list empty, as every account starts. `logic`,
/// `devices` and `grant_generation` are not read. Returns `False` when a
/// counter is not zero or the revoked list is not empty. Never aborts.
pub fn has_zero_counters(state: AccountState) -> Bool {
  and {
    state.next_slot == 0,
    state.revoked == [],
    state.outstanding == 0,
  }
}
