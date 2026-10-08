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
use aiken/interval
use cardano/address.{Script, VerificationKey}
use cardano/assets.{Assets}
use cardano/certificate.{RegisterCredential, UnregisterCredential}
use cardano/governance.{StakePool}
use cardano/script_context.{ScriptContext, Voting}
use cardano/transaction.{Input, NoDatum, Output, Transaction}
use cardano_account_custody_contract/account as custody
use cardano_account_custody_contract/test_helpers.{
  control_output, device_key, fund_output, grant_output, input, logic_hash,
  next_logic_hash, output, publishing, recipient_address, referencing,
  registration, script_hash, stake_script_hash, state_nft, stranger_key,
  with_proxy_redeemers, withdrawing,
}
use cardano_account_custody_contract/types.{
  AccountState, Asset, Grant, Run, Scope,
}
use logic_v1
use logic_v2

// CONSTANTS *******************************************************************

const expiry = 1_800_000_000_000

/// One grant more than the batch the second version admits.
const over_the_batch = logic_v2.max_grant_batch + 1

// FUNCTIONS *******************************************************************

/// The fresh state of an account under `logic`: one device and zero
/// counters.
fn state_under(logic: ByteArray) -> AccountState {
  AccountState {
    logic,
    devices: [device_key],
    grant_generation: 0,
    next_slot: 0,
    revoked: [],
    outstanding: 0,
  }
}

/// The fresh state of the account under test, which runs the second
/// version as `next_logic_hash`.
fn state() -> AccountState {
  state_under(next_logic_hash)
}

/// The state of an account that issued one grant.
fn granted(fresh: AccountState) -> AccountState {
  AccountState { ..fresh, next_slot: 1, outstanding: 1 }
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

/// The grant of `slot` to the stranger under the lovelace scope, issued
/// under `generation`.
fn grant(slot: Int, generation: Int) -> Grant {
  Grant { slot, grantee: stranger_key, generation, scope: lovelace_scope() }
}

/// The slots from zero up to `count`.
fn slots(count: Int) -> List<Int> {
  list.range(0, count - 1)
}

/// The grant tokens of the first `count` slots of the account under test,
/// each in `quantity`.
fn grant_tokens(count: Int, quantity: Int) -> Assets {
  list.foldl(
    slots(count),
    assets.zero,
    fn(slot, minted) {
      assets.merge(
        minted,
        assets.from_asset(
          script_hash,
          custody.grant_token_name(stake_script_hash, slot),
          quantity,
        ),
      )
    },
  )
}

/// Whether the second version, run as `next_logic_hash`, accepts `tx`.
fn run_v2(tx: Transaction) -> Bool {
  logic_v2.logic_v2.withdraw(script_hash, Run, Script(next_logic_hash), tx)
}

/// Whether the first version, run as `logic_hash`, accepts `tx`.
fn run_v1(tx: Transaction) -> Bool {
  logic_v1.logic_v1.withdraw(script_hash, Run, Script(logic_hash), tx)
}

/// An owner transaction under `logic`: the control UTxO of `current`
/// spent at index 0, the given inputs beside it, outputs and mint, signed
/// by the device, with the proxy redeemers attached and `logic`
/// withdrawing.
fn owner_transaction(
  logic: ByteArray,
  current: AccountState,
  inputs: List<Input>,
  outputs: List<Output>,
  minted: Assets,
) -> Transaction {
  test_helpers.transaction(
    [input(0, control_output(current, 2_000_000)), ..inputs],
    outputs,
    minted,
    [device_key],
    interval.everything,
  )
    |> with_proxy_redeemers()
    |> withdrawing([logic])
}

/// A device spend of 4 ADA from a 10 ADA deposit under `logic`, the state
/// kept and the rest returned to the account.
fn device_spend_under(logic: ByteArray) -> Transaction {
  owner_transaction(
    logic,
    state_under(logic),
    [input(1, fund_output(assets.from_lovelace(10_000_000)))],
    [
      control_output(state_under(logic), 2_000_000),
      output(recipient_address(), assets.from_lovelace(4_000_000), NoDatum),
      fund_output(assets.from_lovelace(6_000_000)),
    ],
    assets.zero,
  )
}

/// An issuance of `count` grants under `logic` over the fresh state: one
/// grant output per slot and the control recreated with its counters
/// moved by the count.
fn issuance_under(logic: ByteArray, count: Int) -> Transaction {
  let fresh = state_under(logic)
  owner_transaction(
    logic,
    fresh,
    [],
    [
      control_output(
        AccountState { ..fresh, next_slot: count, outstanding: count },
        2_000_000,
      ),
      ..list.map(
        slots(count),
        fn(slot) { grant_output(grant(slot, 0), 2_000_000) },
      )
    ],
    grant_tokens(count, 1),
  )
}

/// A sweep of `count` grants under `logic`, dead since the account's
/// generation moved past the one they were issued under: every grant UTxO
/// spent beside the control UTxO, its token burned and its lovelace freed
/// to the account.
fn sweep_under(logic: ByteArray, count: Int) -> Transaction {
  let bumped = AccountState {
    ..state_under(logic),
    grant_generation: 1,
    next_slot: count,
    outstanding: count,
  }
  owner_transaction(
    logic,
    bumped,
    list.map(
      slots(count),
      fn(slot) { input(slot + 1, grant_output(grant(slot, 0), 2_000_000)) },
    ),
    [
      control_output(AccountState { ..bumped, outstanding: 0 }, 2_000_000),
      fund_output(assets.from_lovelace(2_000_000 * count)),
    ],
    grant_tokens(count, -1),
  )
}

/// An agent spend of 2 ADA through the grant of slot 0, issued under
/// `grant_generation`, with `control` referenced: the grant UTxO and a 10
/// ADA deposit spent, the grant recreated with its cap reduced and the rest
/// returned, signed by the grantee and valid before the expiry.
fn grant_spend_under(
  control: AccountState,
  grant_generation: Int,
) -> Transaction {
  let spent = grant(0, grant_generation)
  let after = Grant { ..spent, scope: Scope { ..spent.scope, cap: 3_000_000 } }
  test_helpers.transaction(
    [
      input(0, grant_output(spent, 2_000_000)),
      input(1, fund_output(assets.from_lovelace(10_000_000))),
    ],
    [
      grant_output(after, 2_000_000),
      output(recipient_address(), assets.from_lovelace(2_000_000), NoDatum),
      fund_output(assets.from_lovelace(8_000_000)),
    ],
    assets.zero,
    [stranger_key],
    interval.before(expiry - 1),
  )
    |> referencing([input(100, control_output(control, 2_000_000))])
    |> with_proxy_redeemers()
    |> withdrawing([control.logic])
}

/// The creation of the account under `logic`: the state NFT minted into
/// the control output over the fresh state, the registration published
/// through the stake script and `logic` withdrawing.
fn creation_under(logic: ByteArray) -> Transaction {
  test_helpers.transaction(
    [],
    [control_output(state_under(logic), 2_000_000)],
    state_nft(stake_script_hash),
    [device_key],
    interval.everything,
  )
    |> publishing(registration(stake_script_hash))
    |> with_proxy_redeemers()
    |> withdrawing([logic])
}

/// The move of an account holding one grant from `from` to `to`: a
/// rewrite of the control UTxO with `to` in its first field and the
/// generation bumped, both logics withdrawing, signed by `signer`.
fn move(from: ByteArray, to: ByteArray, signer: ByteArray) -> Transaction {
  let current = granted(state_under(from))
  test_helpers.transaction(
    [input(0, control_output(current, 2_000_000))],
    [
      control_output(
        AccountState { ..current, logic: to, grant_generation: 1 },
        2_000_000,
      ),
    ],
    assets.zero,
    [signer],
    interval.everything,
  )
    |> with_proxy_redeemers()
    |> withdrawing([from, to])
}

// TESTS ***********************************************************************

/// The bound the library applies to every batch it builds, so a change to
/// one without the other fails here before it fails on a chain.
test max_grant_batch_is_eight() {
  logic_v2.max_grant_batch == 8
}

test create_account_validates_the_initial_state() {
  run_v2(creation_under(next_logic_hash))
}

test device_spends_funds_and_keeps_the_state() {
  run_v2(device_spend_under(next_logic_hash))
}

test device_issues_a_batch_of_grants() {
  run_v2(issuance_under(next_logic_hash, logic_v2.max_grant_batch))
}

test device_rejects_an_issuance_over_the_batch() {
  !run_v2(issuance_under(next_logic_hash, over_the_batch))
}

/// The first version has no batch bound: the issuance the second refuses
/// is accepted under it, its size left to the execution budget.
test logic_v1_issues_over_the_batch() {
  run_v1(issuance_under(logic_hash, over_the_batch))
}

test device_sweeps_a_batch_of_dead_grants() {
  run_v2(sweep_under(next_logic_hash, logic_v2.max_grant_batch))
}

test device_rejects_a_sweep_over_the_batch() {
  !run_v2(sweep_under(next_logic_hash, over_the_batch))
}

test logic_v1_sweeps_over_the_batch() {
  run_v1(sweep_under(logic_hash, over_the_batch))
}

test spend_with_grant_accepts_a_current_grant() {
  run_v2(grant_spend_under(granted(state()), 0))
}

test spend_with_grant_rejects_a_grant_issued_before_an_upgrade() {
  !run_v2(
    grant_spend_under(
      AccountState { ..granted(state()), grant_generation: 1 },
      0,
    ),
  )
}

test upgrade_from_the_first_version_is_accepted_by_both_logics() {
  let tx = move(logic_hash, next_logic_hash, device_key)
  run_v1(tx) && run_v2(tx)
}

/// The leaving logic is the one that reads the signature: without a
/// device's, the first version refuses the device spend while the second
/// validates the arrival alone.
test upgrade_from_the_first_version_rejects_a_grantee() {
  let tx = move(logic_hash, next_logic_hash, stranger_key)
  !run_v1(tx) && run_v2(tx)
}

test downgrade_to_the_first_version_is_accepted_by_both_logics() {
  let tx = move(next_logic_hash, logic_hash, device_key)
  run_v2(tx) && run_v1(tx)
}

/// The move back a grantee assembles without a device signature: the
/// second version, which the account would leave, refuses the device
/// spend, while the first, which it would arrive at, reads no signature
/// and accepts.
test downgrade_to_the_first_version_rejects_a_grantee() {
  let tx = move(next_logic_hash, logic_hash, stranger_key)
  !run_v2(tx) && run_v1(tx)
}

test withdraw_rejects_a_key_credential() fail {
  logic_v2.logic_v2.withdraw(
    script_hash,
    Run,
    VerificationKey(next_logic_hash),
    device_spend_under(next_logic_hash),
  )
}

test publish_accepts_a_registration_of_the_credential() {
  logic_v2.logic_v2.publish(
    script_hash,
    Run,
    RegisterCredential { credential: Script(next_logic_hash), deposit: Never },
    creation_under(next_logic_hash),
  )
}

test publish_rejects_a_deregistration() {
  !logic_v2.logic_v2.publish(
    script_hash,
    Run,
    UnregisterCredential { credential: Script(next_logic_hash), refund: Never },
    creation_under(next_logic_hash),
  )
}

test else_fails_for_any_other_purpose() fail {
  let redeemer: Data = Run
  let context = ScriptContext {
    transaction: device_spend_under(next_logic_hash),
    redeemer,
    info: Voting(StakePool(stranger_key)),
  }
  logic_v2.logic_v2.else(script_hash, context)
}
