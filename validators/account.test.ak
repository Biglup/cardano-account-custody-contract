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

use account
use aiken/builtin
use aiken/collection/list
use aiken/interval
use cardano/address.{Script}
use cardano/assets.{Assets}
use cardano/certificate.{DelegateBlockProduction, RegisterAndDelegateCredential}
use cardano/transaction.{
  DatumHash, InlineDatum, Input, NoDatum, Output, Transaction,
}
use cardano_account_custody_contract/account as custody
use cardano_account_custody_contract/test_helpers.{
  account_address, burn, change, control_input, control_output,
  control_reference, control_value, creation, device_key, expiry, fund_input,
  fund_output, grant_burn, grant_data, grant_datum, grant_input, grant_output,
  grant_token, grant_value, granted_state, input, logic_hash, logic_transaction,
  lovelace_grant, next_logic_hash, other_account_address, other_control_output,
  other_stake_script_hash, other_token, output, output_reference, payout,
  publishing, recipient_address, referencing, registration, script_hash,
  spending, stake_script_hash, state, state_data, state_datum, state_nft,
  stranger_key, with_caps, with_proxy_redeemers, withdrawing,
  without_withdrawals,
}
use cardano_account_custody_contract/types.{
  AccountState, BurnGrants, CreateAccount, Device, Fund, IssueGrants,
  SpendWithGrant, SweepGrant,
}

// CONSTANTS *******************************************************************

// FUNCTIONS *******************************************************************

/// A transaction made of the given parts as a builder submits it, valid
/// at any time: the proxy redeemers attached and the test logic
/// withdrawing.
fn timeless_transaction(
  inputs: List<Input>,
  outputs: List<Output>,
  minted: Assets,
  signatories: List<ByteArray>,
) -> Transaction {
  logic_transaction(inputs, outputs, minted, signatories, interval.everything)
}

/// Whether the proxy's mint handler accepts `redeemer` over `tx`.
fn proxy_mint(redeemer: types.MintRedeemer, tx: Transaction) -> Bool {
  account.account.mint(redeemer, script_hash, tx)
}

/// Whether the proxy's spend handler accepts `redeemer` with the given
/// datum for the input at `index` of `tx`.
fn proxy_spend(
  datum: Option<Data>,
  redeemer: types.AccountRedeemer,
  index: Int,
  tx: Transaction,
) -> Bool {
  account.account.spend(datum, redeemer, output_reference(index), tx)
}

/// Whether the mint handler accepts `redeemer` over a transaction made of
/// the given parts.
fn mint(
  redeemer: types.MintRedeemer,
  inputs: List<Input>,
  outputs: List<Output>,
  minted: Assets,
  signatories: List<ByteArray>,
) -> Bool {
  proxy_mint(
    redeemer,
    timeless_transaction(inputs, outputs, minted, signatories),
  )
}

/// Whether the mint handler accepts `CreateAccount` over a creation with
/// the given outputs, mint and signatories.
fn create(
  outputs: List<Output>,
  minted: Assets,
  signatories: List<ByteArray>,
) -> Bool {
  proxy_mint(CreateAccount, creation(outputs, minted, signatories))
}

/// The creation of the fresh state with the given control output in place
/// of the usual one.
fn creation_with_control(control: Output) -> Transaction {
  creation([control], state_nft(stake_script_hash), [device_key])
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
  proxy_spend(
    state_data(state),
    redeemer,
    index,
    timeless_transaction(inputs, outputs, minted, signatories),
  )
}

/// A device rewrite of the fresh control UTxO into itself, as the owner
/// path's simplest transaction.
fn device_transaction() -> Transaction {
  timeless_transaction(
    [control_input(), fund_input()],
    [control_output(state(), 2_000_000), payout(10_000_000)],
    assets.zero,
    [device_key],
  )
}

/// A lovelace grant spend of 2 ADA to the recipient, referencing the
/// granted control UTxO.
fn grant_transaction() -> Transaction {
  test_helpers.transaction(
    [grant_input(lovelace_grant()), fund_input()],
    [
      grant_output(with_caps(lovelace_grant(), 3_000_000, 0), 2_000_000),
      change(8_000_000),
      payout(2_000_000),
    ],
    assets.zero,
    [stranger_key],
    interval.before(expiry - 1),
  )
    |> referencing([control_reference()])
    |> with_proxy_redeemers()
    |> withdrawing([logic_hash])
}

/// A sweep of the revoked slot 0: the control UTxO and the grant UTxO
/// spent, the token burned.
fn sweep_transaction() -> Transaction {
  let revoked = AccountState { ..granted_state(), revoked: [0] }
  timeless_transaction(
    [
      input(0, control_output(revoked, 2_000_000)),
      input(1, grant_output(lovelace_grant(), 2_000_000)),
    ],
    [
      control_output(AccountState { ..revoked, outstanding: 1 }, 2_000_000),
      change(2_000_000),
    ],
    grant_burn(0),
    [device_key],
  )
}

/// An issuance of slot 0 over the fresh control UTxO.
fn issue_transaction() -> Transaction {
  timeless_transaction(
    [control_input()],
    [
      control_output(
        AccountState { ..state(), next_slot: 1, outstanding: 1 },
        2_000_000,
      ),
      grant_output(lovelace_grant(), 2_000_000),
    ],
    grant_token(stake_script_hash, 0),
    [device_key],
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
    |> withdrawing([logic_hash])
  proxy_mint(CreateAccount, tx)
}

test create_account_accepts_a_withdrawal_from_the_named_logic_beside_others() {
  let tx = creation(
    [control_output(state(), 2_000_000)],
    state_nft(stake_script_hash),
    [device_key],
  )
    |> withdrawing([next_logic_hash])
  proxy_mint(CreateAccount, tx)
}

/// The proxy reads nothing of the state but its logic field; the state
/// itself, ill formed or with counters already moved, is the logic's to
/// refuse.
test create_account_leaves_the_state_to_the_logic() {
  let states = [
    AccountState { ..state(), devices: [] },
    AccountState { ..state(), next_slot: 1 },
    AccountState { ..state(), outstanding: 1 },
    AccountState { ..state(), revoked: [0] },
    AccountState { ..state(), grant_generation: -1 },
  ]
  list.all(
    states,
    fn(next) {
      create(
        [control_output(next, 2_000_000)],
        state_nft(stake_script_hash),
        [device_key],
      )
    },
  )
}

test create_account_rejects_a_missing_logic_withdrawal() {
  let tx = creation(
    [control_output(state(), 2_000_000)],
    state_nft(stake_script_hash),
    [device_key],
  )
    |> without_withdrawals()
  !proxy_mint(CreateAccount, tx)
}

test create_account_rejects_a_withdrawal_from_a_logic_the_datum_does_not_name() {
  let tx = creation(
    [control_output(state(), 2_000_000)],
    state_nft(stake_script_hash),
    [device_key],
  )
    |> without_withdrawals()
    |> withdrawing([next_logic_hash])
  !proxy_mint(CreateAccount, tx)
}

/// A logic pointer shorter than a script hash is refused even though the
/// transaction withdraws from that very credential.
test create_account_rejects_a_logic_pointer_shorter_than_a_script_hash() {
  let short = #"000000000000000000000000000000000000000000000000000008"
  let tx = creation(
    [control_output(AccountState { ..state(), logic: short }, 2_000_000)],
    state_nft(stake_script_hash),
    [device_key],
  )
    |> without_withdrawals()
    |> withdrawing([short])
  !proxy_mint(CreateAccount, tx)
}

test create_account_rejects_a_logic_pointer_that_is_not_a_byte_string() fail {
  let logic: Data = 8
  let devices: Data = state().devices
  let zero: Data = 0
  let revoked: Data = state().revoked
  let padded: Data = builtin.constr_data(
    0,
    [logic, devices, zero, zero, revoked, zero],
  )
  proxy_mint(
    CreateAccount,
    creation_with_control(
      output(
        account_address(),
        control_value(stake_script_hash, 2_000_000),
        InlineDatum(padded),
      ),
    ),
  )
}

test create_account_rejects_a_datum_without_fields() fail {
  let bare: Data = builtin.constr_data(0, [])
  proxy_mint(
    CreateAccount,
    creation_with_control(
      output(
        account_address(),
        control_value(stake_script_hash, 2_000_000),
        InlineDatum(bare),
      ),
    ),
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
    |> withdrawing([logic_hash])
  !proxy_mint(CreateAccount, tx)
}

/// The certificate is listed but no publish redeemer records the stake
/// script running on it; the withdrawal stays so only the registration
/// rule refuses the creation.
test create_account_rejects_a_registration_the_stake_script_did_not_run_on() {
  let tx = creation(
    [control_output(state(), 2_000_000)],
    state_nft(stake_script_hash),
    [device_key],
  )
  !proxy_mint(CreateAccount, Transaction { ..tx, redeemers: [] })
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
    |> withdrawing([logic_hash])
  !proxy_mint(CreateAccount, tx)
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
  proxy_mint(
    CreateAccount,
    creation_with_control(
      output(
        other_account_address(),
        control_value(stake_script_hash, 2_000_000),
        state_datum(state()),
      ),
    ),
  )
}

test create_account_rejects_a_control_output_without_a_stake_credential() fail {
  proxy_mint(
    CreateAccount,
    creation_with_control(
      output(
        address.from_script(script_hash),
        control_value(stake_script_hash, 2_000_000),
        state_datum(state()),
      ),
    ),
  )
}

test create_account_rejects_a_malformed_state_datum() fail {
  let data: Data = 42
  proxy_mint(
    CreateAccount,
    creation_with_control(
      output(
        account_address(),
        control_value(stake_script_hash, 2_000_000),
        InlineDatum(data),
      ),
    ),
  )
}

test create_account_rejects_a_state_datum_given_by_hash() fail {
  proxy_mint(
    CreateAccount,
    creation_with_control(
      output(
        account_address(),
        control_value(stake_script_hash, 2_000_000),
        DatumHash(stranger_key),
      ),
    ),
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

test create_account_rejects_a_reference_script_on_the_control_output() {
  let encumbered = Output {
    ..control_output(state(), 2_000_000),
    reference_script: Some(logic_hash),
  }
  !create([encumbered], state_nft(stake_script_hash), [device_key])
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
/// signs, the registration is published and the logic runs.
test mint_rejects_a_burn_of_the_state_nft_from_the_control_utxo() {
  let tx = Transaction {
    ..creation([payout(2_000_000)], burn(), [device_key]),
    inputs: [control_input()],
  }
  !proxy_mint(CreateAccount, tx)
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

test issue_grants_accepts_a_mint_with_the_control_spent_and_its_logic_run() {
  proxy_mint(IssueGrants, issue_transaction())
}

/// A mint with the control UTxO referenced instead of spent reaches the
/// logic, which refuses it; the proxy only asks that the control UTxO is
/// present and its logic runs.
test issue_grants_accepts_a_mint_with_the_control_referenced() {
  let tx = timeless_transaction(
    [fund_input()],
    [grant_output(lovelace_grant(), 2_000_000), change(8_000_000)],
    grant_token(stake_script_hash, 0),
    [device_key],
  )
    |> referencing([control_reference()])
  proxy_mint(IssueGrants, tx)
}

test issue_grants_rejects_a_missing_logic_withdrawal() {
  !proxy_mint(IssueGrants, issue_transaction() |> without_withdrawals())
}

test issue_grants_rejects_a_withdrawal_from_a_logic_the_control_does_not_name() {
  let tx = issue_transaction()
    |> without_withdrawals()
    |> withdrawing([next_logic_hash])
  !proxy_mint(IssueGrants, tx)
}

test issue_grants_rejects_a_mint_without_the_control_utxo() {
  let tx = timeless_transaction(
    [fund_input()],
    [grant_output(lovelace_grant(), 2_000_000), change(8_000_000)],
    grant_token(stake_script_hash, 0),
    [device_key],
  )
  !proxy_mint(IssueGrants, tx)
}

test issue_grants_rejects_an_empty_mint() fail {
  proxy_mint(
    IssueGrants,
    timeless_transaction(
      [control_input()],
      [control_output(state(), 2_000_000)],
      assets.zero,
      [device_key],
    ),
  )
}

/// The minted name denotes the other account, whose control UTxO is not
/// present; the spent control UTxO of this account does not stand in for
/// it.
test issue_grants_rejects_a_name_of_an_account_whose_control_is_absent() {
  let tx = timeless_transaction(
    [control_input()],
    [
      control_output(state(), 2_000_000),
      output(
        other_account_address(),
        grant_value(other_stake_script_hash, 0, 2_000_000),
        grant_datum(lovelace_grant()),
      ),
    ],
    grant_token(other_stake_script_hash, 0),
    [device_key],
  )
  !proxy_mint(IssueGrants, tx)
}

test issue_grants_rejects_the_control_spent_and_referenced() {
  !proxy_mint(
    IssueGrants,
    issue_transaction() |> referencing([control_input()]),
  )
}

/// `IssueGrants` mints every entry in quantity one: a burn under it would
/// escape the burn redeemer, and a quantity of two would put two tokens
/// under one grant name.
test issue_grants_rejects_a_negative_quantity() {
  !proxy_mint(
    IssueGrants,
    sweep_transaction() |> test_helpers.minting(IssueGrants),
  )
}

test issue_grants_rejects_a_quantity_of_two() {
  let tx = Transaction {
    ..issue_transaction(),
    mint: assets.from_asset(
      script_hash,
      custody.grant_token_name(stake_script_hash, 0),
      2,
    ),
  }
  !proxy_mint(IssueGrants, tx)
}

/// Every minted name belongs to the account whose control UTxO is
/// present: another account's grant token minted beside this account's
/// is refused whatever that account's logic would allow.
test issue_grants_rejects_another_accounts_grant_token_beside_its_own() {
  let tx = timeless_transaction(
    [control_input()],
    [
      control_output(
        AccountState { ..state(), next_slot: 1, outstanding: 1 },
        2_000_000,
      ),
      grant_output(lovelace_grant(), 2_000_000),
      output(
        other_account_address(),
        grant_value(other_stake_script_hash, 0, 2_000_000),
        grant_datum(lovelace_grant()),
      ),
    ],
    assets.merge(
      grant_token(stake_script_hash, 0),
      grant_token(other_stake_script_hash, 0),
    ),
    [device_key],
  )
  !proxy_mint(IssueGrants, tx)
}

/// A state NFT name is never a grant name: another account's state NFT
/// minted beside this account's grant token is refused, so no second
/// control UTxO of any account is ever minted outside `CreateAccount`.
test issue_grants_rejects_another_accounts_state_nft_beside_its_own_grant() {
  let tx = timeless_transaction(
    [control_input()],
    [
      control_output(
        AccountState { ..state(), next_slot: 1, outstanding: 1 },
        2_000_000,
      ),
      grant_output(lovelace_grant(), 2_000_000),
      other_control_output(state(), 2_000_000),
    ],
    assets.merge(
      grant_token(stake_script_hash, 0),
      state_nft(other_stake_script_hash),
    ),
    [device_key],
  )
    |> test_helpers.minting(IssueGrants)
  !proxy_mint(IssueGrants, tx)
}

test issue_grants_rejects_the_accounts_own_state_nft_beside_its_grant() {
  let tx = timeless_transaction(
    [control_input()],
    [
      control_output(
        AccountState { ..state(), next_slot: 1, outstanding: 1 },
        2_000_000,
      ),
      grant_output(lovelace_grant(), 2_000_000),
    ],
    assets.merge(
      grant_token(stake_script_hash, 0),
      state_nft(stake_script_hash),
    ),
    [device_key],
  )
    |> test_helpers.minting(IssueGrants)
  !proxy_mint(IssueGrants, tx)
}

/// Under `IssueGrants` every account token in the outputs sits at its own
/// account address: the account's own grant token placed at another
/// account's address is refused by the proxy, whatever its logic says.
test issue_grants_rejects_its_own_grant_token_at_another_accounts_address() {
  let tx = timeless_transaction(
    [control_input()],
    [
      control_output(
        AccountState { ..state(), next_slot: 1, outstanding: 1 },
        2_000_000,
      ),
      output(
        other_account_address(),
        grant_value(stake_script_hash, 0, 2_000_000),
        grant_datum(lovelace_grant()),
      ),
    ],
    grant_token(stake_script_hash, 0),
    [device_key],
  )
  !proxy_mint(IssueGrants, tx)
}

test issue_grants_rejects_its_own_grant_token_at_a_key_address() {
  let tx = timeless_transaction(
    [control_input()],
    [
      control_output(
        AccountState { ..state(), next_slot: 1, outstanding: 1 },
        2_000_000,
      ),
      output(
        recipient_address(),
        grant_value(stake_script_hash, 0, 2_000_000),
        grant_datum(lovelace_grant()),
      ),
    ],
    grant_token(stake_script_hash, 0),
    [device_key],
  )
  !proxy_mint(IssueGrants, tx)
}

test issue_grants_rejects_the_state_nft_sent_outside_the_account() {
  let stray = output(
    recipient_address(),
    control_value(stake_script_hash, 2_000_000),
    NoDatum,
  )
  let tx = timeless_transaction(
    [control_input()],
    [stray, grant_output(lovelace_grant(), 2_000_000)],
    grant_token(stake_script_hash, 0),
    [device_key],
  )
  !proxy_mint(IssueGrants, tx)
}

test burn_grants_accepts_a_burn_with_the_control_spent_and_its_logic_run() {
  proxy_mint(BurnGrants, sweep_transaction())
}

/// A state NFT name is 28 bytes and never a grant name, so a burn of the
/// state NFT under `BurnGrants` is refused by the proxy itself, with the
/// control UTxO spent, a device signing and the logic running.
test burn_grants_rejects_the_state_nft_name() {
  let tx = timeless_transaction(
    [control_input()],
    [payout(2_000_000)],
    burn(),
    [device_key],
  )
  !proxy_mint(BurnGrants, tx)
}

test burn_grants_rejects_the_state_nft_name_beside_a_grant_burn() {
  let tx = timeless_transaction(
    [
      input(0, control_output(granted_state(), 2_000_000)),
      input(1, grant_output(lovelace_grant(), 2_000_000)),
    ],
    [change(4_000_000)],
    assets.merge(burn(), grant_burn(0)),
    [device_key],
  )
  !proxy_mint(BurnGrants, tx)
}

/// `BurnGrants` burns every entry: a grant token minted under it would
/// escape the placement rule of `IssueGrants`.
test burn_grants_rejects_a_positive_quantity() {
  let tx = Transaction {
    ..sweep_transaction(),
    mint: grant_token(stake_script_hash, 2),
  }
    |> test_helpers.minting(BurnGrants)
  !proxy_mint(BurnGrants, tx)
}

test burn_grants_rejects_a_burn_of_two() {
  let tx = Transaction {
    ..sweep_transaction(),
    mint: assets.from_asset(
      script_hash,
      custody.grant_token_name(stake_script_hash, 0),
      -2,
    ),
  }
  !proxy_mint(BurnGrants, tx)
}

test burn_grants_rejects_another_accounts_grant_token_beside_its_own() {
  let tx = Transaction {
    ..sweep_transaction(),
    mint: assets.merge(
      grant_burn(0),
      assets.from_asset(
        script_hash,
        custody.grant_token_name(other_stake_script_hash, 0),
        -1,
      ),
    ),
  }
  !proxy_mint(BurnGrants, tx)
}

test burn_grants_rejects_a_missing_logic_withdrawal() {
  !proxy_mint(BurnGrants, sweep_transaction() |> without_withdrawals())
}

test burn_grants_rejects_a_burn_without_the_control_utxo() {
  let tx = timeless_transaction(
    [input(1, grant_output(lovelace_grant(), 2_000_000))],
    [change(2_000_000)],
    grant_burn(0),
    [device_key],
  )
  !proxy_mint(BurnGrants, tx)
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

/// `Fund` carries no authority of its own and never reads the withdrawals:
/// the account token spent beside it is what needs the logic.
test fund_needs_no_logic_withdrawal() {
  proxy_spend(None, Fund, 1, device_transaction() |> without_withdrawals())
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
  let tx = timeless_transaction(
    [control_input(), deposit],
    [control_output(state(), 2_000_000), payout(10_000_000)],
    assets.zero,
    [device_key],
  )
  proxy_spend(Some(foreign), Fund, 1, tx)
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
  let tx = timeless_transaction(
    [grant_input(lovelace_grant()), reserve],
    [grant_output(lovelace_grant(), 2_000_000), payout(10_000_000)],
    assets.zero,
    [stranger_key],
  )
  !proxy_spend(Some(foreign), Fund, 1, tx)
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
  let foreign = input(0, other_control_output(state(), 2_000_000))
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
  !proxy_spend(state_data(Some(state())), Fund, 0, device_transaction())
}

test fund_rejects_a_grant_utxo_itself() {
  !proxy_spend(grant_data(lovelace_grant()), Fund, 0, grant_transaction())
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

test device_accepts_a_control_spend_with_its_logic_run() {
  proxy_spend(state_data(Some(state())), Device, 0, device_transaction())
}

/// The proxy reads neither the datum nor the state: a device spend signed
/// by a stranger, over a deposit without the NFT and with no datum given,
/// passes the proxy and is the logic's to refuse.
test device_leaves_the_rules_to_the_logic() {
  let tx = Transaction {
    ..device_transaction(),
    extra_signatories: [stranger_key],
  }
  and {
    proxy_spend(None, Device, 0, tx),
    proxy_spend(None, Device, 1, tx),
  }
}

test device_rejects_a_missing_logic_withdrawal() {
  !proxy_spend(
    state_data(Some(state())),
    Device,
    0,
    device_transaction() |> without_withdrawals(),
  )
}

/// The device transaction with the NFT holding output replaced.
fn device_transaction_with_control(control: Output) -> Transaction {
  timeless_transaction(
    [control_input(), fund_input()],
    [control, payout(10_000_000)],
    assets.zero,
    [device_key],
  )
}

/// A control spend keeps the NFT in one output at the same address,
/// whatever the logic says: the NFT sent to a key address, to another
/// account's address or to the bare script address is refused by the
/// proxy before any logic runs.
test device_rejects_the_state_nft_sent_to_another_address() {
  let value = control_value(stake_script_hash, 2_000_000)
  list.all(
    [
      recipient_address(),
      other_account_address(),
      address.from_script(script_hash),
    ],
    fn(destination) {
      !proxy_spend(
        state_data(Some(state())),
        Device,
        0,
        device_transaction_with_control(
          output(destination, value, state_datum(state())),
        ),
      )
    },
  )
}

test device_rejects_a_reference_script_on_the_control_output() {
  let encumbered = Output {
    ..control_output(state(), 2_000_000),
    reference_script: Some(logic_hash),
  }
  !proxy_spend(
    state_data(Some(state())),
    Device,
    0,
    device_transaction_with_control(encumbered),
  )
}

test device_rejects_extra_tokens_on_the_control_output() {
  let parked = output(
    account_address(),
    assets.merge(control_value(stake_script_hash, 2_000_000), other_token()),
    state_datum(state()),
  )
  !proxy_spend(
    state_data(Some(state())),
    Device,
    0,
    device_transaction_with_control(parked),
  )
}

test device_rejects_a_grant_token_on_the_control_output() {
  let parked = output(
    account_address(),
    assets.merge(
      control_value(stake_script_hash, 2_000_000),
      grant_token(stake_script_hash, 0),
    ),
    state_datum(state()),
  )
  !proxy_spend(
    state_data(Some(state())),
    Device,
    0,
    device_transaction_with_control(parked),
  )
}

test device_rejects_the_control_output_under_a_datum_hash() {
  let hashed = output(
    account_address(),
    control_value(stake_script_hash, 2_000_000),
    DatumHash(stranger_key),
  )
  !proxy_spend(
    state_data(Some(state())),
    Device,
    0,
    device_transaction_with_control(hashed),
  )
}

test device_rejects_the_state_nft_in_two_outputs() {
  let tx = timeless_transaction(
    [control_input(), fund_input()],
    [
      control_output(state(), 2_000_000),
      control_output(state(), 2_000_000),
      payout(8_000_000),
    ],
    assets.zero,
    [device_key],
  )
  !proxy_spend(state_data(Some(state())), Device, 0, tx)
}

test device_rejects_a_missing_control_output() {
  let tx = timeless_transaction(
    [control_input(), fund_input()],
    [payout(12_000_000)],
    assets.zero,
    [device_key],
  )
  !proxy_spend(state_data(Some(state())), Device, 0, tx)
}

/// The pinned control output is read without decoding its datum: a datum
/// the logic could not read passes the proxy and is the logic's to
/// refuse.
test device_accepts_a_control_output_with_a_datum_of_any_shape() {
  let foreign: Data = 42
  proxy_spend(
    state_data(Some(state())),
    Device,
    0,
    device_transaction_with_control(
      output(
        account_address(),
        control_value(stake_script_hash, 2_000_000),
        InlineDatum(foreign),
      ),
    ),
  )
}

/// The rule follows the NFT, not the redeemer: a control UTxO spent under
/// `SpendWithGrant` or `SweepGrant` is pinned the same way, and a deposit
/// spent under `Device` is not.
test spend_pins_the_control_output_under_every_redeemer() {
  let stray = output(
    recipient_address(),
    control_value(stake_script_hash, 2_000_000),
    NoDatum,
  )
  let tx = device_transaction_with_control(stray)
  and {
    !proxy_spend(state_data(Some(state())), SpendWithGrant, 0, tx),
    !proxy_spend(state_data(Some(state())), SweepGrant, 0, tx),
    proxy_spend(None, Device, 1, tx),
  }
}

test device_rejects_a_withdrawal_from_a_logic_the_control_does_not_name() {
  let tx = device_transaction()
    |> without_withdrawals()
    |> withdrawing([next_logic_hash])
  !proxy_spend(state_data(Some(state())), Device, 0, tx)
}

/// The logic to run is read from the control UTxO's own datum, whichever
/// version it names.
test device_requires_the_logic_the_control_names() {
  let upgraded = AccountState { ..state(), logic: next_logic_hash }
  let tx = timeless_transaction(
    [input(0, control_output(upgraded, 2_000_000))],
    [control_output(upgraded, 2_000_000)],
    assets.zero,
    [device_key],
  )
  and {
    !proxy_spend(state_data(Some(upgraded)), Device, 0, tx),
    proxy_spend(
      state_data(Some(upgraded)),
      Device,
      0,
      tx |> withdrawing([next_logic_hash]),
    ),
  }
}

test device_rejects_a_spend_without_the_control_utxo() {
  let tx = timeless_transaction(
    [fund_input()],
    [payout(10_000_000)],
    assets.zero,
    [device_key],
  )
  !proxy_spend(None, Device, 1, tx)
}

test device_rejects_the_control_spent_and_referenced() {
  let tx = device_transaction() |> referencing([control_reference()])
  !proxy_spend(state_data(Some(state())), Device, 0, tx)
}

test device_rejects_two_control_utxos_of_the_account_spent() {
  let tx = timeless_transaction(
    [control_input(), input(1, control_output(state(), 2_000_000))],
    [control_output(state(), 2_000_000)],
    assets.zero,
    [device_key],
  )
  !proxy_spend(state_data(Some(state())), Device, 0, tx)
}

test device_accepts_another_accounts_control_beside_its_own() {
  let tx = timeless_transaction(
    [control_input(), input(1, other_control_output(state(), 2_000_000))],
    [
      control_output(state(), 2_000_000),
      other_control_output(state(), 2_000_000),
    ],
    assets.zero,
    [device_key],
  )
  proxy_spend(state_data(Some(state())), Device, 0, tx)
}

test device_rejects_another_accounts_control_in_place_of_its_own() {
  let tx = timeless_transaction(
    [input(0, other_control_output(state(), 2_000_000)), fund_input()],
    [other_control_output(state(), 2_000_000), payout(10_000_000)],
    assets.zero,
    [device_key],
  )
  !proxy_spend(None, Device, 1, tx)
}

/// A UTxO holding the NFT under a datum hash is no control UTxO: a control
/// UTxO always carries its state inline, so none is found.
test spend_rejects_a_control_whose_datum_is_given_by_hash() {
  let hashed = input(
    0,
    output(
      account_address(),
      control_value(stake_script_hash, 2_000_000),
      DatumHash(stranger_key),
    ),
  )
  let tx = timeless_transaction(
    [hashed, fund_input()],
    [control_output(state(), 2_000_000), payout(10_000_000)],
    assets.zero,
    [device_key],
  )
  !proxy_spend(None, Device, 1, tx)
}

test spend_rejects_a_control_whose_datum_has_no_logic_field() fail {
  let data: Data = 42
  let bare = input(
    0,
    output(
      account_address(),
      control_value(stake_script_hash, 2_000_000),
      InlineDatum(data),
    ),
  )
  let tx = timeless_transaction(
    [bare, fund_input()],
    [control_output(state(), 2_000_000), payout(10_000_000)],
    assets.zero,
    [device_key],
  )
  proxy_spend(None, Device, 1, tx)
}

test spend_with_grant_accepts_a_grant_spend_with_the_control_referenced() {
  proxy_spend(
    grant_data(lovelace_grant()),
    SpendWithGrant,
    0,
    grant_transaction(),
  )
}

test spend_with_grant_rejects_a_missing_control_reference() {
  !proxy_spend(
    grant_data(lovelace_grant()),
    SpendWithGrant,
    0,
    grant_transaction() |> referencing([]),
  )
}

test spend_with_grant_rejects_two_control_references() {
  let tx = grant_transaction()
    |> referencing(
        [
          control_reference(),
          input(101, control_output(granted_state(), 2_000_000)),
        ],
      )
  !proxy_spend(grant_data(lovelace_grant()), SpendWithGrant, 0, tx)
}

test spend_with_grant_rejects_another_accounts_control_reference() {
  let tx = grant_transaction()
    |> referencing(
        [input(100, other_control_output(granted_state(), 2_000_000))],
      )
  !proxy_spend(grant_data(lovelace_grant()), SpendWithGrant, 0, tx)
}

test spend_with_grant_rejects_the_control_spent_beside_the_reference() {
  let tx = grant_transaction()
    |> spending(2, Device)
  let tx = Transaction {
    ..tx,
    inputs: list.concat(
      tx.inputs,
      [input(2, control_output(granted_state(), 2_000_000))],
    ),
    outputs: [control_output(granted_state(), 2_000_000), ..tx.outputs],
  }
  !proxy_spend(grant_data(lovelace_grant()), SpendWithGrant, 0, tx)
}

/// With the control UTxO spent instead of referenced the proxy still finds
/// it once and defers; the logic refuses the grant path over a spent
/// control.
test spend_with_grant_accepts_the_control_spent_in_place_of_the_reference() {
  let tx = grant_transaction() |> referencing([])
  let tx = Transaction {
    ..tx,
    inputs: list.concat(
      tx.inputs,
      [input(2, control_output(granted_state(), 2_000_000))],
    ),
    outputs: [control_output(granted_state(), 2_000_000), ..tx.outputs],
  }
  proxy_spend(grant_data(lovelace_grant()), SpendWithGrant, 0, tx)
}

test spend_with_grant_rejects_a_missing_logic_withdrawal() {
  !proxy_spend(
    grant_data(lovelace_grant()),
    SpendWithGrant,
    0,
    grant_transaction() |> without_withdrawals(),
  )
}

test spend_with_grant_rejects_a_withdrawal_from_a_logic_the_control_does_not_name() {
  let tx = grant_transaction()
    |> without_withdrawals()
    |> withdrawing([next_logic_hash])
  !proxy_spend(grant_data(lovelace_grant()), SpendWithGrant, 0, tx)
}

/// An agent runs the logic the owner chose: with the referenced control
/// naming a later version, only that version's withdrawal passes.
test spend_with_grant_requires_the_logic_the_referenced_control_names() {
  let upgraded = AccountState { ..granted_state(), logic: next_logic_hash }
  let tx = grant_transaction()
    |> referencing([input(100, control_output(upgraded, 2_000_000))])
  and {
    !proxy_spend(grant_data(lovelace_grant()), SpendWithGrant, 0, tx),
    proxy_spend(
      grant_data(lovelace_grant()),
      SpendWithGrant,
      0,
      tx |> withdrawing([next_logic_hash]),
    ),
  }
}

test sweep_grant_accepts_a_sweep_with_the_control_spent_and_its_logic_run() {
  proxy_spend(grant_data(lovelace_grant()), SweepGrant, 1, sweep_transaction())
}

test sweep_grant_rejects_a_missing_logic_withdrawal() {
  !proxy_spend(
    grant_data(lovelace_grant()),
    SweepGrant,
    1,
    sweep_transaction() |> without_withdrawals(),
  )
}

/// A sweep over a referenced control UTxO passes the proxy and is the
/// logic's to refuse.
test sweep_grant_accepts_a_referenced_control() {
  let tx = timeless_transaction(
    [input(1, grant_output(lovelace_grant(), 2_000_000))],
    [change(2_000_000)],
    grant_burn(0),
    [device_key],
  )
    |> referencing([control_reference()])
  proxy_spend(grant_data(lovelace_grant()), SweepGrant, 1, tx)
}

/// The grant UTxO of slot 0 recreated at the other account's address.
fn relocated_grant_output() -> Output {
  output(
    other_account_address(),
    grant_value(stake_script_hash, 0, 2_000_000),
    grant_datum(lovelace_grant()),
  )
}

/// Every spend of an account token places every account token in the
/// outputs at its own account address, whatever the logic says: a grant
/// token sent to another account's address is refused on the agent path.
test spend_with_grant_rejects_the_grant_token_sent_to_another_accounts_address() {
  let tx = Transaction {
    ..grant_transaction(),
    outputs: [relocated_grant_output(), change(8_000_000), payout(2_000_000)],
  }
  !proxy_spend(grant_data(lovelace_grant()), SpendWithGrant, 0, tx)
}

/// The rule follows the token, not the redeemer: with a grant token sent
/// to another account's address and no burn, the control spend and the
/// sweep are refused, and a deposit spent beside them under any redeemer
/// is not.
test spend_places_every_account_token_under_every_redeemer() {
  let tx = sweep_transaction()
  let tx = Transaction {
    ..tx,
    inputs: list.concat(
      tx.inputs,
      [input(2, fund_output(assets.from_lovelace(1_000_000)))],
    ),
    outputs: [relocated_grant_output(), ..tx.outputs],
    mint: assets.zero,
  }
  and {
    !proxy_spend(state_data(Some(granted_state())), Device, 0, tx),
    !proxy_spend(grant_data(lovelace_grant()), SweepGrant, 1, tx),
    proxy_spend(None, Device, 2, tx),
  }
}

/// The owner path of one account and the agent path of another share a
/// transaction: each proxy spend finds its own control UTxO and its own
/// logic withdrawal.
test spend_accepts_two_accounts_under_different_logics() {
  let other = AccountState { ..granted_state(), logic: next_logic_hash }
  let tx = test_helpers.transaction(
    [
      control_input(),
      fund_input(),
      input(2, other_control_output(other, 2_000_000)),
    ],
    [
      control_output(state(), 2_000_000),
      payout(10_000_000),
      other_control_output(other, 2_000_000),
    ],
    assets.zero,
    [device_key],
    interval.everything,
  )
    |> with_proxy_redeemers()
    |> withdrawing([logic_hash, next_logic_hash])
  and {
    proxy_spend(state_data(Some(state())), Device, 0, tx),
    proxy_spend(None, Fund, 1, tx),
    proxy_spend(state_data(Some(other)), Device, 2, tx),
    !proxy_spend(
      state_data(Some(other)),
      Device,
      2,
      tx |> without_withdrawals() |> withdrawing([logic_hash]),
    ),
  }
}
