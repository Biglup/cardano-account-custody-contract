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

use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{ScriptHash}
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction,
}
use cardano_account_custody_contract/account as custody
use cardano_account_custody_contract/grant.{
  carries_grant, carries_no_reference_script, deposits_are_plain,
  ends_before_expiry, grant_after_spend, is_authorised_by_grantee, is_current,
  is_dead, leaving_value, pays_only_recipients, referenced_control,
  spends_one_account_token, stays_within_scope,
}
use cardano_account_custody_contract/state
use cardano_account_custody_contract/types.{
  AccountRedeemer, AccountState, BurnGrants, CreateAccount, Device, Fund, Grant,
  IssueGrants, MintRedeemer, SpendWithGrant, SweepGrant,
}

// VALIDATORS ******************************************************************

/// The account's multi-purpose validator. Its script hash is the policy id
/// of every account token and the payment credential of every account
/// address; the stake part of an address is the account's own
/// `account_stake` script hash, which names the account's state NFT and
/// prefixes its grant token names. No redeemer burns a state NFT, so an
/// account is permanent and holds exactly one control UTxO from creation
/// on. Each grant lives in its own grant UTxO under its grant token. See
/// README, Design.
///
/// Mint, `CreateAccount`: mints exactly one state NFT named after a stake
/// credential; the account stake script runs on a certificate registering
/// that credential; the NFT lands in a single valid control output whose
/// state has zero counters; every account token in the outputs sits at its
/// own account address. `IssueGrants`: the account's control UTxO is spent
/// and a device signs; the minted names are the next slots in order, each
/// in quantity one, each in exactly one output at the account address
/// holding only lovelace and that token, with no reference script and a
/// well formed grant of that slot and the recreated control's generation.
/// `BurnGrants`: the control UTxO is spent and a device signs; every entry
/// burns one grant token of the account.
///
/// Spend, `Fund`: the UTxO holds no account token; with no datum some input
/// at the address holds an account token, with any datum the control UTxO
/// is spent. `Device`: the UTxO is the control UTxO and its inline datum is
/// an `AccountState`; a device signs; every account token in the inputs and
/// outputs sits at its own account address; a single valid control output
/// recreates the NFT with a non decreasing generation and counters that
/// follow the grant tokens minted and burned. `SpendWithGrant`: the UTxO
/// is a grant UTxO holding only lovelace and its token, the only account
/// token among the inputs; the control UTxO is referenced exactly once and
/// the grant is current against it; the grantee signs; the validity range
/// ends before the grant expires; the leaving value stays within the scope
/// caps; outputs away from the account go to allowed recipients; deposits
/// paid back are plain; placement holds; the single grant output sits at
/// the same address with the same value, carries the grant with its
/// remaining caps reduced by what left and no reference script; nothing is
/// minted under the policy. Placement already pins the grant output to the
/// account address, so the address rule on it is defence in depth.
/// `SweepGrant`: the UTxO is a grant UTxO, the control UTxO is spent and a
/// device signs, the grant is dead and its token is burned. See README,
/// Agent path.
validator account {
  mint(redeemer: MintRedeemer, policy_id: PolicyId, self: Transaction) {
    let minted = assets.tokens(self.mint, policy_id) |> dict.to_pairs
    when redeemer is {
      CreateAccount ->
        when minted is {
          [Pair(stake_script_hash, 1)] -> {
            expect Some(control) = custody.find_control_output(
              self.outputs,
              policy_id,
              stake_script_hash,
            )
            and {
              custody.is_state_nft_name(stake_script_hash),
              custody.registers_stake_credential(
                self.redeemers,
                stake_script_hash,
              ),
              custody.is_valid_control_output(
                control,
                policy_id,
                stake_script_hash,
              ),
              state.has_zero_counters(custody.state_datum(control)),
              custody.tokens_sit_at_their_own_addresses(self.outputs, policy_id),
            }
          }
          _ -> False
        }
      IssueGrants -> {
        expect [Pair(first_name, _), ..] = minted
        let stake_script_hash = custody.account_of_name(first_name)
        let old = spent_control_state(self.inputs, policy_id, stake_script_hash)
        expect Some(control) = custody.find_control_output(
          self.outputs,
          policy_id,
          stake_script_hash,
        )
        let new = custody.state_datum(control)
        and {
          custody.is_signed_by_a_device(old, self.extra_signatories),
          list.indexed_foldr(
            minted,
            True,
            fn(index, token, ok) {
              ok && issues_grant(
                token,
                old.next_slot + index,
                new.grant_generation,
                self.outputs,
                policy_id,
                stake_script_hash,
              )
            },
          ),
        }
      }
      BurnGrants -> {
        expect [Pair(first_name, _), ..] = minted
        let stake_script_hash = custody.account_of_name(first_name)
        let old = spent_control_state(self.inputs, policy_id, stake_script_hash)
        and {
          custody.is_signed_by_a_device(old, self.extra_signatories),
          list.all(
            minted,
            fn(token) {
              let Pair(name, quantity) = token
              and {
                quantity == -1,
                custody.is_grant_name(name),
                custody.account_of_name(name) == stake_script_hash,
              }
            },
          ),
        }
      }
    }
  }

  spend(
    datum: Option<Data>,
    redeemer: AccountRedeemer,
    output_reference: OutputReference,
    self: Transaction,
  ) {
    let own = custody.own_input(self.inputs, output_reference)
    let script_hash = custody.script_hash_of(own.output.address)
    let stake_script_hash = custody.stake_script_hash_of(own.output.address)
    when redeemer is {
      Fund -> and {
          custody.holds_no_account_token(own.output.value, script_hash),
          when datum is {
            None ->
              custody.has_account_token_input(
                self.inputs,
                script_hash,
                stake_script_hash,
              )
            Some(_) ->
              custody.has_control_input(
                self.inputs,
                script_hash,
                stake_script_hash,
              )
          },
        }
      Device -> {
        expect Some(data) = datum
        expect old: AccountState = data
        and {
          custody.holds_state_nft(
            own.output.value,
            script_hash,
            stake_script_hash,
          ),
          custody.is_signed_by_a_device(old, self.extra_signatories),
          custody.tokens_sit_at_their_own_addresses(
            list.map(self.inputs, fn(input) { input.output }),
            script_hash,
          ),
          custody.tokens_sit_at_their_own_addresses(self.outputs, script_hash),
          recreates_control_output(old, self, script_hash, stake_script_hash),
        }
      }
      SpendWithGrant -> {
        expect Some(data) = datum
        expect grant: Grant = data
        let address = own.output.address
        expect Some(control) = referenced_control(
          self.reference_inputs,
          script_hash,
          stake_script_hash,
        )
        let control_state = custody.state_datum(control)
        let leaving = leaving_value(self.inputs, self.outputs, address)
        expect Some(grant_output) = custody.find_grant_output(
          self.outputs,
          script_hash,
          stake_script_hash,
          grant.slot,
        )
        and {
          custody.holds_only_lovelace_and_grant_token(
            own.output.value,
            script_hash,
            stake_script_hash,
            grant.slot,
          ),
          spends_one_account_token(self.inputs, script_hash, stake_script_hash),
          is_current(grant, control_state),
          is_authorised_by_grantee(grant.grantee, self.extra_signatories),
          ends_before_expiry(self.validity_range, grant.scope.expires_at),
          stays_within_scope(grant.scope, leaving),
          pays_only_recipients(self.outputs, address, grant.scope.recipients),
          deposits_are_plain(
            self.outputs,
            address,
            script_hash,
            stake_script_hash,
          ),
          custody.tokens_sit_at_their_own_addresses(
            list.map(self.inputs, fn(input) { input.output }),
            script_hash,
          ),
          custody.tokens_sit_at_their_own_addresses(self.outputs, script_hash),
          grant_output.address == address,
          grant_output.value == own.output.value,
          carries_grant(grant_output, grant_after_spend(grant, leaving)),
          carries_no_reference_script(grant_output),
          custody.holds_no_account_token(self.mint, script_hash),
        }
      }
      SweepGrant -> {
        expect Some(data) = datum
        expect grant: Grant = data
        let control_state = spent_control_state(
          self.inputs,
          script_hash,
          stake_script_hash,
        )
        and {
          custody.holds_only_lovelace_and_grant_token(
            own.output.value,
            script_hash,
            stake_script_hash,
            grant.slot,
          ),
          custody.is_signed_by_a_device(control_state, self.extra_signatories),
          is_dead(grant, control_state, self.validity_range),
          assets.quantity_of(
            self.mint,
            script_hash,
            custody.grant_token_name(stake_script_hash, grant.slot),
          ) == -1,
        }
      }
    }
  }

  else(_context) {
    fail
  }
}

// FUNCTIONS *******************************************************************

/// The state of the account's control UTxO among the inputs; fails when
/// the control UTxO is not spent.
fn spent_control_state(
  inputs: List<Input>,
  script_hash: ScriptHash,
  stake_script_hash: ScriptHash,
) -> AccountState {
  expect Some(control) = custody.find_control_input(
    inputs,
    script_hash,
    stake_script_hash,
  )
  custody.state_datum(control.output)
}

/// Whether exactly one output at the account address holds the state NFT
/// and is a valid control output whose state follows from `old`: a non
/// decreasing generation, and counters moved by the grant tokens minted
/// and burned.
fn recreates_control_output(
  old: AccountState,
  self: Transaction,
  script_hash: ScriptHash,
  stake_script_hash: ScriptHash,
) -> Bool {
  expect Some(control) = custody.find_control_output(
    self.outputs,
    script_hash,
    stake_script_hash,
  )
  let new = custody.state_datum(control)
  let (minted, burned) = custody.grant_mint_delta(
    self.mint,
    script_hash,
    stake_script_hash,
  )
  and {
    custody.holds_only_lovelace_and_state_nft(
      control.value,
      script_hash,
      stake_script_hash,
    ),
    state.is_well_formed(new),
    new.grant_generation >= old.grant_generation,
    new.next_slot == old.next_slot + minted,
    new.outstanding == old.outstanding + minted - burned,
  }
}

/// Whether a minted entry is one grant token named after `slot`, landing in
/// exactly one output at the account address that holds only lovelace and
/// that token, carries no reference script, and carries a well formed grant
/// of that slot issued under `generation`. Fails when the token lands in no
/// output or in several, or under a datum that is not a grant.
fn issues_grant(
  token: Pair<AssetName, Int>,
  slot: Int,
  generation: Int,
  outputs: List<Output>,
  script_hash: ScriptHash,
  stake_script_hash: ScriptHash,
) -> Bool {
  let Pair(name, quantity) = token
  expect Some(grant_output) = custody.find_token_output(
    outputs,
    script_hash,
    name,
  )
  expect InlineDatum(data) = grant_output.datum
  expect grant: Grant = data
  and {
    quantity == 1,
    name == custody.grant_token_name(stake_script_hash, slot),
    grant_output.address == custody.account_address(
      script_hash,
      stake_script_hash,
    ),
    assets.has_nft_strict(grant_output.value, script_hash, name),
    carries_no_reference_script(grant_output),
    grant.slot == slot,
    grant.generation == generation,
    state.is_grant_well_formed(grant),
  }
}
