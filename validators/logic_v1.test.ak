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
use aiken/interval.{Interval}
use cardano/address.{Address, Script, VerificationKey}
use cardano/assets.{Assets}
use cardano/certificate.{
  AlwaysAbstain, DelegateBlockProduction, DelegateCredential, DelegateVote,
  RegisterAndDelegateCredential, RegisterCredential, UnregisterCredential,
}
use cardano/governance.{StakePool}
use cardano/script_context.{ScriptContext, Voting}
use cardano/transaction.{
  DatumHash, InlineDatum, Input, NoDatum, Output, Transaction,
}
use cardano_account_custody_contract/account as custody
use cardano_account_custody_contract/logic
use cardano_account_custody_contract/test_helpers.{
  account_address, burn, control_input, control_output, control_reference,
  control_value, creation, device_key, expiry, fund_input, fund_output,
  grant_burn, grant_datum, grant_input, grant_output, grant_token, grant_value,
  granted_state, input, issued_state, logic_hash, logic_transaction,
  lovelace_grant, lovelace_scope, next_logic_hash, other_account_address,
  other_control_output, other_device_key, other_fund_output, other_grant_output,
  other_stake_script_hash, other_token, output, owner_transaction, payout,
  recipient_address, referencing, script_hash, spending, stake_script_hash,
  state, state_datum, state_nft, stranger_key, token, token_grant, token_scope,
  treasury_input, upgrade_into, upgraded_state, with_caps, with_proxy_redeemers,
  withdrawing,
}
use cardano_account_custody_contract/types.{
  AccountState, BurnGrants, Device, Grant, IssueGrants, Run, Scope,
  SpendWithGrant, SweepGrant,
}
use logic_v1

// CONSTANTS *******************************************************************

/// The hash standing in for a third logic version.
const third_logic_hash =
  #"0000000000000000000000000000000000000000000000000000000a"

// FUNCTIONS *******************************************************************

/// The fresh state once a device rewrite adds a second device and raises
/// the generation.
fn rewritten_state() -> AccountState {
  AccountState {
    ..state(),
    devices: [device_key, other_device_key],
    grant_generation: 1,
  }
}

/// The lovelace grant once 2 ADA have been spent through it.
fn spent_lovelace_grant() -> Grant {
  with_caps(lovelace_grant(), 3_000_000, 0)
}

/// The control UTxO of the granted state, spent at index 0.
fn granted_control_input() -> Input {
  input(0, control_output(granted_state(), 2_000_000))
}

/// A deposit output returning `value` to the account address.
fn change_of(value: Assets) -> Output {
  fund_output(value)
}

/// Whether the logic, run as `logic` over the test proxy, accepts `tx`.
fn run_as(logic: ByteArray, tx: Transaction) -> Bool {
  logic_v1.logic_v1.withdraw(script_hash, Run, Script(logic), tx)
}

/// Whether the test logic accepts `tx`.
fn run(tx: Transaction) -> Bool {
  run_as(logic_hash, tx)
}

/// Whether the dispatch written out in `logic_v1` and the shared withdraw
/// handler, each run as the test logic over the test proxy, both give
/// `verdict` on `tx`.
fn dispatches_like_the_shared_handler(tx: Transaction, verdict: Bool) -> Bool {
  and {
    run(tx) == verdict,
    logic.validates_withdrawal(logic_hash, script_hash, tx) == verdict,
  }
}

/// A transaction creating the account under test with the given control
/// state, its registration published through the stake script.
fn creation_with_state(next: AccountState) -> Transaction {
  creation(
    [control_output(next, 2_000_000)],
    state_nft(stake_script_hash),
    [device_key],
  )
}

/// A device rewrite of the fresh control UTxO into `next`.
fn rewrite(next: AccountState) -> Transaction {
  owner_transaction(state(), [], [control_output(next, 2_000_000)], assets.zero)
}

/// An issuance over the fresh control UTxO with the given outputs and
/// mint, signed by the device.
fn issue_transaction(outputs: List<Output>, minted: Assets) -> Transaction {
  owner_transaction(state(), [], outputs, minted)
}

/// A sweep: the control UTxO with slot 0 revoked and the grant UTxO
/// spent, the grant token burned and the control recreated as `next`.
fn sweep_transaction(grant: Grant, next: AccountState) -> Transaction {
  owner_transaction(
    AccountState { ..granted_state(), revoked: [0] },
    [input(1, grant_output(grant, 2_000_000))],
    [
      control_output(next, 2_000_000),
      change_of(assets.from_lovelace(2_000_000)),
    ],
    grant_burn(grant.slot),
  )
}

/// The granted state once slot 0 has been revoked and swept.
fn swept_state() -> AccountState {
  AccountState { ..granted_state(), revoked: [0], outstanding: 1 }
}

/// A sweep of the unrevoked grant of slot 0 over the granted state, valid
/// within `validity_range`, so that only expiry can make the grant dead.
fn expired_sweep_transaction(validity_range: Interval) -> Transaction {
  logic_transaction(
    [
      granted_control_input(),
      input(1, grant_output(lovelace_grant(), 2_000_000)),
    ],
    [
      control_output(
        AccountState { ..granted_state(), outstanding: 1 },
        2_000_000,
      ),
      change_of(assets.from_lovelace(2_000_000)),
    ],
    grant_burn(0),
    [device_key],
    validity_range,
  )
}

/// A transaction in which the grantee of `grant` spends from the given
/// inputs into `outputs`, referencing the given control UTxOs, valid
/// within `validity_range`.
fn grant_transaction_within(
  validity_range: Interval,
  inputs: List<Input>,
  reference_inputs: List<Input>,
  outputs: List<Output>,
  minted: Assets,
  signatories: List<ByteArray>,
) -> Transaction {
  test_helpers.transaction(inputs, outputs, minted, signatories, validity_range)
    |> referencing(reference_inputs)
    |> with_proxy_redeemers()
    |> withdrawing([logic_hash])
}

/// A lovelace grant spend of the 10 ADA deposit into the given outputs,
/// signed by `signatories` and valid within `validity_range`.
fn lovelace_spend(
  validity_range: Interval,
  outputs: List<Output>,
  signatories: List<ByteArray>,
) -> Transaction {
  grant_transaction_within(
    validity_range,
    [grant_input(lovelace_grant()), fund_input()],
    [control_reference()],
    outputs,
    assets.zero,
    signatories,
  )
}

/// Whether the lovelace grant spends the 10 ADA deposit into the given
/// outputs, signed by `signatories` and valid within `validity_range`.
fn spend_lovelace(
  validity_range: Interval,
  outputs: List<Output>,
  signatories: List<ByteArray>,
) -> Bool {
  run(lovelace_spend(validity_range, outputs, signatories))
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
    change_of(assets.from_lovelace(10_000_000 - lovelace)),
    payout(lovelace),
  ]
}

/// Whether the lovelace grant spends 2 ADA to the recipient while handing
/// back a grant output carrying `after`.
fn rewritten_spend(after: Grant) -> Bool {
  spend_lovelace(
    interval.before(expiry - 1),
    [
      grant_output(after, 2_000_000),
      change_of(assets.from_lovelace(8_000_000)),
      payout(2_000_000),
    ],
    [stranger_key],
  )
}

/// Whether `grant` spends the treasury deposit into the given outputs,
/// signed by the stranger before expiry.
fn spend_token_from(grant: Grant, outputs: List<Output>) -> Bool {
  run(
    grant_transaction_within(
      interval.before(expiry - 1),
      [grant_input(grant), treasury_input()],
      [control_reference()],
      outputs,
      assets.zero,
      [stranger_key],
    ),
  )
}

/// Whether the token grant spends the treasury deposit into the given
/// outputs.
fn spend_token(outputs: List<Output>) -> Bool {
  spend_token_from(token_grant(), outputs)
}

/// The outputs of a token grant spend paying 10 tokens and `lovelace` to
/// `destination`: the grant output with its caps reduced, the change and
/// the payout.
fn token_spend_outputs(lovelace: Int, destination: Address) -> List<Output> {
  [
    grant_output(with_caps(token_grant(), 40, 2_000_000 - lovelace), 2_000_000),
    change_of(
      assets.merge(assets.from_lovelace(10_000_000 - lovelace), token(10)),
    ),
    output(
      destination,
      assets.merge(assets.from_lovelace(lovelace), token(10)),
      NoDatum,
    ),
  ]
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
      change_of(
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

/// Whether the lovelace grant with `cap` remaining pays `lovelace` to the
/// recipient, handing back a grant output whose cap is reduced by it.
fn spend_remaining_lovelace(cap: Int, lovelace: Int) -> Bool {
  let nearly_spent = with_caps(lovelace_grant(), cap, 0)
  run(
    grant_transaction_within(
      interval.before(expiry - 1),
      [grant_input(nearly_spent), fund_input()],
      [control_reference()],
      [
        grant_output(with_caps(lovelace_grant(), cap - lovelace, 0), 2_000_000),
        change_of(assets.from_lovelace(10_000_000 - lovelace)),
        payout(lovelace),
      ],
      assets.zero,
      [stranger_key],
    ),
  )
}

/// Whether the lovelace grant pays `lovelace` to the recipient while the
/// account pays `fee`, handing back a grant output carrying `after`.
fn spend_lovelace_with_fee(fee: Int, lovelace: Int, after: Grant) -> Bool {
  let tx = lovelace_spend(
    interval.before(expiry - 1),
    [
      grant_output(after, 2_000_000),
      change_of(assets.from_lovelace(10_000_000 - lovelace - fee)),
      payout(lovelace),
    ],
    [stranger_key],
  )
  run(Transaction { ..tx, fee })
}

/// Whether the token grant with `cap` tokens remaining pays `tokens` and
/// 1 ADA to the recipient, handing back a grant output whose caps are
/// reduced by both.
fn spend_remaining_tokens(cap: Int, tokens: Int) -> Bool {
  let nearly_spent = with_caps(token_grant(), cap, 2_000_000)
  spend_token_from(
    nearly_spent,
    [
      grant_output(with_caps(token_grant(), cap - tokens, 1_000_000), 2_000_000),
      change_of(
        assets.merge(assets.from_lovelace(9_000_000), token(20 - tokens)),
      ),
      output(
        recipient_address(),
        assets.merge(assets.from_lovelace(1_000_000), token(tokens)),
        NoDatum,
      ),
    ],
  )
}

/// Whether the token grant pays 10 tokens and `lovelace` to the recipient
/// while the account pays `fee`, handing back a grant output carrying
/// `after`.
fn spend_token_with_fee(fee: Int, lovelace: Int, after: Grant) -> Bool {
  let tx = grant_transaction_within(
    interval.before(expiry - 1),
    [grant_input(token_grant()), treasury_input()],
    [control_reference()],
    [
      grant_output(after, 2_000_000),
      change_of(
        assets.merge(
          assets.from_lovelace(10_000_000 - lovelace - fee),
          token(10),
        ),
      ),
      output(
        recipient_address(),
        assets.merge(assets.from_lovelace(lovelace), token(10)),
        NoDatum,
      ),
    ],
    assets.zero,
    [stranger_key],
  )
  run(Transaction { ..tx, fee })
}

/// Whether the token grant pays 10 tokens and 1 ADA to the recipient,
/// handing back a grant output with `cap` and `lovelace_cap` remaining;
/// the outflow leaves 40 tokens and 1 ADA.
fn spend_token_recapped(cap: Int, lovelace_cap: Int) -> Bool {
  spend_token(
    [
      grant_output(with_caps(token_grant(), cap, lovelace_cap), 2_000_000),
      change_of(assets.merge(assets.from_lovelace(9_000_000), token(10))),
      output(
        recipient_address(),
        assets.merge(assets.from_lovelace(1_000_000), token(10)),
        NoDatum,
      ),
    ],
  )
}

/// The outputs of a lovelace grant spend in which the agent deposits more
/// than it pays out: the grant output carrying `after`, 14 ADA of change
/// and a 1 ADA payout.
fn agent_deposit_outputs(after: Grant) -> List<Output> {
  [
    grant_output(after, 2_000_000),
    change_of(assets.from_lovelace(14_000_000)),
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
  run(
    grant_transaction_within(
      interval.before(expiry - 1),
      [grant_input(lovelace_grant()), fund_input(), agent_funds],
      [control_reference()],
      agent_deposit_outputs(after),
      assets.zero,
      [stranger_key],
    ),
  )
}

/// The upgrade of the granted account to the next logic.
fn upgrade_transaction() -> Transaction {
  upgrade_into(upgraded_state())
}

/// Whether both logics accept the upgrade transaction.
fn upgrades(tx: Transaction) -> Bool {
  run(tx) && run_as(next_logic_hash, tx)
}

/// The upgrade of the account under test and of the other account, both
/// from the test logic to the next, in one transaction.
fn two_account_upgrade_transaction() -> Transaction {
  test_helpers.transaction(
    [
      granted_control_input(),
      input(1, other_control_output(granted_state(), 2_000_000)),
    ],
    [
      control_output(upgraded_state(), 2_000_000),
      other_control_output(upgraded_state(), 2_000_000),
    ],
    assets.zero,
    [device_key],
    interval.everything,
  )
    |> with_proxy_redeemers()
    |> withdrawing([logic_hash, next_logic_hash])
}

// TESTS ***********************************************************************

test create_account_validates_the_initial_state() {
  run(creation_with_state(state()))
}

test create_account_accepts_a_non_zero_grant_generation() {
  run(creation_with_state(AccountState { ..state(), grant_generation: 5 }))
}

test create_account_accepts_other_outputs_beside_the_control_output() {
  run(
    creation(
      [payout(1), control_output(state(), 2_000_000), payout(2)],
      state_nft(stake_script_hash),
      [device_key],
    ),
  )
}

test create_account_rejects_an_ill_formed_state() {
  !run(creation_with_state(AccountState { ..state(), devices: [] }))
}

test create_account_rejects_a_non_zero_next_slot() {
  !run(creation_with_state(AccountState { ..state(), next_slot: 1 }))
}

test create_account_rejects_a_non_zero_outstanding_count() {
  !run(creation_with_state(AccountState { ..state(), outstanding: 1 }))
}

test create_account_rejects_a_revoked_slot() {
  !run(creation_with_state(AccountState { ..state(), revoked: [0] }))
}

test create_account_rejects_extra_tokens_on_the_control_output() {
  let parked = output(
    account_address(),
    assets.merge(control_value(stake_script_hash, 2_000_000), other_token()),
    state_datum(state()),
  )
  !run(creation([parked], state_nft(stake_script_hash), [device_key]))
}

/// Without a control UTxO of the account among the inputs the arrival is
/// a creation, which mints the state NFT and nothing else under the
/// policy.
test create_account_rejects_a_missing_mint() {
  !run(
    creation([control_output(state(), 2_000_000)], assets.zero, [device_key]),
  )
}

test create_account_rejects_a_quantity_of_two() {
  !run(
    creation(
      [control_output(state(), 2_000_000)],
      assets.from_asset(script_hash, stake_script_hash, 2),
      [device_key],
    ),
  )
}

test create_account_rejects_a_grant_token_beside_the_state_nft() {
  !run(
    creation(
      [
        control_output(state(), 2_000_000),
        grant_output(lovelace_grant(), 2_000_000),
      ],
      assets.merge(
        state_nft(stake_script_hash),
        grant_token(stake_script_hash, 0),
      ),
      [device_key],
    ),
  )
}

/// A creation minting the state NFT with a payout as its only output: the
/// arrival path finds no control output naming this logic and aborts.
test create_account_rejects_a_missing_control_output() fail {
  run(creation([payout(1)], state_nft(stake_script_hash), [device_key]))
}

/// A creation with two control outputs naming this logic: the arrival path
/// finds two where it expects one and aborts.
test create_account_rejects_two_control_outputs() fail {
  run(
    creation(
      [control_output(state(), 2_000_000), control_output(state(), 2_000_000)],
      state_nft(stake_script_hash),
      [device_key],
    ),
  )
}

/// A control output naming another logic is no arrival for this one, so
/// it finds nothing to validate and aborts; the proxy requires the named
/// logic to run instead.
test create_account_rejects_a_control_output_naming_another_logic() fail {
  run(creation_with_state(AccountState { ..state(), logic: next_logic_hash }))
}

/// A creation whose control datum is an integer: the arrival path reads the
/// logic field of the output holding the state NFT, finds no constructor
/// and aborts.
test create_account_rejects_a_malformed_state_datum() fail {
  let data: Data = 42
  let malformed = output(
    account_address(),
    control_value(stake_script_hash, 2_000_000),
    InlineDatum(data),
  )
  run(creation([malformed], state_nft(stake_script_hash), [device_key]))
}

/// A creation whose control output carries its state by datum hash: an
/// output without an inline datum names no logic, so the arrival path finds
/// no control output and aborts.
test create_account_rejects_a_state_datum_given_by_hash() fail {
  let hashed = output(
    account_address(),
    control_value(stake_script_hash, 2_000_000),
    DatumHash(stranger_key),
  )
  run(creation([hashed], state_nft(stake_script_hash), [device_key]))
}

/// A datum whose logic field names this logic but whose remaining fields
/// are not an account state aborts the arrival.
test create_account_rejects_a_state_the_logic_cannot_read() fail {
  let logic: Data = logic_hash
  let padded: Data = builtin.constr_data(0, [logic])
  let unreadable = output(
    account_address(),
    control_value(stake_script_hash, 2_000_000),
    InlineDatum(padded),
  )
  run(creation([unreadable], state_nft(stake_script_hash), [device_key]))
}

test device_spends_funds_and_keeps_the_state() {
  run(
    owner_transaction(
      state(),
      [fund_input()],
      [control_output(state(), 2_000_000), payout(10_000_000)],
      assets.zero,
    ),
  )
}

test device_rewrites_the_state() {
  run(rewrite(rewritten_state()))
}

test device_accepts_any_device_signature() {
  let two_devices = AccountState {
    ..state(),
    devices: [device_key, other_device_key],
  }
  let tx = logic_transaction(
    [input(0, control_output(two_devices, 2_000_000))],
    [control_output(two_devices, 2_000_000)],
    assets.zero,
    [other_device_key],
    interval.everything,
  )
  run(tx)
}

/// A reserve, a deposit carrying a datum, spent beside the control UTxO
/// carries `Fund`, which the proxy validates and the logic leaves alone.
test device_accepts_a_reserve_spent_beside_the_control() {
  let marker: Data = 1
  let reserve = input(
    1,
    output(
      account_address(),
      assets.from_lovelace(10_000_000),
      InlineDatum(marker),
    ),
  )
  run(
    owner_transaction(
      state(),
      [reserve],
      [control_output(state(), 2_000_000), payout(10_000_000)],
      assets.zero,
    ),
  )
}

test device_rejects_a_missing_device_signature() {
  !run(Transaction { ..rewrite(state()), extra_signatories: [] })
}

test device_rejects_a_signature_from_a_key_that_is_not_a_device() {
  !run(Transaction { ..rewrite(state()), extra_signatories: [stranger_key] })
}

test device_rejects_an_ill_formed_new_state() {
  !run(rewrite(AccountState { ..state(), devices: [] }))
}

/// A device spend recreating the control output under an inline datum that
/// is an integer: the `Device` rule reads the logic field of the control
/// output, finds no constructor and aborts.
test device_rejects_a_malformed_state_datum() fail {
  let data: Data = 42
  let malformed = output(
    account_address(),
    control_value(stake_script_hash, 2_000_000),
    InlineDatum(data),
  )
  run(owner_transaction(state(), [], [malformed], assets.zero))
}

test device_rejects_extra_tokens_on_the_control_output() {
  let parked = output(
    account_address(),
    assets.merge(control_value(stake_script_hash, 2_000_000), other_token()),
    state_datum(state()),
  )
  !run(owner_transaction(state(), [], [parked], assets.zero))
}

/// The control UTxO names this logic but its state does not decode, so the
/// owner path aborts rather than reading a state it cannot trust.
test device_rejects_a_control_input_whose_datum_is_not_an_account_state() fail {
  let logic: Data = logic_hash
  let foreign: Data = 42
  let padded: Data = builtin.constr_data(0, [logic, foreign])
  let control = input(
    0,
    output(
      account_address(),
      control_value(stake_script_hash, 2_000_000),
      InlineDatum(padded),
    ),
  )
  run(
    logic_transaction(
      [control],
      [control_output(state(), 2_000_000)],
      assets.zero,
      [device_key],
      interval.everything,
    ),
  )
}

test device_rejects_a_state_nft_sent_outside_the_account() {
  let stray = output(
    recipient_address(),
    control_value(stake_script_hash, 2_000_000),
    NoDatum,
  )
  !run(
    owner_transaction(
      state(),
      [],
      [control_output(state(), 2_000_000), stray],
      assets.zero,
    ),
  )
}

test device_rejects_a_grant_token_sent_outside_the_account() {
  let stray = output(
    recipient_address(),
    grant_value(stake_script_hash, 0, 2_000_000),
    NoDatum,
  )
  !run(
    owner_transaction(
      granted_state(),
      [input(1, grant_output(lovelace_grant(), 2_000_000))],
      [control_output(granted_state(), 2_000_000), stray],
      assets.zero,
    ),
  )
}

/// Another account's control output beside this one is that account's
/// logic's to validate: accepted when it names another logic, refused
/// when it names this one, which validates the spent account only.
test device_accepts_another_accounts_control_output_under_another_logic() {
  run(
    owner_transaction(
      state(),
      [],
      [
        control_output(state(), 2_000_000),
        other_control_output(
          AccountState { ..state(), logic: next_logic_hash },
          2_000_000,
        ),
      ],
      assets.zero,
    ),
  )
}

test device_rejects_another_accounts_control_output_naming_this_logic() {
  !run(
    owner_transaction(
      state(),
      [],
      [
        control_output(state(), 2_000_000),
        other_control_output(state(), 2_000_000),
      ],
      assets.zero,
    ),
  )
}

test device_rejects_a_state_nft_sent_to_an_enterprise_script_address() {
  let stray = output(
    address.from_script(script_hash),
    control_value(other_stake_script_hash, 2_000_000),
    NoDatum,
  )
  !run(
    owner_transaction(
      state(),
      [],
      [control_output(state(), 2_000_000), stray],
      assets.zero,
    ),
  )
}

test device_rejects_forging_another_accounts_control_output_from_a_stray_nft() {
  let other_state = AccountState { ..state(), devices: [stranger_key] }
  let other_control = other_control_output(other_state, 2_000_000)
  let stray = input(
    1,
    output(
      other_account_address(),
      control_value(stake_script_hash, 2_000_000),
      NoDatum,
    ),
  )
  let forged = control_output(other_state, 2_000_000)
  !run(
    logic_transaction(
      [input(0, other_control), stray],
      [other_control, forged],
      assets.zero,
      [stranger_key],
      interval.everything,
    ),
  )
}

test device_rejects_a_control_output_at_another_stake_credential() {
  let misplaced = output(
    other_account_address(),
    control_value(stake_script_hash, 2_000_000),
    state_datum(state()),
  )
  !run(owner_transaction(state(), [], [misplaced], assets.zero))
}

/// A device spend of the control UTxO with a payout as its only output: the
/// `Device` rule finds no control output of the account and aborts.
test device_rejects_a_missing_control_output() fail {
  run(owner_transaction(state(), [], [payout(2_000_000)], assets.zero))
}

/// A device spend recreating the control UTxO twice: the `Device` rule
/// finds no single control output and aborts.
test device_rejects_two_control_outputs() fail {
  run(
    owner_transaction(
      state(),
      [],
      [control_output(state(), 1_000_000), control_output(state(), 1_000_000)],
      assets.zero,
    ),
  )
}

/// `Device` on a plain deposit beside the control UTxO: the deposit holds
/// no state NFT, so the owner rule refuses it.
test device_rejects_an_input_without_the_state_nft() {
  let tx = owner_transaction(
    state(),
    [fund_input()],
    [control_output(state(), 2_000_000), payout(10_000_000)],
    assets.zero,
  )
    |> spending(1, Device)
  !run(tx)
}

test device_rejects_a_grant_utxo_as_the_control() {
  let tx = owner_transaction(
    granted_state(),
    [input(1, grant_output(lovelace_grant(), 2_000_000))],
    [control_output(granted_state(), 2_000_000), payout(2_000_000)],
    assets.zero,
  )
    |> spending(1, Device)
  !run(tx)
}

/// A grant UTxO spent on the agent path beside the control UTxO, with a
/// device signing and its cap raised in place: the owner path admits no
/// `SpendWithGrant`, so a grant is never edited, only revoked and
/// reissued.
test device_rejects_a_grant_rewritten_on_the_agent_path_beside_the_control() {
  let tx = owner_transaction(
    granted_state(),
    [input(1, grant_output(lovelace_grant(), 2_000_000))],
    [
      control_output(granted_state(), 2_000_000),
      grant_output(with_caps(lovelace_grant(), 50_000_000, 0), 2_000_000),
    ],
    assets.zero,
  )
    |> spending(1, SpendWithGrant)
  !run(tx)
}

/// The control UTxO spent under `Fund` dodges the owner rule; the proxy
/// refuses `Fund` on a UTxO holding an account token and the logic
/// requires `Device` on the control UTxO besides.
test device_rejects_the_control_spent_under_fund() {
  !run(rewrite(state()) |> spending(0, types.Fund))
}

test device_rejects_a_missing_control_output_even_when_the_state_nft_is_burned() {
  !run(owner_transaction(state(), [fund_input()], [payout(12_000_000)], burn()))
}

test device_rejects_a_next_slot_edit_without_a_mint() {
  !run(rewrite(AccountState { ..state(), next_slot: 1 }))
}

test device_rejects_an_outstanding_edit_without_a_mint() {
  !run(rewrite(AccountState { ..state(), outstanding: 1 }))
}

test device_rejects_a_decreased_grant_generation() {
  let bumped = AccountState { ..state(), grant_generation: 2 }
  !run(
    owner_transaction(
      bumped,
      [],
      [
        control_output(
          AccountState { ..bumped, grant_generation: 1 },
          2_000_000,
        ),
      ],
      assets.zero,
    ),
  )
}

test device_issues_a_grant() {
  run(
    issue_transaction(
      [
        control_output(issued_state(1), 2_000_000),
        grant_output(lovelace_grant(), 2_000_000),
      ],
      grant_token(stake_script_hash, 0),
    ),
  )
}

test device_issues_two_grants() {
  run(
    issue_transaction(
      [
        control_output(issued_state(2), 2_000_000),
        grant_output(lovelace_grant(), 2_000_000),
        grant_output(token_grant(), 2_000_000),
      ],
      assets.merge(
        grant_token(stake_script_hash, 0),
        grant_token(stake_script_hash, 1),
      ),
    ),
  )
}

test device_rejects_a_mint_without_the_next_slot_bump() {
  !run(
    issue_transaction(
      [
        control_output(AccountState { ..state(), outstanding: 1 }, 2_000_000),
        grant_output(lovelace_grant(), 2_000_000),
      ],
      grant_token(stake_script_hash, 0),
    ),
  )
}

test device_rejects_a_mint_without_the_outstanding_bump() {
  !run(
    issue_transaction(
      [
        control_output(AccountState { ..state(), next_slot: 1 }, 2_000_000),
        grant_output(lovelace_grant(), 2_000_000),
      ],
      grant_token(stake_script_hash, 0),
    ),
  )
}

test device_rejects_a_seventeenth_outstanding_grant() {
  let full = AccountState { ..state(), next_slot: 16, outstanding: 16 }
  let grant = Grant { ..lovelace_grant(), slot: 16 }
  !run(
    owner_transaction(
      full,
      [],
      [
        control_output(
          AccountState { ..full, next_slot: 17, outstanding: 17 },
          2_000_000,
        ),
        grant_output(grant, 2_000_000),
      ],
      grant_token(stake_script_hash, 16),
    ),
  )
}

/// A state NFT minted on the owner path carries `CreateAccount`, which the
/// owner path refuses outright.
test device_rejects_a_state_nft_minted_beside_the_control() {
  !run(
    issue_transaction(
      [
        control_output(state(), 2_000_000),
        other_control_output(state(), 2_000_000),
      ],
      state_nft(other_stake_script_hash),
    ),
  )
}

test device_rejects_another_accounts_grant_token_minted() {
  !run(
    issue_transaction(
      [
        control_output(state(), 2_000_000),
        other_grant_output(lovelace_grant(), 2_000_000),
      ],
      grant_token(other_stake_script_hash, 0),
    ),
  )
}

/// An issuance minting the grant token of slot 0 in quantity two with no
/// grant output: the issue rule finds no output holding the token and
/// aborts.
test device_rejects_a_grant_token_minted_in_quantity_two() fail {
  run(
    issue_transaction(
      [control_output(issued_state(2), 2_000_000)],
      assets.from_asset(
        script_hash,
        custody.grant_token_name(stake_script_hash, 0),
        2,
      ),
    ),
  )
}

test device_revokes_a_slot() {
  run(
    owner_transaction(
      granted_state(),
      [],
      [
        control_output(
          AccountState { ..granted_state(), revoked: [0] },
          2_000_000,
        ),
      ],
      assets.zero,
    ),
  )
}

test device_revokes_all_grants_by_bumping_the_generation() {
  let revoked = AccountState { ..granted_state(), revoked: [0, 1] }
  run(
    owner_transaction(
      revoked,
      [],
      [
        control_output(
          AccountState { ..revoked, grant_generation: 1, revoked: [] },
          2_000_000,
        ),
      ],
      assets.zero,
    ),
  )
}

test device_rejects_a_thirty_third_revoked_slot() {
  let full = AccountState { ..granted_state(), revoked: list.range(1, 32) }
  !run(
    owner_transaction(
      full,
      [],
      [
        control_output(
          AccountState { ..full, revoked: list.range(1, 33) },
          2_000_000,
        ),
      ],
      assets.zero,
    ),
  )
}

test device_spends_funds_with_grants_outstanding() {
  run(
    owner_transaction(
      granted_state(),
      [fund_input()],
      [control_output(granted_state(), 2_000_000), payout(10_000_000)],
      assets.zero,
    ),
  )
}

test device_sweeps_a_grant() {
  run(sweep_transaction(lovelace_grant(), swept_state()))
}

test device_rejects_a_burn_without_the_outstanding_decrement() {
  !run(
    sweep_transaction(
      lovelace_grant(),
      AccountState { ..granted_state(), revoked: [0] },
    ),
  )
}

test sweep_grant_burns_a_grant_of_an_older_generation() {
  let bumped = AccountState { ..granted_state(), grant_generation: 1 }
  run(
    owner_transaction(
      bumped,
      [input(1, grant_output(lovelace_grant(), 2_000_000))],
      [
        control_output(AccountState { ..bumped, outstanding: 1 }, 2_000_000),
        change_of(assets.from_lovelace(2_000_000)),
      ],
      grant_burn(0),
    ),
  )
}

test sweep_grant_burns_an_expired_grant() {
  run(expired_sweep_transaction(interval.after(expiry + 1)))
}

test sweep_grant_rejects_a_live_grant() {
  !run(expired_sweep_transaction(interval.everything))
}

test sweep_grant_rejects_a_lower_bound_at_the_expiry() {
  !run(expired_sweep_transaction(interval.after(expiry)))
}

test sweep_grant_rejects_a_missing_device_signature() {
  !run(
    Transaction {
      ..sweep_transaction(lovelace_grant(), swept_state()),
      extra_signatories: [stranger_key],
    },
  )
}

/// A sweep over a referenced control UTxO is the agent path, which admits
/// no `SweepGrant`.
test sweep_grant_rejects_a_referenced_control() {
  let tx = logic_transaction(
    [input(1, grant_output(lovelace_grant(), 2_000_000))],
    [change_of(assets.from_lovelace(2_000_000))],
    grant_burn(0),
    [device_key],
    interval.everything,
  )
    |> referencing(
        [
          input(
            100,
            control_output(
              AccountState { ..granted_state(), revoked: [0] },
              2_000_000,
            ),
          ),
        ],
      )
    |> spending(1, SweepGrant)
  !run(tx)
}

test sweep_grant_rejects_an_unburned_token() {
  !run(
    Transaction {
      ..sweep_transaction(lovelace_grant(), swept_state()),
      mint: assets.zero,
    },
  )
}

test sweep_grant_rejects_a_burn_of_another_slot() {
  !run(
    Transaction {
      ..sweep_transaction(lovelace_grant(), swept_state()),
      mint: grant_burn(1),
    },
  )
}

test sweep_grant_rejects_extra_tokens_on_the_grant_utxo() {
  let dusted = output(
    account_address(),
    assets.merge(grant_value(stake_script_hash, 0, 2_000_000), other_token()),
    grant_datum(lovelace_grant()),
  )
  !run(
    owner_transaction(
      AccountState { ..granted_state(), revoked: [0] },
      [input(1, dusted)],
      [
        control_output(swept_state(), 2_000_000),
        change_of(assets.from_lovelace(2_000_000)),
      ],
      grant_burn(0),
    ),
  )
}

test sweep_grant_rejects_a_datum_whose_slot_differs_from_the_token() {
  let mislabelled = output(
    account_address(),
    grant_value(stake_script_hash, 0, 2_000_000),
    grant_datum(Grant { ..lovelace_grant(), slot: 1 }),
  )
  !run(
    owner_transaction(
      AccountState { ..granted_state(), revoked: [0] },
      [input(1, mislabelled)],
      [
        control_output(swept_state(), 2_000_000),
        change_of(assets.from_lovelace(2_000_000)),
      ],
      grant_burn(0),
    ),
  )
}

/// A device spend in which the deposit carries the `SweepGrant` redeemer:
/// the sweep rule reads the inline datum of a UTxO that carries none and
/// aborts.
test sweep_grant_rejects_a_fund_input() fail {
  let tx = owner_transaction(
    state(),
    [fund_input()],
    [control_output(state(), 2_000_000), payout(10_000_000)],
    assets.zero,
  )
    |> spending(1, SweepGrant)
  run(tx)
}

test sweep_grant_rejects_the_control_utxo() {
  !run(
    sweep_transaction(lovelace_grant(), swept_state())
      |> spending(0, SweepGrant),
  )
}

/// The grant UTxO of slot 0 issued under `generation`, with the lovelace
/// grant as a datum of another shape: its four fields followed by a fifth
/// this logic does not know.
fn padded_grant_output(generation: Int) -> Output {
  let slot: Data = 0
  let grantee: Data = stranger_key
  let generation: Data = generation
  let scope: Data = lovelace_scope()
  let extra_field: Data = 7
  output(
    account_address(),
    grant_value(stake_script_hash, 0, 2_000_000),
    InlineDatum(
      builtin.constr_data(0, [slot, grantee, generation, scope, extra_field]),
    ),
  )
}

/// A sweep reads only the stable prefix of the grant datum: a grant of
/// another shape is swept once its generation or its slot is dead.
test sweep_grant_burns_a_grant_of_another_shape_under_an_older_generation() {
  let bumped = AccountState { ..granted_state(), grant_generation: 1 }
  run(
    owner_transaction(
      bumped,
      [input(1, padded_grant_output(0))],
      [
        control_output(AccountState { ..bumped, outstanding: 1 }, 2_000_000),
        change_of(assets.from_lovelace(2_000_000)),
      ],
      grant_burn(0),
    ),
  )
}

test sweep_grant_burns_a_revoked_grant_of_another_shape() {
  run(
    owner_transaction(
      AccountState { ..granted_state(), revoked: [0] },
      [input(1, padded_grant_output(0))],
      [
        control_output(swept_state(), 2_000_000),
        change_of(assets.from_lovelace(2_000_000)),
      ],
      grant_burn(0),
    ),
  )
}

/// The expiry lives in the scope, which a datum of another shape does not
/// yield, so a grant of another shape that is only expired stays unswept
/// until its slot is revoked or its generation passes.
test sweep_grant_rejects_an_expired_grant_of_another_shape() {
  !run(
    logic_transaction(
      [granted_control_input(), input(1, padded_grant_output(0))],
      [
        control_output(
          AccountState { ..granted_state(), outstanding: 1 },
          2_000_000,
        ),
        change_of(assets.from_lovelace(2_000_000)),
      ],
      grant_burn(0),
      [device_key],
      interval.after(expiry + 1),
    ),
  )
}

test issue_grants_mints_two_grant_tokens_in_slot_order() {
  run(
    issue_transaction(
      [
        control_output(issued_state(2), 2_000_000),
        grant_output(token_grant(), 2_000_000),
        grant_output(lovelace_grant(), 2_000_000),
      ],
      assets.merge(
        grant_token(stake_script_hash, 1),
        grant_token(stake_script_hash, 0),
      ),
    ),
  )
}

test issue_grants_continues_from_the_next_slot() {
  let grant = Grant { ..lovelace_grant(), slot: 2 }
  run(
    owner_transaction(
      granted_state(),
      [],
      [
        control_output(
          AccountState { ..granted_state(), next_slot: 3, outstanding: 3 },
          2_000_000,
        ),
        grant_output(grant, 2_000_000),
      ],
      grant_token(stake_script_hash, 2),
    ),
  )
}

test issue_grants_binds_the_grant_to_the_recreated_generation() {
  let grant = Grant { ..lovelace_grant(), generation: 1 }
  run(
    issue_transaction(
      [
        control_output(
          AccountState { ..issued_state(1), grant_generation: 1 },
          2_000_000,
        ),
        grant_output(grant, 2_000_000),
      ],
      grant_token(stake_script_hash, 0),
    ),
  )
}

test issue_grants_rejects_a_missing_device_signature() {
  !run(
    Transaction {
      ..issue_transaction(
        [
          control_output(issued_state(1), 2_000_000),
          grant_output(lovelace_grant(), 2_000_000),
        ],
        grant_token(stake_script_hash, 0),
      ),
      extra_signatories: [stranger_key],
    },
  )
}

/// Without a control UTxO present the logic finds no control output naming
/// it either, since the grant output carries a grant, and aborts; the
/// proxy refuses the mint before that.
test issue_grants_rejects_a_missing_control_input() fail {
  run(
    logic_transaction(
      [fund_input()],
      [
        grant_output(lovelace_grant(), 2_000_000),
        change_of(assets.from_lovelace(8_000_000)),
      ],
      grant_token(stake_script_hash, 0),
      [device_key],
      interval.everything,
    ),
  )
}

/// An issuance of slot 0 whose only output is the grant UTxO: the issue
/// rule finds no control output of the account and aborts.
test issue_grants_rejects_a_missing_control_output() fail {
  run(
    issue_transaction(
      [grant_output(lovelace_grant(), 2_000_000)],
      grant_token(stake_script_hash, 0),
    ),
  )
}

/// A mint over a referenced control UTxO is the agent path, which admits
/// no mint under the policy.
test issue_grants_rejects_a_referenced_control() {
  let tx = logic_transaction(
    [fund_input()],
    [
      grant_output(lovelace_grant(), 2_000_000),
      change_of(assets.from_lovelace(8_000_000)),
    ],
    grant_token(stake_script_hash, 0),
    [device_key],
    interval.everything,
  )
    |> referencing([control_reference()])
  !run(tx)
}

test issue_grants_rejects_a_quantity_of_two() {
  !run(
    issue_transaction(
      [
        control_output(issued_state(1), 2_000_000),
        grant_output(lovelace_grant(), 2_000_000),
      ],
      assets.from_asset(
        script_hash,
        custody.grant_token_name(stake_script_hash, 0),
        2,
      ),
    ),
  )
}

test issue_grants_rejects_a_skipped_slot() {
  let grant = Grant { ..lovelace_grant(), slot: 1 }
  !run(
    issue_transaction(
      [
        control_output(issued_state(1), 2_000_000),
        grant_output(grant, 2_000_000),
      ],
      grant_token(stake_script_hash, 1),
    ),
  )
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
  !run(
    issue_transaction(
      [control_output(issued_state(1), 2_000_000), mislabelled],
      grant_token(stake_script_hash, 1),
    ),
  )
}

test issue_grants_rejects_a_reused_slot() {
  !run(
    owner_transaction(
      granted_state(),
      [],
      [
        control_output(
          AccountState { ..granted_state(), next_slot: 3, outstanding: 3 },
          2_000_000,
        ),
        grant_output(lovelace_grant(), 2_000_000),
      ],
      grant_token(stake_script_hash, 0),
    ),
  )
}

test issue_grants_rejects_a_grant_output_at_another_address() {
  let misplaced = output(
    other_account_address(),
    grant_value(stake_script_hash, 0, 2_000_000),
    grant_datum(lovelace_grant()),
  )
  !run(
    issue_transaction(
      [control_output(issued_state(1), 2_000_000), misplaced],
      grant_token(stake_script_hash, 0),
    ),
  )
}

test issue_grants_rejects_extra_tokens_on_the_grant_output() {
  let dusted = output(
    account_address(),
    assets.merge(grant_value(stake_script_hash, 0, 2_000_000), other_token()),
    grant_datum(lovelace_grant()),
  )
  !run(
    issue_transaction(
      [control_output(issued_state(1), 2_000_000), dusted],
      grant_token(stake_script_hash, 0),
    ),
  )
}

test issue_grants_rejects_a_reference_script_on_the_grant_output() {
  let weighted = Output {
    ..grant_output(lovelace_grant(), 2_000_000),
    reference_script: Some(script_hash),
  }
  !run(
    issue_transaction(
      [control_output(issued_state(1), 2_000_000), weighted],
      grant_token(stake_script_hash, 0),
    ),
  )
}

test issue_grants_rejects_a_grant_of_another_slot_under_the_token() {
  let mislabelled = output(
    account_address(),
    grant_value(stake_script_hash, 0, 2_000_000),
    grant_datum(Grant { ..lovelace_grant(), slot: 1 }),
  )
  !run(
    issue_transaction(
      [control_output(issued_state(1), 2_000_000), mislabelled],
      grant_token(stake_script_hash, 0),
    ),
  )
}

test issue_grants_rejects_a_grant_of_another_generation() {
  !run(
    issue_transaction(
      [
        control_output(issued_state(1), 2_000_000),
        grant_output(Grant { ..lovelace_grant(), generation: 1 }, 2_000_000),
      ],
      grant_token(stake_script_hash, 0),
    ),
  )
}

test issue_grants_rejects_an_ill_formed_scope() {
  let grant = Grant {
    ..lovelace_grant(),
    scope: Scope { ..lovelace_scope(), expires_at: 0 },
  }
  !run(
    issue_transaction(
      [
        control_output(issued_state(1), 2_000_000),
        grant_output(grant, 2_000_000),
      ],
      grant_token(stake_script_hash, 0),
    ),
  )
}

/// An issuance of slot 0 whose grant token lands in no output: the issue
/// rule finds no output holding the token and aborts.
test issue_grants_rejects_a_grant_token_in_no_output() fail {
  run(
    issue_transaction(
      [control_output(issued_state(1), 2_000_000)],
      grant_token(stake_script_hash, 0),
    ),
  )
}

/// An issuance of slot 0 whose grant token lands in two outputs: the issue
/// rule finds no single output holding the token and aborts.
test issue_grants_rejects_a_grant_token_in_two_outputs() fail {
  run(
    issue_transaction(
      [
        control_output(issued_state(1), 2_000_000),
        grant_output(lovelace_grant(), 2_000_000),
        grant_output(lovelace_grant(), 2_000_000),
      ],
      grant_token(stake_script_hash, 0),
    ),
  )
}

/// An issuance of slot 0 whose grant output carries its grant by datum
/// hash: the issue rule reads the grant of an output without an inline
/// datum and aborts.
test issue_grants_rejects_a_grant_datum_given_by_hash() fail {
  let hashed = output(
    account_address(),
    grant_value(stake_script_hash, 0, 2_000_000),
    DatumHash(stranger_key),
  )
  run(
    issue_transaction(
      [control_output(issued_state(1), 2_000_000), hashed],
      grant_token(stake_script_hash, 0),
    ),
  )
}

/// An issuance of slot 0 whose grant output carries an integer inline: the
/// issue rule reads it as a grant and aborts.
test issue_grants_rejects_a_malformed_grant_datum() fail {
  let data: Data = 42
  let malformed = output(
    account_address(),
    grant_value(stake_script_hash, 0, 2_000_000),
    InlineDatum(data),
  )
  run(
    issue_transaction(
      [control_output(issued_state(1), 2_000_000), malformed],
      grant_token(stake_script_hash, 0),
    ),
  )
}

/// `IssueGrants` over a state NFT name: the owner rule ties the minted
/// names to the next slots and refuses a name that is no grant token.
test issue_grants_rejects_the_state_nft_name() {
  !run(
    issue_transaction(
      [
        control_output(state(), 2_000_000),
        other_control_output(state(), 2_000_000),
      ],
      state_nft(other_stake_script_hash),
    )
      |> test_helpers.minting(IssueGrants),
  )
}

test burn_grants_burns_two_grant_tokens() {
  run(
    owner_transaction(
      AccountState { ..granted_state(), grant_generation: 1 },
      [
        input(1, grant_output(lovelace_grant(), 2_000_000)),
        input(2, grant_output(token_grant(), 2_000_000)),
      ],
      [
        control_output(
          AccountState {
            ..granted_state(),
            grant_generation: 1,
            outstanding: 0,
          },
          2_000_000,
        ),
        change_of(assets.from_lovelace(4_000_000)),
      ],
      assets.merge(grant_burn(0), grant_burn(1)),
    ),
  )
}

test burn_grants_rejects_a_mint_among_the_burns() {
  !run(
    Transaction {
      ..sweep_transaction(lovelace_grant(), swept_state()),
      mint: assets.merge(grant_burn(0), grant_token(stake_script_hash, 2)),
    }
      |> test_helpers.minting(BurnGrants),
  )
}

/// `BurnGrants` over another account's grant token: the owner rule
/// requires every burned name to be the account's own and refuses it.
test burn_grants_rejects_another_accounts_grant_token() {
  !run(
    Transaction {
      ..sweep_transaction(lovelace_grant(), swept_state()),
      mint: assets.merge(
        grant_burn(0),
        assets.from_asset(
          script_hash,
          custody.grant_token_name(other_stake_script_hash, 0),
          -1,
        ),
      ),
    },
  )
}

/// `BurnGrants` requires 32 byte names; the state NFT name is refused
/// before the owner rule aborts on it.
test burn_grants_rejects_the_state_nft() {
  !run(
    owner_transaction(state(), [], [payout(2_000_000)], burn())
      |> test_helpers.minting(BurnGrants),
  )
}

/// A grant token of this account minted under `BurnGrants` fails the burn
/// rule on its quantity.
test burn_grants_rejects_a_positive_quantity() {
  !run(
    issue_transaction(
      [
        control_output(issued_state(1), 2_000_000),
        grant_output(lovelace_grant(), 2_000_000),
      ],
      grant_token(stake_script_hash, 0),
    )
      |> test_helpers.minting(BurnGrants),
  )
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

test spend_with_grant_accepts_spending_exactly_the_remaining_cap() {
  spend_remaining_lovelace(2_000_000, 2_000_000)
}

test spend_with_grant_rejects_one_lovelace_above_the_remaining_cap() {
  !spend_remaining_lovelace(2_000_000, 2_000_001)
}

test spend_with_grant_rejects_spending_above_the_remaining_cap() {
  !spend_remaining_lovelace(1_000_000, 2_000_000)
}

/// The fee the account pays leaves it like a payout, so the cap decrement
/// is the payout plus the fee.
test spend_with_grant_charges_a_fee_paid_by_the_account_against_the_cap() {
  spend_lovelace_with_fee(
    500_000,
    2_000_000,
    with_caps(lovelace_grant(), 2_500_000, 0),
  )
}

test spend_with_grant_rejects_a_cap_decrement_that_leaves_out_the_fee() {
  !spend_lovelace_with_fee(
    500_000,
    2_000_000,
    with_caps(lovelace_grant(), 3_000_000, 0),
  )
}

/// A builder may charge the cap for a fee estimate above the fee it ends
/// up paying, so the grant output need not depend on the exact fee.
test spend_with_grant_accepts_a_cap_decrement_beyond_the_fee() {
  spend_lovelace_with_fee(
    500_000,
    2_000_000,
    with_caps(lovelace_grant(), 2_000_000, 0),
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

test spend_with_grant_accepts_lovelace_exactly_at_the_remaining_lovelace_cap() {
  let nearly_spent = with_caps(token_grant(), 50, 1_000_000)
  spend_token_lovelace_from(nearly_spent, 1_000_000, 0)
}

test spend_with_grant_rejects_lovelace_above_the_remaining_lovelace_cap_on_a_token_grant() {
  let nearly_spent = with_caps(token_grant(), 50, 1_000_000)
  !spend_token_lovelace_from(nearly_spent, 1_000_001, -1)
}

test spend_with_grant_accepts_spending_exactly_the_remaining_token_cap() {
  spend_remaining_tokens(5, 5)
}

test spend_with_grant_rejects_one_token_above_the_remaining_token_cap() {
  !spend_remaining_tokens(5, 6)
}

test spend_with_grant_accepts_spending_exactly_the_token_per_call_cap() {
  spend_remaining_tokens(50, 10)
}

test spend_with_grant_rejects_one_token_above_the_per_call_cap() {
  !spend_remaining_tokens(50, 11)
}

/// On a token grant the fee counts against the lovelace cap, so its
/// decrement is the lovelace payout plus the fee.
test spend_with_grant_charges_a_fee_paid_by_the_account_against_the_lovelace_cap() {
  spend_token_with_fee(
    500_000,
    1_000_000,
    with_caps(token_grant(), 40, 500_000),
  )
}

test spend_with_grant_rejects_a_lovelace_cap_decrement_that_leaves_out_the_fee() {
  !spend_token_with_fee(
    500_000,
    1_000_000,
    with_caps(token_grant(), 40, 1_000_000),
  )
}

test spend_with_grant_accepts_a_token_cap_decremented_below_the_outflow() {
  spend_token_recapped(30, 1_000_000)
}

test spend_with_grant_accepts_a_lovelace_cap_decremented_below_the_outflow() {
  spend_token_recapped(40, 500_000)
}

test spend_with_grant_accepts_both_caps_decremented_below_the_outflow() {
  spend_token_recapped(39, 999_999)
}

test spend_with_grant_rejects_a_token_cap_one_above_the_outflow_decrement() {
  !spend_token_recapped(41, 1_000_000)
}

test spend_with_grant_rejects_a_lovelace_cap_one_above_the_outflow_decrement() {
  !spend_token_recapped(40, 1_000_001)
}

test spend_with_grant_rejects_a_negative_token_cap() {
  !spend_token_recapped(-1, 1_000_000)
}

test spend_with_grant_rejects_a_negative_lovelace_cap() {
  !spend_token_recapped(40, -1)
}

test spend_with_grant_rejects_a_foreign_asset_leaving() {
  let stocked = input(
    1,
    fund_output(assets.merge(assets.from_lovelace(10_000_000), other_token())),
  )
  !run(
    grant_transaction_within(
      interval.before(expiry - 1),
      [grant_input(lovelace_grant()), stocked],
      [control_reference()],
      [
        grant_output(with_caps(lovelace_grant(), 3_000_000, 0), 2_000_000),
        change_of(assets.from_lovelace(8_000_000)),
        output(
          recipient_address(),
          assets.merge(assets.from_lovelace(2_000_000), other_token()),
          NoDatum,
        ),
      ],
      assets.zero,
      [stranger_key],
    ),
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
      change_of(assets.from_lovelace(8_000_000)),
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

test spend_with_grant_keeps_the_caps_on_a_net_deposit() {
  spend_with_agent_deposit(lovelace_grant())
}

test spend_with_grant_rejects_a_cap_raised_by_a_net_deposit() {
  !spend_with_agent_deposit(with_caps(lovelace_grant(), 9_000_000, 0))
}

test spend_with_grant_rejects_a_cap_decrement_short_of_the_outflow() {
  !rewritten_spend(with_caps(lovelace_grant(), 4_000_000, 0))
}

test spend_with_grant_rejects_an_unchanged_cap() {
  !rewritten_spend(lovelace_grant())
}

test spend_with_grant_accepts_a_cap_decremented_below_the_outflow() {
  rewritten_spend(with_caps(lovelace_grant(), 2_500_000, 0))
}

test spend_with_grant_accepts_a_cap_decremented_to_zero() {
  rewritten_spend(with_caps(lovelace_grant(), 0, 0))
}

test spend_with_grant_rejects_a_cap_one_lovelace_above_the_outflow_decrement() {
  !rewritten_spend(with_caps(lovelace_grant(), 3_000_001, 0))
}

test spend_with_grant_rejects_a_negative_cap() {
  !rewritten_spend(with_caps(lovelace_grant(), -1, 0))
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
    [mislabelled, change_of(assets.from_lovelace(8_000_000)), payout(2_000_000)],
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
  !run(
    grant_transaction_within(
      interval.before(expiry - 1),
      [grant_input(lovelace_grant()), fund_input()],
      [input(100, control_output(bumped, 2_000_000))],
      lovelace_spend_outputs(2_000_000),
      assets.zero,
      [stranger_key],
    ),
  )
}

test spend_with_grant_rejects_a_revoked_slot() {
  let revoked = AccountState { ..granted_state(), revoked: [0] }
  !run(
    grant_transaction_within(
      interval.before(expiry - 1),
      [grant_input(lovelace_grant()), fund_input()],
      [input(100, control_output(revoked, 2_000_000))],
      lovelace_spend_outputs(2_000_000),
      assets.zero,
      [stranger_key],
    ),
  )
}

test spend_with_grant_accepts_another_revoked_slot() {
  let revoked = AccountState { ..granted_state(), revoked: [1] }
  run(
    grant_transaction_within(
      interval.before(expiry - 1),
      [grant_input(lovelace_grant()), fund_input()],
      [input(100, control_output(revoked, 2_000_000))],
      lovelace_spend_outputs(2_000_000),
      assets.zero,
      [stranger_key],
    ),
  )
}

/// Without the control UTxO the logic takes the transaction for an
/// arrival, finds no control output naming it and aborts; the proxy
/// refuses the grant spend before that.
test spend_with_grant_rejects_a_missing_control_reference() fail {
  run(
    grant_transaction_within(
      interval.before(expiry - 1),
      [grant_input(lovelace_grant()), fund_input()],
      [],
      lovelace_spend_outputs(2_000_000),
      assets.zero,
      [stranger_key],
    ),
  )
}

test spend_with_grant_rejects_two_control_references() {
  !run(
    grant_transaction_within(
      interval.before(expiry - 1),
      [grant_input(lovelace_grant()), fund_input()],
      [
        control_reference(),
        input(101, control_output(granted_state(), 2_000_000)),
      ],
      lovelace_spend_outputs(2_000_000),
      assets.zero,
      [stranger_key],
    ),
  )
}

/// The logic validates the account whose control UTxO it finds: with only
/// the other account's control referenced it validates the other account,
/// which has nothing in the transaction, and passes. The proxy refuses
/// this account's grant spend, whose own control UTxO is absent.
test spend_with_grant_validates_the_account_of_the_referenced_control_only() {
  run(
    grant_transaction_within(
      interval.before(expiry - 1),
      [grant_input(lovelace_grant()), fund_input()],
      [input(100, other_control_output(granted_state(), 2_000_000))],
      lovelace_spend_outputs(2_000_000),
      assets.zero,
      [stranger_key],
    ),
  )
}

/// With the control UTxO spent the transaction is on the owner path,
/// which admits no `SpendWithGrant`.
test spend_with_grant_rejects_a_spent_control_in_place_of_a_reference() {
  !run(
    grant_transaction_within(
      interval.before(expiry - 1),
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
    ),
  )
}

test spend_with_grant_rejects_the_control_spent_beside_the_reference() {
  !run(
    grant_transaction_within(
      interval.before(expiry - 1),
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
    ),
  )
}

test spend_with_grant_rejects_two_grant_utxos_of_the_account() {
  !run(
    grant_transaction_within(
      interval.before(expiry - 1),
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
    ),
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
  !run(
    grant_transaction_within(
      interval.before(expiry - 1),
      [mislabelled, fund_input()],
      [control_reference()],
      lovelace_spend_outputs(2_000_000),
      assets.zero,
      [stranger_key],
    ),
  )
}

/// A deposit spent under `Device` or `SweepGrant` beside the grant UTxO,
/// with the control UTxO referenced: the agent path admits neither, even
/// though the grant rule would net the deposit like any other.
test spend_with_grant_rejects_a_deposit_spent_on_the_owner_path_beside_the_grant() {
  let tx = lovelace_spend(
    interval.before(expiry - 1),
    lovelace_spend_outputs(2_000_000),
    [stranger_key],
  )
  and {
    !run(tx |> spending(1, Device)),
    !run(tx |> spending(1, SweepGrant)),
  }
}

test spend_with_grant_rejects_a_grantee_that_did_not_sign() {
  !spend_lovelace(
    interval.before(expiry - 1),
    lovelace_spend_outputs(2_000_000),
    [device_key],
  )
}

/// A grant spend in which the deposit carries the `SpendWithGrant`
/// redeemer: the grant spend rule reads the grant of a UTxO without an
/// inline datum and aborts.
test spend_with_grant_rejects_a_fund_input() fail {
  run(
    lovelace_spend(
      interval.before(expiry - 1),
      lovelace_spend_outputs(2_000_000),
      [stranger_key],
    )
      |> spending(1, SpendWithGrant),
  )
}

/// The control UTxO spent under `SpendWithGrant` is on the owner path,
/// which requires `Device` on it.
test spend_with_grant_rejects_the_control_utxo() {
  !run(
    owner_transaction(
      granted_state(),
      [fund_input()],
      [control_output(granted_state(), 2_000_000), payout(10_000_000)],
      assets.zero,
    )
      |> spending(0, SpendWithGrant),
  )
}

/// A grant spend whose outputs hold the change and the payout and no grant
/// output: the grant spend rule finds no output holding the grant token and
/// aborts.
test spend_with_grant_rejects_a_missing_grant_output() fail {
  spend_lovelace(
    interval.before(expiry - 1),
    [change_of(assets.from_lovelace(10_000_000)), payout(2_000_000)],
    [stranger_key],
  )
}

/// A grant spend handing back two grant outputs of the spent slot: the
/// grant spend rule finds no single output holding the grant token and
/// aborts.
test spend_with_grant_rejects_two_grant_outputs() fail {
  spend_lovelace(
    interval.before(expiry - 1),
    [
      grant_output(spent_lovelace_grant(), 1_000_000),
      grant_output(spent_lovelace_grant(), 1_000_000),
      change_of(assets.from_lovelace(8_000_000)),
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
  !run(
    grant_transaction_within(
      interval.before(expiry - 1),
      [grant_input(lovelace_grant()), treasury_input()],
      [control_reference()],
      [parked, change_of(assets.from_lovelace(8_000_000)), payout(2_000_000)],
      assets.zero,
      [stranger_key],
    ),
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
  !run(
    grant_transaction_within(
      interval.before(expiry - 1),
      [dusted, fund_input()],
      [control_reference()],
      [parked, change_of(assets.from_lovelace(8_000_000)), payout(2_000_000)],
      assets.zero,
      [stranger_key],
    ),
  )
}

test spend_with_grant_rejects_lovelace_drained_from_the_grant_output() {
  !spend_lovelace(
    interval.before(expiry - 1),
    [
      grant_output(spent_lovelace_grant(), 1_000_000),
      change_of(assets.from_lovelace(9_000_000)),
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
      change_of(assets.from_lovelace(7_000_000)),
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
    [relocated, change_of(assets.from_lovelace(8_000_000)), payout(2_000_000)],
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
    [hashed, change_of(assets.from_lovelace(8_000_000)), payout(2_000_000)],
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
    [weighted, change_of(assets.from_lovelace(8_000_000)), payout(2_000_000)],
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
    ..change_of(assets.from_lovelace(8_000_000)),
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
      change_of(assets.from_lovelace(7_000_000)),
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
  !run(
    grant_transaction_within(
      interval.before(expiry - 1),
      [grant_input(lovelace_grant()), fund_input(), stray],
      [control_reference()],
      [
        grant_output(spent_lovelace_grant(), 2_000_000),
        change_of(assets.from_lovelace(8_000_000)),
        payout(2_000_000),
        output(
          other_account_address(),
          control_value(other_stake_script_hash, 1_000_000),
          NoDatum,
        ),
      ],
      assets.zero,
      [stranger_key],
    ),
  )
}

test spend_with_grant_rejects_a_grant_token_minted() {
  !run(
    grant_transaction_within(
      interval.before(expiry - 1),
      [grant_input(lovelace_grant()), fund_input()],
      [control_reference()],
      [
        grant_output(spent_lovelace_grant(), 2_000_000),
        grant_output(Grant { ..lovelace_grant(), slot: 2 }, 2_000_000),
        change_of(assets.from_lovelace(6_000_000)),
        payout(2_000_000),
      ],
      grant_token(stake_script_hash, 2),
      [stranger_key],
    ),
  )
}

test spend_with_grant_rejects_another_accounts_token_minted() {
  !run(
    grant_transaction_within(
      interval.before(expiry - 1),
      [grant_input(lovelace_grant()), fund_input()],
      [control_reference()],
      [
        grant_output(spent_lovelace_grant(), 2_000_000),
        other_control_output(state(), 2_000_000),
        change_of(assets.from_lovelace(6_000_000)),
        payout(2_000_000),
      ],
      state_nft(other_stake_script_hash),
      [stranger_key],
    ),
  )
}

/// Two accounts under the same logic grant the same agent and it spends
/// through both at once. Each account would net its own address and pass
/// on its own, but the logic validates one account per transaction and
/// refuses two control UTxOs naming it; the builder spends one account at
/// a time.
test spend_with_grant_rejects_two_accounts_under_one_logic_in_one_transaction() {
  let other = AccountState { ..granted_state(), devices: [other_device_key] }
  !run(
    grant_transaction_within(
      interval.before(expiry - 1),
      [
        grant_input(lovelace_grant()),
        fund_input(),
        input(2, other_grant_output(lovelace_grant(), 2_000_000)),
        input(3, other_fund_output(assets.from_lovelace(10_000_000))),
      ],
      [control_reference(), input(101, other_control_output(other, 2_000_000))],
      [
        grant_output(spent_lovelace_grant(), 2_000_000),
        change_of(assets.from_lovelace(8_000_000)),
        payout(2_000_000),
        other_grant_output(spent_lovelace_grant(), 2_000_000),
        other_fund_output(assets.from_lovelace(8_000_000)),
        payout(2_000_000),
      ],
      assets.zero,
      [stranger_key],
    ),
  )
}

/// Two accounts under different logics share a transaction: each logic
/// finds its own control UTxO and nets its own account's address.
test spend_with_grant_accepts_two_accounts_under_different_logics() {
  let other = AccountState {
    ..granted_state(),
    logic: next_logic_hash,
    devices: [other_device_key],
  }
  let tx = grant_transaction_within(
    interval.before(expiry - 1),
    [
      grant_input(lovelace_grant()),
      fund_input(),
      input(2, other_grant_output(lovelace_grant(), 2_000_000)),
      input(3, other_fund_output(assets.from_lovelace(10_000_000))),
    ],
    [control_reference(), input(101, other_control_output(other, 2_000_000))],
    [
      grant_output(spent_lovelace_grant(), 2_000_000),
      change_of(assets.from_lovelace(8_000_000)),
      payout(2_000_000),
      other_grant_output(spent_lovelace_grant(), 2_000_000),
      other_fund_output(assets.from_lovelace(8_000_000)),
      payout(2_000_000),
    ],
    assets.zero,
    [stranger_key],
  )
    |> withdrawing([next_logic_hash])
  run(tx) && run_as(next_logic_hash, tx)
}

test upgrade_is_accepted_by_a_device() {
  upgrades(upgrade_transaction())
}

/// The upgrade carries the counters the owner writes: the outstanding
/// grants, dead under the raised generation, stay counted so that they
/// can be swept under the new logic.
test upgrade_keeps_the_counters_the_owner_writes() {
  upgrades(
    upgrade_into(
      AccountState { ..upgraded_state(), revoked: [1], outstanding: 2 },
    ),
  )
}

test sweep_grant_burns_a_grant_issued_before_an_upgrade() {
  let tx = test_helpers.transaction(
    [
      input(0, control_output(upgraded_state(), 2_000_000)),
      input(1, grant_output(lovelace_grant(), 2_000_000)),
    ],
    [
      control_output(
        AccountState { ..upgraded_state(), outstanding: 1 },
        2_000_000,
      ),
      change_of(assets.from_lovelace(2_000_000)),
    ],
    grant_burn(0),
    [device_key],
    interval.everything,
  )
    |> with_proxy_redeemers()
    |> withdrawing([next_logic_hash])
  run_as(next_logic_hash, tx)
}

test spend_with_grant_rejects_a_grant_issued_before_an_upgrade() {
  let tx = grant_transaction_within(
    interval.before(expiry - 1),
    [grant_input(lovelace_grant()), fund_input()],
    [input(100, control_output(upgraded_state(), 2_000_000))],
    lovelace_spend_outputs(2_000_000),
    assets.zero,
    [stranger_key],
  )
    |> withdrawing([next_logic_hash])
  !run_as(next_logic_hash, tx)
}

test upgrade_rejects_a_grantee_on_the_owner_path() {
  !run(
    Transaction { ..upgrade_transaction(), extra_signatories: [stranger_key] },
  )
}

test upgrade_rejects_a_grantee_on_the_grant_path() {
  !run(upgrade_transaction() |> spending(0, SpendWithGrant))
}

/// A grantee cannot spend the control UTxO, so it references it and
/// offers a control output naming the new logic beside its grant spend.
/// The old logic sees an ordinary agent spend; the new logic sees an
/// arrival without a control input, which is a creation, and refuses it
/// for the missing mint.
test upgrade_rejects_a_grantee_that_only_references_the_control() {
  let tx = lovelace_spend(
    interval.before(expiry - 1),
    [
      control_output(upgraded_state(), 2_000_000),
      ..lovelace_spend_outputs(2_000_000)
    ],
    [stranger_key],
  )
    |> withdrawing([next_logic_hash])
  !run_as(next_logic_hash, tx)
}

test upgrade_rejects_a_stranger() {
  let tx = upgrade_transaction()
  !run(Transaction { ..tx, extra_signatories: [] })
}

test upgrade_rejects_a_missing_new_logic_withdrawal() {
  let tx = upgrade_transaction()
  let tx = Transaction { ..tx, withdrawals: [Pair(Script(logic_hash), 0)] }
  !run(tx)
}

/// The arriving logic requires the logic the account leaves to run as
/// well; the proxy requires the same withdrawal before that.
test upgrade_rejects_a_missing_old_logic_withdrawal() {
  let tx = upgrade_transaction()
  let tx = Transaction { ..tx, withdrawals: [Pair(Script(next_logic_hash), 0)] }
  !run_as(next_logic_hash, tx)
}

test upgrade_rejects_an_output_pointing_at_a_logic_whose_withdrawal_is_absent() {
  !run(
    upgrade_into(AccountState { ..upgraded_state(), logic: third_logic_hash }),
  )
}

test upgrade_rejects_an_unchanged_generation() {
  !run_as(
    next_logic_hash,
    upgrade_into(AccountState { ..upgraded_state(), grant_generation: 0 }),
  )
}

test upgrade_rejects_a_lowered_generation() {
  let current = AccountState { ..granted_state(), grant_generation: 3 }
  let tx = test_helpers.transaction(
    [input(0, control_output(current, 2_000_000))],
    [
      control_output(
        AccountState { ..current, logic: next_logic_hash, grant_generation: 2 },
        2_000_000,
      ),
    ],
    assets.zero,
    [device_key],
    interval.everything,
  )
    |> with_proxy_redeemers()
    |> withdrawing([logic_hash, next_logic_hash])
  !run_as(next_logic_hash, tx)
}

test upgrade_rejects_changed_devices() {
  !run_as(
    next_logic_hash,
    upgrade_into(
      AccountState {
        ..upgraded_state(),
        devices: [device_key, other_device_key],
      },
    ),
  )
}

test upgrade_rejects_an_ill_formed_arriving_state() {
  !run_as(
    next_logic_hash,
    upgrade_into(AccountState { ..upgraded_state(), outstanding: 17 }),
  )
}

test upgrade_rejects_extra_tokens_on_the_control_output() {
  let parked = output(
    account_address(),
    assets.merge(control_value(stake_script_hash, 2_000_000), other_token()),
    state_datum(upgraded_state()),
  )
  let tx = test_helpers.transaction(
    [granted_control_input()],
    [parked],
    assets.zero,
    [device_key],
    interval.everything,
  )
    |> with_proxy_redeemers()
    |> withdrawing([logic_hash, next_logic_hash])
  run(tx) && !run_as(next_logic_hash, tx)
}

test upgrade_rejects_a_state_nft_sent_outside_the_account() {
  let stray = output(
    recipient_address(),
    control_value(other_stake_script_hash, 2_000_000),
    NoDatum,
  )
  let tx = test_helpers.transaction(
    [granted_control_input()],
    [control_output(upgraded_state(), 2_000_000), stray],
    assets.zero,
    [device_key],
    interval.everything,
  )
    |> with_proxy_redeemers()
    |> withdrawing([logic_hash, next_logic_hash])
  !run(tx)
}

/// The NFT lands at another account's address: placement refuses before
/// the lookup of the control output could abort.
test upgrade_rejects_a_control_output_at_another_stake_credential() {
  let misplaced = output(
    other_account_address(),
    control_value(stake_script_hash, 2_000_000),
    state_datum(upgraded_state()),
  )
  let tx = test_helpers.transaction(
    [granted_control_input()],
    [misplaced],
    assets.zero,
    [device_key],
    interval.everything,
  )
    |> with_proxy_redeemers()
    |> withdrawing([logic_hash, next_logic_hash])
  !run(tx)
}

/// Neither logic ties the counters to the mint during an upgrade, so both
/// refuse any mint under the policy beside it.
test upgrade_rejects_a_mint_under_the_policy() {
  let grant = Grant { ..lovelace_grant(), slot: 2, generation: 1 }
  let tx = test_helpers.transaction(
    [granted_control_input()],
    [
      control_output(
        AccountState { ..upgraded_state(), next_slot: 3, outstanding: 3 },
        2_000_000,
      ),
      grant_output(grant, 2_000_000),
    ],
    grant_token(stake_script_hash, 2),
    [device_key],
    interval.everything,
  )
    |> with_proxy_redeemers()
    |> withdrawing([logic_hash, next_logic_hash])
  !run(tx) && !run_as(next_logic_hash, tx)
}

test upgrade_rejects_a_burn_under_the_policy() {
  let tx = test_helpers.transaction(
    [
      granted_control_input(),
      input(1, grant_output(lovelace_grant(), 2_000_000)),
    ],
    [
      control_output(
        AccountState { ..upgraded_state(), outstanding: 1 },
        2_000_000,
      ),
      change_of(assets.from_lovelace(2_000_000)),
    ],
    grant_burn(0),
    [device_key],
    interval.everything,
  )
    |> with_proxy_redeemers()
    |> withdrawing([logic_hash, next_logic_hash])
  !run(tx) && !run_as(next_logic_hash, tx)
}

/// The leaving logic reads nothing of the arriving state but its logic
/// field, so a state it could not decode passes it and is the arriving
/// logic's to judge.
test upgrade_leaves_the_arriving_state_to_the_new_logic() {
  let logic: Data = next_logic_hash
  let devices: Data = granted_state().devices
  let generation: Data = 1
  let unknown: Data = "later fields"
  let foreign: Data = builtin.constr_data(
    0,
    [logic, devices, generation, unknown],
  )
  let tx = test_helpers.transaction(
    [granted_control_input()],
    [
      output(
        account_address(),
        control_value(stake_script_hash, 2_000_000),
        InlineDatum(foreign),
      ),
    ],
    assets.zero,
    [device_key],
    interval.everything,
  )
    |> with_proxy_redeemers()
    |> withdrawing([logic_hash, next_logic_hash])
  run(tx)
}

/// The arriving logic reads the devices and the generation of the state
/// the account leaves positionally, so a state of another shape with the
/// stable prefix in place hands over cleanly.
test upgrade_reads_the_stable_prefix_of_the_leaving_state() {
  let logic: Data = third_logic_hash
  let devices: Data = granted_state().devices
  let generation: Data = 0
  let unknown: Data = "later fields"
  let foreign: Data = builtin.constr_data(
    0,
    [logic, devices, generation, unknown],
  )
  let tx = test_helpers.transaction(
    [
      input(
        0,
        output(
          account_address(),
          control_value(stake_script_hash, 2_000_000),
          InlineDatum(foreign),
        ),
      ),
    ],
    [control_output(AccountState { ..state(), grant_generation: 1 }, 2_000_000)],
    assets.zero,
    [device_key],
    interval.everything,
  )
    |> with_proxy_redeemers()
    |> withdrawing([third_logic_hash, logic_hash])
  run(tx)
}

/// A downgrade is the same transaction with the hashes swapped; the
/// mechanism allows it and the signer gates it.
test upgrade_accepts_a_downgrade_with_both_withdrawals() {
  let tx = test_helpers.transaction(
    [input(0, control_output(upgraded_state(), 2_000_000))],
    [
      control_output(
        AccountState {
          ..upgraded_state(),
          logic: logic_hash,
          grant_generation: 2,
        },
        2_000_000,
      ),
    ],
    assets.zero,
    [device_key],
    interval.everything,
  )
    |> with_proxy_redeemers()
    |> withdrawing([next_logic_hash, logic_hash])
  upgrades(tx)
}

/// The arriving state is written beside a referenced control UTxO of
/// another account under the new logic, which needs no authorisation, so
/// the new logic would be on its agent path instead of validating the
/// arrival. The agent path admits no control output naming the logic.
test upgrade_rejects_an_arrival_beside_a_referenced_control_under_the_new_logic() {
  let unvalidated = AccountState {
    ..upgraded_state(),
    devices: [stranger_key],
    grant_generation: 0,
    outstanding: 17,
  }
  let tx = upgrade_into(unvalidated)
    |> referencing(
        [
          input(
            100,
            other_control_output(
              AccountState { ..granted_state(), logic: next_logic_hash },
              2_000_000,
            ),
          ),
        ],
      )
  and {
    run(tx),
    !run_as(next_logic_hash, tx),
  }
}

/// The arriving state is written beside the owner's second account, spent
/// under the new logic, so the new logic would be on its owner path over
/// that account instead of validating the arrival. The owner path pins
/// every control output naming the logic to the spent account's address.
test upgrade_rejects_an_arrival_beside_a_spent_control_under_the_new_logic() {
  let unvalidated = AccountState {
    ..upgraded_state(),
    devices: [stranger_key],
    grant_generation: 0,
    outstanding: 17,
  }
  let second = AccountState { ..granted_state(), logic: next_logic_hash }
  let tx = test_helpers.transaction(
    [granted_control_input(), input(1, other_control_output(second, 2_000_000))],
    [
      control_output(unvalidated, 2_000_000),
      other_control_output(second, 2_000_000),
    ],
    assets.zero,
    [device_key],
    interval.everything,
  )
    |> with_proxy_redeemers()
    |> withdrawing([logic_hash, next_logic_hash])
  and {
    run(tx),
    !run_as(next_logic_hash, tx),
  }
}

/// Two accounts leave the same logic at once: the leaving logic finds two
/// control UTxOs naming it and refuses.
test upgrade_rejects_two_accounts_leaving_the_same_logic() {
  !run(two_account_upgrade_transaction())
}

/// Two accounts arrive at the same logic at once: the arriving logic finds
/// two control outputs naming it and aborts.
test upgrade_rejects_two_accounts_arriving_at_the_same_logic() fail {
  run_as(next_logic_hash, two_account_upgrade_transaction())
}

test upgrade_accepts_two_accounts_under_different_logics() {
  let other = AccountState { ..granted_state(), logic: next_logic_hash }
  let tx = test_helpers.transaction(
    [granted_control_input(), input(1, other_control_output(other, 2_000_000))],
    [
      control_output(granted_state(), 2_000_000),
      other_control_output(other, 2_000_000),
    ],
    assets.zero,
    [device_key],
    interval.everything,
  )
    |> with_proxy_redeemers()
    |> withdrawing([logic_hash, next_logic_hash])
  upgrades(tx)
}

test withdraw_rejects_the_control_spent_and_referenced() {
  !run(rewrite(state()) |> referencing([control_input()]))
}

test withdraw_rejects_two_accounts_under_the_same_logic_spent() {
  !run(
    logic_transaction(
      [control_input(), input(1, other_control_output(state(), 2_000_000))],
      [
        control_output(state(), 2_000_000),
        other_control_output(state(), 2_000_000),
      ],
      assets.zero,
      [device_key],
      interval.everything,
    ),
  )
}

test withdraw_rejects_two_accounts_under_the_same_logic_referenced() {
  !run(
    lovelace_spend(
      interval.before(expiry - 1),
      lovelace_spend_outputs(2_000_000),
      [stranger_key],
    )
      |> referencing(
          [
            control_reference(),
            input(101, other_control_output(granted_state(), 2_000_000)),
          ],
        ),
  )
}

/// The control UTxO spent and no other naming the logic: both handlers
/// take the owner path and accept the device rewrite.
test withdraw_dispatches_a_spent_control_like_the_shared_handler() {
  dispatches_like_the_shared_handler(rewrite(state()), True)
}

/// The control UTxO referenced and no other naming the logic: both
/// handlers take the agent path and accept the grant spend.
test withdraw_dispatches_a_referenced_control_like_the_shared_handler() {
  dispatches_like_the_shared_handler(
    lovelace_spend(
      interval.before(expiry - 1),
      lovelace_spend_outputs(2_000_000),
      [stranger_key],
    ),
    True,
  )
}

/// The control UTxO spent and referenced at once: both handlers refuse
/// before any path runs.
test withdraw_dispatches_the_control_spent_and_referenced_like_the_shared_handler() {
  dispatches_like_the_shared_handler(
    rewrite(state()) |> referencing([control_input()]),
    False,
  )
}

/// No control UTxO naming the logic among the inputs or the reference
/// inputs: both handlers take the arrival path and accept the creation.
test withdraw_dispatches_no_control_like_the_shared_handler() {
  dispatches_like_the_shared_handler(creation_with_state(state()), True)
}

/// The control UTxOs of two accounts naming the logic spent in one
/// transaction: both handlers refuse before any path runs.
test withdraw_dispatches_two_accounts_spent_like_the_shared_handler() {
  dispatches_like_the_shared_handler(
    logic_transaction(
      [control_input(), input(1, other_control_output(state(), 2_000_000))],
      [
        control_output(state(), 2_000_000),
        other_control_output(state(), 2_000_000),
      ],
      assets.zero,
      [device_key],
      interval.everything,
    ),
    False,
  )
}

/// The control UTxOs of two accounts naming the logic referenced in one
/// transaction: both handlers refuse before any path runs.
test withdraw_dispatches_two_accounts_referenced_like_the_shared_handler() {
  dispatches_like_the_shared_handler(
    lovelace_spend(
      interval.before(expiry - 1),
      lovelace_spend_outputs(2_000_000),
      [stranger_key],
    )
      |> referencing(
          [
            control_reference(),
            input(101, other_control_output(granted_state(), 2_000_000)),
          ],
        ),
    False,
  )
}

/// Redeemers of other scripts, of any shape, and spend redeemers of
/// inputs outside the account are left alone: only the proxy redeemers of
/// inputs at the account address are read.
test withdraw_ignores_redeemers_of_other_scripts() {
  let foreign: Data = 42
  let device: Data = Device
  let tx = lovelace_spend(
    interval.before(expiry - 1),
    lovelace_spend_outputs(2_000_000),
    [stranger_key],
  )
  let tx = Transaction {
    ..tx,
    inputs: list.concat(
      tx.inputs,
      [input(7, output(recipient_address(), assets.from_lovelace(1), NoDatum))],
    ),
    redeemers: list.concat(
      tx.redeemers,
      [
        Pair(transaction.Spend(test_helpers.output_reference(7)), foreign),
        Pair(transaction.Spend(test_helpers.output_reference(8)), device),
        Pair(transaction.Mint(stake_script_hash), foreign),
      ],
    ),
  }
  run(tx)
}

/// A referenced control UTxO with no input at its address and no mint
/// leaves the logic nothing to validate.
test withdraw_accepts_a_referenced_control_with_nothing_to_validate() {
  run(
    test_helpers.transaction(
      [],
      [payout(1)],
      assets.zero,
      [device_key],
      interval.everything,
    )
      |> referencing([control_reference()])
      |> withdrawing([logic_hash]),
  )
}

/// The logic run under a key credential: the withdraw handler reads its
/// credential as a script and aborts.
test withdraw_rejects_a_key_credential() fail {
  logic_v1.logic_v1.withdraw(
    script_hash,
    Run,
    VerificationKey(logic_hash),
    rewrite(state()),
  )
}

test publish_accepts_a_registration_of_the_credential() {
  logic_v1.logic_v1.publish(
    script_hash,
    Run,
    RegisterCredential { credential: Script(logic_hash), deposit: Never },
    rewrite(state()),
  )
}

test publish_rejects_a_deregistration() {
  !logic_v1.logic_v1.publish(
    script_hash,
    Run,
    UnregisterCredential { credential: Script(logic_hash), refund: Never },
    rewrite(state()),
  )
}

test publish_rejects_a_delegation() {
  !logic_v1.logic_v1.publish(
    script_hash,
    Run,
    DelegateCredential {
      credential: Script(logic_hash),
      delegate: DelegateBlockProduction { stake_pool: stranger_key },
    },
    rewrite(state()),
  )
}

test publish_rejects_a_registration_with_a_delegation() {
  !logic_v1.logic_v1.publish(
    script_hash,
    Run,
    RegisterAndDelegateCredential {
      credential: Script(logic_hash),
      delegate: DelegateVote { delegate_representative: AlwaysAbstain },
      deposit: 2_000_000,
    },
    rewrite(state()),
  )
}

/// The logic run under a voting purpose: the `else` handler aborts on every
/// purpose but withdraw and publish.
test else_fails_for_any_other_purpose() fail {
  let redeemer: Data = Run
  let context = ScriptContext {
    transaction: rewrite(state()),
    redeemer,
    info: Voting(StakePool(stranger_key)),
  }
  logic_v1.logic_v1.else(script_hash, context)
}
