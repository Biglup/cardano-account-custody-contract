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

/// The account's stake validator, applied to the account's initial device
/// key as `owner` and to the account validator's hash as `account_hash`.
/// Its script hash is the account's stake credential: the stake part of
/// the account address and the name of the account's state NFT. Every
/// user therefore gets their own stake script, and with it their own
/// address and reward account, while every account shares the account
/// validator as its payment credential.
///
/// The publish handler runs on every certificate naming the credential. A
/// certificate registering it, alone or together with a delegation, is the
/// act that creates the account, before any control UTxO exists, so it
/// requires the owner's signature; the account validator in turn accepts
/// `CreateAccount` only alongside such a certificate. A delegation change
/// requires a device of the account: the account's control UTxO must be
/// spent or referenced by the transaction and one of the devices in its
/// state must sign. A deregistration is refused outright, with or without
/// a device: the credential stays registered for the life of the account,
/// which keeps the account permanent, since a second registration, and
/// with it a second control UTxO, is only possible after a deregistration.
/// Certificates of any other kind, such as those registering a delegate
/// representative under the credential, are refused.
///
/// The withdraw handler runs on every withdrawal from the credential's
/// reward account, of any amount including zero, and applies the same
/// device rule, so rewards stay reachable through any device for the life
/// of the account.
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

/// Whether a device of the account identified by `stake_script_hash`
/// signs the transaction, read from the control UTxO the transaction
/// spends or references.
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
