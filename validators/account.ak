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

use aiken/collection/dict
use aiken/crypto.{ScriptHash}
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{OutputReference, Transaction}
use cardano_account_custody_contract/account as custody
use cardano_account_custody_contract/types.{
  AccountRedeemer, BurnGrants, CreateAccount, Fund, IssueGrants, MintRedeemer,
}

// VALIDATORS ******************************************************************

/// The proxy: the permanent validator of every account. Its script hash
/// is the payment credential of every account address and the policy id
/// of every account token. It pins the naming, quantity and placement
/// of account tokens, gates creation on the stake script and keeps the
/// control UTxO in place. Every other rule belongs to the logic named in
/// field 0 of the control datum, which the proxy requires to run through
/// a withdrawal on every path but `Fund`.
///
/// Mint, `CreateAccount`: the mint under the proxy policy is one entry in
/// quantity 1 whose 28 byte name is the stake script hash; the redeemers
/// hold a publish entry registering that credential; the single control
/// output holds only lovelace and the NFT and carries no reference
/// script; every account token in the outputs sits at its own address;
/// the control datum names a 28 byte logic hash the transaction
/// withdraws from. Any other mint returns `False`. Aborts when no single
/// control output of the account exists or its datum is not an inline
/// constructor whose first field is a byte string.
///
/// Mint, `IssueGrants` and `BurnGrants`: every entry is a 32 byte grant
/// token name of the account the first name denotes, in quantity 1 or
/// -1 respectively; that account's control UTxO is present exactly once
/// among the inputs and the reference inputs and the transaction
/// withdraws from the logic it names; for `IssueGrants`, every account
/// token in the outputs sits at its own address. Aborts on an empty mint
/// and when that control UTxO's inline datum is not a constructor whose
/// first field is a byte string.
///
/// Spend: aborts unless the spent UTxO has a script payment credential
/// and an inline script stake credential. `Fund`: the UTxO holds no
/// token under the proxy policy; without a datum some input holds a token of
/// the same account, with a datum the control UTxO is spent. `Device`,
/// `SpendWithGrant` and `SweepGrant` make the same checks: the control
/// UTxO is present exactly once among the inputs and the reference
/// inputs and the transaction withdraws from the logic it names, which
/// aborts on a control datum that is not a constructor whose first field
/// is a byte string; if the UTxO holds a token under the proxy policy, every
/// account token in the outputs sits at its own address; if it holds the
/// state NFT, exactly one output recreates the control UTxO at the same
/// address with only lovelace and the NFT, an inline datum and no
/// reference script. Every other violation returns `False`.
///
/// Every other purpose aborts.
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
            let logic = custody.logic_of(custody.inline_datum(control))
            and {
              custody.is_state_nft_name(stake_script_hash),
              custody.registers_stake_credential(
                self.redeemers,
                stake_script_hash,
              ),
              custody.holds_only_lovelace_and_state_nft(
                control.value,
                policy_id,
                stake_script_hash,
              ),
              control.reference_script == None,
              custody.tokens_sit_at_their_own_addresses(self.outputs, policy_id),
              custody.is_script_hash(logic),
              custody.withdraws_from(self.withdrawals, logic),
            }
          }
          _ -> False
        }
      IssueGrants -> and {
          mints_grants_of_one_account(self, policy_id, minted, 1),
          custody.tokens_sit_at_their_own_addresses(self.outputs, policy_id),
        }
      BurnGrants -> mints_grants_of_one_account(self, policy_id, minted, -1)
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
      _ -> and {
          runs_the_logic(self, script_hash, stake_script_hash),
          or {
            custody.holds_no_account_token(own.output.value, script_hash),
            custody.tokens_sit_at_their_own_addresses(self.outputs, script_hash),
          },
          or {
            !custody.holds_state_nft(
              own.output.value,
              script_hash,
              stake_script_hash,
            ),
            custody.keeps_control_output(
              self.outputs,
              script_hash,
              stake_script_hash,
            ),
          },
        }
    }
  }

  else(_context) {
    fail
  }
}

// FUNCTIONS *******************************************************************

/// Whether every minted entry is a grant token of one account, the one
/// the first name denotes, in `quantity`, with that account's control
/// UTxO present and its logic running. Aborts on an empty mint and on
/// every abort of `runs_the_logic`.
fn mints_grants_of_one_account(
  self: Transaction,
  policy_id: PolicyId,
  minted: Pairs<AssetName, Int>,
  quantity: Int,
) -> Bool {
  expect [Pair(first_name, _), ..] = minted
  let stake_script_hash = custody.account_of_name(first_name)
  and {
    custody.mints_grants_of(minted, stake_script_hash, quantity),
    runs_the_logic(self, policy_id, stake_script_hash),
  }
}

/// Whether the account's control UTxO is present exactly once among the
/// inputs and the reference inputs and the transaction withdraws from the
/// logic named in the first field of its datum. Returns `False` when no
/// control UTxO is present or several are. Aborts when the control
/// UTxO's inline datum is not a constructor whose first field is a byte
/// string.
fn runs_the_logic(
  self: Transaction,
  script_hash: ScriptHash,
  stake_script_hash: ScriptHash,
) -> Bool {
  when
    custody.find_present_control(
      self.inputs,
      self.reference_inputs,
      script_hash,
      stake_script_hash,
    )
  is {
    Some(control) ->
      custody.withdraws_from(
        self.withdrawals,
        custody.logic_of(custody.inline_datum(control)),
      )
    None -> False
  }
}
