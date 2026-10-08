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

use aiken/collection/list
use aiken/crypto.{ScriptHash, VerificationKeyHash}
use cardano/address.{Credential, Script}
use cardano/certificate.{
  Certificate, DelegateCredential, RegisterAndDelegateCredential,
  RegisterCredential,
}
use cardano/transaction.{Transaction}
use cardano_account_custody_contract/account as custody
use cardano_account_custody_contract/types.{StakeRedeemer}

// VALIDATORS ******************************************************************

/// The account's stake validator, applied to the account's initial device
/// key as `owner` and the account validator's hash as `account_hash`. Its
/// script hash is the account's stake credential, the name of its state
/// NFT and the prefix of its grant token names, so every user has their
/// own stake script, address and reward account. See README, Stake script.
///
/// Publish: registering the credential, alone or with a delegation, needs
/// the owner's signature and is the act that creates the account; a
/// delegation change needs a device of the account, read from the control
/// UTxO spent or referenced; deregistration and every other certificate
/// are refused, so the credential stays registered for the life of the
/// account.
///
/// Withdraw: any withdrawal from the reward account, including zero, needs
/// a device of the account.
validator account_stake(owner: VerificationKeyHash, account_hash: ScriptHash) {
  withdraw(_redeemer: StakeRedeemer, credential: Credential, self: Transaction) {
    expect Script(stake_script_hash) = credential
    is_authorised_by_a_device(self, account_hash, stake_script_hash)
  }

  publish(_redeemer: StakeRedeemer, certificate: Certificate, self: Transaction) {
    when certificate is {
      RegisterCredential { credential: Script(_), .. } ->
        list.has(self.extra_signatories, owner)
      RegisterAndDelegateCredential { credential: Script(_), .. } ->
        list.has(self.extra_signatories, owner)
      DelegateCredential { credential: Script(stake_script_hash), .. } ->
        is_authorised_by_a_device(self, account_hash, stake_script_hash)
      _ -> False
    }
  }

  else(_context) {
    fail
  }
}

// FUNCTIONS *******************************************************************

/// Whether a device of the account named by `stake_script_hash` signs,
/// read from the control UTxO the transaction spends or references.
fn is_authorised_by_a_device(
  self: Transaction,
  account_hash: ScriptHash,
  stake_script_hash: ScriptHash,
) -> Bool {
  custody.is_authorised_by_a_device(
    self.inputs,
    self.reference_inputs,
    self.extra_signatories,
    account_hash,
    stake_script_hash,
  )
}
