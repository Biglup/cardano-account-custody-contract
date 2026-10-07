use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{ScriptHash}
use cardano/assets.{PolicyId}
use cardano/transaction.{Output, OutputReference, Transaction}
use cardano_account_custody_contract/account as custody
use cardano_account_custody_contract/grant.{
  carries_no_reference_script, carries_state, deposits_carry_no_datum,
  ends_before_expiry, is_authorised_by_grantee, leaving_value,
  pays_only_recipients, spends_one_control_utxo, state_after_spend,
  stays_within_scope,
}
use cardano_account_custody_contract/state.{find_grant}
use cardano_account_custody_contract/types.{
  AccountRedeemer, AccountState, CreateAccount, Device, Fund, MintRedeemer,
  SpendWithGrant,
}

/// The account's multi-purpose validator. Its script hash is the policy id
/// of every state NFT and the payment credential of every account address;
/// the stake part of an address is the account's own `account_stake` script
/// hash, which also names the account's state NFT. No redeemer burns a
/// state NFT, so an account is permanent and holds exactly one control
/// UTxO from creation on. See README, Design.
///
/// Mint, `CreateAccount`: mints exactly one state NFT named after a stake
/// credential; the account stake script runs on a certificate registering
/// that credential; the NFT lands in a single valid control output; every
/// state NFT in the outputs sits at its own account address.
///
/// Spend, `Fund`: the UTxO holds no state NFT; the account's control UTxO
/// is spent alongside; the datum is not read. `Device`: the UTxO is the
/// control UTxO and its inline datum is an `AccountState`; a device signs;
/// every state NFT in the inputs and outputs sits at its own account
/// address; a single valid control output recreates the NFT.
/// `SpendWithGrant`: the UTxO is the control UTxO; the grant in `slot`
/// exists and its grantee signs; the validity range ends before the grant
/// expires; the leaving value stays within the scope caps; outputs away
/// from the account go to allowed recipients; deposits paid back carry no
/// datum; exactly one control UTxO is spent; every state NFT in the inputs
/// and outputs sits at its own account address; the single control output
/// holds only lovelace and the NFT, carries the state with this grant's
/// remaining caps reduced by what left, and has no reference script. See
/// README, Agent path.
validator account {
  mint(redeemer: MintRedeemer, policy_id: PolicyId, self: Transaction) {
    expect [Pair(stake_script_hash, quantity)] = assets.tokens(
      self.mint,
      policy_id,
    )
      |> dict.to_pairs
    when (redeemer, quantity) is {
      (CreateAccount, 1) -> {
        expect Some(control) = custody.find_control_output(
          self.outputs,
          policy_id,
          stake_script_hash,
        )
        and {
          custody.registers_stake_credential(self.redeemers, stake_script_hash),
          custody.is_valid_control_output(control, policy_id, stake_script_hash),
          custody.state_nfts_sit_at_their_own_addresses(self.outputs, policy_id),
        }
      }
      _ -> False
    }
  }

  spend(
    datum: Option<Data>,
    redeemer: AccountRedeemer,
    output_reference: OutputReference,
    self: Transaction,
  ) {
    let own = custody.own_input(self.inputs, output_reference)
    let script_hash = custody.script_hash_of(own.output.address)
    let stake_script_hash = custody.stake_script_hash_of(own.output.address)
    let holds_nft = custody.holds_state_nft(
      own.output.value,
      script_hash,
      stake_script_hash,
    )
    when redeemer is {
      Fund -> and {
          !holds_nft,
          custody.has_control_input(self.inputs, script_hash, stake_script_hash),
        }
      Device -> {
        expect Some(data) = datum
        expect state: AccountState = data
        and {
          holds_nft,
          list.any(
            state.devices,
            fn(device) { list.has(self.extra_signatories, device) },
          ),
          custody.state_nfts_sit_at_their_own_addresses(
            list.map(self.inputs, fn(input) { input.output }),
            script_hash,
          ),
          custody.state_nfts_sit_at_their_own_addresses(
            self.outputs,
            script_hash,
          ),
          recreates_control_output(self.outputs, script_hash, stake_script_hash),
        }
      }
      SpendWithGrant { slot } -> {
        expect Some(data) = datum
        expect state: AccountState = data
        expect Some(grant) = find_grant(state, slot)
        let address = own.output.address
        let leaving = leaving_value(self.inputs, self.outputs, address)
        expect Some(control) = custody.find_control_output(
          self.outputs,
          script_hash,
          stake_script_hash,
        )
        and {
          holds_nft,
          is_authorised_by_grantee(grant.grantee, self.extra_signatories),
          ends_before_expiry(self.validity_range, grant.scope.expires_at),
          stays_within_scope(grant.scope, leaving),
          pays_only_recipients(self.outputs, address, grant.scope.recipients),
          deposits_carry_no_datum(
            self.outputs,
            address,
            script_hash,
            stake_script_hash,
          ),
          spends_one_control_utxo(self.inputs, script_hash, stake_script_hash),
          custody.state_nfts_sit_at_their_own_addresses(
            list.map(self.inputs, fn(input) { input.output }),
            script_hash,
          ),
          custody.state_nfts_sit_at_their_own_addresses(
            self.outputs,
            script_hash,
          ),
          custody.holds_only_lovelace_and_state_nft(
            control.value,
            script_hash,
            stake_script_hash,
          ),
          carries_state(control, state_after_spend(state, slot, leaving)),
          carries_no_reference_script(control),
        }
      }
    }
  }

  else(_context) {
    fail
  }
}

/// Whether exactly one output at the account address holds the state NFT
/// and is a valid control output.
fn recreates_control_output(
  outputs: List<Output>,
  script_hash: ScriptHash,
  stake_script_hash: ScriptHash,
) -> Bool {
  expect Some(control) = custody.find_control_output(
    outputs,
    script_hash,
    stake_script_hash,
  )
  custody.is_valid_control_output(control, script_hash, stake_script_hash)
}
