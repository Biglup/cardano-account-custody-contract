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

use aiken/collection/list
use aiken/crypto.{ScriptHash, VerificationKeyHash}
use cardano/address.{Credential, Script}
use cardano/assets
use cardano/certificate.{
  Certificate, DelegateCredential, RegisterAndDelegateCredential,
  RegisterCredential,
}
use cardano/transaction.{Output, Transaction}
use cardano_account_custody_contract/account as custody
use cardano_account_custody_contract/types.{StakeRedeemer}

// VALIDATORS ******************************************************************

/// The account's stake script, applied to the owner key hash as `owner`
/// and the proxy's hash as `proxy_hash`. Its script hash is the
/// account's stake credential, the name of its state NFT and the prefix
/// of its grant token names. The redeemer is not read. It reads field 1
/// of the control datum, the devices, and nothing else, so it holds
/// under every logic.
///
/// Withdraw: a device of the control UTxO, taken from the reference
/// inputs first and the inputs second, is among the required signers,
/// for any amount.
///
/// Publish: `RegisterCredential` and `RegisterAndDelegateCredential` of
/// the script credential create the account, so `owner` is among the
/// required signers, the proxy mints exactly one token named after the
/// credential and the single control output lists `owner` among its
/// devices; `DelegateCredential` of the script credential needs a device
/// of the control UTxO, taken the same way as for a withdrawal; every
/// other certificate returns `False`.
///
/// Every other purpose aborts. Aborts also when a device check finds no
/// control UTxO of the account, when a creation finds no single control
/// output, and when the control datum read is not a constructor whose
/// second field is a list of byte strings.
validator account_stake(owner: VerificationKeyHash, proxy_hash: ScriptHash) {
  withdraw(_redeemer: StakeRedeemer, credential: Credential, self: Transaction) {
    expect Script(stake_script_hash) = credential
    is_authorised_by_a_device(self, proxy_hash, stake_script_hash)
  }

  publish(_redeemer: StakeRedeemer, certificate: Certificate, self: Transaction) {
    when certificate is {
      RegisterCredential { credential: Script(stake_script_hash), .. } ->
        creates_the_account(self, owner, proxy_hash, stake_script_hash)
      RegisterAndDelegateCredential {
        credential: Script(stake_script_hash),
        ..
      } -> creates_the_account(self, owner, proxy_hash, stake_script_hash)
      DelegateCredential { credential: Script(stake_script_hash), .. } ->
        is_authorised_by_a_device(self, proxy_hash, stake_script_hash)
      _ -> False
    }
  }

  else(_context) {
    fail
  }
}

// FUNCTIONS *******************************************************************

/// Whether a device of the account named by `stake_script_hash` signs,
/// read from the control UTxO taken from the reference inputs first and
/// the inputs second. Aborts when no control UTxO of the account is
/// present and when its inline datum is not a constructor whose second
/// field is a list of byte strings.
fn is_authorised_by_a_device(
  self: Transaction,
  proxy_hash: ScriptHash,
  stake_script_hash: ScriptHash,
) -> Bool {
  custody.is_authorised_by_a_device(
    self.inputs,
    self.reference_inputs,
    self.extra_signatories,
    proxy_hash,
    stake_script_hash,
  )
}

/// Whether the transaction creates the account named by `stake_script_hash`
/// with the owner in it: the owner signs, the proxy mints exactly one
/// token named after the credential, and the control output holding
/// that token lists the owner among its devices. Aborts on every abort of
/// `lists_the_owner_as_a_device`; every other violation returns `False`.
fn creates_the_account(
  self: Transaction,
  owner: VerificationKeyHash,
  proxy_hash: ScriptHash,
  stake_script_hash: ScriptHash,
) -> Bool {
  and {
    list.has(self.extra_signatories, owner),
    assets.quantity_of(self.mint, proxy_hash, stake_script_hash) == 1,
    lists_the_owner_as_a_device(
      self.outputs,
      owner,
      proxy_hash,
      stake_script_hash,
    ),
  }
}

/// Whether the account's single control output among the outputs lists
/// `owner` in the device list of its inline state. Only the second field
/// of the datum is decoded, since the logic the control names checks the
/// whole state in the same transaction. Aborts when no single control
/// output exists or its datum is not an inline constructor whose second
/// field is a list of byte strings.
fn lists_the_owner_as_a_device(
  outputs: List<Output>,
  owner: VerificationKeyHash,
  proxy_hash: ScriptHash,
  stake_script_hash: ScriptHash,
) -> Bool {
  expect Some(control) = custody.find_control_output(
    outputs,
    proxy_hash,
    stake_script_hash,
  )
  list.has(custody.devices_of(custody.inline_datum(control)), owner)
}
