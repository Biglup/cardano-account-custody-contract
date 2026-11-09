//// Finds the recipient entries of a grant that name this policy script.
//// A grant datum is read by position: the logic keeps `scope` at field 3
//// and `recipients` at field 6 of the scope.

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
use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{ScriptHash}
use aiken/primitive/bytearray
use cardano/address.{Address, Inline, Script}
use cardano/assets
use cardano/transaction.{InlineDatum, Input, Output}

// TYPES ***********************************************************************

/// The policy of a recipient entry, as the contract's `GrantPolicy`.
pub type GrantPolicy {
  /// The script hash, 28 bytes.
  script: ScriptHash,
  /// The parameters this policy script reads.
  settings: Data,
}

/// A recipient entry of a grant, as the contract's `Recipient`.
pub type Recipient {
  /// The address, compared whole.
  address: Address,
  /// The policy of the entry.
  policy: Option<GrantPolicy>,
}

// CONSTANTS *******************************************************************

/// The bytes of a grant token name: the 28 byte account prefix and the
/// 4 byte slot.
const grant_token_name_length = 32

/// The bytes of the account prefix of a grant token name.
const account_prefix_length = 28

// FUNCTIONS *******************************************************************

/// Whether `output` is a grant UTxO of an account under `proxy_hash`: a
/// single token under the proxy policy whose name has the shape of a
/// grant token, at the address that name denotes, under an inline
/// datum. Never aborts.
fn is_grant_output(output: Output, proxy_hash: ScriptHash) -> Bool {
  when dict.to_pairs(assets.tokens(output.value, proxy_hash)) is {
    [Pair(name, 1)] -> and {
        bytearray.length(name) == grant_token_name_length,
        output.address.payment_credential == Script(proxy_hash),
        output.address.stake_credential == Some(
          Inline(Script(bytearray.take(name, account_prefix_length))),
        ),
        when output.datum is {
          InlineDatum(_) -> True
          _ -> False
        },
      }
    _ -> False
  }
}

/// The one grant UTxO among `inputs`, the input whose datum this policy
/// reads and whose address the account proceeds must return to. Aborts
/// unless exactly one input is a grant UTxO.
pub fn grant_input(proxy_hash: ScriptHash, inputs: List<Input>) -> Output {
  expect [grant] = list.filter(
    inputs,
    fn(input) { is_grant_output(input.output, proxy_hash) },
  )
  grant.output
}

/// The recipient entries of `grant` naming `own_hash`, as pairs of address
/// and settings. Aborts when its datum is not shaped like a grant or when
/// no entry names `own_hash`.
pub fn own_entries(
  grant: Output,
  own_hash: ScriptHash,
) -> List<Pair<Address, Data>> {
  expect InlineDatum(data) = grant.datum
  expect Some(scope) = list.at(builtin.un_constr_data(data).2nd, 3)
  expect Some(field) = list.at(builtin.un_constr_data(scope).2nd, 6)
  expect recipients: List<Recipient> = field
  let entries = list.filter_map(
    recipients,
    fn(recipient) {
      when recipient.policy is {
        Some(policy) ->
          if policy.script == own_hash {
            Some(Pair(recipient.address, policy.settings))
          } else {
            None
          }
        None -> None
      }
    },
  )
  expect [_, ..] = entries
  entries
}
