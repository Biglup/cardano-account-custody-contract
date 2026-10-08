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

use account
use aiken/collection/list
use aiken/interval.{Interval}
use cardano/address.{Address, Script}
use cardano/assets.{Assets}
use cardano/certificate.{DelegateBlockProduction, RegisterAndDelegateCredential}
use cardano/transaction.{
  DatumHash, InlineDatum, Input, NoDatum, Output, Transaction,
}
use cardano_account_custody_contract/account as custody
use cardano_account_custody_contract/test_helpers.{
  account_address, control_output, control_value, device_key, fund_output,
  grant_datum, grant_output, grant_token, grant_value, input,
  other_account_address, other_device_key, other_stake_script_hash, output,
  output_reference, publishing, recipient_address, referencing, registration,
  script_hash, stake_script_hash, state_datum, state_nft, stranger_key,
}
use cardano_account_custody_contract/types.{
  AccountState, Asset, BurnGrants, CreateAccount, Device, Fund, Grant,
  IssueGrants, Scope, SpendWithGrant, SweepGrant,
}

// CONSTANTS *******************************************************************

const expiry = 1_800_000_000_000

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

/// The fresh state once a device rewrite adds a second device and bumps
/// the generation.
fn rewritten_state() -> AccountState {
  AccountState {
    ..state(),
    devices: [device_key, other_device_key],
    grant_generation: 1,
  }
}

/// One token under a policy that is not the account policy.
fn other_token() -> Assets {
  assets.from_asset(
    #"00000000000000000000000000000000000000000000000000000099",
    "other",
    1,
  )
}

/// The control UTxO of the fresh state, spent at index 0.
fn control_input() -> Input {
  input(0, control_output(state(), 2_000_000))
}

/// A deposit of 10 ADA at the account address, spent at index 1.
fn fund_input() -> Input {
  input(1, fund_output(assets.from_lovelace(10_000_000)))
}

/// An output paying `lovelace` to the recipient outside the account.
fn payout(lovelace: Int) -> Output {
  output(recipient_address(), assets.from_lovelace(lovelace), NoDatum)
}

/// A mint burning the state NFT of the account under test.
fn burn() -> Assets {
  assets.from_asset(script_hash, stake_script_hash, -1)
}

/// A mint burning the grant token of `slot` of the account under test.
fn grant_burn(slot: Int) -> Assets {
  assets.from_asset(
    script_hash,
    custody.grant_token_name(stake_script_hash, slot),
    -1,
  )
}

/// Whether the mint handler accepts `redeemer` over a transaction made of
/// the given parts, valid at any time.
fn mint(
  redeemer: types.MintRedeemer,
  inputs: List<Input>,
  outputs: List<Output>,
  minted: Assets,
  signatories: List<ByteArray>,
) -> Bool {
  let tx = test_helpers.transaction(
    inputs,
    outputs,
    minted,
    signatories,
    interval.everything,
  )
  account.account.mint(redeemer, script_hash, tx)
}

/// A transaction creating the account under test with the given outputs
/// and mint, its registration published through the stake script.
fn creation(
  outputs: List<Output>,
  minted: Assets,
  signatories: List<ByteArray>,
) -> Transaction {
  test_helpers.transaction(
    [],
    outputs,
    minted,
    signatories,
    interval.everything,
  )
    |> publishing(registration(stake_script_hash))
}

/// Whether the mint handler accepts `CreateAccount` over a creation with
/// the given outputs, mint and signatories.
fn create(
  outputs: List<Output>,
  minted: Assets,
  signatories: List<ByteArray>,
) -> Bool {
  account.account.mint(
    CreateAccount,
    script_hash,
    creation(outputs, minted, signatories),
  )
}

/// Whether the spend handler accepts `redeemer` with the given datum for
/// the input at `index` of a transaction made of the given parts.
fn spend_with_datum(
  datum: Option<Data>,
  redeemer: types.AccountRedeemer,
  index: Int,
  inputs: List<Input>,
  outputs: List<Output>,
  minted: Assets,
  signatories: List<ByteArray>,
) -> Bool {
  let tx = test_helpers.transaction(
    inputs,
    outputs,
    minted,
    signatories,
    interval.everything,
  )
  account.account.spend(datum, redeemer, output_reference(index), tx)
}

/// An account state as the spend handler's optional datum.
fn state_data(state: Option<AccountState>) -> Option<Data> {
  when state is {
    Some(state) -> {
      let data: Data = state
      Some(data)
    }
    None -> None
  }
}

/// A grant as the spend handler's optional datum.
fn grant_data(grant: Option<Grant>) -> Option<Data> {
  when grant is {
    Some(grant) -> {
      let data: Data = grant
      Some(data)
    }
    None -> None
  }
}

/// Whether the spend handler accepts `redeemer` with an optional account
/// state datum for the input at `index` of a transaction made of the given
/// parts.
fn spend(
  state: Option<AccountState>,
  redeemer: types.AccountRedeemer,
  index: Int,
  inputs: List<Input>,
  outputs: List<Output>,
  minted: Assets,
  signatories: List<ByteArray>,
) -> Bool {
  spend_with_datum(
    state_data(state),
    redeemer,
    index,
    inputs,
    outputs,
    minted,
    signatories,
  )
}

// TESTS ***********************************************************************

test create_account_mints_the_state_nft_into_a_control_output() {
  create(
    [control_output(state(), 2_000_000)],
    state_nft(stake_script_hash),
    [device_key],
  )
}

test create_account_accepts_other_outputs_beside_the_control_output() {
  create(
    [payout(1), control_output(state(), 2_000_000), payout(2)],
    state_nft(stake_script_hash),
    [device_key, stranger_key],
  )
}

test create_account_accepts_a_registration_with_a_delegation() {
  let delegating = RegisterAndDelegateCredential {
    credential: Script(stake_script_hash),
    delegate: DelegateBlockProduction { stake_pool: stranger_key },
    deposit: 2_000_000,
  }
  let tx = test_helpers.transaction(
    [],
    [control_output(state(), 2_000_000)],
    state_nft(stake_script_hash),
    [device_key],
    interval.everything,
  )
    |> publishing(delegating)
  account.account.mint(CreateAccount, script_hash, tx)
}

test create_account_accepts_a_non_zero_grant_generation() {
  create(
    [control_output(AccountState { ..state(), grant_generation: 5 }, 2_000_000)],
    state_nft(stake_script_hash),
    [device_key],
  )
}

test create_account_rejects_a_missing_registration() {
  !mint(
    CreateAccount,
    [],
    [control_output(state(), 2_000_000)],
    state_nft(stake_script_hash),
    [device_key],
  )
}

test create_account_rejects_a_registration_of_another_credential() {
  let tx = test_helpers.transaction(
    [],
    [control_output(state(), 2_000_000)],
    state_nft(stake_script_hash),
    [device_key],
    interval.everything,
  )
    |> publishing(registration(other_stake_script_hash))
  !account.account.mint(CreateAccount, script_hash, tx)
}

test create_account_rejects_a_registration_the_stake_script_did_not_run_on() {
  let tx = Transaction {
    ..creation(
      [control_output(state(), 2_000_000)],
      state_nft(stake_script_hash),
      [device_key],
    ),
    redeemers: [],
  }
  !account.account.mint(CreateAccount, script_hash, tx)
}

test create_account_rejects_a_quantity_of_two() {
  !create(
    [control_output(state(), 2_000_000)],
    assets.from_asset(script_hash, stake_script_hash, 2),
    [device_key],
  )
}

test create_account_rejects_two_asset_names_under_the_policy() {
  !create(
    [control_output(state(), 2_000_000)],
    assets.merge(
      state_nft(stake_script_hash),
      state_nft(other_stake_script_hash),
    ),
    [device_key],
  )
}

test create_account_rejects_a_grant_token_beside_the_state_nft() {
  !create(
    [control_output(state(), 2_000_000)],
    assets.merge(
      state_nft(stake_script_hash),
      grant_token(stake_script_hash, 0),
    ),
    [device_key],
  )
}

test create_account_rejects_a_burn_beside_the_mint() {
  !create(
    [control_output(state(), 2_000_000)],
    assets.merge(
      state_nft(stake_script_hash),
      assets.from_asset(script_hash, other_stake_script_hash, -1),
    ),
    [device_key],
  )
}

test create_account_rejects_an_empty_mint_under_the_policy() {
  !create([control_output(state(), 2_000_000)], assets.zero, [device_key])
}

test create_account_rejects_a_burn() {
  !mint(CreateAccount, [control_input()], [], burn(), [device_key])
}

/// The state NFT name must be a 28 byte stake script hash. A 27 byte
/// name is its own account prefix, so a control output placed under it
/// passes every other check and only the name rule refuses the creation.
test create_account_rejects_a_name_shorter_than_a_stake_script_hash() {
  let name = #"000000000000000000000000000000000000000000000000000002"
  let control = output(
    custody.account_address(script_hash, name),
    assets.merge(
      assets.from_lovelace(2_000_000),
      assets.from_asset(script_hash, name, 1),
    ),
    state_datum(state()),
  )
  let tx = test_helpers.transaction(
    [],
    [control],
    assets.from_asset(script_hash, name, 1),
    [device_key],
    interval.everything,
  )
    |> publishing(registration(name))
  !account.account.mint(CreateAccount, script_hash, tx)
}

test create_account_rejects_a_missing_control_output() fail {
  create([payout(1)], state_nft(stake_script_hash), [device_key])
}

test create_account_rejects_two_control_outputs() fail {
  create(
    [control_output(state(), 2_000_000), control_output(state(), 2_000_000)],
    state_nft(stake_script_hash),
    [device_key],
  )
}

test create_account_rejects_a_control_output_at_another_stake_credential() fail {
  let misplaced = output(
    other_account_address(),
    control_value(stake_script_hash, 2_000_000),
    state_datum(state()),
  )
  create([misplaced], state_nft(stake_script_hash), [device_key])
}

test create_account_rejects_a_control_output_without_a_stake_credential() fail {
  let misplaced = output(
    address.from_script(script_hash),
    control_value(stake_script_hash, 2_000_000),
    state_datum(state()),
  )
  create([misplaced], state_nft(stake_script_hash), [device_key])
}

test create_account_rejects_a_malformed_state_datum() fail {
  let data: Data = 42
  let malformed = output(
    account_address(),
    control_value(stake_script_hash, 2_000_000),
    InlineDatum(data),
  )
  create([malformed], state_nft(stake_script_hash), [device_key])
}

test create_account_rejects_a_state_datum_given_by_hash() fail {
  let hashed = output(
    account_address(),
    control_value(stake_script_hash, 2_000_000),
    DatumHash(stranger_key),
  )
  create([hashed], state_nft(stake_script_hash), [device_key])
}

test create_account_rejects_an_ill_formed_state() {
  let no_devices = AccountState { ..state(), devices: [] }
  !create(
    [control_output(no_devices, 2_000_000)],
    state_nft(stake_script_hash),
    [device_key],
  )
}

test create_account_rejects_a_non_zero_next_slot() {
  !create(
    [control_output(AccountState { ..state(), next_slot: 1 }, 2_000_000)],
    state_nft(stake_script_hash),
    [device_key],
  )
}

test create_account_rejects_a_non_zero_outstanding_count() {
  !create(
    [control_output(AccountState { ..state(), outstanding: 1 }, 2_000_000)],
    state_nft(stake_script_hash),
    [device_key],
  )
}

test create_account_rejects_a_revoked_slot() {
  !create(
    [control_output(AccountState { ..state(), revoked: [0] }, 2_000_000)],
    state_nft(stake_script_hash),
    [device_key],
  )
}

test create_account_rejects_extra_tokens_on_the_control_output() {
  let parked = output(
    account_address(),
    assets.merge(control_value(stake_script_hash, 2_000_000), other_token()),
    state_datum(state()),
  )
  !create([parked], state_nft(stake_script_hash), [device_key])
}

test create_account_rejects_a_state_nft_sent_outside_the_account() {
  let stray = output(
    recipient_address(),
    control_value(stake_script_hash, 2_000_000),
    NoDatum,
  )
  !create(
    [control_output(state(), 2_000_000), stray],
    state_nft(stake_script_hash),
    [device_key],
  )
}

test create_account_rejects_a_state_nft_sent_to_another_accounts_address() {
  let exported = output(
    other_account_address(),
    control_value(stake_script_hash, 2_000_000),
    NoDatum,
  )
  !create(
    [control_output(state(), 2_000_000), exported],
    state_nft(stake_script_hash),
    [device_key],
  )
}

/// `CreateAccount` accepts a mint of one and nothing else, so a burn is
/// refused even when the control UTxO holding the NFT is spent, a device
/// signs and the registration is published.
test mint_rejects_a_burn_of_the_state_nft_from_the_control_utxo() {
  let tx = Transaction {
    ..creation([payout(2_000_000)], burn(), [device_key]),
    inputs: [control_input()],
  }
  !account.account.mint(CreateAccount, script_hash, tx)
}

test mint_rejects_a_burn_of_two() {
  !mint(
    CreateAccount,
    [control_input()],
    [],
    assets.from_asset(script_hash, stake_script_hash, -2),
    [device_key],
  )
}

/// `BurnGrants` requires 32 byte names, so the state NFT cannot be burned
/// under it either.
test burn_grants_rejects_the_state_nft() {
  !mint(
    BurnGrants,
    [control_input()],
    [control_output(state(), 2_000_000)],
    burn(),
    [device_key],
  )
}

test fund_spends_alongside_the_control_utxo() {
  spend(
    None,
    Fund,
    1,
    [control_input(), fund_input()],
    [control_output(state(), 2_000_000), payout(10_000_000)],
    assets.zero,
    [device_key],
  )
}

test fund_spends_alongside_a_grant_utxo() {
  spend(
    None,
    Fund,
    1,
    [grant_input(lovelace_grant()), fund_input()],
    [grant_output(lovelace_grant(), 2_000_000), payout(10_000_000)],
    assets.zero,
    [stranger_key],
  )
}

test fund_spends_a_deposit_carrying_a_foreign_inline_datum_alongside_the_control() {
  let foreign: Data = 42
  let deposit = input(
    1,
    output(
      account_address(),
      assets.from_lovelace(10_000_000),
      InlineDatum(foreign),
    ),
  )
  spend_with_datum(
    Some(foreign),
    Fund,
    1,
    [control_input(), deposit],
    [control_output(state(), 2_000_000), payout(10_000_000)],
    assets.zero,
    [device_key],
  )
}

/// A deposit with a datum is an owner only reserve: it rides on the control
/// UTxO and never on a grant UTxO.
test fund_rejects_a_deposit_with_a_datum_alongside_a_grant_utxo_only() {
  let foreign: Data = 42
  let reserve = input(
    1,
    output(
      account_address(),
      assets.from_lovelace(10_000_000),
      InlineDatum(foreign),
    ),
  )
  !spend_with_datum(
    Some(foreign),
    Fund,
    1,
    [grant_input(lovelace_grant()), reserve],
    [grant_output(lovelace_grant(), 2_000_000), payout(10_000_000)],
    assets.zero,
    [stranger_key],
  )
}

test fund_rejects_a_spend_without_an_account_token_input() {
  !spend(
    None,
    Fund,
    1,
    [fund_input()],
    [payout(10_000_000)],
    assets.zero,
    [device_key],
  )
}

test fund_rejects_the_control_utxo_of_another_account() {
  let foreign = input(
    0,
    output(
      other_account_address(),
      control_value(other_stake_script_hash, 2_000_000),
      state_datum(state()),
    ),
  )
  !spend(
    None,
    Fund,
    1,
    [foreign, fund_input()],
    [payout(10_000_000)],
    assets.zero,
    [device_key],
  )
}

test fund_rejects_a_grant_utxo_of_another_account() {
  let foreign = input(
    0,
    output(
      other_account_address(),
      grant_value(other_stake_script_hash, 0, 2_000_000),
      grant_datum(lovelace_grant()),
    ),
  )
  !spend(
    None,
    Fund,
    1,
    [foreign, fund_input()],
    [payout(10_000_000)],
    assets.zero,
    [device_key],
  )
}

test fund_rejects_a_foreign_state_nft_at_the_account_address() {
  let foreign = input(
    0,
    output(
      account_address(),
      control_value(other_stake_script_hash, 2_000_000),
      state_datum(state()),
    ),
  )
  !spend(
    None,
    Fund,
    1,
    [foreign, fund_input()],
    [payout(10_000_000)],
    assets.zero,
    [device_key],
  )
}

test fund_rejects_the_control_utxo_itself() {
  !spend(
    Some(state()),
    Fund,
    0,
    [control_input(), fund_input()],
    [control_output(state(), 2_000_000), payout(10_000_000)],
    assets.zero,
    [device_key],
  )
}

test fund_rejects_a_grant_utxo_itself() {
  !spend_with_datum(
    grant_data(Some(lovelace_grant())),
    Fund,
    0,
    [control_input(), grant_input(lovelace_grant())],
    [control_output(state(), 2_000_000), payout(2_000_000)],
    assets.zero,
    [device_key],
  )
}

test spend_rejects_an_input_without_a_stake_credential() fail {
  let stray = input(
    1,
    output(address.from_script(script_hash), assets.from_lovelace(5), NoDatum),
  )
  spend(
    None,
    Fund,
    1,
    [control_input(), stray],
    [control_output(state(), 2_000_000)],
    assets.zero,
    [device_key],
  )
}

test device_spends_funds_and_keeps_the_state() {
  spend(
    Some(state()),
    Device,
    0,
    [control_input(), fund_input()],
    [control_output(state(), 2_000_000), payout(10_000_000)],
    assets.zero,
    [device_key],
  )
}

test device_rewrites_the_state() {
  spend(
    Some(state()),
    Device,
    0,
    [control_input()],
    [control_output(rewritten_state(), 2_000_000)],
    assets.zero,
    [device_key],
  )
}

test device_accepts_any_device_signature() {
  let two_devices = AccountState {
    ..state(),
    devices: [device_key, other_device_key],
  }
  spend(
    Some(two_devices),
    Device,
    0,
    [input(0, control_output(two_devices, 2_000_000))],
    [control_output(two_devices, 2_000_000)],
    assets.zero,
    [other_device_key],
  )
}

test device_rejects_a_missing_device_signature() {
  !spend(
    Some(state()),
    Device,
    0,
    [control_input()],
    [control_output(state(), 2_000_000)],
    assets.zero,
    [],
  )
}

test device_rejects_a_signature_from_a_key_that_is_not_a_device() {
  !spend(
    Some(state()),
    Device,
    0,
    [control_input()],
    [control_output(state(), 2_000_000)],
    assets.zero,
    [stranger_key],
  )
}

test device_rejects_an_ill_formed_new_state() {
  let no_devices = AccountState { ..state(), devices: [] }
  !spend(
    Some(state()),
    Device,
    0,
    [control_input()],
    [control_output(no_devices, 2_000_000)],
    assets.zero,
    [device_key],
  )
}

test device_rejects_a_malformed_state_datum() fail {
  let data: Data = 42
  let malformed = output(
    account_address(),
    control_value(stake_script_hash, 2_000_000),
    InlineDatum(data),
  )
  spend(
    Some(state()),
    Device,
    0,
    [control_input()],
    [malformed],
    assets.zero,
    [device_key],
  )
}

test device_rejects_extra_tokens_on_the_control_output() {
  let parked = output(
    account_address(),
    assets.merge(control_value(stake_script_hash, 2_000_000), other_token()),
    state_datum(state()),
  )
  !spend(
    Some(state()),
    Device,
    0,
    [control_input()],
    [parked],
    assets.zero,
    [device_key],
  )
}

test device_rejects_a_control_input_whose_datum_is_not_an_account_state() fail {
  let foreign: Data = 42
  spend_with_datum(
    Some(foreign),
    Device,
    0,
    [control_input()],
    [control_output(state(), 2_000_000)],
    assets.zero,
    [device_key],
  )
}

test device_rejects_a_state_nft_sent_outside_the_account() {
  let stray = output(
    recipient_address(),
    control_value(stake_script_hash, 2_000_000),
    NoDatum,
  )
  !spend(
    Some(state()),
    Device,
    0,
    [control_input()],
    [control_output(state(), 2_000_000), stray],
    assets.zero,
    [device_key],
  )
}

test device_rejects_a_grant_token_sent_outside_the_account() {
  let stray = output(
    recipient_address(),
    grant_value(stake_script_hash, 0, 2_000_000),
    NoDatum,
  )
  !spend(
    Some(granted_state()),
    Device,
    0,
    [
      granted_control_input(),
      input(1, grant_output(lovelace_grant(), 2_000_000)),
    ],
    [control_output(granted_state(), 2_000_000), stray],
    assets.zero,
    [device_key],
  )
}

test device_accepts_another_accounts_control_output_beside_its_own() {
  let other = output(
    other_account_address(),
    control_value(other_stake_script_hash, 2_000_000),
    state_datum(state()),
  )
  spend(
    Some(state()),
    Device,
    0,
    [control_input()],
    [control_output(state(), 2_000_000), other],
    assets.zero,
    [device_key],
  )
}

test device_rejects_a_state_nft_sent_to_an_enterprise_script_address() {
  let stray = output(
    address.from_script(script_hash),
    control_value(other_stake_script_hash, 2_000_000),
    NoDatum,
  )
  !spend(
    Some(state()),
    Device,
    0,
    [control_input()],
    [control_output(state(), 2_000_000), stray],
    assets.zero,
    [device_key],
  )
}

test device_rejects_forging_another_accounts_control_output_from_a_stray_nft() {
  let other_state = AccountState { ..state(), devices: [stranger_key] }
  let other_control = output(
    other_account_address(),
    control_value(other_stake_script_hash, 2_000_000),
    state_datum(other_state),
  )
  let stray = input(
    1,
    output(
      other_account_address(),
      control_value(stake_script_hash, 2_000_000),
      NoDatum,
    ),
  )
  let forged = output(
    account_address(),
    control_value(stake_script_hash, 2_000_000),
    state_datum(other_state),
  )
  !spend(
    Some(other_state),
    Device,
    0,
    [input(0, other_control), stray],
    [other_control, forged],
    assets.zero,
    [stranger_key],
  )
}

test device_rejects_a_control_output_at_another_stake_credential() {
  let misplaced = output(
    other_account_address(),
    control_value(stake_script_hash, 2_000_000),
    state_datum(state()),
  )
  !spend(
    Some(state()),
    Device,
    0,
    [control_input()],
    [misplaced],
    assets.zero,
    [device_key],
  )
}

test device_rejects_a_missing_control_output() fail {
  spend(
    Some(state()),
    Device,
    0,
    [control_input()],
    [payout(2_000_000)],
    assets.zero,
    [device_key],
  )
}

test device_rejects_two_control_outputs() fail {
  spend(
    Some(state()),
    Device,
    0,
    [control_input()],
    [control_output(state(), 1_000_000), control_output(state(), 1_000_000)],
    assets.zero,
    [device_key],
  )
}

test device_rejects_a_fund_input() fail {
  spend(
    None,
    Device,
    1,
    [control_input(), fund_input()],
    [control_output(state(), 2_000_000), payout(10_000_000)],
    assets.zero,
    [device_key],
  )
}

test device_rejects_an_input_without_the_state_nft() {
  !spend(
    Some(state()),
    Device,
    1,
    [control_input(), fund_input()],
    [control_output(state(), 2_000_000), payout(10_000_000)],
    assets.zero,
    [device_key],
  )
}

test device_rejects_a_grant_utxo_as_the_control() {
  !spend(
    Some(state()),
    Device,
    1,
    [control_input(), input(1, grant_output(lovelace_grant(), 2_000_000))],
    [control_output(state(), 2_000_000), payout(2_000_000)],
    assets.zero,
    [device_key],
  )
}

test device_rejects_a_missing_control_output_even_when_the_state_nft_is_burned() fail {
  spend(
    Some(state()),
    Device,
    0,
    [control_input(), fund_input()],
    [payout(12_000_000)],
    burn(),
    [device_key],
  )
}

test device_rejects_a_next_slot_edit_without_a_mint() {
  !spend(
    Some(state()),
    Device,
    0,
    [control_input()],
    [control_output(AccountState { ..state(), next_slot: 1 }, 2_000_000)],
    assets.zero,
    [device_key],
  )
}

test device_rejects_an_outstanding_edit_without_a_mint() {
  !spend(
    Some(state()),
    Device,
    0,
    [control_input()],
    [control_output(AccountState { ..state(), outstanding: 1 }, 2_000_000)],
    assets.zero,
    [device_key],
  )
}

test device_rejects_a_decreased_grant_generation() {
  let bumped = AccountState { ..state(), grant_generation: 2 }
  !spend(
    Some(bumped),
    Device,
    0,
    [input(0, control_output(bumped, 2_000_000))],
    [control_output(AccountState { ..bumped, grant_generation: 1 }, 2_000_000)],
    assets.zero,
    [device_key],
  )
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

/// A scope over lovelace with a per call cap of 3 ADA, a cap of 5 ADA and
/// no recipient restriction.
fn lovelace_scope() -> Scope {
  Scope {
    asset: Asset {
      policy_id: assets.ada_policy_id,
      asset_name: assets.ada_asset_name,
    },
    per_call_cap: 3_000_000,
    cap: 5_000_000,
    lovelace_per_call_cap: 0,
    lovelace_cap: 0,
    expires_at: expiry,
    recipients: [],
  }
}

/// A scope over the native asset with a per call cap of 10, a cap of 50,
/// 2 ADA of lovelace caps and the recipient as its only allowed
/// destination.
fn token_scope() -> Scope {
  Scope {
    asset: token_asset(),
    per_call_cap: 10,
    cap: 50,
    lovelace_per_call_cap: 2_000_000,
    lovelace_cap: 2_000_000,
    expires_at: expiry,
    recipients: [recipient_address()],
  }
}

/// The state once slots 0 and 1 have been issued.
fn granted_state() -> AccountState {
  AccountState { ..state(), next_slot: 2, outstanding: 2 }
}

/// The grant of slot 0 to the stranger under the lovelace scope.
fn lovelace_grant() -> Grant {
  Grant {
    slot: 0,
    grantee: stranger_key,
    generation: 0,
    scope: lovelace_scope(),
  }
}

/// The grant of slot 1 to the stranger under the token scope.
fn token_grant() -> Grant {
  Grant { slot: 1, grantee: stranger_key, generation: 0, scope: token_scope() }
}

/// The grant with its remaining asset and lovelace caps replaced.
fn with_caps(grant: Grant, cap: Int, lovelace_cap: Int) -> Grant {
  Grant { ..grant, scope: Scope { ..grant.scope, cap, lovelace_cap } }
}

/// The control UTxO of the granted state, spent at index 0.
fn granted_control_input() -> Input {
  input(0, control_output(granted_state(), 2_000_000))
}

/// The control UTxO of the granted state as a reference input, at an
/// index no spent input uses.
fn control_reference() -> Input {
  input(100, control_output(granted_state(), 2_000_000))
}

/// The grant UTxO of `grant`, spent at index 0.
fn grant_input(grant: Grant) -> Input {
  input(0, grant_output(grant, 2_000_000))
}

/// A deposit of 10 ADA and 20 tokens at the account address, spent at
/// index 1.
fn treasury_input() -> Input {
  input(
    1,
    fund_output(assets.merge(assets.from_lovelace(10_000_000), token(20))),
  )
}

/// A deposit output returning `value` to the account address.
fn change(value: Assets) -> Output {
  fund_output(value)
}

/// The transaction with the control UTxO of the granted state spent, the
/// given mint and a device signature.
fn owner_transaction(
  inputs: List<Input>,
  outputs: List<Output>,
  minted: Assets,
) -> Transaction {
  test_helpers.transaction(
    inputs,
    outputs,
    minted,
    [device_key],
    interval.everything,
  )
}

/// The fresh state once `count` grants have been issued.
fn issued_state(count: Int) -> AccountState {
  AccountState {
    ..state(),
    next_slot: state().next_slot + count,
    outstanding: state().outstanding + count,
  }
}

/// An issuance over the fresh control UTxO with the given outputs and
/// mint, signed by the device.
fn issue_transaction(outputs: List<Output>, minted: Assets) -> Transaction {
  owner_transaction([control_input()], outputs, minted)
}

test device_issues_a_grant() {
  let tx = issue_transaction(
    [
      control_output(issued_state(1), 2_000_000),
      grant_output(lovelace_grant(), 2_000_000),
    ],
    grant_token(stake_script_hash, 0),
  )
  account.account.spend(
    state_data(Some(state())),
    Device,
    output_reference(0),
    tx,
  )
}

test device_issues_two_grants() {
  let tx = issue_transaction(
    [
      control_output(issued_state(2), 2_000_000),
      grant_output(lovelace_grant(), 2_000_000),
      grant_output(token_grant(), 2_000_000),
    ],
    assets.merge(
      grant_token(stake_script_hash, 0),
      grant_token(stake_script_hash, 1),
    ),
  )
  account.account.spend(
    state_data(Some(state())),
    Device,
    output_reference(0),
    tx,
  )
}

test device_rejects_a_mint_without_the_next_slot_bump() {
  let tx = issue_transaction(
    [
      control_output(AccountState { ..state(), outstanding: 1 }, 2_000_000),
      grant_output(lovelace_grant(), 2_000_000),
    ],
    grant_token(stake_script_hash, 0),
  )
  !account.account.spend(
    state_data(Some(state())),
    Device,
    output_reference(0),
    tx,
  )
}

test device_rejects_a_mint_without_the_outstanding_bump() {
  let tx = issue_transaction(
    [
      control_output(AccountState { ..state(), next_slot: 1 }, 2_000_000),
      grant_output(lovelace_grant(), 2_000_000),
    ],
    grant_token(stake_script_hash, 0),
  )
  !account.account.spend(
    state_data(Some(state())),
    Device,
    output_reference(0),
    tx,
  )
}

test device_rejects_a_seventeenth_outstanding_grant() {
  let full = AccountState { ..state(), next_slot: 16, outstanding: 16 }
  let grant = Grant { ..lovelace_grant(), slot: 16 }
  let tx = owner_transaction(
    [input(0, control_output(full, 2_000_000))],
    [
      control_output(
        AccountState { ..full, next_slot: 17, outstanding: 17 },
        2_000_000,
      ),
      grant_output(grant, 2_000_000),
    ],
    grant_token(stake_script_hash, 16),
  )
  !account.account.spend(
    state_data(Some(full)),
    Device,
    output_reference(0),
    tx,
  )
}

test device_rejects_a_state_nft_minted_beside_the_control() fail {
  let tx = issue_transaction(
    [control_output(state(), 2_000_000)],
    state_nft(other_stake_script_hash),
  )
  account.account.spend(
    state_data(Some(state())),
    Device,
    output_reference(0),
    tx,
  )
}

test device_rejects_another_accounts_grant_token_minted() fail {
  let tx = issue_transaction(
    [control_output(state(), 2_000_000)],
    grant_token(other_stake_script_hash, 0),
  )
  account.account.spend(
    state_data(Some(state())),
    Device,
    output_reference(0),
    tx,
  )
}

test device_rejects_a_grant_token_minted_in_quantity_two() fail {
  let tx = issue_transaction(
    [control_output(issued_state(2), 2_000_000)],
    assets.from_asset(
      script_hash,
      custody.grant_token_name(stake_script_hash, 0),
      2,
    ),
  )
  account.account.spend(
    state_data(Some(state())),
    Device,
    output_reference(0),
    tx,
  )
}

test device_revokes_a_slot() {
  let tx = owner_transaction(
    [granted_control_input()],
    [
      control_output(
        AccountState { ..granted_state(), revoked: [0] },
        2_000_000,
      ),
    ],
    assets.zero,
  )
  account.account.spend(
    state_data(Some(granted_state())),
    Device,
    output_reference(0),
    tx,
  )
}

test device_revokes_all_grants_by_bumping_the_generation() {
  let revoked = AccountState { ..granted_state(), revoked: [0, 1] }
  let tx = owner_transaction(
    [input(0, control_output(revoked, 2_000_000))],
    [
      control_output(
        AccountState { ..revoked, grant_generation: 1, revoked: [] },
        2_000_000,
      ),
    ],
    assets.zero,
  )
  account.account.spend(
    state_data(Some(revoked)),
    Device,
    output_reference(0),
    tx,
  )
}

test device_rejects_a_thirty_third_revoked_slot() {
  let full = AccountState { ..granted_state(), revoked: list.range(1, 32) }
  let tx = owner_transaction(
    [input(0, control_output(full, 2_000_000))],
    [
      control_output(
        AccountState { ..full, revoked: list.range(1, 33) },
        2_000_000,
      ),
    ],
    assets.zero,
  )
  !account.account.spend(
    state_data(Some(full)),
    Device,
    output_reference(0),
    tx,
  )
}

test device_spends_funds_with_grants_outstanding() {
  let tx = owner_transaction(
    [granted_control_input(), fund_input()],
    [control_output(granted_state(), 2_000_000), payout(10_000_000)],
    assets.zero,
  )
  account.account.spend(
    state_data(Some(granted_state())),
    Device,
    output_reference(0),
    tx,
  )
}

/// A sweep: the control UTxO and a revoked grant UTxO spent, the grant
/// token burned and the outstanding count reduced.
fn sweep_transaction(grant: Grant, next: AccountState) -> Transaction {
  owner_transaction(
    [
      input(
        0,
        control_output(
          AccountState { ..granted_state(), revoked: [0] },
          2_000_000,
        ),
      ),
      input(1, grant_output(grant, 2_000_000)),
    ],
    [control_output(next, 2_000_000), change(assets.from_lovelace(2_000_000))],
    grant_burn(grant.slot),
  )
}

/// The granted state once slot 0 has been revoked and swept.
fn swept_state() -> AccountState {
  AccountState { ..granted_state(), revoked: [0], outstanding: 1 }
}

test device_sweeps_a_grant() {
  account.account.spend(
    state_data(Some(AccountState { ..granted_state(), revoked: [0] })),
    Device,
    output_reference(0),
    sweep_transaction(lovelace_grant(), swept_state()),
  )
}

test device_rejects_a_burn_without_the_outstanding_decrement() {
  !account.account.spend(
    state_data(Some(AccountState { ..granted_state(), revoked: [0] })),
    Device,
    output_reference(0),
    sweep_transaction(
      lovelace_grant(),
      AccountState { ..granted_state(), revoked: [0] },
    ),
  )
}

test sweep_grant_burns_a_revoked_grant() {
  account.account.spend(
    grant_data(Some(lovelace_grant())),
    SweepGrant,
    output_reference(1),
    sweep_transaction(lovelace_grant(), swept_state()),
  )
}

test sweep_grant_burns_a_grant_of_an_older_generation() {
  let bumped = AccountState { ..granted_state(), grant_generation: 1 }
  let tx = owner_transaction(
    [
      input(0, control_output(bumped, 2_000_000)),
      input(1, grant_output(lovelace_grant(), 2_000_000)),
    ],
    [
      control_output(AccountState { ..bumped, outstanding: 1 }, 2_000_000),
      change(assets.from_lovelace(2_000_000)),
    ],
    grant_burn(0),
  )
  account.account.spend(
    grant_data(Some(lovelace_grant())),
    SweepGrant,
    output_reference(1),
    tx,
  )
}

/// A sweep of the unrevoked grant of slot 0 over the granted state, valid
/// within `validity_range`, so that only expiry can make the grant dead.
fn expired_sweep_transaction(validity_range: Interval) -> Transaction {
  let tx = owner_transaction(
    [
      granted_control_input(),
      input(1, grant_output(lovelace_grant(), 2_000_000)),
    ],
    [
      control_output(
        AccountState { ..granted_state(), outstanding: 1 },
        2_000_000,
      ),
      change(assets.from_lovelace(2_000_000)),
    ],
    grant_burn(0),
  )
  Transaction { ..tx, validity_range }
}

test sweep_grant_burns_an_expired_grant() {
  account.account.spend(
    grant_data(Some(lovelace_grant())),
    SweepGrant,
    output_reference(1),
    expired_sweep_transaction(interval.after(expiry + 1)),
  )
}

test sweep_grant_rejects_a_live_grant() {
  !account.account.spend(
    grant_data(Some(lovelace_grant())),
    SweepGrant,
    output_reference(1),
    expired_sweep_transaction(interval.everything),
  )
}

test sweep_grant_rejects_a_lower_bound_at_the_expiry() {
  !account.account.spend(
    grant_data(Some(lovelace_grant())),
    SweepGrant,
    output_reference(1),
    expired_sweep_transaction(interval.after(expiry)),
  )
}

test sweep_grant_rejects_a_missing_device_signature() {
  let tx = Transaction {
    ..sweep_transaction(lovelace_grant(), swept_state()),
    extra_signatories: [stranger_key],
  }
  !account.account.spend(
    grant_data(Some(lovelace_grant())),
    SweepGrant,
    output_reference(1),
    tx,
  )
}

test sweep_grant_rejects_a_referenced_control() fail {
  let tx = owner_transaction(
    [input(1, grant_output(lovelace_grant(), 2_000_000))],
    [change(assets.from_lovelace(2_000_000))],
    grant_burn(0),
  )
    |> referencing(
        [
          input(
            0,
            control_output(
              AccountState { ..granted_state(), revoked: [0] },
              2_000_000,
            ),
          ),
        ],
      )
  account.account.spend(
    grant_data(Some(lovelace_grant())),
    SweepGrant,
    output_reference(1),
    tx,
  )
}

test sweep_grant_rejects_an_unburned_token() {
  let tx = Transaction {
    ..sweep_transaction(lovelace_grant(), swept_state()),
    mint: assets.zero,
  }
  !account.account.spend(
    grant_data(Some(lovelace_grant())),
    SweepGrant,
    output_reference(1),
    tx,
  )
}

test sweep_grant_rejects_a_burn_of_another_slot() {
  let tx = Transaction {
    ..sweep_transaction(lovelace_grant(), swept_state()),
    mint: grant_burn(1),
  }
  !account.account.spend(
    grant_data(Some(lovelace_grant())),
    SweepGrant,
    output_reference(1),
    tx,
  )
}

test sweep_grant_rejects_extra_tokens_on_the_grant_utxo() {
  let dusted = output(
    account_address(),
    assets.merge(grant_value(stake_script_hash, 0, 2_000_000), other_token()),
    grant_datum(lovelace_grant()),
  )
  let tx = Transaction {
    ..sweep_transaction(lovelace_grant(), swept_state()),
    inputs: [
      input(
        0,
        control_output(
          AccountState { ..granted_state(), revoked: [0] },
          2_000_000,
        ),
      ),
      input(1, dusted),
    ],
  }
  !account.account.spend(
    grant_data(Some(lovelace_grant())),
    SweepGrant,
    output_reference(1),
    tx,
  )
}

test sweep_grant_rejects_a_datum_whose_slot_differs_from_the_token() {
  !account.account.spend(
    grant_data(Some(Grant { ..lovelace_grant(), slot: 1 })),
    SweepGrant,
    output_reference(1),
    sweep_transaction(lovelace_grant(), swept_state()),
  )
}

test sweep_grant_rejects_a_fund_input() fail {
  account.account.spend(
    None,
    SweepGrant,
    output_reference(1),
    owner_transaction(
      [control_input(), fund_input()],
      [control_output(state(), 2_000_000), payout(10_000_000)],
      assets.zero,
    ),
  )
}

test sweep_grant_rejects_the_control_utxo() fail {
  account.account.spend(
    state_data(Some(granted_state())),
    SweepGrant,
    output_reference(0),
    sweep_transaction(lovelace_grant(), swept_state()),
  )
}

test issue_grants_mints_a_grant_token_into_a_grant_utxo() {
  let tx = issue_transaction(
    [
      control_output(issued_state(1), 2_000_000),
      grant_output(lovelace_grant(), 2_000_000),
    ],
    grant_token(stake_script_hash, 0),
  )
  account.account.mint(IssueGrants, script_hash, tx)
}

test issue_grants_mints_two_grant_tokens_in_slot_order() {
  let tx = issue_transaction(
    [
      control_output(issued_state(2), 2_000_000),
      grant_output(token_grant(), 2_000_000),
      grant_output(lovelace_grant(), 2_000_000),
    ],
    assets.merge(
      grant_token(stake_script_hash, 1),
      grant_token(stake_script_hash, 0),
    ),
  )
  account.account.mint(IssueGrants, script_hash, tx)
}

test issue_grants_continues_from_the_next_slot() {
  let grant = Grant { ..lovelace_grant(), slot: 2 }
  let tx = owner_transaction(
    [granted_control_input()],
    [
      control_output(
        AccountState { ..granted_state(), next_slot: 3, outstanding: 3 },
        2_000_000,
      ),
      grant_output(grant, 2_000_000),
    ],
    grant_token(stake_script_hash, 2),
  )
  account.account.mint(IssueGrants, script_hash, tx)
}

test issue_grants_binds_the_grant_to_the_recreated_generation() {
  let grant = Grant { ..lovelace_grant(), generation: 1 }
  let tx = issue_transaction(
    [
      control_output(
        AccountState { ..issued_state(1), grant_generation: 1 },
        2_000_000,
      ),
      grant_output(grant, 2_000_000),
    ],
    grant_token(stake_script_hash, 0),
  )
  account.account.mint(IssueGrants, script_hash, tx)
}

test issue_grants_rejects_a_missing_device_signature() {
  let tx = Transaction {
    ..issue_transaction(
      [
        control_output(issued_state(1), 2_000_000),
        grant_output(lovelace_grant(), 2_000_000),
      ],
      grant_token(stake_script_hash, 0),
    ),
    extra_signatories: [stranger_key],
  }
  !account.account.mint(IssueGrants, script_hash, tx)
}

test issue_grants_rejects_a_missing_control_input() fail {
  let tx = owner_transaction(
    [fund_input()],
    [
      grant_output(lovelace_grant(), 2_000_000),
      change(assets.from_lovelace(8_000_000)),
    ],
    grant_token(stake_script_hash, 0),
  )
  account.account.mint(IssueGrants, script_hash, tx)
}

test issue_grants_rejects_a_missing_control_output() fail {
  let tx = issue_transaction(
    [grant_output(lovelace_grant(), 2_000_000)],
    grant_token(stake_script_hash, 0),
  )
  account.account.mint(IssueGrants, script_hash, tx)
}

test issue_grants_rejects_an_empty_mint() fail {
  let tx = issue_transaction([control_output(state(), 2_000_000)], assets.zero)
  account.account.mint(IssueGrants, script_hash, tx)
}

test issue_grants_rejects_a_quantity_of_two() {
  let tx = issue_transaction(
    [
      control_output(issued_state(1), 2_000_000),
      grant_output(lovelace_grant(), 2_000_000),
    ],
    assets.from_asset(
      script_hash,
      custody.grant_token_name(stake_script_hash, 0),
      2,
    ),
  )
  !account.account.mint(IssueGrants, script_hash, tx)
}

test issue_grants_rejects_a_skipped_slot() {
  let grant = Grant { ..lovelace_grant(), slot: 1 }
  let tx = issue_transaction(
    [control_output(issued_state(1), 2_000_000), grant_output(grant, 2_000_000)],
    grant_token(stake_script_hash, 1),
  )
  !account.account.mint(IssueGrants, script_hash, tx)
}

/// The grant datum names slot 0, the control's next slot, while the
/// minted token is named for slot 1, so only the minted name rule can
/// refuse the issuance.
test issue_grants_rejects_a_token_named_for_a_later_slot_than_its_grant() {
  let mislabelled = output(
    account_address(),
    grant_value(stake_script_hash, 1, 2_000_000),
    grant_datum(lovelace_grant()),
  )
  let tx = issue_transaction(
    [control_output(issued_state(1), 2_000_000), mislabelled],
    grant_token(stake_script_hash, 1),
  )
  !account.account.mint(IssueGrants, script_hash, tx)
}

test issue_grants_rejects_a_reused_slot() {
  let tx = owner_transaction(
    [granted_control_input()],
    [
      control_output(
        AccountState { ..granted_state(), next_slot: 3, outstanding: 3 },
        2_000_000,
      ),
      grant_output(lovelace_grant(), 2_000_000),
    ],
    grant_token(stake_script_hash, 0),
  )
  !account.account.mint(IssueGrants, script_hash, tx)
}

test issue_grants_rejects_a_grant_output_at_another_address() {
  let misplaced = output(
    other_account_address(),
    grant_value(stake_script_hash, 0, 2_000_000),
    grant_datum(lovelace_grant()),
  )
  let tx = issue_transaction(
    [control_output(issued_state(1), 2_000_000), misplaced],
    grant_token(stake_script_hash, 0),
  )
  !account.account.mint(IssueGrants, script_hash, tx)
}

test issue_grants_rejects_extra_tokens_on_the_grant_output() {
  let dusted = output(
    account_address(),
    assets.merge(grant_value(stake_script_hash, 0, 2_000_000), other_token()),
    grant_datum(lovelace_grant()),
  )
  let tx = issue_transaction(
    [control_output(issued_state(1), 2_000_000), dusted],
    grant_token(stake_script_hash, 0),
  )
  !account.account.mint(IssueGrants, script_hash, tx)
}

test issue_grants_rejects_a_reference_script_on_the_grant_output() {
  let weighted = Output {
    ..grant_output(lovelace_grant(), 2_000_000),
    reference_script: Some(script_hash),
  }
  let tx = issue_transaction(
    [control_output(issued_state(1), 2_000_000), weighted],
    grant_token(stake_script_hash, 0),
  )
  !account.account.mint(IssueGrants, script_hash, tx)
}

test issue_grants_rejects_a_grant_of_another_slot_under_the_token() {
  let mislabelled = output(
    account_address(),
    grant_value(stake_script_hash, 0, 2_000_000),
    grant_datum(Grant { ..lovelace_grant(), slot: 1 }),
  )
  let tx = issue_transaction(
    [control_output(issued_state(1), 2_000_000), mislabelled],
    grant_token(stake_script_hash, 0),
  )
  !account.account.mint(IssueGrants, script_hash, tx)
}

test issue_grants_rejects_a_grant_of_another_generation() {
  let tx = issue_transaction(
    [
      control_output(issued_state(1), 2_000_000),
      grant_output(Grant { ..lovelace_grant(), generation: 1 }, 2_000_000),
    ],
    grant_token(stake_script_hash, 0),
  )
  !account.account.mint(IssueGrants, script_hash, tx)
}

test issue_grants_rejects_an_ill_formed_scope() {
  let grant = Grant {
    ..lovelace_grant(),
    scope: Scope { ..lovelace_scope(), expires_at: 0 },
  }
  let tx = issue_transaction(
    [control_output(issued_state(1), 2_000_000), grant_output(grant, 2_000_000)],
    grant_token(stake_script_hash, 0),
  )
  !account.account.mint(IssueGrants, script_hash, tx)
}

test issue_grants_rejects_a_grant_token_in_no_output() fail {
  let tx = issue_transaction(
    [control_output(issued_state(1), 2_000_000)],
    grant_token(stake_script_hash, 0),
  )
  account.account.mint(IssueGrants, script_hash, tx)
}

test issue_grants_rejects_a_grant_token_in_two_outputs() fail {
  let tx = issue_transaction(
    [
      control_output(issued_state(1), 2_000_000),
      grant_output(lovelace_grant(), 2_000_000),
      grant_output(lovelace_grant(), 2_000_000),
    ],
    grant_token(stake_script_hash, 0),
  )
  account.account.mint(IssueGrants, script_hash, tx)
}

test issue_grants_rejects_a_grant_datum_given_by_hash() fail {
  let hashed = output(
    account_address(),
    grant_value(stake_script_hash, 0, 2_000_000),
    DatumHash(stranger_key),
  )
  let tx = issue_transaction(
    [control_output(issued_state(1), 2_000_000), hashed],
    grant_token(stake_script_hash, 0),
  )
  account.account.mint(IssueGrants, script_hash, tx)
}

test issue_grants_rejects_a_malformed_grant_datum() fail {
  let data: Data = 42
  let malformed = output(
    account_address(),
    grant_value(stake_script_hash, 0, 2_000_000),
    InlineDatum(data),
  )
  let tx = issue_transaction(
    [control_output(issued_state(1), 2_000_000), malformed],
    grant_token(stake_script_hash, 0),
  )
  account.account.mint(IssueGrants, script_hash, tx)
}

test issue_grants_rejects_the_state_nft_name() fail {
  let tx = issue_transaction(
    [control_output(state(), 2_000_000)],
    state_nft(stake_script_hash),
  )
  account.account.mint(IssueGrants, script_hash, tx)
}

test burn_grants_burns_a_grant_token_with_the_control_spent() {
  account.account.mint(
    BurnGrants,
    script_hash,
    sweep_transaction(lovelace_grant(), swept_state()),
  )
}

test burn_grants_burns_two_grant_tokens() {
  let tx = owner_transaction(
    [
      input(
        0,
        control_output(
          AccountState { ..granted_state(), grant_generation: 1 },
          2_000_000,
        ),
      ),
      input(1, grant_output(lovelace_grant(), 2_000_000)),
      input(2, grant_output(token_grant(), 2_000_000)),
    ],
    [
      control_output(
        AccountState { ..granted_state(), grant_generation: 1, outstanding: 0 },
        2_000_000,
      ),
      change(assets.from_lovelace(4_000_000)),
    ],
    assets.merge(grant_burn(0), grant_burn(1)),
  )
  account.account.mint(BurnGrants, script_hash, tx)
}

test burn_grants_rejects_a_missing_device_signature() {
  let tx = Transaction {
    ..sweep_transaction(lovelace_grant(), swept_state()),
    extra_signatories: [stranger_key],
  }
  !account.account.mint(BurnGrants, script_hash, tx)
}

test burn_grants_rejects_a_missing_control_input() fail {
  let tx = owner_transaction(
    [input(1, grant_output(lovelace_grant(), 2_000_000))],
    [change(assets.from_lovelace(2_000_000))],
    grant_burn(0),
  )
  account.account.mint(BurnGrants, script_hash, tx)
}

test burn_grants_rejects_a_mint_among_the_burns() {
  let tx = Transaction {
    ..sweep_transaction(lovelace_grant(), swept_state()),
    mint: assets.merge(grant_burn(0), grant_token(stake_script_hash, 2)),
  }
  !account.account.mint(BurnGrants, script_hash, tx)
}

test burn_grants_rejects_another_accounts_grant_token() {
  let tx = Transaction {
    ..sweep_transaction(lovelace_grant(), swept_state()),
    mint: assets.merge(
      grant_burn(0),
      assets.from_asset(
        script_hash,
        custody.grant_token_name(other_stake_script_hash, 0),
        -1,
      ),
    ),
  }
  !account.account.mint(BurnGrants, script_hash, tx)
}

/// Whether the spend handler accepts `SpendWithGrant` for `grant` at index
/// 0 of a transaction made of the given parts and valid within
/// `validity_range`.
fn spend_grant_within(
  validity_range: Interval,
  grant: Grant,
  inputs: List<Input>,
  reference_inputs: List<Input>,
  outputs: List<Output>,
  minted: Assets,
  signatories: List<ByteArray>,
) -> Bool {
  let tx = test_helpers.transaction(
    inputs,
    outputs,
    minted,
    signatories,
    validity_range,
  )
    |> referencing(reference_inputs)
  account.account.spend(
    grant_data(Some(grant)),
    SpendWithGrant,
    output_reference(0),
    tx,
  )
}

/// Whether the lovelace grant spends the 10 ADA deposit into the given
/// outputs, signed by `signatories` and valid within `validity_range`.
fn spend_lovelace(
  validity_range: Interval,
  outputs: List<Output>,
  signatories: List<ByteArray>,
) -> Bool {
  spend_grant_within(
    validity_range,
    lovelace_grant(),
    [grant_input(lovelace_grant()), fund_input()],
    [control_reference()],
    outputs,
    assets.zero,
    signatories,
  )
}

/// The outputs of a lovelace grant spend paying `lovelace` to the
/// recipient: the grant output with its cap reduced, the change and the
/// payout.
fn lovelace_spend_outputs(lovelace: Int) -> List<Output> {
  [
    grant_output(
      with_caps(lovelace_grant(), 5_000_000 - lovelace, 0),
      2_000_000,
    ),
    change(assets.from_lovelace(10_000_000 - lovelace)),
    payout(lovelace),
  ]
}

/// Whether the token grant spends the treasury deposit into the given
/// outputs.
fn spend_token(outputs: List<Output>) -> Bool {
  spend_token_from(token_grant(), outputs)
}

/// Whether `grant` spends the treasury deposit into the given outputs,
/// signed by the stranger before expiry.
fn spend_token_from(grant: Grant, outputs: List<Output>) -> Bool {
  spend_grant_within(
    interval.before(expiry - 1),
    grant,
    [grant_input(grant), treasury_input()],
    [control_reference()],
    outputs,
    assets.zero,
    [stranger_key],
  )
}

/// The token grant with its lovelace per call cap lowered below its
/// lovelace cap, so that the two lovelace rules can be told apart.
fn metered_grant() -> Grant {
  Grant {
    ..token_grant(),
    scope: Scope { ..token_scope(), lovelace_per_call_cap: 1_000_000 },
  }
}

/// Spends 10 tokens and `lovelace` to the recipient through `grant`,
/// handing back a grant output that keeps `lovelace_cap` as its remaining
/// lovelace cap.
fn spend_token_lovelace_from(
  grant: Grant,
  lovelace: Int,
  lovelace_cap: Int,
) -> Bool {
  spend_token_from(
    grant,
    [
      grant_output(with_caps(grant, 40, lovelace_cap), 2_000_000),
      change(
        assets.merge(assets.from_lovelace(10_000_000 - lovelace), token(10)),
      ),
      output(
        recipient_address(),
        assets.merge(assets.from_lovelace(lovelace), token(10)),
        NoDatum,
      ),
    ],
  )
}

/// The outputs of a token grant spend paying 10 tokens and `lovelace` to
/// `destination`: the grant output with its caps reduced, the change and
/// the payout.
fn token_spend_outputs(lovelace: Int, destination: Address) -> List<Output> {
  [
    grant_output(with_caps(token_grant(), 40, 2_000_000 - lovelace), 2_000_000),
    change(assets.merge(assets.from_lovelace(10_000_000 - lovelace), token(10))),
    output(
      destination,
      assets.merge(assets.from_lovelace(lovelace), token(10)),
      NoDatum,
    ),
  ]
}

test spend_with_grant_spends_lovelace_within_scope() {
  spend_lovelace(
    interval.before(expiry - 1),
    lovelace_spend_outputs(2_000_000),
    [stranger_key],
  )
}

test spend_with_grant_accepts_spending_exactly_the_per_call_cap() {
  spend_lovelace(
    interval.before(expiry - 1),
    lovelace_spend_outputs(3_000_000),
    [stranger_key],
  )
}

test spend_with_grant_rejects_one_lovelace_above_the_per_call_cap() {
  !spend_lovelace(
    interval.before(expiry - 1),
    lovelace_spend_outputs(3_000_001),
    [stranger_key],
  )
}

test spend_with_grant_rejects_spending_above_the_remaining_cap() {
  let nearly_spent = with_caps(lovelace_grant(), 1_000_000, 0)
  !spend_grant_within(
    interval.before(expiry - 1),
    nearly_spent,
    [grant_input(nearly_spent), fund_input()],
    [control_reference()],
    [
      grant_output(with_caps(lovelace_grant(), -1_000_000, 0), 2_000_000),
      change(assets.from_lovelace(8_000_000)),
      payout(2_000_000),
    ],
    assets.zero,
    [stranger_key],
  )
}

test spend_with_grant_spends_a_token_scope() {
  spend_token(token_spend_outputs(2_000_000, recipient_address()))
}

test spend_with_grant_accepts_lovelace_exactly_at_the_lovelace_per_call_cap() {
  spend_token_lovelace_from(metered_grant(), 1_000_000, 1_000_000)
}

test spend_with_grant_rejects_one_lovelace_above_the_lovelace_per_call_cap() {
  !spend_token_lovelace_from(metered_grant(), 1_000_001, 999_999)
}

test spend_with_grant_rejects_lovelace_above_the_remaining_lovelace_cap_on_a_token_grant() {
  let nearly_spent = with_caps(token_grant(), 50, 1_000_000)
  !spend_token_lovelace_from(nearly_spent, 1_000_001, -1)
}

test spend_with_grant_rejects_a_foreign_asset_leaving() {
  let stocked = input(
    1,
    fund_output(assets.merge(assets.from_lovelace(10_000_000), other_token())),
  )
  !spend_grant_within(
    interval.before(expiry - 1),
    lovelace_grant(),
    [grant_input(lovelace_grant()), stocked],
    [control_reference()],
    [
      grant_output(with_caps(lovelace_grant(), 3_000_000, 0), 2_000_000),
      change(assets.from_lovelace(8_000_000)),
      output(
        recipient_address(),
        assets.merge(assets.from_lovelace(2_000_000), other_token()),
        NoDatum,
      ),
    ],
    assets.zero,
    [stranger_key],
  )
}

test spend_with_grant_rejects_an_output_outside_the_recipients() {
  !spend_token(
    token_spend_outputs(
      2_000_000,
      address.from_verification_key(other_device_key),
    ),
  )
}

test spend_with_grant_accepts_any_destination_when_recipients_are_empty() {
  spend_lovelace(
    interval.before(expiry - 1),
    [
      grant_output(with_caps(lovelace_grant(), 3_000_000, 0), 2_000_000),
      change(assets.from_lovelace(8_000_000)),
      output(
        address.from_verification_key(other_device_key),
        assets.from_lovelace(2_000_000),
        NoDatum,
      ),
    ],
    [stranger_key],
  )
}

test spend_with_grant_rejects_an_unbounded_validity_range() {
  !spend_lovelace(
    interval.everything,
    lovelace_spend_outputs(2_000_000),
    [stranger_key],
  )
}

test spend_with_grant_rejects_a_validity_range_ending_after_the_expiry() {
  !spend_lovelace(
    interval.before(expiry + 1),
    lovelace_spend_outputs(2_000_000),
    [stranger_key],
  )
}

test spend_with_grant_accepts_a_validity_range_ending_at_the_expiry() {
  spend_lovelace(
    interval.before(expiry),
    lovelace_spend_outputs(2_000_000),
    [stranger_key],
  )
}

test spend_with_grant_accepts_an_exclusive_bound_at_the_expiry() {
  spend_lovelace(
    interval.entirely_before(expiry),
    lovelace_spend_outputs(2_000_000),
    [stranger_key],
  )
}

/// The outputs of a lovelace grant spend in which the agent deposits more
/// than it pays out: the grant output carrying `after`, 14 ADA of change
/// and a 1 ADA payout.
fn agent_deposit_outputs(after: Grant) -> List<Output> {
  [
    grant_output(after, 2_000_000),
    change(assets.from_lovelace(14_000_000)),
    payout(1_000_000),
  ]
}

/// Whether the lovelace grant spends alongside 5 ADA of the agent's own
/// funds, paying out 1 ADA and handing back a grant output carrying
/// `after`.
fn spend_with_agent_deposit(after: Grant) -> Bool {
  let agent_funds = input(
    2,
    output(recipient_address(), assets.from_lovelace(5_000_000), NoDatum),
  )
  spend_grant_within(
    interval.before(expiry - 1),
    lovelace_grant(),
    [grant_input(lovelace_grant()), fund_input(), agent_funds],
    [control_reference()],
    agent_deposit_outputs(after),
    assets.zero,
    [stranger_key],
  )
}

test spend_with_grant_keeps_the_caps_on_a_net_deposit() {
  spend_with_agent_deposit(lovelace_grant())
}

test spend_with_grant_rejects_a_cap_raised_by_a_net_deposit() {
  !spend_with_agent_deposit(with_caps(lovelace_grant(), 9_000_000, 0))
}

test spend_with_grant_rejects_a_wrong_cap_decrement() {
  !spend_lovelace(
    interval.before(expiry - 1),
    [
      grant_output(with_caps(lovelace_grant(), 4_000_000, 0), 2_000_000),
      change(assets.from_lovelace(8_000_000)),
      payout(2_000_000),
    ],
    [stranger_key],
  )
}

test spend_with_grant_rejects_an_unchanged_cap() {
  !spend_lovelace(
    interval.before(expiry - 1),
    [
      grant_output(lovelace_grant(), 2_000_000),
      change(assets.from_lovelace(8_000_000)),
      payout(2_000_000),
    ],
    [stranger_key],
  )
}

/// The lovelace grant once 2 ADA have been spent through it.
fn spent_lovelace_grant() -> Grant {
  with_caps(lovelace_grant(), 3_000_000, 0)
}

/// Whether the lovelace grant spends 2 ADA to the recipient while handing
/// back a grant output carrying `after`.
fn rewritten_spend(after: Grant) -> Bool {
  spend_lovelace(
    interval.before(expiry - 1),
    [
      grant_output(after, 2_000_000),
      change(assets.from_lovelace(8_000_000)),
      payout(2_000_000),
    ],
    [stranger_key],
  )
}

test spend_with_grant_rejects_a_changed_generation() {
  !rewritten_spend(Grant { ..spent_lovelace_grant(), generation: 1 })
}

test spend_with_grant_rejects_a_changed_grantee() {
  !rewritten_spend(
    Grant { ..spent_lovelace_grant(), grantee: other_device_key },
  )
}

test spend_with_grant_rejects_a_changed_slot_in_the_datum() {
  let mislabelled = output(
    account_address(),
    grant_value(stake_script_hash, 0, 2_000_000),
    grant_datum(Grant { ..spent_lovelace_grant(), slot: 1 }),
  )
  !spend_lovelace(
    interval.before(expiry - 1),
    [mislabelled, change(assets.from_lovelace(8_000_000)), payout(2_000_000)],
    [stranger_key],
  )
}

test spend_with_grant_rejects_a_changed_per_call_cap() {
  !rewritten_spend(
    Grant {
      ..spent_lovelace_grant(),
      scope: Scope { ..spent_lovelace_grant().scope, per_call_cap: 4_000_000 },
    },
  )
}

test spend_with_grant_rejects_a_changed_expiry() {
  !rewritten_spend(
    Grant {
      ..spent_lovelace_grant(),
      scope: Scope { ..spent_lovelace_grant().scope, expires_at: expiry + 1 },
    },
  )
}

test spend_with_grant_rejects_changed_recipients() {
  !rewritten_spend(
    Grant {
      ..spent_lovelace_grant(),
      scope: Scope {
        ..spent_lovelace_grant().scope,
        recipients: [recipient_address()],
      },
    },
  )
}

test spend_with_grant_rejects_a_grant_of_an_older_generation() {
  let bumped = AccountState { ..granted_state(), grant_generation: 1 }
  !spend_grant_within(
    interval.before(expiry - 1),
    lovelace_grant(),
    [grant_input(lovelace_grant()), fund_input()],
    [input(100, control_output(bumped, 2_000_000))],
    lovelace_spend_outputs(2_000_000),
    assets.zero,
    [stranger_key],
  )
}

test spend_with_grant_rejects_a_revoked_slot() {
  let revoked = AccountState { ..granted_state(), revoked: [0] }
  !spend_grant_within(
    interval.before(expiry - 1),
    lovelace_grant(),
    [grant_input(lovelace_grant()), fund_input()],
    [input(100, control_output(revoked, 2_000_000))],
    lovelace_spend_outputs(2_000_000),
    assets.zero,
    [stranger_key],
  )
}

test spend_with_grant_accepts_another_revoked_slot() {
  let revoked = AccountState { ..granted_state(), revoked: [1] }
  spend_grant_within(
    interval.before(expiry - 1),
    lovelace_grant(),
    [grant_input(lovelace_grant()), fund_input()],
    [input(100, control_output(revoked, 2_000_000))],
    lovelace_spend_outputs(2_000_000),
    assets.zero,
    [stranger_key],
  )
}

test spend_with_grant_rejects_a_missing_control_reference() fail {
  spend_grant_within(
    interval.before(expiry - 1),
    lovelace_grant(),
    [grant_input(lovelace_grant()), fund_input()],
    [],
    lovelace_spend_outputs(2_000_000),
    assets.zero,
    [stranger_key],
  )
}

test spend_with_grant_rejects_two_control_references() fail {
  spend_grant_within(
    interval.before(expiry - 1),
    lovelace_grant(),
    [grant_input(lovelace_grant()), fund_input()],
    [
      control_reference(),
      input(101, control_output(granted_state(), 2_000_000)),
    ],
    lovelace_spend_outputs(2_000_000),
    assets.zero,
    [stranger_key],
  )
}

test spend_with_grant_rejects_another_accounts_control_reference() fail {
  let other = input(
    100,
    output(
      other_account_address(),
      control_value(other_stake_script_hash, 2_000_000),
      state_datum(granted_state()),
    ),
  )
  spend_grant_within(
    interval.before(expiry - 1),
    lovelace_grant(),
    [grant_input(lovelace_grant()), fund_input()],
    [other],
    lovelace_spend_outputs(2_000_000),
    assets.zero,
    [stranger_key],
  )
}

test spend_with_grant_rejects_a_spent_control_in_place_of_a_reference() fail {
  spend_grant_within(
    interval.before(expiry - 1),
    lovelace_grant(),
    [
      grant_input(lovelace_grant()),
      fund_input(),
      input(2, control_output(granted_state(), 2_000_000)),
    ],
    [],
    [
      control_output(granted_state(), 2_000_000),
      ..lovelace_spend_outputs(2_000_000)
    ],
    assets.zero,
    [stranger_key],
  )
}

test spend_with_grant_rejects_the_control_spent_beside_the_reference() {
  !spend_grant_within(
    interval.before(expiry - 1),
    lovelace_grant(),
    [
      grant_input(lovelace_grant()),
      fund_input(),
      input(2, control_output(granted_state(), 2_000_000)),
    ],
    [control_reference()],
    [
      control_output(granted_state(), 2_000_000),
      ..lovelace_spend_outputs(2_000_000)
    ],
    assets.zero,
    [stranger_key],
  )
}

test spend_with_grant_rejects_two_grant_utxos_of_the_account() {
  !spend_grant_within(
    interval.before(expiry - 1),
    lovelace_grant(),
    [
      grant_input(lovelace_grant()),
      fund_input(),
      input(2, grant_output(token_grant(), 2_000_000)),
    ],
    [control_reference()],
    [
      grant_output(token_grant(), 2_000_000),
      ..lovelace_spend_outputs(2_000_000)
    ],
    assets.zero,
    [stranger_key],
  )
}

test spend_with_grant_rejects_a_datum_whose_slot_differs_from_the_token() {
  let mislabelled = input(
    0,
    output(
      account_address(),
      grant_value(stake_script_hash, 1, 2_000_000),
      grant_datum(lovelace_grant()),
    ),
  )
  !spend_grant_within(
    interval.before(expiry - 1),
    lovelace_grant(),
    [mislabelled, fund_input()],
    [control_reference()],
    lovelace_spend_outputs(2_000_000),
    assets.zero,
    [stranger_key],
  )
}

test spend_with_grant_rejects_a_grantee_that_did_not_sign() {
  !spend_lovelace(
    interval.before(expiry - 1),
    lovelace_spend_outputs(2_000_000),
    [device_key],
  )
}

test spend_with_grant_rejects_a_fund_input() fail {
  let tx = test_helpers.transaction(
    [grant_input(lovelace_grant()), fund_input()],
    lovelace_spend_outputs(2_000_000),
    assets.zero,
    [stranger_key],
    interval.before(expiry - 1),
  )
    |> referencing([control_reference()])
  account.account.spend(None, SpendWithGrant, output_reference(1), tx)
}

test spend_with_grant_rejects_the_control_utxo() fail {
  let tx = test_helpers.transaction(
    [granted_control_input(), fund_input()],
    [control_output(granted_state(), 2_000_000), payout(10_000_000)],
    assets.zero,
    [stranger_key],
    interval.before(expiry - 1),
  )
  account.account.spend(
    state_data(Some(granted_state())),
    SpendWithGrant,
    output_reference(0),
    tx,
  )
}

test spend_with_grant_rejects_a_missing_grant_output() fail {
  spend_lovelace(
    interval.before(expiry - 1),
    [change(assets.from_lovelace(10_000_000)), payout(2_000_000)],
    [stranger_key],
  )
}

test spend_with_grant_rejects_two_grant_outputs() fail {
  spend_lovelace(
    interval.before(expiry - 1),
    [
      grant_output(spent_lovelace_grant(), 1_000_000),
      grant_output(spent_lovelace_grant(), 1_000_000),
      change(assets.from_lovelace(8_000_000)),
      payout(2_000_000),
    ],
    [stranger_key],
  )
}

test spend_with_grant_rejects_extra_tokens_on_the_grant_output() {
  let parked = output(
    account_address(),
    assets.merge(grant_value(stake_script_hash, 0, 2_000_000), token(20)),
    grant_datum(spent_lovelace_grant()),
  )
  !spend_grant_within(
    interval.before(expiry - 1),
    lovelace_grant(),
    [grant_input(lovelace_grant()), treasury_input()],
    [control_reference()],
    [parked, change(assets.from_lovelace(8_000_000)), payout(2_000_000)],
    assets.zero,
    [stranger_key],
  )
}

test spend_with_grant_rejects_extra_tokens_on_the_grant_input() {
  let dusted = input(
    0,
    output(
      account_address(),
      assets.merge(grant_value(stake_script_hash, 0, 2_000_000), other_token()),
      grant_datum(lovelace_grant()),
    ),
  )
  let parked = output(
    account_address(),
    assets.merge(grant_value(stake_script_hash, 0, 2_000_000), other_token()),
    grant_datum(spent_lovelace_grant()),
  )
  !spend_grant_within(
    interval.before(expiry - 1),
    lovelace_grant(),
    [dusted, fund_input()],
    [control_reference()],
    [parked, change(assets.from_lovelace(8_000_000)), payout(2_000_000)],
    assets.zero,
    [stranger_key],
  )
}

test spend_with_grant_rejects_lovelace_drained_from_the_grant_output() {
  !spend_lovelace(
    interval.before(expiry - 1),
    [
      grant_output(spent_lovelace_grant(), 1_000_000),
      change(assets.from_lovelace(9_000_000)),
      payout(2_000_000),
    ],
    [stranger_key],
  )
}

test spend_with_grant_rejects_lovelace_added_to_the_grant_output() {
  !spend_lovelace(
    interval.before(expiry - 1),
    [
      grant_output(spent_lovelace_grant(), 3_000_000),
      change(assets.from_lovelace(7_000_000)),
      payout(2_000_000),
    ],
    [stranger_key],
  )
}

test spend_with_grant_rejects_the_grant_output_at_another_accounts_address() {
  let relocated = output(
    other_account_address(),
    grant_value(stake_script_hash, 0, 2_000_000),
    grant_datum(spent_lovelace_grant()),
  )
  !spend_lovelace(
    interval.before(expiry - 1),
    [relocated, change(assets.from_lovelace(8_000_000)), payout(2_000_000)],
    [stranger_key],
  )
}

test spend_with_grant_rejects_a_grant_datum_given_by_hash() {
  let hashed = output(
    account_address(),
    grant_value(stake_script_hash, 0, 2_000_000),
    DatumHash(stranger_key),
  )
  !spend_lovelace(
    interval.before(expiry - 1),
    [hashed, change(assets.from_lovelace(8_000_000)), payout(2_000_000)],
    [stranger_key],
  )
}

test spend_with_grant_rejects_a_reference_script_on_the_grant_output() {
  let weighted = Output {
    ..grant_output(spent_lovelace_grant(), 2_000_000),
    reference_script: Some(script_hash),
  }
  !spend_lovelace(
    interval.before(expiry - 1),
    [weighted, change(assets.from_lovelace(8_000_000)), payout(2_000_000)],
    [stranger_key],
  )
}

test spend_with_grant_rejects_a_deposit_under_a_datum_hash() {
  !spend_lovelace(
    interval.before(expiry - 1),
    [
      grant_output(spent_lovelace_grant(), 2_000_000),
      output(
        account_address(),
        assets.from_lovelace(8_000_000),
        DatumHash(stranger_key),
      ),
      payout(2_000_000),
    ],
    [stranger_key],
  )
}

test spend_with_grant_rejects_a_deposit_with_a_reference_script() {
  let weighted = Output {
    ..change(assets.from_lovelace(8_000_000)),
    reference_script: Some(script_hash),
  }
  !spend_lovelace(
    interval.before(expiry - 1),
    [
      grant_output(spent_lovelace_grant(), 2_000_000),
      weighted,
      payout(2_000_000),
    ],
    [stranger_key],
  )
}

test spend_with_grant_rejects_a_state_nft_sent_outside_the_account() {
  let stray = output(
    recipient_address(),
    control_value(other_stake_script_hash, 1_000_000),
    NoDatum,
  )
  !spend_lovelace(
    interval.before(expiry - 1),
    [
      grant_output(with_caps(lovelace_grant(), 2_000_000, 0), 2_000_000),
      change(assets.from_lovelace(7_000_000)),
      payout(2_000_000),
      stray,
    ],
    [stranger_key],
  )
}

test spend_with_grant_rejects_a_stray_state_nft_among_the_inputs() {
  let stray = input(
    2,
    output(
      recipient_address(),
      control_value(other_stake_script_hash, 1_000_000),
      NoDatum,
    ),
  )
  !spend_grant_within(
    interval.before(expiry - 1),
    lovelace_grant(),
    [grant_input(lovelace_grant()), fund_input(), stray],
    [control_reference()],
    [
      grant_output(spent_lovelace_grant(), 2_000_000),
      change(assets.from_lovelace(8_000_000)),
      payout(2_000_000),
      output(
        other_account_address(),
        control_value(other_stake_script_hash, 1_000_000),
        NoDatum,
      ),
    ],
    assets.zero,
    [stranger_key],
  )
}

test spend_with_grant_rejects_a_grant_token_minted() {
  !spend_grant_within(
    interval.before(expiry - 1),
    lovelace_grant(),
    [grant_input(lovelace_grant()), fund_input()],
    [control_reference()],
    [
      grant_output(spent_lovelace_grant(), 2_000_000),
      grant_output(Grant { ..lovelace_grant(), slot: 2 }, 2_000_000),
      change(assets.from_lovelace(6_000_000)),
      payout(2_000_000),
    ],
    grant_token(stake_script_hash, 2),
    [stranger_key],
  )
}

test spend_with_grant_rejects_another_accounts_token_minted() {
  !spend_grant_within(
    interval.before(expiry - 1),
    lovelace_grant(),
    [grant_input(lovelace_grant()), fund_input()],
    [control_reference()],
    [
      grant_output(spent_lovelace_grant(), 2_000_000),
      output(
        other_account_address(),
        control_value(other_stake_script_hash, 2_000_000),
        state_datum(state()),
      ),
      change(assets.from_lovelace(6_000_000)),
      payout(2_000_000),
    ],
    state_nft(other_stake_script_hash),
    [stranger_key],
  )
}
