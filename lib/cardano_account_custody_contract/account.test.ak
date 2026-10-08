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

//
// USINGS **********************************************************************

use aiken/primitive/bytearray
use cardano/address.{Address, Inline, Pointer, Script, VerificationKey}
use cardano/assets
use cardano/certificate.{
  DelegateBlockProduction, DelegateCredential, RegisterAndDelegateCredential,
  RegisterDelegateRepresentative, UnregisterCredential,
}
use cardano/transaction.{DatumHash, Mint, NoDatum}
use cardano_account_custody_contract/account.{
  account_address, account_of_name, count_account_token_inputs,
  find_control_input, find_control_output, find_grant_output, find_token_output,
  grant_mint_delta, grant_token_name, has_account_token_input, has_control_input,
  holds_account_token, holds_no_account_token,
  holds_only_lovelace_and_grant_token, holds_only_lovelace_and_state_nft,
  holds_state_nft, is_authorised_by_a_device, is_control_output, is_grant_name,
  is_signed_by_a_device, is_state_nft_name, is_valid_control_output, own_input,
  registers_credential, registers_stake_credential, script_hash_of,
  stake_script_hash_of, state_datum, tokens_sit_at_their_own_addresses,
}
use cardano_account_custody_contract/test_helpers.{
  control_output, control_value, device_key, fund_output, grant_output,
  grant_token, grant_value, input, other_account_address,
  other_stake_script_hash, output, output_reference, publishing,
  recipient_address, registration, script_hash, stake_script_hash, state_nft,
  stranger_key,
}
use cardano_account_custody_contract/types.{
  AccountState, Asset, Grant, Operate, Scope,
}

// FUNCTIONS *******************************************************************

/// The state of the account under test: one device and one issued grant.
fn state() -> AccountState {
  AccountState {
    devices: [device_key],
    grant_generation: 0,
    next_slot: 1,
    revoked: [],
    outstanding: 1,
  }
}

/// The control UTxO of the state with 2 ADA.
fn control() -> transaction.Output {
  control_output(state(), 2_000_000)
}

/// A minimal grant of slot 0 to the stranger over lovelace.
fn grant() -> Grant {
  Grant {
    slot: 0,
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

/// The grant UTxO of the grant with 2 ADA.
fn grant_utxo() -> transaction.Output {
  grant_output(grant(), 2_000_000)
}

/// One token under a policy that is not the account policy.
fn other_token() -> assets.Assets {
  assets.from_asset(
    #"00000000000000000000000000000000000000000000000000000099",
    "token",
    1,
  )
}

// TESTS ***********************************************************************

test own_input_finds_the_input_by_output_reference() {
  let control = input(0, control())
  let fund = input(1, fund_output(assets.from_lovelace(5)))
  own_input([fund, control], output_reference(0)) == control
}

test own_input_fails_when_the_reference_is_not_spent() fail {
  let fund = input(1, fund_output(assets.from_lovelace(5)))
  own_input([fund], output_reference(0)) == fund
}

test script_hash_of_returns_the_payment_script() {
  script_hash_of(test_helpers.account_address()) == script_hash
}

test script_hash_of_fails_for_a_key_address() fail {
  script_hash_of(recipient_address()) == script_hash
}

test stake_script_hash_of_returns_the_inline_stake_script() {
  stake_script_hash_of(test_helpers.account_address()) == stake_script_hash
}

test stake_script_hash_of_fails_without_a_stake_credential() fail {
  stake_script_hash_of(address.from_script(script_hash)) == stake_script_hash
}

test stake_script_hash_of_fails_for_a_key_stake_credential() fail {
  let address = address.from_script(script_hash)
    |> address.with_delegation_key(stake_script_hash)
  stake_script_hash_of(address) == stake_script_hash
}

test stake_script_hash_of_fails_for_a_pointer_stake_credential() fail {
  let address = Address {
    payment_credential: Script(script_hash),
    stake_credential: Some(
      Pointer { slot_number: 1, transaction_index: 2, certificate_index: 3 },
    ),
  }
  stake_script_hash_of(address) == stake_script_hash
}

test account_address_pairs_the_script_with_the_stake_script() {
  account_address(script_hash, stake_script_hash) == Address {
    payment_credential: Script(script_hash),
    stake_credential: Some(Inline(Script(stake_script_hash))),
  }
}

test account_address_differs_from_the_key_stake_form_of_the_same_bytes() {
  account_address(script_hash, stake_script_hash) != Address {
    payment_credential: Script(script_hash),
    stake_credential: Some(Inline(VerificationKey(stake_script_hash))),
  }
}

test grant_token_name_appends_the_slot_as_four_big_endian_bytes() {
  and {
    grant_token_name(stake_script_hash, 0) == bytearray.concat(
      stake_script_hash,
      #"00000000",
    ),
    grant_token_name(stake_script_hash, 258) == bytearray.concat(
      stake_script_hash,
      #"00000102",
    ),
    grant_token_name(stake_script_hash, 4_294_967_295) == bytearray.concat(
      stake_script_hash,
      #"ffffffff",
    ),
  }
}

test grant_token_name_fails_for_a_slot_beyond_four_bytes() fail {
  grant_token_name(stake_script_hash, 4_294_967_296) == stake_script_hash
}

test grant_token_name_fails_for_a_negative_slot() fail {
  grant_token_name(stake_script_hash, -1) == stake_script_hash
}

test account_of_name_is_the_name_of_a_state_nft() {
  account_of_name(stake_script_hash) == stake_script_hash
}

test account_of_name_is_the_prefix_of_a_grant_token() {
  account_of_name(grant_token_name(other_stake_script_hash, 7)) == other_stake_script_hash
}

test is_state_nft_name_accepts_twenty_eight_bytes_only() {
  and {
    is_state_nft_name(stake_script_hash),
    !is_state_nft_name(grant_token_name(stake_script_hash, 0)),
    !is_state_nft_name(#""),
  }
}

test is_grant_name_accepts_thirty_two_bytes_only() {
  and {
    is_grant_name(grant_token_name(stake_script_hash, 0)),
    !is_grant_name(stake_script_hash),
    !is_grant_name(bytearray.concat(stake_script_hash, #"0000000000")),
  }
}

test holds_state_nft_accepts_one_token_of_the_account() {
  holds_state_nft(
    control_value(stake_script_hash, 1),
    script_hash,
    stake_script_hash,
  )
}

test holds_state_nft_rejects_a_missing_token() {
  !holds_state_nft(assets.from_lovelace(1), script_hash, stake_script_hash)
}

test holds_state_nft_rejects_another_accounts_token() {
  !holds_state_nft(
    control_value(other_stake_script_hash, 1),
    script_hash,
    stake_script_hash,
  )
}

test holds_state_nft_rejects_a_grant_token_of_the_account() {
  !holds_state_nft(
    grant_value(stake_script_hash, 0, 1),
    script_hash,
    stake_script_hash,
  )
}

test holds_state_nft_rejects_a_quantity_of_two() {
  let value = assets.from_asset(script_hash, stake_script_hash, 2)
  !holds_state_nft(value, script_hash, stake_script_hash)
}

test holds_only_lovelace_and_state_nft_accepts_lovelace_with_the_nft() {
  holds_only_lovelace_and_state_nft(
    control_value(stake_script_hash, 1),
    script_hash,
    stake_script_hash,
  )
}

test holds_only_lovelace_and_state_nft_accepts_the_nft_alone() {
  holds_only_lovelace_and_state_nft(
    state_nft(stake_script_hash),
    script_hash,
    stake_script_hash,
  )
}

test holds_only_lovelace_and_state_nft_rejects_an_extra_token() {
  let value = assets.merge(control_value(stake_script_hash, 1), other_token())
  !holds_only_lovelace_and_state_nft(value, script_hash, stake_script_hash)
}

test holds_only_lovelace_and_state_nft_rejects_a_second_token_of_the_policy() {
  let value = assets.merge(
    control_value(stake_script_hash, 1),
    state_nft(other_stake_script_hash),
  )
  !holds_only_lovelace_and_state_nft(value, script_hash, stake_script_hash)
}

test holds_only_lovelace_and_state_nft_rejects_a_grant_token_beside_the_nft() {
  let value = assets.merge(
    control_value(stake_script_hash, 1),
    grant_token(stake_script_hash, 0),
  )
  !holds_only_lovelace_and_state_nft(value, script_hash, stake_script_hash)
}

test holds_only_lovelace_and_state_nft_rejects_lovelace_alone() {
  !holds_only_lovelace_and_state_nft(
    assets.from_lovelace(1),
    script_hash,
    stake_script_hash,
  )
}

test holds_only_lovelace_and_grant_token_accepts_lovelace_with_the_token() {
  holds_only_lovelace_and_grant_token(
    grant_value(stake_script_hash, 0, 1),
    script_hash,
    stake_script_hash,
    0,
  )
}

test holds_only_lovelace_and_grant_token_rejects_another_slots_token() {
  !holds_only_lovelace_and_grant_token(
    grant_value(stake_script_hash, 1, 1),
    script_hash,
    stake_script_hash,
    0,
  )
}

test holds_only_lovelace_and_grant_token_rejects_the_state_nft() {
  !holds_only_lovelace_and_grant_token(
    control_value(stake_script_hash, 1),
    script_hash,
    stake_script_hash,
    0,
  )
}

test holds_only_lovelace_and_grant_token_rejects_an_extra_token() {
  !holds_only_lovelace_and_grant_token(
    assets.merge(grant_value(stake_script_hash, 0, 1), other_token()),
    script_hash,
    stake_script_hash,
    0,
  )
}

test holds_no_account_token_accepts_lovelace_and_foreign_tokens() {
  and {
    holds_no_account_token(assets.from_lovelace(1), script_hash),
    holds_no_account_token(other_token(), script_hash),
    holds_no_account_token(assets.zero, script_hash),
  }
}

test holds_no_account_token_rejects_the_state_nft_and_the_grant_token() {
  and {
    !holds_no_account_token(control_value(stake_script_hash, 1), script_hash),
    !holds_no_account_token(grant_value(stake_script_hash, 0, 1), script_hash),
    !holds_no_account_token(state_nft(other_stake_script_hash), script_hash),
  }
}

test is_control_output_accepts_the_control_utxo() {
  is_control_output(control(), script_hash, stake_script_hash)
}

test is_control_output_rejects_a_fund_utxo() {
  !is_control_output(
    fund_output(assets.from_lovelace(5)),
    script_hash,
    stake_script_hash,
  )
}

test is_control_output_rejects_a_grant_utxo() {
  !is_control_output(grant_utxo(), script_hash, stake_script_hash)
}

test is_control_output_rejects_the_nft_at_another_address() {
  let stray = output(
    recipient_address(),
    control_value(stake_script_hash, 1),
    NoDatum,
  )
  !is_control_output(stray, script_hash, stake_script_hash)
}

test find_control_output_returns_the_single_control_output() {
  let payout = output(recipient_address(), assets.from_lovelace(1), NoDatum)
  find_control_output(
    [payout, grant_utxo(), control()],
    script_hash,
    stake_script_hash,
  ) == Some(control())
}

test find_control_output_returns_none_without_a_control_output() {
  let payout = output(recipient_address(), assets.from_lovelace(1), NoDatum)
  find_control_output([payout, grant_utxo()], script_hash, stake_script_hash) == None
}

test find_control_output_returns_none_for_two_control_outputs() {
  find_control_output([control(), control()], script_hash, stake_script_hash) == None
}

test find_token_output_returns_the_single_holder_wherever_it_sits() {
  let stray = output(
    recipient_address(),
    grant_value(stake_script_hash, 0, 1),
    NoDatum,
  )
  find_token_output(
    [control(), stray],
    script_hash,
    grant_token_name(stake_script_hash, 0),
  ) == Some(stray)
}

test find_token_output_returns_none_without_a_holder() {
  find_token_output(
    [control()],
    script_hash,
    grant_token_name(stake_script_hash, 0),
  ) == None
}

test find_token_output_returns_none_for_two_holders() {
  find_token_output(
    [grant_utxo(), grant_utxo()],
    script_hash,
    grant_token_name(stake_script_hash, 0),
  ) == None
}

test find_token_output_ignores_a_quantity_of_two() {
  let doubled = output(
    test_helpers.account_address(),
    assets.from_asset(script_hash, grant_token_name(stake_script_hash, 0), 2),
    NoDatum,
  )
  find_token_output(
    [doubled],
    script_hash,
    grant_token_name(stake_script_hash, 0),
  ) == None
}

test find_grant_output_returns_the_grant_output_of_the_slot() {
  find_grant_output(
    [control(), grant_utxo()],
    script_hash,
    stake_script_hash,
    0,
  ) == Some(grant_utxo())
}

test find_grant_output_returns_none_for_another_slot() {
  find_grant_output(
    [control(), grant_utxo()],
    script_hash,
    stake_script_hash,
    1,
  ) == None
}

test holds_account_token_accepts_the_control_and_grant_utxos() {
  and {
    holds_account_token(control(), script_hash, stake_script_hash),
    holds_account_token(grant_utxo(), script_hash, stake_script_hash),
  }
}

test holds_account_token_rejects_a_fund_utxo() {
  !holds_account_token(
    fund_output(assets.from_lovelace(5)),
    script_hash,
    stake_script_hash,
  )
}

test holds_account_token_rejects_a_foreign_token_at_the_account_address() {
  !holds_account_token(
    fund_output(other_token()),
    script_hash,
    stake_script_hash,
  )
}

test holds_account_token_rejects_another_accounts_token_at_the_account_address() {
  !holds_account_token(
    fund_output(control_value(other_stake_script_hash, 1)),
    script_hash,
    stake_script_hash,
  )
}

test holds_account_token_rejects_the_accounts_token_at_another_address() {
  let stray = output(
    other_account_address(),
    grant_value(stake_script_hash, 0, 1),
    NoDatum,
  )
  !holds_account_token(stray, script_hash, stake_script_hash)
}

test has_account_token_input_accepts_a_grant_input() {
  let fund = input(1, fund_output(assets.from_lovelace(5)))
  has_account_token_input(
    [fund, input(0, grant_utxo())],
    script_hash,
    stake_script_hash,
  )
}

test has_account_token_input_rejects_fund_inputs_alone() {
  let fund = input(1, fund_output(assets.from_lovelace(5)))
  !has_account_token_input([fund], script_hash, stake_script_hash)
}

test count_account_token_inputs_counts_the_control_and_grant_inputs() {
  let fund = input(1, fund_output(assets.from_lovelace(5)))
  let other = input(
    3,
    output(
      other_account_address(),
      control_value(other_stake_script_hash, 1),
      NoDatum,
    ),
  )
  count_account_token_inputs(
    [fund, input(0, grant_utxo()), input(2, control()), other],
    script_hash,
    stake_script_hash,
  ) == 2
}

test has_control_input_accepts_a_spent_control_utxo() {
  let fund = input(1, fund_output(assets.from_lovelace(5)))
  has_control_input([fund, input(0, control())], script_hash, stake_script_hash)
}

test has_control_input_rejects_fund_inputs_alone() {
  let fund = input(1, fund_output(assets.from_lovelace(5)))
  !has_control_input([fund], script_hash, stake_script_hash)
}

test has_control_input_rejects_a_grant_input_alone() {
  !has_control_input([input(0, grant_utxo())], script_hash, stake_script_hash)
}

test tokens_sit_at_their_own_addresses_accepts_control_grant_and_plain_outputs() {
  let payout = output(recipient_address(), assets.from_lovelace(1), NoDatum)
  tokens_sit_at_their_own_addresses(
    [payout, control(), grant_utxo()],
    script_hash,
  )
}

test tokens_sit_at_their_own_addresses_accepts_another_accounts_tokens_at_its_address() {
  let other_control = output(
    other_account_address(),
    control_value(other_stake_script_hash, 1),
    NoDatum,
  )
  let other_grant = output(
    other_account_address(),
    grant_value(other_stake_script_hash, 4, 1),
    NoDatum,
  )
  tokens_sit_at_their_own_addresses(
    [control(), other_control, other_grant],
    script_hash,
  )
}

test tokens_sit_at_their_own_addresses_accepts_no_outputs() {
  tokens_sit_at_their_own_addresses([], script_hash)
}

test tokens_sit_at_their_own_addresses_rejects_the_nft_at_a_key_address() {
  let stray = output(
    recipient_address(),
    control_value(stake_script_hash, 1),
    NoDatum,
  )
  !tokens_sit_at_their_own_addresses([control(), stray], script_hash)
}

test tokens_sit_at_their_own_addresses_rejects_a_grant_token_at_a_key_address() {
  let stray = output(
    recipient_address(),
    grant_value(stake_script_hash, 0, 1),
    NoDatum,
  )
  !tokens_sit_at_their_own_addresses([control(), stray], script_hash)
}

test tokens_sit_at_their_own_addresses_rejects_another_name_at_a_key_address() {
  let stray = output(
    recipient_address(),
    state_nft(other_stake_script_hash),
    NoDatum,
  )
  !tokens_sit_at_their_own_addresses([control(), stray], script_hash)
}

test tokens_sit_at_their_own_addresses_rejects_the_nft_at_another_accounts_address() {
  let exported = output(
    other_account_address(),
    control_value(stake_script_hash, 1),
    NoDatum,
  )
  !tokens_sit_at_their_own_addresses([control(), exported], script_hash)
}

test tokens_sit_at_their_own_addresses_rejects_a_grant_token_at_another_accounts_address() {
  let exported = output(
    other_account_address(),
    grant_value(stake_script_hash, 0, 1),
    NoDatum,
  )
  !tokens_sit_at_their_own_addresses([control(), exported], script_hash)
}

test tokens_sit_at_their_own_addresses_rejects_the_nft_at_an_enterprise_script_address() {
  let stray = output(
    address.from_script(script_hash),
    control_value(stake_script_hash, 1),
    NoDatum,
  )
  !tokens_sit_at_their_own_addresses([control(), stray], script_hash)
}

test tokens_sit_at_their_own_addresses_rejects_a_quantity_of_two() {
  let doubled = output(
    test_helpers.account_address(),
    assets.from_asset(script_hash, stake_script_hash, 2),
    NoDatum,
  )
  !tokens_sit_at_their_own_addresses([doubled], script_hash)
}

test grant_mint_delta_is_zero_without_a_mint() {
  grant_mint_delta(assets.zero, script_hash, stake_script_hash) == (0, 0)
}

test grant_mint_delta_ignores_other_policies() {
  grant_mint_delta(other_token(), script_hash, stake_script_hash) == (0, 0)
}

test grant_mint_delta_counts_minted_and_burned_grant_tokens() {
  let mint = assets.merge(
    assets.merge(
      grant_token(stake_script_hash, 5),
      grant_token(stake_script_hash, 6),
    ),
    assets.from_asset(script_hash, grant_token_name(stake_script_hash, 1), -1),
  )
  grant_mint_delta(mint, script_hash, stake_script_hash) == (2, 1)
}

test grant_mint_delta_fails_on_the_state_nft() fail {
  grant_mint_delta(state_nft(stake_script_hash), script_hash, stake_script_hash) == (
    0,
    0,
  )
}

test grant_mint_delta_fails_on_another_accounts_grant_token() fail {
  grant_mint_delta(
    grant_token(other_stake_script_hash, 0),
    script_hash,
    stake_script_hash,
  ) == (1, 0)
}

test grant_mint_delta_fails_on_a_quantity_of_two() fail {
  let mint = assets.from_asset(
    script_hash,
    grant_token_name(stake_script_hash, 5),
    2,
  )
  grant_mint_delta(mint, script_hash, stake_script_hash) == (2, 0)
}

test grant_mint_delta_fails_on_a_burn_of_two() fail {
  let mint = assets.from_asset(
    script_hash,
    grant_token_name(stake_script_hash, 5),
    -2,
  )
  grant_mint_delta(mint, script_hash, stake_script_hash) == (0, 2)
}

test state_datum_decodes_the_inline_state() {
  state_datum(control()) == state()
}

test state_datum_fails_without_a_datum() fail {
  state_datum(fund_output(assets.from_lovelace(5))) == state()
}

test state_datum_fails_for_a_datum_hash() fail {
  let hashed = output(
    test_helpers.account_address(),
    control_value(stake_script_hash, 1),
    DatumHash(stranger_key),
  )
  state_datum(hashed) == state()
}

test state_datum_fails_for_a_malformed_datum() fail {
  let data: Data = 42
  let malformed = output(
    test_helpers.account_address(),
    control_value(stake_script_hash, 1),
    transaction.InlineDatum(data),
  )
  state_datum(malformed) == state()
}

test state_datum_fails_for_a_grant_datum() fail {
  state_datum(grant_utxo()) == state()
}

test is_valid_control_output_accepts_a_well_formed_state() {
  is_valid_control_output(control(), script_hash, stake_script_hash)
}

test is_valid_control_output_rejects_an_ill_formed_state() {
  let empty = AccountState { ..state(), devices: [] }
  !is_valid_control_output(
    control_output(empty, 2_000_000),
    script_hash,
    stake_script_hash,
  )
}

test is_valid_control_output_rejects_an_extra_token() {
  let parked = output(
    test_helpers.account_address(),
    assets.merge(control_value(stake_script_hash, 1), other_token()),
    test_helpers.state_datum(state()),
  )
  !is_valid_control_output(parked, script_hash, stake_script_hash)
}

test find_control_input_returns_the_control_input() {
  let fund = input(1, fund_output(assets.from_lovelace(5)))
  find_control_input(
    [fund, input(2, grant_utxo()), input(0, control())],
    script_hash,
    stake_script_hash,
  ) == Some(input(0, control()))
}

test find_control_input_returns_none_without_a_control_input() {
  let fund = input(1, fund_output(assets.from_lovelace(5)))
  find_control_input(
    [fund, input(2, grant_utxo())],
    script_hash,
    stake_script_hash,
  ) == None
}

test find_control_input_ignores_another_accounts_control_input() {
  let other = input(
    0,
    output(
      other_account_address(),
      control_value(other_stake_script_hash, 1),
      test_helpers.state_datum(state()),
    ),
  )
  find_control_input([other], script_hash, stake_script_hash) == None
}

test is_signed_by_a_device_accepts_any_device() {
  let two = AccountState { ..state(), devices: [device_key, stranger_key] }
  is_signed_by_a_device(two, [stranger_key])
}

test is_signed_by_a_device_rejects_a_missing_device_signature() {
  !is_signed_by_a_device(state(), [stranger_key])
}

test is_authorised_by_a_device_accepts_a_device_over_a_referenced_control() {
  is_authorised_by_a_device(
    [],
    [input(0, control())],
    [device_key],
    script_hash,
    stake_script_hash,
  )
}

test is_authorised_by_a_device_accepts_a_device_over_a_spent_control() {
  is_authorised_by_a_device(
    [input(0, control())],
    [],
    [stranger_key, device_key],
    script_hash,
    stake_script_hash,
  )
}

test is_authorised_by_a_device_rejects_a_missing_device_signature() {
  !is_authorised_by_a_device(
    [],
    [input(0, control())],
    [stranger_key],
    script_hash,
    stake_script_hash,
  )
}

test is_authorised_by_a_device_fails_without_a_control_utxo() fail {
  is_authorised_by_a_device(
    [input(1, fund_output(assets.from_lovelace(5)))],
    [],
    [device_key],
    script_hash,
    stake_script_hash,
  )
}

test is_authorised_by_a_device_fails_over_a_grant_utxo_alone() fail {
  is_authorised_by_a_device(
    [],
    [input(0, grant_utxo())],
    [device_key],
    script_hash,
    stake_script_hash,
  )
}

test is_authorised_by_a_device_fails_for_a_control_without_a_state() fail {
  let bare = output(
    test_helpers.account_address(),
    control_value(stake_script_hash, 1),
    NoDatum,
  )
  is_authorised_by_a_device(
    [],
    [input(0, bare)],
    [device_key],
    script_hash,
    stake_script_hash,
  )
}

test registers_credential_accepts_a_registration() {
  registers_credential(
    registration(stake_script_hash),
    Script(stake_script_hash),
  )
}

test registers_credential_accepts_a_registration_with_a_delegation() {
  registers_credential(
    RegisterAndDelegateCredential {
      credential: Script(stake_script_hash),
      delegate: DelegateBlockProduction { stake_pool: stranger_key },
      deposit: 2_000_000,
    },
    Script(stake_script_hash),
  )
}

test registers_credential_rejects_another_credential() {
  !registers_credential(
    registration(other_stake_script_hash),
    Script(stake_script_hash),
  )
}

test registers_credential_rejects_a_key_credential_of_the_same_bytes() {
  !registers_credential(
    registration(stake_script_hash),
    VerificationKey(stake_script_hash),
  )
}

test registers_credential_rejects_other_certificate_kinds() {
  let credential = Script(stake_script_hash)
  and {
    !registers_credential(
      UnregisterCredential { credential, refund: Never },
      credential,
    ),
    !registers_credential(
      DelegateCredential {
        credential,
        delegate: DelegateBlockProduction { stake_pool: stranger_key },
      },
      credential,
    ),
    !registers_credential(
      RegisterDelegateRepresentative {
        delegate_representative: credential,
        deposit: 500_000_000,
      },
      credential,
    ),
  }
}

test registers_stake_credential_accepts_a_published_registration() {
  let tx = publishing(transaction.placeholder, registration(stake_script_hash))
  registers_stake_credential(tx.redeemers, stake_script_hash)
}

test registers_stake_credential_accepts_a_registration_among_other_redeemers() {
  let minting: Data = Operate
  let tx = publishing(
    transaction.placeholder,
    registration(other_stake_script_hash),
  )
    |> publishing(registration(stake_script_hash))
  registers_stake_credential(
    [Pair(Mint(script_hash), minting), ..tx.redeemers],
    stake_script_hash,
  )
}

test registers_stake_credential_rejects_no_redeemers() {
  !registers_stake_credential([], stake_script_hash)
}

test registers_stake_credential_rejects_another_credentials_registration() {
  let tx = publishing(
    transaction.placeholder,
    registration(other_stake_script_hash),
  )
  !registers_stake_credential(tx.redeemers, stake_script_hash)
}

test registers_stake_credential_rejects_a_published_delegation() {
  let tx = publishing(
    transaction.placeholder,
    DelegateCredential {
      credential: Script(stake_script_hash),
      delegate: DelegateBlockProduction { stake_pool: stranger_key },
    },
  )
  !registers_stake_credential(tx.redeemers, stake_script_hash)
}

test registers_stake_credential_ignores_a_certificate_without_a_redeemer() {
  let tx = publishing(transaction.placeholder, registration(stake_script_hash))
  and {
    tx.certificates == [registration(stake_script_hash)],
    !registers_stake_credential([], stake_script_hash),
  }
}
