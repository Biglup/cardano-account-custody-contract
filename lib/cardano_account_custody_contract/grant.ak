use aiken/collection/list
use aiken/crypto.{ScriptHash, VerificationKeyHash}
use aiken/interval.{Finite}
use aiken/math
use cardano/address.{Address}
use cardano/assets.{Assets}
use cardano/transaction.{InlineDatum, Input, NoDatum, Output, ValidityRange}
use cardano_account_custody_contract/account
use cardano_account_custody_contract/state
use cardano_account_custody_contract/types.{AccountState, Asset, Grant, Scope}

/// Whether the grantee is among the transaction's required signers.
pub fn is_authorised_by_grantee(
  grantee: VerificationKeyHash,
  extra_signatories: List<VerificationKeyHash>,
) -> Bool {
  list.has(extra_signatories, grantee)
}

/// Whether the validity range ends at a finite time no later than
/// `expires_at`; an open upper bound never passes.
pub fn ends_before_expiry(
  validity_range: ValidityRange,
  expires_at: Int,
) -> Bool {
  when validity_range.upper_bound.bound_type is {
    Finite(upper_bound) -> upper_bound <= expires_at
    _ -> False
  }
}

/// The value spent from an address minus the value paid back to it, per
/// asset class; a negative quantity is a net deposit.
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

/// Whether a leaving value stays within the scope: the scoped asset within
/// its per call and remaining caps, lovelace within its caps when the
/// scoped asset is not lovelace, and nothing else leaving.
pub fn stays_within_scope(scope: Scope, leaving: Assets) -> Bool {
  let asset_leaving = quantity_of_asset(leaving, scope.asset)
  let lovelace_leaving = assets.lovelace_of(leaving)
  and {
    asset_leaving <= scope.per_call_cap,
    asset_leaving <= scope.cap,
    or {
      state.is_lovelace(scope.asset),
      and {
        lovelace_leaving <= scope.lovelace_per_call_cap,
        lovelace_leaving <= scope.lovelace_cap,
      },
    },
    nothing_else_leaves(leaving, scope.asset),
  }
}

/// Whether only the scoped asset and lovelace have a positive leaving
/// quantity.
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

/// Whether every output away from the account goes to a listed recipient;
/// an empty list allows any destination.
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
/// output, carries no datum. See README, Agent spend checks.
pub fn deposits_carry_no_datum(
  outputs: List<Output>,
  account_address: Address,
  script_hash: ScriptHash,
  stake_script_hash: ScriptHash,
) -> Bool {
  list.all(
    outputs,
    fn(output) {
      or {
        output.address != account_address,
        account.holds_state_nft(output.value, script_hash, stake_script_hash),
        output.datum == NoDatum,
      }
    },
  )
}

/// Whether exactly one control UTxO of the account is spent.
pub fn spends_one_control_utxo(
  inputs: List<Input>,
  script_hash: ScriptHash,
  stake_script_hash: ScriptHash,
) -> Bool {
  list.count(
    inputs,
    fn(input) {
      account.is_control_output(input.output, script_hash, stake_script_hash)
    },
  ) == 1
}

/// The state after a grant spend: unchanged except that the used grant's
/// remaining caps are reduced by the net outflow, never increased.
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

/// The scope with each remaining cap reduced by max(0, net outflow) of its
/// asset; per call caps never change.
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

/// Whether the output's inline datum equals the expected state as data.
pub fn carries_state(output: Output, expected: AccountState) -> Bool {
  let data: Data = expected
  output.datum == InlineDatum(data)
}

/// Whether the output carries no reference script. See README, Agent spend
/// checks.
pub fn carries_no_reference_script(output: Output) -> Bool {
  output.reference_script == None
}
