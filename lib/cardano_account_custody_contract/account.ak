use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{ScriptHash, VerificationKeyHash}
use cardano/address.{Address, Inline, Script, VerificationKey}
use cardano/assets.{Assets}
use cardano/transaction.{InlineDatum, Input, Output, OutputReference}
use cardano_account_custody_contract/state
use cardano_account_custody_contract/types.{AccountState}

/// Find the input the spend handler is validating. Fails when the output
/// reference is not among the transaction's inputs, which the ledger never
/// allows for a genuine spend.
pub fn own_input(
  inputs: List<Input>,
  output_reference: OutputReference,
) -> Input {
  expect Some(input) = transaction.find_input(inputs, output_reference)
  input
}

/// The hash of the script an address pays to. Fails when the payment
/// credential is a verification key, which never holds for an input the
/// account validator is asked to spend.
pub fn script_hash_of(address: Address) -> ScriptHash {
  expect Script(script_hash) = address.payment_credential
  script_hash
}

/// The stake key hash that identifies the account owning an address and
/// names its state NFT. Fails unless the address carries an inline
/// verification key stake credential: outputs at the account script with
/// any other stake part belong to no account and cannot be spent.
pub fn stake_key_hash_of(address: Address) -> VerificationKeyHash {
  expect Some(Inline(VerificationKey(stake_key_hash))) = address.stake_credential
  stake_key_hash
}

/// The address of a user's account: the account script as the payment
/// credential and the user's own stake key as the stake credential.
pub fn account_address(
  script_hash: ScriptHash,
  stake_key_hash: VerificationKeyHash,
) -> Address {
  address.from_script(script_hash)
    |> address.with_delegation_key(stake_key_hash)
}

/// Whether a value holds exactly one state NFT of the account: the token
/// the account script mints under the user's stake key hash.
pub fn holds_state_nft(
  value: Assets,
  script_hash: ScriptHash,
  stake_key_hash: VerificationKeyHash,
) -> Bool {
  assets.has_nft(value, script_hash, stake_key_hash)
}

/// Whether a value holds nothing but lovelace and the account's state NFT,
/// so that no other token can be parked on the control UTxO.
pub fn holds_only_lovelace_and_state_nft(
  value: Assets,
  script_hash: ScriptHash,
  stake_key_hash: VerificationKeyHash,
) -> Bool {
  assets.has_nft_strict(value, script_hash, stake_key_hash)
}

/// Whether a transaction's mint burns exactly one state NFT of the account.
pub fn burns_state_nft(
  mint: Assets,
  script_hash: ScriptHash,
  stake_key_hash: VerificationKeyHash,
) -> Bool {
  assets.quantity_of(mint, script_hash, stake_key_hash) == -1
}

/// Whether an output is the account's control UTxO: it sits at the account
/// address and holds the state NFT.
pub fn is_control_output(
  output: Output,
  script_hash: ScriptHash,
  stake_key_hash: VerificationKeyHash,
) -> Bool {
  output.address == account_address(script_hash, stake_key_hash) && holds_state_nft(
    output.value,
    script_hash,
    stake_key_hash,
  )
}

/// Find the account's control output among a transaction's outputs. There
/// must be exactly one; none or several yield `None`.
pub fn find_control_output(
  outputs: List<Output>,
  script_hash: ScriptHash,
  stake_key_hash: VerificationKeyHash,
) -> Option<Output> {
  when
    list.filter(outputs, is_control_output(_, script_hash, stake_key_hash))
  is {
    [output] -> Some(output)
    _ -> None
  }
}

/// Whether a transaction spends the account's control UTxO.
pub fn has_control_input(
  inputs: List<Input>,
  script_hash: ScriptHash,
  stake_key_hash: VerificationKeyHash,
) -> Bool {
  list.any(
    inputs,
    fn(input) { is_control_output(input.output, script_hash, stake_key_hash) },
  )
}

/// Whether every token of the account policy among the given outputs sits
/// where its name says it belongs: a token named N must be held in a
/// quantity of exactly one by an output at the account address of N. The
/// name of a state NFT is the stake key hash of its account, so this binds
/// each state NFT to its own account address and refuses to let one reach
/// a key address, an enterprise script address or the address of another
/// account, even when the owner asks for it. Two accounts may still be
/// handled in one transaction, since each control output sits at its own
/// address. Account creation checks a transaction's outputs this way and
/// a device spend checks both its inputs and its outputs, so a state NFT
/// can only ever sit at its own account address or be burned.
pub fn state_nfts_sit_at_their_own_addresses(
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
                name,
              )
            },
          )
    },
  )
}

/// The account state an output carries as its inline datum. Fails when the
/// datum is absent, given by hash, or does not decode as an `AccountState`.
pub fn state_datum(output: Output) -> AccountState {
  expect InlineDatum(data) = output.datum
  expect state: AccountState = data
  state
}

/// Whether a control output may carry the account's state: its value holds
/// only lovelace and the state NFT, and its inline datum is a well formed
/// `AccountState`. Both account creation and every device rewrite of the
/// state accept a control output only under this check.
pub fn is_valid_control_output(
  output: Output,
  script_hash: ScriptHash,
  stake_key_hash: VerificationKeyHash,
) -> Bool {
  holds_only_lovelace_and_state_nft(output.value, script_hash, stake_key_hash) && state.is_well_formed(
    state_datum(output),
  )
}
