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
use aiken/collection/pairs
use aiken/crypto.{ScriptHash, VerificationKeyHash}
use aiken/primitive/bytearray
use cardano/address.{Address, Credential, Inline, Script}
use cardano/assets.{AssetName, Assets, Lovelace, PolicyId}
use cardano/certificate.{
  Certificate, RegisterAndDelegateCredential, RegisterCredential,
}
use cardano/transaction.{
  InlineDatum, Input, Mint, Output, OutputReference, Publish, Redeemer,
  ScriptPurpose, Spend,
}
use cardano_account_custody_contract/state
use cardano_account_custody_contract/types.{
  AccountRedeemer, AccountState, Grant, MintRedeemer,
}

// CONSTANTS *******************************************************************

/// The length of a script hash, which is what a state NFT name and the
/// logic pointer of a control datum are.
pub const script_hash_length = 28

/// The length of a state NFT name: the account's stake script hash.
pub const state_nft_name_length = script_hash_length

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

/// The account address: the account proxy as payment credential and the
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

/// Whether a byte string has the length of a script hash.
pub fn is_script_hash(bytes: ByteArray) -> Bool {
  bytearray.length(bytes) == script_hash_length
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

/// Whether an output is the control UTxO of the account: it carries an
/// inline datum, holds the state NFT and sits at `address`, the account
/// address. A control UTxO always carries its state inline, so the datum
/// shape is checked first and a plain deposit fails on one match; the
/// token check follows and the address comparison comes last.
fn is_control(
  output: Output,
  address: Address,
  script_hash: ScriptHash,
  stake_script_hash: ScriptHash,
) -> Bool {
  when output.datum is {
    InlineDatum(_) ->
      holds_state_nft(output.value, script_hash, stake_script_hash) && output.address == address
    _ -> False
  }
}

/// Whether an output sits at the account address and holds the state NFT
/// under an inline datum.
pub fn is_control_output(
  output: Output,
  script_hash: ScriptHash,
  stake_script_hash: ScriptHash,
) -> Bool {
  is_control(
    output,
    account_address(script_hash, stake_script_hash),
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
  let address = account_address(script_hash, stake_script_hash)
  when
    list.filter(
      outputs,
      fn(output) { is_control(output, address, script_hash, stake_script_hash) },
    )
  is {
    [output] -> Some(output)
    _ -> None
  }
}

/// The account's control UTxO among the inputs and the reference inputs
/// taken together; none or several, spent and referenced at once
/// included, yield `None`. This is the one scan the proxy runs on every
/// spend that defers to the logic, so it reads nothing but the datum
/// shape, the value and the address of each input.
pub fn find_present_control(
  inputs: List<Input>,
  reference_inputs: List<Input>,
  script_hash: ScriptHash,
  stake_script_hash: ScriptHash,
) -> Option<Output> {
  let address = account_address(script_hash, stake_script_hash)
  let collect = fn(input: Input, found: List<Output>) {
    if is_control(input.output, address, script_hash, stake_script_hash) {
      [input.output, ..found]
    } else {
      found
    }
  }
  when
    list.foldl(reference_inputs, list.foldl(inputs, [], collect), collect)
  is {
    [control] -> Some(control)
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
/// grant tokens. The token check runs first, since most outputs at an
/// account address are deposits that fail it on one lookup.
pub fn holds_account_token(
  output: Output,
  script_hash: ScriptHash,
  stake_script_hash: ScriptHash,
) -> Bool {
  (
    assets.tokens(output.value, script_hash)
      |> dict.to_pairs
      |> list.any(
          fn(token) {
            let Pair(name, _) = token
            account_of_name(name) == stake_script_hash
          },
        )
  ) && output.address == account_address(script_hash, stake_script_hash)
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
/// its prefix.
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

/// Whether every minted entry is a grant token of the account in the
/// given quantity: a 32 byte name prefixed by the account's stake script
/// hash, in quantity one for an issuance and minus one for a burn. A
/// state NFT name, another account's prefix, a burn beside an issuance or
/// any other quantity fails, so a mint under the grant redeemers can
/// neither mint a second state NFT nor touch another account's tokens.
pub fn mints_grants_of(
  minted: Pairs<AssetName, Int>,
  stake_script_hash: ScriptHash,
  quantity: Int,
) -> Bool {
  list.all(
    minted,
    fn(token) {
      let Pair(name, minted_quantity) = token
      and {
        minted_quantity == quantity,
        is_grant_name(name),
        account_of_name(name) == stake_script_hash,
      }
    },
  )
}

/// Whether the outputs keep the account's control UTxO in place: exactly
/// one output holds the state NFT, at the account address, under an
/// inline datum, with nothing but lovelace beside the NFT and no reference
/// script. The datum is not decoded, so the rule holds whatever state
/// shape the account's logic writes.
pub fn keeps_control_output(
  outputs: List<Output>,
  script_hash: ScriptHash,
  stake_script_hash: ScriptHash,
) -> Bool {
  when
    list.filter(
      outputs,
      fn(output) {
        holds_state_nft(output.value, script_hash, stake_script_hash)
      },
    )
  is {
    [control] -> and {
        control.address == account_address(script_hash, stake_script_hash),
        holds_only_lovelace_and_state_nft(
          control.value,
          script_hash,
          stake_script_hash,
        ),
        when control.datum is {
          InlineDatum(_) -> True
          _ -> False
        },
        control.reference_script == None,
      }
    _ -> False
  }
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

/// The data an output carries as its inline datum; fails on any other
/// datum.
pub fn inline_datum(output: Output) -> Data {
  expect InlineDatum(data) = output.datum
  data
}

/// The logic hash a control datum names in its first field, read without
/// decoding the rest of the state. Fails on a datum that is not a
/// constructor whose first field is a byte string.
pub fn logic_of(data: Data) -> ScriptHash {
  expect [logic, ..] = builtin.unconstr_fields(data)
  builtin.un_b_data(logic)
}

/// The device list a control datum carries in its second field, read
/// without decoding the rest of the state. Fails on a datum that is not a
/// constructor whose second field is a list of byte strings.
pub fn devices_of(data: Data) -> List<VerificationKeyHash> {
  expect [_, devices, ..] = builtin.unconstr_fields(data)
  expect keys: List<VerificationKeyHash> = devices
  keys
}

/// The grant generation a control datum carries in its third field, read
/// without decoding the rest of the state. Fails on a datum that is not a
/// constructor whose third field is an integer.
pub fn generation_of(data: Data) -> Int {
  expect [_, _, generation, ..] = builtin.unconstr_fields(data)
  builtin.un_i_data(generation)
}

/// The slot a grant datum carries in its first field, read without
/// decoding the rest of the grant. Fails on a datum that is not a
/// constructor whose first field is an integer.
pub fn grant_slot_of(data: Data) -> Int {
  expect [slot, ..] = builtin.unconstr_fields(data)
  builtin.un_i_data(slot)
}

/// The generation a grant datum carries in its third field, read without
/// decoding the rest of the grant. Fails on a datum that is not a
/// constructor whose third field is an integer.
pub fn grant_generation_of(data: Data) -> Int {
  expect [_, _, generation, ..] = builtin.unconstr_fields(data)
  builtin.un_i_data(generation)
}

/// The `AccountState` an output carries as its inline datum; fails on any
/// other datum.
pub fn state_datum(output: Output) -> AccountState {
  expect state: AccountState = inline_datum(output)
  state
}

/// The `Grant` an output carries as its inline datum; fails on any other
/// datum.
pub fn grant_datum(output: Output) -> Grant {
  expect grant: Grant = inline_datum(output)
  grant
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

/// Whether one of the listed devices is among the required signers.
pub fn has_device_signature(
  devices: List<VerificationKeyHash>,
  extra_signatories: List<VerificationKeyHash>,
) -> Bool {
  list.any(devices, fn(device) { list.has(extra_signatories, device) })
}

/// Whether one of the state's devices is among the required signers.
pub fn is_signed_by_a_device(
  state: AccountState,
  extra_signatories: List<VerificationKeyHash>,
) -> Bool {
  has_device_signature(state.devices, extra_signatories)
}

/// Whether a device listed in the account's control UTxO, spent or
/// referenced, is among the required signers. The devices are read from
/// the second field of the control datum, so the rule holds whatever
/// state shape the account's logic keeps after them. Fails when no control
/// UTxO of the account is present.
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
  has_device_signature(
    devices_of(inline_datum(control.output)),
    extra_signatories,
  )
}

/// Whether the transaction withdraws from the reward account of a logic
/// script, which is what makes the ledger run that logic over the whole
/// transaction. The amount does not matter and is zero in practice.
pub fn withdraws_from(
  withdrawals: Pairs<Credential, Lovelace>,
  logic: ScriptHash,
) -> Bool {
  pairs.has_key(withdrawals, Script(logic))
}

/// The proxy redeemer of the input at `output_reference`, read from the
/// transaction's redeemers; fails when the input carries none or one of
/// another shape.
pub fn spend_redeemer_of(
  redeemers: Pairs<ScriptPurpose, Redeemer>,
  output_reference: OutputReference,
) -> AccountRedeemer {
  expect Some(data) = pairs.get_first(redeemers, Spend(output_reference))
  expect redeemer: AccountRedeemer = data
  redeemer
}

/// The proxy redeemer of the mint under the account policy, read from the
/// transaction's redeemers; fails when the policy is not run or its
/// redeemer has another shape.
pub fn mint_redeemer_of(
  redeemers: Pairs<ScriptPurpose, Redeemer>,
  policy_id: PolicyId,
) -> MintRedeemer {
  expect Some(data) = pairs.get_first(redeemers, Mint(policy_id))
  expect redeemer: MintRedeemer = data
  redeemer
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
/// The certificate list proves nothing on its own, since a registration
/// in the legacy format carries no witness and runs no script.
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
