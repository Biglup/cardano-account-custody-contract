use cardano/assets.{PolicyId}
use cardano/transaction.{OutputReference, Transaction}
use cardano_account_custody_contract/types.{
  AccountRedeemer, AccountState, MintRedeemer,
}

/// The account's multi-purpose validator. Its script hash is both the
/// policy id of the account's state NFT and the payment credential of
/// every account address, so the mint and spend handlers share one
/// identity and can trust each other's checks within a transaction.
///
/// The mint and spend rules are not implemented yet: both handlers fail
/// unconditionally.
validator account {
  mint(_redeemer: MintRedeemer, _policy_id: PolicyId, _self: Transaction) {
    fail
  }

  spend(
    _datum: Option<AccountState>,
    _redeemer: AccountRedeemer,
    _output_reference: OutputReference,
    _self: Transaction,
  ) {
    fail
  }

  else(_context) {
    fail
  }
}
