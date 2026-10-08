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
use aiken/interval
use cardano/assets.{Assets}
use cardano/transaction.{InlineDatum, Output, Transaction}
use cardano_account_custody_contract/account
use cardano_account_custody_contract/rules.{
  burn_grants_rule, issues_grant, recreates_control_output,
}
use cardano_account_custody_contract/test_helpers.{
  account_address, control_output, control_value, device_key, grant_datum,
  grant_output, grant_token, grant_value, input, logic_hash, next_logic_hash,
  other_account_address, output, recipient_address, script_hash,
  stake_script_hash, stranger_key, withdrawing,
}
use cardano_account_custody_contract/types.{AccountState, Asset, Grant, Scope}

// FUNCTIONS *******************************************************************

/// The state of the account under test: the test logic, one device and
/// two issued grants.
fn state() -> AccountState {
  AccountState {
    logic: logic_hash,
    devices: [device_key],
    grant_generation: 0,
    next_slot: 2,
    revoked: [],
    outstanding: 2,
  }
}

/// A grant of slot 2 to the stranger over lovelace.
fn grant() -> Grant {
  Grant {
    slot: 2,
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

/// A device transaction spending the control UTxO of `state` into the
/// given outputs with the given mint, the test logic withdrawing.
fn transaction(outputs: List<Output>, minted: Assets) -> Transaction {
  test_helpers.transaction(
    [input(0, control_output(state(), 2_000_000))],
    outputs,
    minted,
    [device_key],
    interval.everything,
  )
    |> withdrawing([logic_hash])
}

/// Whether the control UTxO of `state` is recreated by `tx` under the
/// test logic.
fn recreates(tx: Transaction) -> Bool {
  recreates_control_output(
    state(),
    tx,
    script_hash,
    stake_script_hash,
    logic_hash,
  )
}

/// The state once slot 2 has been issued.
fn issued() -> AccountState {
  AccountState { ..state(), next_slot: 3, outstanding: 3 }
}

/// The minted entry of the grant token of slot 2.
fn minted_entry() -> Pair<ByteArray, Int> {
  Pair(account.grant_token_name(stake_script_hash, 2), 1)
}

/// Whether `minted_entry` issues the grant of slot 2 under generation 0
/// into the given outputs.
fn issues(outputs: List<Output>) -> Bool {
  issues_grant(minted_entry(), 2, 0, outputs, script_hash, stake_script_hash)
}

// TESTS ***********************************************************************

test recreates_control_output_accepts_the_same_state() {
  recreates(transaction([control_output(state(), 2_000_000)], assets.zero))
}

test recreates_control_output_accepts_a_bumped_generation() {
  recreates(
    transaction(
      [
        control_output(
          AccountState { ..state(), grant_generation: 1 },
          2_000_000,
        ),
      ],
      assets.zero,
    ),
  )
}

test recreates_control_output_follows_a_mint() {
  recreates(
    transaction(
      [control_output(issued(), 2_000_000), grant_output(grant(), 2_000_000)],
      grant_token(stake_script_hash, 2),
    ),
  )
}

test recreates_control_output_follows_a_burn() {
  recreates(
    transaction(
      [control_output(AccountState { ..state(), outstanding: 1 }, 2_000_000)],
      assets.from_asset(
        script_hash,
        account.grant_token_name(stake_script_hash, 0),
        -1,
      ),
    ),
  )
}

test recreates_control_output_rejects_a_lowered_generation() {
  let current = AccountState { ..state(), grant_generation: 2 }
  !recreates_control_output(
    current,
    transaction(
      [
        control_output(
          AccountState { ..current, grant_generation: 1 },
          2_000_000,
        ),
      ],
      assets.zero,
    ),
    script_hash,
    stake_script_hash,
    logic_hash,
  )
}

test recreates_control_output_rejects_counters_moved_without_a_mint() {
  !recreates(transaction([control_output(issued(), 2_000_000)], assets.zero))
}

test recreates_control_output_rejects_an_ill_formed_state() {
  !recreates(
    transaction(
      [control_output(AccountState { ..state(), devices: [] }, 2_000_000)],
      assets.zero,
    ),
  )
}

test recreates_control_output_rejects_extra_tokens_on_the_control() {
  let parked = output(
    account_address(),
    assets.merge(
      control_value(stake_script_hash, 2_000_000),
      assets.from_asset(#"ab", "dust", 1),
    ),
    test_helpers.state_datum(state()),
  )
  !recreates(transaction([parked], assets.zero))
}

test recreates_control_output_fails_without_a_control_output() fail {
  recreates(transaction([], assets.zero))
}

test recreates_control_output_fails_for_a_datum_without_a_logic_field() fail {
  let data: Data = 42
  recreates(
    transaction(
      [
        output(
          account_address(),
          control_value(stake_script_hash, 2_000_000),
          InlineDatum(data),
        ),
      ],
      assets.zero,
    ),
  )
}

test recreates_control_output_accepts_an_upgrade_with_the_new_logic_withdrawing() {
  recreates(
    transaction(
      [
        control_output(
          AccountState { ..state(), logic: next_logic_hash },
          2_000_000,
        ),
      ],
      assets.zero,
    )
      |> withdrawing([next_logic_hash]),
  )
}

/// The leaving logic reads nothing of the arriving state but its logic
/// field, so a state of another shape passes it.
test recreates_control_output_accepts_an_upgrade_into_a_state_of_another_shape() {
  let logic: Data = next_logic_hash
  let foreign: Data = builtin.constr_data(0, [logic])
  recreates(
    transaction(
      [
        output(
          account_address(),
          control_value(stake_script_hash, 2_000_000),
          InlineDatum(foreign),
        ),
      ],
      assets.zero,
    )
      |> withdrawing([next_logic_hash]),
  )
}

test recreates_control_output_rejects_an_upgrade_without_the_new_logic_withdrawing() {
  !recreates(
    transaction(
      [
        control_output(
          AccountState { ..state(), logic: next_logic_hash },
          2_000_000,
        ),
      ],
      assets.zero,
    ),
  )
}

test recreates_control_output_rejects_a_mint_during_an_upgrade() {
  !recreates(
    transaction(
      [
        control_output(
          AccountState { ..issued(), logic: next_logic_hash },
          2_000_000,
        ),
        grant_output(grant(), 2_000_000),
      ],
      grant_token(stake_script_hash, 2),
    )
      |> withdrawing([next_logic_hash]),
  )
}

test recreates_control_output_rejects_an_upgrade_output_at_another_address() fail {
  recreates(
    transaction(
      [
        output(
          other_account_address(),
          control_value(stake_script_hash, 2_000_000),
          test_helpers.state_datum(
            AccountState { ..state(), logic: next_logic_hash },
          ),
        ),
      ],
      assets.zero,
    )
      |> withdrawing([next_logic_hash]),
  )
}

test issues_grant_accepts_a_grant_output_of_the_slot() {
  issues([grant_output(grant(), 2_000_000)])
}

test issues_grant_rejects_a_quantity_of_two() {
  !issues_grant(
    Pair(account.grant_token_name(stake_script_hash, 2), 2),
    2,
    0,
    [grant_output(grant(), 2_000_000)],
    script_hash,
    stake_script_hash,
  )
}

test issues_grant_rejects_a_name_of_another_slot() {
  let mislabelled = output(
    account_address(),
    grant_value(stake_script_hash, 3, 2_000_000),
    grant_datum(grant()),
  )
  !issues_grant(
    Pair(account.grant_token_name(stake_script_hash, 3), 1),
    2,
    0,
    [mislabelled],
    script_hash,
    stake_script_hash,
  )
}

test issues_grant_rejects_a_grant_of_another_slot() {
  let mislabelled = output(
    account_address(),
    grant_value(stake_script_hash, 2, 2_000_000),
    grant_datum(Grant { ..grant(), slot: 3 }),
  )
  !issues([mislabelled])
}

test issues_grant_rejects_a_grant_of_another_generation() {
  !issues([grant_output(Grant { ..grant(), generation: 1 }, 2_000_000)])
}

test issues_grant_rejects_an_ill_formed_scope() {
  !issues(
    [
      grant_output(
        Grant { ..grant(), scope: Scope { ..grant().scope, expires_at: 0 } },
        2_000_000,
      ),
    ],
  )
}

test issues_grant_rejects_an_output_at_another_address() {
  !issues(
    [
      output(
        other_account_address(),
        grant_value(stake_script_hash, 2, 2_000_000),
        grant_datum(grant()),
      ),
    ],
  )
}

test issues_grant_rejects_extra_tokens_on_the_output() {
  !issues(
    [
      output(
        account_address(),
        assets.merge(
          grant_value(stake_script_hash, 2, 2_000_000),
          assets.from_asset(#"ab", "dust", 1),
        ),
        grant_datum(grant()),
      ),
    ],
  )
}

test issues_grant_rejects_a_reference_script_on_the_output() {
  !issues(
    [
      Output {
        ..grant_output(grant(), 2_000_000),
        reference_script: Some(script_hash),
      },
    ],
  )
}

test issues_grant_fails_without_an_output_holding_the_token() fail {
  issues(
    [output(recipient_address(), assets.from_lovelace(1), transaction.NoDatum)],
  )
}

test issues_grant_fails_for_an_output_without_a_grant_datum() fail {
  issues(
    [
      output(
        account_address(),
        grant_value(stake_script_hash, 2, 2_000_000),
        transaction.NoDatum,
      ),
    ],
  )
}

test burn_grants_rule_accepts_burns_of_the_accounts_grant_tokens() {
  burn_grants_rule(
    [
      Pair(account.grant_token_name(stake_script_hash, 0), -1),
      Pair(account.grant_token_name(stake_script_hash, 1), -1),
    ],
    state(),
    stake_script_hash,
    [device_key],
  )
}

test burn_grants_rule_rejects_a_missing_device_signature() {
  !burn_grants_rule(
    [Pair(account.grant_token_name(stake_script_hash, 0), -1)],
    state(),
    stake_script_hash,
    [stranger_key],
  )
}

test burn_grants_rule_rejects_a_mint_among_the_burns() {
  !burn_grants_rule(
    [Pair(account.grant_token_name(stake_script_hash, 0), 1)],
    state(),
    stake_script_hash,
    [device_key],
  )
}

test burn_grants_rule_rejects_the_state_nft() {
  !burn_grants_rule(
    [Pair(stake_script_hash, -1)],
    state(),
    stake_script_hash,
    [device_key],
  )
}

test burn_grants_rule_rejects_another_accounts_grant_token() {
  !burn_grants_rule(
    [
      Pair(
        account.grant_token_name(test_helpers.other_stake_script_hash, 0),
        -1,
      ),
    ],
    state(),
    stake_script_hash,
    [device_key],
  )
}
