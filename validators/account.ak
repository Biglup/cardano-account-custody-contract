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

/// The account's multi-purpose validator. Its script hash is both the
/// policy id of the account's state NFT and the payment credential of
/// every account address, so the mint and spend handlers share one
/// identity and can trust each other's checks within a transaction.
///
/// An account's stake credential is the hash of its own account stake
/// script, the parameterised `account_stake` validator, and that hash
/// names the account's state NFT. The ledger registers a stake credential
/// at most once: a second registration of a registered credential is
/// refused outright, and the stake script refuses every deregistration, so
/// the credential stays registered for the life of the account. Account
/// creation is tied to that registration, so an account is created exactly
/// once, and no key can mint a parallel control UTxO behind the devices'
/// backs.
///
/// An account is permanent. The mint handler only creates accounts:
/// `CreateAccount` mints exactly one state NFT named after the user's
/// stake credential and requires that the transaction runs the account
/// stake script on a certificate registering that credential, which is how
/// the owner authorises the creation, and that the NFT lands in a single
/// control output at the user's account address holding only lovelace, the
/// NFT and a well formed inline `AccountState`. No redeemer burns a state
/// NFT, and every spend of the control UTxO recreates it, so from creation
/// on exactly one control UTxO of the account exists at all times. That
/// invariant is what keeps every fund UTxO spendable: a deposit can only
/// leave alongside the control UTxO, and the control UTxO is always there
/// to spend.
///
/// The spend handler guards every UTxO at an account address, with the
/// account identified by the stake credential of the UTxO's own address.
/// `Fund` spends a plain deposit and only requires that the account's own
/// control UTxO is spent alongside, so the control UTxO's checks run once
/// over the whole transaction; a deposit may carry any inline datum or
/// none, since the datum is never read on this path. `Device` is the owner
/// path: the control UTxO's datum must decode as an `AccountState`, and
/// with a device signature the UTxO may be spent freely, as long as the
/// state NFT is recreated in a single control output carrying only
/// lovelace, the NFT and a well formed state.
/// `SpendWithGrant` is the agent path: the grant in the named slot must
/// exist, its grantee must authorise the transaction, either as a required
/// signer for an Ed25519 grantee or through a secp256k1 signature over the
/// transaction for a Secp256k1 grantee, and the transaction must stay
/// within the grant's scope: it ends before the grant expires, the value
/// leaving the account address stays within the per call cap, the
/// remaining cap, the lovelace per call cap and the remaining lovelace
/// cap, nothing of any other asset leaves, every output away from the
/// account goes to an allowed
/// recipient, every output paid back to the account other than the control
/// output is a plain deposit with no datum, so the balance can never be
/// parked under a datum hash nobody can spend, and the single control
/// output carries the same state with only that grant's remaining caps
/// reduced by what left and no reference script, since every transaction
/// spending a UTxO pays for the reference script it holds and a grantee
/// could otherwise raise the cost of the owner's next spend. Only one
/// control UTxO of the account may be spent, so the accounting runs over
/// one state.
///
/// The validator maintains one invariant about its tokens: a state NFT
/// named N only ever sits at the account address of N, in exactly one
/// control UTxO. Account creation and every device spend check every
/// output of the transaction for it, so a token of the account policy can
/// never reach a key address, an enterprise script address or the address
/// of another account, not even at the owner's request, and the account
/// whose NFT is spent always demands a single control output at its own
/// address. A device spend checks the spent UTxOs the same way,
/// so an account never takes part in a transaction that spends a token of
/// the policy sitting away from its own address, and such a token could
/// never be turned back into a control UTxO. Since the ledger only moves a
/// state NFT through a spend of the UTxO holding it, and that UTxO sits at
/// the account address of its name, the invariant holds across every
/// transaction.
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
      SpendWithGrant { slot, signature } -> {
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
          is_authorised_by_grantee(
            grant.grantee,
            signature,
            output_reference,
            self,
          ),
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

/// Whether the transaction recreates the account's control UTxO: exactly
/// one output at the account address holds the state NFT, and that output
/// carries only lovelace, the NFT and a well formed state.
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
