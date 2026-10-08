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
use aiken/crypto.{ScriptHash, VerificationKeyHash}
use aiken/primitive/bytearray
use cardano/address.{Address, Credential, Inline, Script}
use cardano/assets.{AssetName, Assets}
use cardano/certificate.{
  Certificate, RegisterAndDelegateCredential, RegisterCredential,
}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Publish, Redeemer, ScriptPurpose,
}
use cardano_account_custody_contract/state
use cardano_account_custody_contract/types.{AccountState}

// CONSTANTS *******************************************************************

/// The length of a state NFT name: the account's stake script hash.
pub const state_nft_name_length = 28

/// The length of the slot suffix a grant token name appends to the stake
/// script hash, as a big endian integer.
pub const slot_length = 4

// FUNCTIONS *******************************************************************

/// The input the spend handler is validating; fails when the output
/// reference is not among the inputs.
pub fn own_input(
  inputs: List<Input>,
  output_reference: OutputReference,
) -> Input {
  expect Some(input) = transaction.find_input(inputs, output_reference)
  input
}

/// The script hash an address pays to; fails on a key payment credential.
pub fn script_hash_of(address: Address) -> ScriptHash {
  expect Script(script_hash) = address.payment_credential
  script_hash
}

/// The account stake script hash that identifies the account owning an
/// address and names its state NFT. Fails unless the stake credential is an
/// inline script; outputs with any other stake part belong to no account.
pub fn stake_script_hash_of(address: Address) -> ScriptHash {
  expect Some(Inline(Script(stake_script_hash))) = address.stake_credential
  stake_script_hash
}

/// The account address: the account script as payment credential and the
/// account stake script as stake credential.
pub fn account_address(
  script_hash: ScriptHash,
  stake_script_hash: ScriptHash,
) -> Address {
  address.from_script(script_hash)
    |> address.with_delegation_script(stake_script_hash)
}

/// The name of the grant token of an account's slot: the stake script hash
/// followed by the slot as four big endian bytes. Fails for a slot outside
/// that range.
pub fn grant_token_name(stake_script_hash: ScriptHash, slot: Int) -> AssetName {
  bytearray.concat(
    stake_script_hash,
    bytearray.from_int_big_endian(slot, slot_length),
  )
}

/// The stake script hash a token name under the account policy belongs
/// to: the name itself for a state NFT, its prefix for a grant token.
pub fn account_of_name(name: AssetName) -> ScriptHash {
  bytearray.take(name, state_nft_name_length)
}

/// Whether a token name has the shape of a state NFT name.
pub fn is_state_nft_name(name: AssetName) -> Bool {
  bytearray.length(name) == state_nft_name_length
}

/// Whether a token name has the shape of a grant token name.
pub fn is_grant_name(name: AssetName) -> Bool {
  bytearray.length(name) == state_nft_name_length + slot_length
}

/// Whether a value holds exactly one state NFT of the account.
pub fn holds_state_nft(
  value: Assets,
  script_hash: ScriptHash,
  stake_script_hash: ScriptHash,
) -> Bool {
  assets.has_nft(value, script_hash, stake_script_hash)
}

/// Whether a value holds nothing but lovelace and the account's state NFT.
pub fn holds_only_lovelace_and_state_nft(
  value: Assets,
  script_hash: ScriptHash,
  stake_script_hash: ScriptHash,
) -> Bool {
  assets.has_nft_strict(value, script_hash, stake_script_hash)
}

/// Whether a value holds nothing but lovelace and the grant token of the
/// account's slot.
pub fn holds_only_lovelace_and_grant_token(
  value: Assets,
  script_hash: ScriptHash,
  stake_script_hash: ScriptHash,
  slot: Int,
) -> Bool {
  assets.has_nft_strict(
    value,
    script_hash,
    grant_token_name(stake_script_hash, slot),
  )
}

/// Whether a value holds no token of the account policy at all: a deposit's
/// value, or the mint of an agent spend.
pub fn holds_no_account_token(value: Assets, script_hash: ScriptHash) -> Bool {
  assets.tokens(value, script_hash) == dict.empty
}

/// Whether an output sits at the account address and holds the state NFT.
pub fn is_control_output(
  output: Output,
  script_hash: ScriptHash,
  stake_script_hash: ScriptHash,
) -> Bool {
  output.address == account_address(script_hash, stake_script_hash) && holds_state_nft(
    output.value,
    script_hash,
    stake_script_hash,
  )
}

/// The account's single control output; none or several yield `None`.
pub fn find_control_output(
  outputs: List<Output>,
  script_hash: ScriptHash,
  stake_script_hash: ScriptHash,
) -> Option<Output> {
  when
    list.filter(outputs, is_control_output(_, script_hash, stake_script_hash))
  is {
    [output] -> Some(output)
    _ -> None
  }
}

/// The single output holding one token of the account policy with the
/// given name, wherever it sits; none or several yield `None`.
pub fn find_token_output(
  outputs: List<Output>,
  script_hash: ScriptHash,
  name: AssetName,
) -> Option<Output> {
  when
    list.filter(
      outputs,
      fn(output) { assets.quantity_of(output.value, script_hash, name) == 1 },
    )
  is {
    [output] -> Some(output)
    _ -> None
  }
}

/// The single output holding the grant token of the account's slot,
/// wherever it sits; none or several yield `None`.
pub fn find_grant_output(
  outputs: List<Output>,
  script_hash: ScriptHash,
  stake_script_hash: ScriptHash,
  slot: Int,
) -> Option<Output> {
  find_token_output(
    outputs,
    script_hash,
    grant_token_name(stake_script_hash, slot),
  )
}

/// Whether an output sits at the account address and holds a token of the
/// account policy named under the account: its state NFT or one of its
/// grant tokens.
pub fn holds_account_token(
  output: Output,
  script_hash: ScriptHash,
  stake_script_hash: ScriptHash,
) -> Bool {
  output.address == account_address(script_hash, stake_script_hash) && (
    assets.tokens(output.value, script_hash)
      |> dict.to_pairs
      |> list.any(
          fn(token) {
            let Pair(name, _) = token
            account_of_name(name) == stake_script_hash
          },
        )
  )
}

/// Whether some input holds a token of the account: its control UTxO or
/// one of its grant UTxOs.
pub fn has_account_token_input(
  inputs: List<Input>,
  script_hash: ScriptHash,
  stake_script_hash: ScriptHash,
) -> Bool {
  list.any(
    inputs,
    fn(input) {
      holds_account_token(input.output, script_hash, stake_script_hash)
    },
  )
}

/// The number of inputs holding a token of the account: the control UTxO
/// and the grant UTxOs spent.
pub fn count_account_token_inputs(
  inputs: List<Input>,
  script_hash: ScriptHash,
  stake_script_hash: ScriptHash,
) -> Int {
  list.count(
    inputs,
    fn(input) {
      holds_account_token(input.output, script_hash, stake_script_hash)
    },
  )
}

/// Whether a transaction spends the account's control UTxO.
pub fn has_control_input(
  inputs: List<Input>,
  script_hash: ScriptHash,
  stake_script_hash: ScriptHash,
) -> Bool {
  list.any(
    inputs,
    fn(input) {
      is_control_output(input.output, script_hash, stake_script_hash)
    },
  )
}

/// Whether every token of the account policy among the outputs is held in
/// quantity one by an output at the account address its name denotes: a
/// state NFT at the address of its name, a grant token at the address of
/// its prefix. See README, State NFT placement.
pub fn tokens_sit_at_their_own_addresses(
  outputs: List<Output>,
  script_hash: ScriptHash,
) -> Bool {
  list.all(
    outputs,
    fn(output) {
      assets.tokens(output.value, script_hash)
        |> dict.to_pairs
        |> list.all(
            fn(token) {
              let Pair(name, quantity) = token
              quantity == 1 && output.address == account_address(
                script_hash,
                account_of_name(name),
              )
            },
          )
    },
  )
}

/// The number of grant tokens of the account minted and the number burned
/// in a transaction, read from the mint field. Fails on any other token of
/// the account policy, on another account's grant token and on any
/// quantity but one or minus one.
pub fn grant_mint_delta(
  mint: Assets,
  script_hash: ScriptHash,
  stake_script_hash: ScriptHash,
) -> (Int, Int) {
  assets.tokens(mint, script_hash)
    |> dict.to_pairs
    |> list.foldl(
        (0, 0),
        fn(token, delta) {
          let Pair(name, quantity) = token
          expect
            is_grant_name(name) && account_of_name(name) == stake_script_hash
          let (minted, burned) = delta
          if quantity == 1 {
            (minted + 1, burned)
          } else if quantity == -1 {
            (minted, burned + 1)
          } else {
            fail
          }
        },
      )
}

/// The `AccountState` an output carries as its inline datum; fails on any
/// other datum.
pub fn state_datum(output: Output) -> AccountState {
  expect InlineDatum(data) = output.datum
  expect state: AccountState = data
  state
}

/// Whether a control output holds only lovelace and the state NFT and
/// carries a well formed `AccountState` as its inline datum.
pub fn is_valid_control_output(
  output: Output,
  script_hash: ScriptHash,
  stake_script_hash: ScriptHash,
) -> Bool {
  holds_only_lovelace_and_state_nft(
    output.value,
    script_hash,
    stake_script_hash,
  ) && state.is_well_formed(state_datum(output))
}

/// The account's control UTxO among the given inputs or reference inputs.
pub fn find_control_input(
  inputs: List<Input>,
  script_hash: ScriptHash,
  stake_script_hash: ScriptHash,
) -> Option<Input> {
  list.find(
    inputs,
    fn(input) {
      is_control_output(input.output, script_hash, stake_script_hash)
    },
  )
}

/// Whether one of the state's devices is among the required signers.
pub fn is_signed_by_a_device(
  state: AccountState,
  extra_signatories: List<VerificationKeyHash>,
) -> Bool {
  list.any(state.devices, fn(device) { list.has(extra_signatories, device) })
}

/// Whether a device listed in the account's control UTxO, spent or
/// referenced, is among the required signers. Fails when no control UTxO
/// of the account is present.
pub fn is_authorised_by_a_device(
  inputs: List<Input>,
  reference_inputs: List<Input>,
  extra_signatories: List<VerificationKeyHash>,
  script_hash: ScriptHash,
  stake_script_hash: ScriptHash,
) -> Bool {
  expect Some(control) = find_control_input(
    list.concat(reference_inputs, inputs),
    script_hash,
    stake_script_hash,
  )
  is_signed_by_a_device(state_datum(control.output), extra_signatories)
}

/// Whether a certificate registers the credential, alone or with a
/// delegation.
pub fn registers_credential(
  certificate: Certificate,
  credential: Credential,
) -> Bool {
  when certificate is {
    RegisterCredential { credential: registered, .. } ->
      registered == credential
    RegisterAndDelegateCredential { credential: registered, .. } ->
      registered == credential
    _ -> False
  }
}

/// Whether a publish redeemer exists for a certificate registering the
/// account's stake credential, which proves the stake script ran on it.
/// Checked through the redeemers, not the certificate list; see README,
/// Registration gated creation.
pub fn registers_stake_credential(
  redeemers: Pairs<ScriptPurpose, Redeemer>,
  stake_script_hash: ScriptHash,
) -> Bool {
  list.any(
    redeemers,
    fn(entry) {
      when entry is {
        Pair(Publish { certificate, .. }, _) ->
          registers_credential(certificate, Script(stake_script_hash))
        _ -> False
      }
    },
  )
}
