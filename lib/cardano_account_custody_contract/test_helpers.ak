//// Builders for the hand made transactions the validator tests exercise.
//// Every builder works against one fictitious account proxy, one logic
//// and one account owner, so tests only spell out what differs between
//// cases.

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
use aiken/collection/list
use aiken/collection/pairs
use aiken/crypto.{ScriptHash, VerificationKeyHash}
use aiken/interval.{Interval}
use cardano/address.{Address, Script}
use cardano/assets.{Assets}
use cardano/certificate.{Certificate, RegisterCredential}
use cardano/transaction.{
  Datum, InlineDatum, Input, Mint, NoDatum, Output, OutputReference, Publish,
  Spend, Transaction, Withdraw,
}
use cardano_account_custody_contract/account
use cardano_account_custody_contract/types.{
  AccountRedeemer, AccountState, BurnGrants, CreateAccount, Device, Fund, Grant,
  IssueGrants, MintRedeemer, Operate, Run, SpendWithGrant, SweepGrant,
}

// CONSTANTS *******************************************************************

/// The hash standing in for the account proxy script.
pub const script_hash: ScriptHash =
  #"00000000000000000000000000000000000000000000000000000001"

/// The stake credential of the account under test: the hash standing in
/// for the owner's account stake script.
pub const stake_script_hash: ScriptHash =
  #"00000000000000000000000000000000000000000000000000000002"

/// The stake credential of a second, unrelated account.
pub const other_stake_script_hash: ScriptHash =
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

/// The hash standing in for the logic the account under test runs.
pub const logic_hash: ScriptHash =
  #"00000000000000000000000000000000000000000000000000000008"

/// The hash standing in for a later logic version.
pub const next_logic_hash: ScriptHash =
  #"00000000000000000000000000000000000000000000000000000009"

// FUNCTIONS *******************************************************************

/// The address of the account identified by `stake_script_hash` at the
/// test proxy.
pub fn account_address() -> Address {
  account.account_address(script_hash, stake_script_hash)
}

/// The address of the account identified by `other_stake_script_hash` at
/// the test proxy.
pub fn other_account_address() -> Address {
  account.account_address(script_hash, other_stake_script_hash)
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

/// One state NFT of the account identified by `stake_script_hash` under
/// the test proxy.
pub fn state_nft(stake_script_hash: ScriptHash) -> Assets {
  assets.from_asset(script_hash, stake_script_hash, 1)
}

/// A value holding some lovelace and the state NFT of the account
/// identified by `stake_script_hash`.
pub fn control_value(stake_script_hash: ScriptHash, lovelace: Int) -> Assets {
  assets.merge(assets.from_lovelace(lovelace), state_nft(stake_script_hash))
}

/// One grant token of the account identified by `stake_script_hash` for
/// `slot`, under the test proxy.
pub fn grant_token(stake_script_hash: ScriptHash, slot: Int) -> Assets {
  assets.from_asset(
    script_hash,
    account.grant_token_name(stake_script_hash, slot),
    1,
  )
}

/// A value holding some lovelace and the grant token of the account
/// identified by `stake_script_hash` for `slot`.
pub fn grant_value(
  stake_script_hash: ScriptHash,
  slot: Int,
  lovelace: Int,
) -> Assets {
  assets.merge(
    assets.from_lovelace(lovelace),
    grant_token(stake_script_hash, slot),
  )
}

/// An inline datum carrying an account state.
pub fn state_datum(state: AccountState) -> Datum {
  let data: Data = state
  InlineDatum(data)
}

/// An inline datum carrying a grant.
pub fn grant_datum(grant: Grant) -> Datum {
  let data: Data = grant
  InlineDatum(data)
}

/// The control UTxO of the account under test: lovelace, its state NFT and
/// the given state inline.
pub fn control_output(state: AccountState, lovelace: Int) -> Output {
  output(
    account_address(),
    control_value(stake_script_hash, lovelace),
    state_datum(state),
  )
}

/// A grant UTxO of the account under test: lovelace, the grant token of
/// the grant's slot and the grant inline.
pub fn grant_output(grant: Grant, lovelace: Int) -> Output {
  output(
    account_address(),
    grant_value(stake_script_hash, grant.slot, lovelace),
    grant_datum(grant),
  )
}

/// A deposit UTxO at the account address under test: a value and no datum.
pub fn fund_output(value: Assets) -> Output {
  output(account_address(), value, NoDatum)
}

/// The control UTxO of the other account: lovelace, its state NFT and
/// `state` inline.
pub fn other_control_output(state: AccountState, lovelace: Int) -> Output {
  output(
    other_account_address(),
    control_value(other_stake_script_hash, lovelace),
    state_datum(state),
  )
}

/// A grant UTxO of the other account: lovelace, the grant token of the
/// grant's slot and the grant inline.
pub fn other_grant_output(grant: Grant, lovelace: Int) -> Output {
  output(
    other_account_address(),
    grant_value(other_stake_script_hash, grant.slot, lovelace),
    grant_datum(grant),
  )
}

/// A deposit UTxO at the other account's address: a value and no datum.
pub fn other_fund_output(value: Assets) -> Output {
  output(other_account_address(), value, NoDatum)
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

/// The transaction with the given reference inputs.
pub fn referencing(
  self: Transaction,
  reference_inputs: List<Input>,
) -> Transaction {
  Transaction { ..self, reference_inputs }
}

/// A certificate registering the stake credential of the account
/// identified by `stake_script_hash`.
pub fn registration(stake_script_hash: ScriptHash) -> Certificate {
  RegisterCredential { credential: Script(stake_script_hash), deposit: Never }
}

/// The transaction with a certificate published through its stake script:
/// the certificate is appended to the certificates and a redeemer under
/// the publish purpose records that the script ran on it, as the ledger
/// does for every certificate witnessed by a script.
pub fn publishing(self: Transaction, certificate: Certificate) -> Transaction {
  let redeemer: Data = Operate
  Transaction {
    ..self,
    certificates: list.concat(self.certificates, [certificate]),
    redeemers: list.concat(
      self.redeemers,
      [
        Pair(
          Publish { at: list.length(self.certificates), certificate },
          redeemer,
        ),
      ],
    ),
  }
}

/// The transaction with a zero withdrawal from the reward account of each
/// logic and a redeemer under the withdraw purpose for each, which is what
/// makes the ledger run a logic.
pub fn withdrawing(self: Transaction, logics: List<ScriptHash>) -> Transaction {
  let redeemer: Data = Run
  Transaction {
    ..self,
    withdrawals: list.concat(
      self.withdrawals,
      list.map(logics, fn(logic) { Pair(Script(logic), 0) }),
    ),
    redeemers: list.concat(
      self.redeemers,
      list.map(logics, fn(logic) { Pair(Withdraw(Script(logic)), redeemer) }),
    ),
  }
}

/// Whether a value holds a state NFT of any account under the test proxy.
fn holds_a_state_nft(value: Assets) -> Bool {
  assets.tokens(value, script_hash)
    |> dict.keys
    |> list.any(account.is_state_nft_name)
}

/// The spend redeemer a builder attaches to an input at an account
/// address: `Device` on a control UTxO, `SweepGrant` on a grant UTxO when
/// the control UTxO of its own account is spent and `SpendWithGrant` when
/// it is not, `Fund` on any other UTxO.
fn default_spend_redeemer(
  output: Output,
  inputs: List<Input>,
) -> AccountRedeemer {
  if holds_a_state_nft(output.value) {
    Device
  } else {
    when assets.tokens(output.value, script_hash) |> dict.keys is {
      [] -> Fund
      [name, ..] ->
        if account.has_control_input(
          inputs,
          script_hash,
          account.account_of_name(name),
        ) {
          SweepGrant
        } else {
          SpendWithGrant
        }
    }
  }
}

/// The mint redeemer a builder attaches to a mint under the test proxy:
/// `CreateAccount` for a state NFT name, `IssueGrants` for a positive
/// quantity and `BurnGrants` for a negative one, judged by the first
/// entry.
fn default_mint_redeemer(mint: Assets) -> Option<MintRedeemer> {
  when assets.tokens(mint, script_hash) |> dict.to_pairs is {
    [] -> None
    [Pair(name, quantity), ..] ->
      if account.is_state_nft_name(name) {
        Some(CreateAccount)
      } else if quantity > 0 {
        Some(IssueGrants)
      } else {
        Some(BurnGrants)
      }
  }
}

/// The transaction with the proxy redeemers a builder attaches where the
/// transaction carries none yet: a spend redeemer for every input paying to
/// the test proxy and a mint redeemer for a mint under it, as the ledger
/// lists them for the logic to read. Redeemers already present are kept,
/// so a test overrides one by setting it first.
pub fn with_proxy_redeemers(self: Transaction) -> Transaction {
  let spends = list.filter_map(
    self.inputs,
    fn(input) {
      let purpose = Spend(input.output_reference)
      if input.output.address.payment_credential == Script(script_hash) && !pairs.has_key(
        self.redeemers,
        purpose,
      ) {
        let redeemer: Data = default_spend_redeemer(input.output, self.inputs)
        Some(Pair(purpose, redeemer))
      } else {
        None
      }
    },
  )
  let mints = when default_mint_redeemer(self.mint) is {
    Some(redeemer) ->
      if pairs.has_key(self.redeemers, Mint(script_hash)) {
        []
      } else {
        let data: Data = redeemer
        [Pair(Mint(script_hash), data)]
      }
    None -> []
  }
  Transaction {
    ..self,
    redeemers: list.concat(self.redeemers, list.concat(spends, mints)),
  }
}

/// The transaction with `redeemer` as the proxy's spend redeemer of the
/// input at `output_reference(index)`, in place of any it carried.
pub fn spending(
  self: Transaction,
  index: Int,
  redeemer: AccountRedeemer,
) -> Transaction {
  let purpose = Spend(output_reference(index))
  let data: Data = redeemer
  Transaction {
    ..self,
    redeemers: list.concat(
      pairs.delete_all(self.redeemers, purpose),
      [Pair(purpose, data)],
    ),
  }
}

/// The transaction with `redeemer` as the proxy's mint redeemer, in place
/// of any it carried.
pub fn minting(self: Transaction, redeemer: MintRedeemer) -> Transaction {
  let purpose = Mint(script_hash)
  let data: Data = redeemer
  Transaction {
    ..self,
    redeemers: list.concat(
      pairs.delete_all(self.redeemers, purpose),
      [Pair(purpose, data)],
    ),
  }
}
