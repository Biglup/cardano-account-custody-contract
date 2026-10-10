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
use cardano/address.{Address, Inline, Script, VerificationKey}
use cardano/assets
use cardano/certificate.{RegisterCredential, UnregisterCredential}
use cardano/transaction.{DatumHash, NoDatum, Output, Transaction}
use cardano_account_custody_contract/logic
use cardano_account_custody_contract/test_helpers.{
  account_address, control_output, control_value, creation, device_key, expiry,
  fund_output, grant_output, input, issued_state, logic_hash, lovelace_grant,
  next_logic_hash, output, recipient_address, referencing, script_hash,
  stake_script_hash, state, state_datum, state_nft, stranger_key,
  with_proxy_redeemers, withdrawing,
}
use cardano_account_custody_contract/types.{Grant, Scope}

// CONSTANTS *******************************************************************

/// The hash standing in for another script at the payment credential.
const other_script_hash =
  #"00000000000000000000000000000000000000000000000000000077"

// FUNCTIONS *******************************************************************

/// Whether the shared handler, run as the test logic over the test
/// proxy, accepts `tx`.
fn run(tx: Transaction) -> Bool {
  logic.validates_withdrawal(logic_hash, script_hash, tx)
}

/// A device spend of 4 ADA from a 10 ADA deposit, the state kept.
fn device_spend() -> Transaction {
  test_helpers.transaction(
    [
      input(0, control_output(state(), 2_000_000)),
      input(1, fund_output(assets.from_lovelace(10_000_000))),
    ],
    [
      control_output(state(), 2_000_000),
      output(recipient_address(), assets.from_lovelace(4_000_000), NoDatum),
      fund_output(assets.from_lovelace(6_000_000)),
    ],
    assets.zero,
    [device_key],
    interval.everything,
  )
    |> with_proxy_redeemers()
    |> withdrawing([logic_hash])
}

/// An agent spend of 2 ADA through the grant of slot 0 with the granted
/// control UTxO referenced, the grant recreated with its cap reduced.
fn grant_spend() -> Transaction {
  let spent = lovelace_grant()
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
    |> referencing([input(100, control_output(issued_state(1), 2_000_000))])
    |> with_proxy_redeemers()
    |> withdrawing([logic_hash])
}

// TESTS ***********************************************************************

test is_own_control_accepts_the_control_output_naming_the_logic() {
  logic.is_own_control(
    control_output(state(), 2_000_000),
    script_hash,
    logic_hash,
  )
}

test is_own_control_rejects_a_control_output_naming_another_logic() {
  !logic.is_own_control(
    control_output(state(), 2_000_000),
    script_hash,
    next_logic_hash,
  )
}

test is_own_control_rejects_a_grant_output() {
  !logic.is_own_control(
    grant_output(lovelace_grant(), 2_000_000),
    script_hash,
    logic_hash,
  )
}

test is_own_control_rejects_a_deposit() {
  !logic.is_own_control(
    fund_output(assets.from_lovelace(2_000_000)),
    script_hash,
    logic_hash,
  )
}

test is_own_control_rejects_a_state_given_by_hash() {
  !logic.is_own_control(
    Output {
      address: account_address(),
      value: control_value(stake_script_hash, 2_000_000),
      datum: DatumHash(
        #"0000000000000000000000000000000000000000000000000000000000000000",
      ),
      reference_script: None,
    },
    script_hash,
    logic_hash,
  )
}

test is_own_control_rejects_another_payment_credential() {
  !logic.is_own_control(
    output(
      Address {
        payment_credential: Script(other_script_hash),
        stake_credential: Some(Inline(Script(stake_script_hash))),
      },
      control_value(stake_script_hash, 2_000_000),
      state_datum(state()),
    ),
    script_hash,
    logic_hash,
  )
}

test is_own_control_rejects_a_key_stake_credential() {
  !logic.is_own_control(
    output(
      Address {
        payment_credential: Script(script_hash),
        stake_credential: Some(Inline(VerificationKey(device_key))),
      },
      control_value(stake_script_hash, 2_000_000),
      state_datum(state()),
    ),
    script_hash,
    logic_hash,
  )
}

test validates_withdrawal_takes_the_owner_path_on_a_spent_control() {
  run(device_spend())
}

test validates_withdrawal_takes_the_agent_path_on_a_referenced_control() {
  run(grant_spend())
}

test validates_withdrawal_takes_the_arrival_path_without_a_control() {
  run(
    creation(
      [control_output(state(), 2_000_000)],
      state_nft(stake_script_hash),
      [device_key],
    ),
  )
}

test validates_withdrawal_rejects_the_control_spent_and_referenced() {
  !run(
    device_spend()
      |> referencing([input(100, control_output(state(), 2_000_000))]),
  )
}

/// A logic that finds no control UTxO naming it takes the arrival path,
/// which aborts without a control output naming it.
test validates_withdrawal_aborts_as_a_logic_the_control_does_not_name() fail {
  logic.validates_withdrawal(next_logic_hash, script_hash, device_spend())
}

test publish_accepts_a_registration_of_a_script_credential() {
  logic.publish(
    RegisterCredential { credential: Script(logic_hash), deposit: Never },
  )
}

test publish_rejects_a_deregistration() {
  !logic.publish(
    UnregisterCredential { credential: Script(logic_hash), refund: Never },
  )
}
