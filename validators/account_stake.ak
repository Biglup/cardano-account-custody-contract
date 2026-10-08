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

/// The account's stake validator, applied to the account's initial device
/// key as `owner` and the account proxy's hash as `proxy_hash`. Its
/// script hash is the account's stake credential, the name of its state
/// NFT and the prefix of its grant token names, so every user has their
/// own stake script, address and reward account. The script reads the
/// devices from the second field of the control datum and nothing else of
/// the state, so it answers to no logic version and keeps rewards and
/// delegation under the devices whatever logic the account runs. See
/// README, Stake script.
///
/// Publish: registering the credential, alone or with a delegation, is the
/// act that creates the account and needs the owner's signature, exactly
/// one state NFT of the credential minted under the account policy and the
/// owner among the devices of the control output that holds it, so a
/// registration can neither strand the credential without an account nor
/// create one the owner is locked out of; a delegation change needs a
/// device of the account, read from the control UTxO spent or referenced;
/// deregistration and every other certificate are refused, so the
/// credential stays registered for the life of the account.
///
/// Withdraw: any withdrawal from the reward account, including zero, needs
/// a device of the account.
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
/// read from the control UTxO the transaction spends or references.
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
/// with the owner in it: the owner signs, the account policy mints exactly
/// one token named after the credential, and the control output holding
/// that token lists the owner among its devices. See README, Registration
/// gated creation.
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
/// whole state in the same transaction. Fails when no single control
/// output exists or its datum is not an inline constructor with a key
/// list second.
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
