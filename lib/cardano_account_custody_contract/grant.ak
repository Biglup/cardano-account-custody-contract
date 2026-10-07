use aiken/builtin
use aiken/cbor
use aiken/collection/list
use aiken/crypto.{ScriptHash, VerificationKeyHash}
use aiken/interval.{Finite}
use aiken/math
use cardano/address.{Address}
use cardano/assets.{Assets}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction,
  ValidityRange,
}
use cardano_account_custody_contract/account
use cardano_account_custody_contract/state
use cardano_account_custody_contract/types.{
  AccountState, Asset, Ed25519, Grant, Grantee, Scope, Secp256k1,
}

/// The domain separation prefix of the message a Secp256k1 grantee signs,
/// so that a signature over a custody transaction can never be mistaken
/// for a signature over anything else.
pub const message_domain: ByteArray = "cardano_account_custody:grant:v1"

/// The message a Secp256k1 grantee signs to authorise a transaction: the
/// blake2b-256 digest of the CBOR serialisation of the tuple made of the
/// domain prefix, the output reference of the control UTxO being spent,
/// the output references of every input, the outputs, the fee, the
/// validity range and the mint, in that order. The tuple binds the
/// signature to the whole transaction, and the control UTxO's output
/// reference binds it to a single use, since that reference is consumed.
pub fn grantee_message(
  control_reference: OutputReference,
  self: Transaction,
) -> ByteArray {
  let spent = list.map(self.inputs, fn(input) { input.output_reference })
  let payload: Data = (
    message_domain,
    control_reference,
    spent,
    self.outputs,
    self.fee,
    self.validity_range,
    self.mint,
  )
  crypto.blake2b_256(cbor.serialise(payload))
}

/// Whether the grantee authorised the transaction. An Ed25519 grantee
/// signs the transaction itself and appears among its required signers,
/// so the redeemer carries no signature. A Secp256k1 grantee cannot sign
/// a Cardano transaction, so the redeemer carries its 64 byte r||s ECDSA
/// signature over `grantee_message`, checked with the secp256k1 builtin.
/// A key or signature of the wrong length makes the builtin error rather
/// than return False, which fails the transaction all the same.
pub fn is_authorised_by_grantee(
  grantee: Grantee,
  signature: Option<ByteArray>,
  control_reference: OutputReference,
  self: Transaction,
) -> Bool {
  when (grantee, signature) is {
    (Ed25519(key_hash), None) -> list.has(self.extra_signatories, key_hash)
    (Secp256k1(key), Some(signature)) ->
      builtin.verify_ecdsa_secp256k1_signature(
        key,
        grantee_message(control_reference, self),
        signature,
      )
    _ -> False
  }
}

/// Whether the transaction can only be applied before the grant expires:
/// its validity range must end at a finite time no later than
/// `expires_at`. A range open at the top could be applied at any time, so
/// it never passes.
pub fn ends_before_expiry(
  validity_range: ValidityRange,
  expires_at: Int,
) -> Bool {
  when validity_range.upper_bound.bound_type is {
    Finite(upper_bound) -> upper_bound <= expires_at
    _ -> False
  }
}

/// The value leaving an address in a transaction: everything spent from
/// it minus everything paid back to it, per asset class. A negative
/// quantity means the transaction adds that asset to the address.
pub fn leaving_value(
  inputs: List<Input>,
  outputs: List<Output>,
  address: Address,
) -> Assets {
  let spent = list.foldl(
    inputs,
    assets.zero,
    fn(input, total) {
      if input.output.address == address {
        assets.merge(total, input.output.value)
      } else {
        total
      }
    },
  )
  let returned = list.foldl(
    outputs,
    assets.zero,
    fn(output, total) {
      if output.address == address {
        assets.merge(total, output.value)
      } else {
        total
      }
    },
  )
  assets.merge(spent, assets.negate(returned))
}

/// The quantity of an asset class held in a value.
pub fn quantity_of_asset(value: Assets, asset: Asset) -> Int {
  assets.quantity_of(value, asset.policy_id, asset.asset_name)
}

/// Whether a value leaving the account stays within a scope: no more of
/// the scoped asset than the per call cap and the remaining cap, no more
/// lovelace than the remaining lovelace cap when the scoped asset is not
/// lovelace itself, and nothing at all of any other asset class.
pub fn stays_within_scope(scope: Scope, leaving: Assets) -> Bool {
  let asset_leaving = quantity_of_asset(leaving, scope.asset)
  and {
    asset_leaving <= scope.per_call_cap,
    asset_leaving <= scope.cap,
    state.is_lovelace(scope.asset) || assets.lovelace_of(leaving) <= scope.lovelace_cap,
    nothing_else_leaves(leaving, scope.asset),
  }
}

/// Whether no asset class other than the scoped asset and lovelace has a
/// positive quantity in a leaving value.
fn nothing_else_leaves(leaving: Assets, asset: Asset) -> Bool {
  assets.reduce(
    leaving,
    True,
    fn(policy_id, asset_name, quantity, ok) {
      let class = Asset { policy_id, asset_name }
      ok && ( class == asset || state.is_lovelace(class) || quantity <= 0 )
    },
  )
}

/// Whether every output paid away from the account goes to one of the
/// scope's recipients. An empty recipient list allows any destination.
pub fn pays_only_recipients(
  outputs: List<Output>,
  account_address: Address,
  recipients: List<Address>,
) -> Bool {
  recipients == [] || list.all(
    outputs,
    fn(output) {
      output.address == account_address || list.has(recipients, output.address)
    },
  )
}

/// Whether every output paid back to the account, other than the control
/// output, is a plain deposit carrying no datum. An output under a datum
/// hash can only be spent by whoever knows the preimage, so a grantee could
/// otherwise put the whole balance beyond reach without any of it counting
/// as leaving; an inline datum is refused as well, since a deposit has no
/// use for one and the owner's deposits never carry any.
pub fn deposits_carry_no_datum(
  outputs: List<Output>,
  account_address: Address,
  script_hash: ScriptHash,
  stake_key_hash: VerificationKeyHash,
) -> Bool {
  list.all(
    outputs,
    fn(output) {
      or {
        output.address != account_address,
        account.holds_state_nft(output.value, script_hash, stake_key_hash),
        output.datum == NoDatum,
      }
    },
  )
}

/// Whether the transaction spends exactly one control UTxO of the account,
/// so that the grant's accounting runs over a single state.
pub fn spends_one_control_utxo(
  inputs: List<Input>,
  script_hash: ScriptHash,
  stake_key_hash: VerificationKeyHash,
) -> Bool {
  list.count(
    inputs,
    fn(input) {
      account.is_control_output(input.output, script_hash, stake_key_hash)
    },
  ) == 1
}

/// The state the account must carry after a grant spend: the same state
/// with the used grant's remaining cap reduced by the net outflow of its
/// asset, and its remaining lovelace cap reduced by the net outflow of
/// lovelace when its asset is not lovelace. A net inflow of either asset
/// leaves its cap as it was, so a cap never increases through an agent
/// spend. Every other field, including every other grant, stays as it
/// was.
pub fn state_after_spend(
  current: AccountState,
  slot: Int,
  leaving: Assets,
) -> AccountState {
  AccountState {
    ..current,
    grants: list.map(
      current.grants,
      fn(grant) {
        if grant.slot == slot {
          Grant { ..grant, scope: scope_after_spend(grant.scope, leaving) }
        } else {
          grant
        }
      },
    ),
  }
}

/// A scope with its remaining caps reduced by a leaving value: each cap
/// loses the net outflow of its asset, clamped at zero, so a deposit made
/// alongside the spend never raises a cap above what the owner granted.
fn scope_after_spend(scope: Scope, leaving: Assets) -> Scope {
  let lovelace_cap = if state.is_lovelace(scope.asset) {
    scope.lovelace_cap
  } else {
    scope.lovelace_cap - math.max(0, assets.lovelace_of(leaving))
  }
  Scope {
    ..scope,
    cap: scope.cap - math.max(0, quantity_of_asset(leaving, scope.asset)),
    lovelace_cap,
  }
}

/// Whether a control output carries exactly the expected state as its
/// inline datum, compared byte for byte as data.
pub fn carries_state(output: Output, expected: AccountState) -> Bool {
  let data: Data = expected
  output.datum == InlineDatum(data)
}

/// Whether a control output carries no reference script. Every transaction
/// that spends a UTxO pays a fee for the size of the reference script it
/// holds, so a grantee could otherwise attach a large script to the state
/// it hands back and raise the cost of the owner's next spend.
pub fn carries_no_reference_script(output: Output) -> Bool {
  output.reference_script == None
}
