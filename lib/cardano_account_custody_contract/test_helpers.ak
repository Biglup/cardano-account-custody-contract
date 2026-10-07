//// Builders for the hand made transactions the validator tests exercise.
//// Every builder works against one fictitious account script and one
//// account owner, so tests only spell out what differs between cases.

use aiken/crypto.{ScriptHash, VerificationKeyHash}
use aiken/interval.{Interval}
use cardano/address.{Address}
use cardano/assets.{Assets}
use cardano/transaction.{
  Datum, InlineDatum, Input, NoDatum, Output, OutputReference, Transaction,
}
use cardano_account_custody_contract/account
use cardano_account_custody_contract/types.{AccountState}

/// The hash standing in for the account validator script.
pub const script_hash: ScriptHash =
  #"00000000000000000000000000000000000000000000000000000001"

/// The stake key hash of the account owner under test.
pub const stake_key_hash: VerificationKeyHash =
  #"00000000000000000000000000000000000000000000000000000002"

/// The stake key hash of a second, unrelated account owner.
pub const other_stake_key_hash: VerificationKeyHash =
  #"00000000000000000000000000000000000000000000000000000003"

/// The verification key hash of the account's first device.
pub const device_key: VerificationKeyHash =
  #"00000000000000000000000000000000000000000000000000000004"

/// The verification key hash of a second device.
pub const other_device_key: VerificationKeyHash =
  #"00000000000000000000000000000000000000000000000000000005"

/// A verification key hash that is neither a device nor the owner.
pub const stranger_key: VerificationKeyHash =
  #"00000000000000000000000000000000000000000000000000000006"

/// The address of the account owned by `stake_key_hash` at the test script.
pub fn account_address() -> Address {
  account.account_address(script_hash, stake_key_hash)
}

/// The address of the account owned by `other_stake_key_hash` at the test
/// script.
pub fn other_account_address() -> Address {
  account.account_address(script_hash, other_stake_key_hash)
}

/// A plain key address, used as a destination outside the account.
pub fn recipient_address() -> Address {
  address.from_verification_key(stranger_key)
}

/// A reference to the output at `index` of one fictitious earlier
/// transaction, so that distinct indices never collide.
pub fn output_reference(index: Int) -> OutputReference {
  OutputReference {
    transaction_id: #"0000000000000000000000000000000000000000000000000000000000000000",
    output_index: index,
  }
}

/// An input at `output_reference(index)` resolving to `output`.
pub fn input(index: Int, output: Output) -> Input {
  Input { output_reference: output_reference(index), output }
}

/// An output with no reference script.
pub fn output(address: Address, value: Assets, datum: Datum) -> Output {
  Output { address, value, datum, reference_script: None }
}

/// One state NFT of the account identified by `owner` under the test
/// script.
pub fn state_nft(owner: VerificationKeyHash) -> Assets {
  assets.from_asset(script_hash, owner, 1)
}

/// A value holding some lovelace and the state NFT of `owner`.
pub fn control_value(owner: VerificationKeyHash, lovelace: Int) -> Assets {
  assets.merge(assets.from_lovelace(lovelace), state_nft(owner))
}

/// An inline datum carrying an account state.
pub fn state_datum(state: AccountState) -> Datum {
  let data: Data = state
  InlineDatum(data)
}

/// The control UTxO of the account under test: lovelace, its state NFT and
/// the given state inline.
pub fn control_output(state: AccountState, lovelace: Int) -> Output {
  output(
    account_address(),
    control_value(stake_key_hash, lovelace),
    state_datum(state),
  )
}

/// A deposit UTxO at the account address under test: a value and no datum.
pub fn fund_output(value: Assets) -> Output {
  output(account_address(), value, NoDatum)
}

/// A transaction made of the given parts, with every other field left at
/// its placeholder value.
pub fn transaction(
  inputs: List<Input>,
  outputs: List<Output>,
  mint: Assets,
  extra_signatories: List<VerificationKeyHash>,
  validity_range: Interval,
) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs,
    outputs,
    mint,
    extra_signatories,
    validity_range,
  }
}
