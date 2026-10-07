use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{ScriptHash, VerificationKeyHash}
use cardano/address.{Address, Credential, Inline, Script}
use cardano/assets.{Assets}
use cardano/certificate.{
  Certificate, RegisterAndDelegateCredential, RegisterCredential,
}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Publish, Redeemer, ScriptPurpose,
}
use cardano_account_custody_contract/state
use cardano_account_custody_contract/types.{AccountState}

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
/// quantity one by an output at the account address its name denotes. See
/// README, State NFT placement.
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
  let state = state_datum(control.output)
  list.any(state.devices, fn(device) { list.has(extra_signatories, device) })
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
