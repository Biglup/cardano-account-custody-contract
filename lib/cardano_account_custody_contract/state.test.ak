use aiken/collection/list
use aiken/primitive/bytearray
use cardano/address
use cardano/assets.{ada_asset_name, ada_policy_id}
use cardano_account_custody_contract/state.{find_grant, is_well_formed}
use cardano_account_custody_contract/types.{
  AccountState, Asset, Ed25519, Grant, Scope,
}

fn key(n: Int) -> ByteArray {
  bytearray.push(#"", n)
}

fn devices(count: Int) -> List<ByteArray> {
  list.range(1, count) |> list.map(key)
}

fn recipients(count: Int) -> List<address.Address> {
  list.range(1, count)
    |> list.map(fn(n) { address.from_verification_key(key(100 + n)) })
}

fn lovelace() -> Asset {
  Asset { policy_id: ada_policy_id, asset_name: ada_asset_name }
}

fn other_asset() -> Asset {
  Asset { policy_id: #"ab", asset_name: #"" }
}

fn valid_scope() -> Scope {
  Scope {
    asset: other_asset(),
    per_call_cap: 100,
    cap: 1_000,
    lovelace_cap: 500,
    expires_at: 2_000_000_000_000,
    recipients: [],
  }
}

fn valid_grant(slot: Int) -> Grant {
  Grant { slot, grantee: Ed25519(key(50)), scope: valid_scope() }
}

fn valid_state() -> AccountState {
  AccountState {
    devices: devices(1),
    grants: [valid_grant(0)],
    grant_generation: 0,
  }
}

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

test is_well_formed_accepts_sixteen_grants_with_distinct_slots() {
  let grants = list.range(1, 16) |> list.map(valid_grant)
  let state = AccountState { ..valid_state(), grants }
  is_well_formed(state)
}

test is_well_formed_rejects_seventeen_grants() {
  let grants = list.range(1, 17) |> list.map(valid_grant)
  let state = AccountState { ..valid_state(), grants }
  !is_well_formed(state)
}

test is_well_formed_rejects_a_duplicate_slot() {
  let state = AccountState {
    ..valid_state(),
    grants: [valid_grant(0), valid_grant(0)],
  }
  !is_well_formed(state)
}

test is_well_formed_accepts_zero_caps_for_a_non_lovelace_asset() {
  let scope = Scope {
    ..valid_scope(),
    per_call_cap: 0,
    cap: 0,
    lovelace_cap: 0,
  }
  let grant = Grant { ..valid_grant(0), scope }
  let state = AccountState { ..valid_state(), grants: [grant] }
  is_well_formed(state)
}

test is_well_formed_rejects_a_negative_per_call_cap() {
  let scope = Scope { ..valid_scope(), per_call_cap: -1 }
  let grant = Grant { ..valid_grant(0), scope }
  let state = AccountState { ..valid_state(), grants: [grant] }
  !is_well_formed(state)
}

test is_well_formed_rejects_a_negative_cap() {
  let scope = Scope { ..valid_scope(), cap: -1 }
  let grant = Grant { ..valid_grant(0), scope }
  let state = AccountState { ..valid_state(), grants: [grant] }
  !is_well_formed(state)
}

test is_well_formed_rejects_a_negative_lovelace_cap() {
  let scope = Scope { ..valid_scope(), lovelace_cap: -1 }
  let grant = Grant { ..valid_grant(0), scope }
  let state = AccountState { ..valid_state(), grants: [grant] }
  !is_well_formed(state)
}

test is_well_formed_rejects_a_zero_expiry() {
  let scope = Scope { ..valid_scope(), expires_at: 0 }
  let grant = Grant { ..valid_grant(0), scope }
  let state = AccountState { ..valid_state(), grants: [grant] }
  !is_well_formed(state)
}

test is_well_formed_accepts_an_expiry_of_one() {
  let scope = Scope { ..valid_scope(), expires_at: 1 }
  let grant = Grant { ..valid_grant(0), scope }
  let state = AccountState { ..valid_state(), grants: [grant] }
  is_well_formed(state)
}

test is_well_formed_accepts_eight_recipients() {
  let scope = Scope { ..valid_scope(), recipients: recipients(8) }
  let grant = Grant { ..valid_grant(0), scope }
  let state = AccountState { ..valid_state(), grants: [grant] }
  is_well_formed(state)
}

test is_well_formed_rejects_nine_recipients() {
  let scope = Scope { ..valid_scope(), recipients: recipients(9) }
  let grant = Grant { ..valid_grant(0), scope }
  let state = AccountState { ..valid_state(), grants: [grant] }
  !is_well_formed(state)
}

test is_well_formed_rejects_lovelace_with_a_non_zero_lovelace_cap() {
  let scope = Scope { ..valid_scope(), asset: lovelace(), lovelace_cap: 1 }
  let grant = Grant { ..valid_grant(0), scope }
  let state = AccountState { ..valid_state(), grants: [grant] }
  !is_well_formed(state)
}

test is_well_formed_accepts_lovelace_with_a_zero_lovelace_cap() {
  let scope = Scope { ..valid_scope(), asset: lovelace(), lovelace_cap: 0 }
  let grant = Grant { ..valid_grant(0), scope }
  let state = AccountState { ..valid_state(), grants: [grant] }
  is_well_formed(state)
}

test is_well_formed_rejects_a_negative_grant_generation() {
  let state = AccountState { ..valid_state(), grant_generation: -1 }
  !is_well_formed(state)
}

test find_grant_returns_the_grant_in_its_slot() {
  find_grant(valid_state(), 0) == Some(valid_grant(0))
}

test find_grant_returns_none_for_a_missing_slot() {
  find_grant(valid_state(), 1) == None
}
