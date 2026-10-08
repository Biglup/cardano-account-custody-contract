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

/// The account proxy, the permanent part of every account. Its script hash
/// is the policy id of every account token and the payment credential of
/// every account address; the stake part of an address is the account's
/// own `account_stake` script hash, which names the account's state NFT
/// and prefixes its grant token names. No redeemer burns a state NFT, so
/// an account is permanent and holds exactly one control UTxO from
/// creation on. The proxy owns the naming, the quantity and the placement
/// of every account token, permanent on every path, and no rule about
/// the account's state beyond the first field of the control datum, the
/// hash of the logic script that governs the account: every spend except
/// a plain `Fund` and every
/// mint except `CreateAccount` requires exactly one control UTxO of the
/// account, spent or referenced, and a withdrawal from the logic it
/// names, which makes the ledger run that logic once over the whole
/// transaction. The logic reads the proxy redeemers from the script
/// context and applies the rules of its version. The withdrawal's amount
/// is not read: a non zero amount is accepted and harmless, since the
/// logic runs either way and the reward account is the logic's own. Any
/// registered script credential may be named as a logic; the proxy admits
/// every 28 byte hash and the signer's list of known logic hashes is the
/// gate against an unknown one. See README, Design.
///
/// Mint, `CreateAccount`: mints exactly one state NFT named after a stake
/// credential; the account stake script runs on a certificate registering
/// that credential; the NFT lands in a single control output at its own
/// account address holding only lovelace and the NFT, with no reference
/// script; every account token in the outputs sits at its own account
/// address; the control datum is inline and names a script hash in its
/// first field, and the transaction
/// withdraws from that hash, so the initial logic validates the state.
/// `IssueGrants` and `BurnGrants`: every minted entry is a grant token
/// name prefixed by one account's stake script hash, in quantity one
/// under `IssueGrants` and minus one under `BurnGrants`; the control UTxO
/// of that account is present and its logic runs; under `IssueGrants`
/// every account token in the outputs sits at its own account address.
/// A state NFT name is 28 bytes and never a grant name, so only
/// `CreateAccount` ever mints one, and no mint touches another account's
/// tokens whatever the logic allows. Under logic v1 two accounts under
/// different logics cannot share a transaction when either mints, since
/// each logic validates the mint as its own account's.
///
/// Spend, `Fund`: the UTxO holds no account token; with no datum some input
/// at the address holds an account token, with any datum the control UTxO
/// is spent. `Device`, `SpendWithGrant` and `SweepGrant`: the control UTxO
/// of the UTxO's own account is present and its logic runs; when the UTxO
/// holds any account token, every account token in the outputs sits in
/// quantity one at the address its name denotes, so a grant token of one
/// account never lands among another account's UTxOs, where no path
/// spends it; when the UTxO holds the state NFT, exactly one output holds
/// that NFT, at the same address, under an inline datum, with nothing but
/// lovelace beside it and no reference script. Both hold whatever the
/// logic says, so no logic version can relocate, duplicate or encumber
/// the control UTxO or misplace a grant token. These arms run once per
/// input, so they read nothing of the transaction but the inputs, the
/// reference inputs, the outputs and the withdrawals; every other check
/// belongs to the logic, which runs once.
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
/// UTxO present and its logic running. Fails on an empty mint.
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
/// logic named in the first field of its datum.
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
