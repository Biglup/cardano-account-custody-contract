use aiken/collection/list
use cardano/assets.{ada_asset_name, ada_policy_id}
use cardano_account_custody_contract/types.{AccountState, Asset, Grant, Scope}

/// The maximum number of device keys an account may hold.
pub const max_devices = 8

/// The maximum number of outstanding grants an account may hold.
pub const max_grants = 16

/// The maximum number of recipients a grant's scope may list.
pub const max_recipients = 8

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

/// Whether a grant's scope is well formed; slot uniqueness is checked by
/// `is_well_formed`.
pub fn is_grant_well_formed(grant: Grant) -> Bool {
  is_scope_well_formed(grant.scope)
}

/// Whether a state obeys every bound: one to `max_devices` distinct devices,
/// at most `max_grants` grants with distinct slots and well formed scopes,
/// and a non-negative grant generation.
pub fn is_well_formed(state: AccountState) -> Bool {
  let device_count = list.length(state.devices)
  let devices_ok = device_count >= 1 && device_count <= max_devices && list.length(
    list.unique(state.devices),
  ) == device_count

  let grant_count = list.length(state.grants)
  let slots = list.map(state.grants, fn(grant) { grant.slot })
  let grants_ok = grant_count <= max_grants && list.length(list.unique(slots)) == grant_count && list.all(
    state.grants,
    is_grant_well_formed,
  )

  devices_ok && grants_ok && state.grant_generation >= 0
}

/// The grant occupying a slot, if any; well formed states hold at most one.
pub fn find_grant(state: AccountState, slot: Int) -> Option<Grant> {
  list.find(state.grants, fn(grant) { grant.slot == slot })
}
