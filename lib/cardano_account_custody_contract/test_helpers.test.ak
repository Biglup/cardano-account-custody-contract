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
use aiken/primitive/bytearray
use cardano/address.{Inline, Script}
use cardano/assets
use cardano/certificate.{RegisterCredential}
use cardano/transaction.{InlineDatum, NoDatum, Publish}
use cardano_account_custody_contract/account
use cardano_account_custody_contract/test_helpers.{
  account_address, control_output, control_value, device_key, fund_output,
  grant_output, grant_token, grant_value, input, other_account_address,
  other_control_output, other_fund_output, other_grant_output,
  other_stake_script_hash, output_reference, publishing, referencing,
  registration, script_hash, stake_script_hash, state_nft, stranger_key,
}
use cardano_account_custody_contract/types.{
  AccountState, Asset, Grant, Operate, Scope,
}

// FUNCTIONS *******************************************************************

/// The fresh state of the account under test: one device and zero
/// counters.
fn state() -> AccountState {
  AccountState {
    devices: [device_key],
    grant_generation: 0,
    next_slot: 0,
    revoked: [],
    outstanding: 0,
  }
}

/// A minimal grant of slot 3 to the stranger over lovelace.
fn grant() -> Grant {
  Grant {
    slot: 3,
    grantee: stranger_key,
    generation: 0,
    scope: Scope {
      asset: Asset {
        policy_id: assets.ada_policy_id,
        asset_name: assets.ada_asset_name,
      },
      per_call_cap: 1,
      cap: 1,
      lovelace_per_call_cap: 0,
      lovelace_cap: 0,
      expires_at: 1,
      recipients: [],
    },
  }
}

// TESTS ***********************************************************************

test account_address_pays_to_the_script_and_stakes_to_the_stake_script() {
  let address = account_address()
  address.payment_credential == Script(script_hash) && address.stake_credential == Some(
    Inline(Script(stake_script_hash)),
  )
}

test output_references_differ_by_index() {
  output_reference(0) != output_reference(1) && output_reference(1).output_index == 1
}

test input_resolves_to_the_given_output() {
  let fund = fund_output(assets.from_lovelace(5))
  let built = input(3, fund)
  built.output_reference == output_reference(3) && built.output == fund
}

test control_output_carries_the_state_nft_and_the_inline_state() {
  let control = control_output(state(), 2_000_000)
  let data: Data = state()
  and {
    control.address == account_address(),
    control.value == control_value(stake_script_hash, 2_000_000),
    assets.quantity_of(control.value, script_hash, stake_script_hash) == 1,
    assets.lovelace_of(control.value) == 2_000_000,
    control.datum == InlineDatum(data),
    control.reference_script == None,
  }
}

test grant_token_is_named_after_the_account_and_the_slot() {
  let name = bytearray.concat(stake_script_hash, #"00000003")
  and {
    grant_token(stake_script_hash, 3) == assets.from_asset(script_hash, name, 1),
    bytearray.length(name) == 32,
  }
}

test grant_output_carries_the_grant_token_and_the_inline_grant() {
  let built = grant_output(grant(), 2_000_000)
  let data: Data = grant()
  and {
    built.address == account_address(),
    built.value == grant_value(stake_script_hash, 3, 2_000_000),
    built.value == assets.merge(
      assets.from_lovelace(2_000_000),
      grant_token(stake_script_hash, 3),
    ),
    built.datum == InlineDatum(data),
    built.reference_script == None,
  }
}

test fund_output_carries_no_datum() {
  let fund = fund_output(assets.from_lovelace(5))
  fund.address == account_address() && fund.datum == NoDatum
}

test other_control_output_sits_at_the_other_account_under_its_own_nft() {
  let control = other_control_output(state(), 2_000_000)
  let data: Data = state()
  and {
    control.address == other_account_address(),
    control.value == control_value(other_stake_script_hash, 2_000_000),
    assets.quantity_of(control.value, script_hash, stake_script_hash) == 0,
    control.datum == InlineDatum(data),
    control.reference_script == None,
  }
}

test other_grant_output_sits_at_the_other_account_under_its_own_token() {
  let built = other_grant_output(grant(), 2_000_000)
  let data: Data = grant()
  and {
    built.address == other_account_address(),
    built.value == grant_value(other_stake_script_hash, 3, 2_000_000),
    assets.quantity_of(
      built.value,
      script_hash,
      account.grant_token_name(stake_script_hash, 3),
    ) == 0,
    built.datum == InlineDatum(data),
    built.reference_script == None,
  }
}

test other_fund_output_sits_at_the_other_account_without_a_datum() {
  let fund = other_fund_output(assets.from_lovelace(5))
  and {
    fund.address == other_account_address(),
    fund.value == assets.from_lovelace(5),
    fund.datum == NoDatum,
  }
}

test transaction_carries_the_given_parts() {
  let control = input(0, control_output(state(), 2_000_000))
  let payout = fund_output(assets.from_lovelace(1))
  let mint = state_nft(stake_script_hash)
  let range = interval.before(10)
  let built = test_helpers.transaction(
    [control],
    [payout],
    mint,
    [device_key],
    range,
  )
  and {
    built.inputs == [control],
    built.outputs == [payout],
    built.mint == mint,
    built.extra_signatories == [device_key],
    built.validity_range == range,
    built.reference_inputs == [],
    built.fee == 0,
  }
}

test referencing_sets_the_reference_inputs() {
  let control = input(0, control_output(state(), 2_000_000))
  let built = test_helpers.transaction(
    [],
    [],
    assets.zero,
    [device_key],
    interval.everything,
  )
    |> referencing([control])
  built.reference_inputs == [control] && built.inputs == []
}

test registration_registers_the_script_credential() {
  registration(stake_script_hash) == RegisterCredential {
    credential: Script(stake_script_hash),
    deposit: Never,
  }
}

test publishing_appends_the_certificate_and_its_redeemer() {
  let first = registration(stake_script_hash)
  let second = registration(other_stake_script_hash)
  let redeemer: Data = Operate
  let built = test_helpers.transaction(
    [],
    [],
    assets.zero,
    [device_key],
    interval.everything,
  )
    |> publishing(first)
    |> publishing(second)
  and {
    built.certificates == [first, second],
    built.redeemers == [
      Pair(Publish { at: 0, certificate: first }, redeemer),
      Pair(Publish { at: 1, certificate: second }, redeemer),
    ],
    built.extra_signatories == [device_key],
  }
}
