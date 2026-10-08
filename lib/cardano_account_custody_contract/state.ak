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

/// The maximum number of device keys an account may hold.
pub const max_devices = 8

/// The maximum number of outstanding grants an account may hold.
pub const max_grants = 16

/// The maximum number of revoked slots the state may list before the owner
/// has to bump the grant generation instead.
pub const max_revoked = 32

/// The maximum number of recipients a grant's scope may list.
pub const max_recipients = 8

// FUNCTIONS *******************************************************************

/// Whether an asset class is lovelace.
pub fn is_lovelace(asset: Asset) -> Bool {
  asset.policy_id == ada_policy_id && asset.asset_name == ada_asset_name
}

/// Whether a scope obeys the bounds: non-negative caps, a positive expiry,
/// at most `max_recipients` recipients, and zero lovelace caps when the
/// asset is lovelace.
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

/// Whether a grant's scope is well formed; its slot and generation are
/// tied to the control UTxO at issuance.
pub fn is_grant_well_formed(grant: Grant) -> Bool {
  is_scope_well_formed(grant.scope)
}

/// Whether a state obeys every bound: one to `max_devices` distinct devices,
/// non-negative counters, at most `max_grants` outstanding grants and at
/// most `max_revoked` revoked slots.
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

/// Whether a state has issued nothing yet: zero counters and no revoked
/// slot, as every account starts.
pub fn has_zero_counters(state: AccountState) -> Bool {
  and {
    state.next_slot == 0,
    state.revoked == [],
    state.outstanding == 0,
  }
}
