//// The checks of a grant spend and of a sweep under `logic_v1`: the
//// grantee's signature, the expiry against the validity range, whether a
//// grant is current or dead, the leaving value against the scope caps,
//// the recipients, the deposits paid back and the grant written back.
//// `grant_spend_rule` and `sweep_rule` call them. Each returns `False`
//// on a violation; the ones that decode a datum abort and say so.

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
use aiken/interval.{Finite}
use aiken/math
use cardano/address.{Address}
use cardano/assets.{Assets}
use cardano/transaction.{InlineDatum, Input, NoDatum, Output, ValidityRange}
use cardano_account_custody_contract/account
use cardano_account_custody_contract/state
use cardano_account_custody_contract/types.{AccountState, Asset, Grant, Scope}

// FUNCTIONS *******************************************************************

/// Whether `grantee` is among `extra_signatories`, the transaction's
/// required signers. Returns `False` otherwise. Never aborts.
pub fn is_authorised_by_grantee(
  grantee: VerificationKeyHash,
  extra_signatories: List<VerificationKeyHash>,
) -> Bool {
  list.has(extra_signatories, grantee)
}

/// Whether `validity_range` has a finite upper bound at or before
/// `expires_at`, both POSIX times in milliseconds. An open upper bound
/// returns `False`. The bound's inclusivity flag is not read. Never
/// aborts.
pub fn ends_before_expiry(
  validity_range: ValidityRange,
  expires_at: Int,
) -> Bool {
  when validity_range.upper_bound.bound_type is {
    Finite(upper_bound) -> upper_bound <= expires_at
    _ -> False
  }
}

/// Whether `validity_range` has a finite lower bound strictly after
/// `expires_at`, both POSIX times in milliseconds, so the transaction
/// can only apply once the grant has expired. An open lower bound
/// returns `False`. The bound's inclusivity flag is not read. Never
/// aborts.
pub fn starts_after_expiry(
  validity_range: ValidityRange,
  expires_at: Int,
) -> Bool {
  when validity_range.lower_bound.bound_type is {
    Finite(lower_bound) -> lower_bound > expires_at
    _ -> False
  }
}

/// Whether the grant datum `data` is dead against `state`, the state of
/// the control UTxO, judged from the stable prefix of the datum: its
/// generation is lower than the state's, or its slot is in the revoked
/// list, or `validity_range` starts after its expiry. Expiry lives in the
/// scope, so it counts only when `data` decodes as a full `Grant`; a
/// grant of another shape, issued under another logic version, dies by
/// generation or revocation alone. Returns `False` otherwise. Aborts
/// when `data` is not a constructor whose third field is an integer and,
/// once the generation is not lower, whose first field is an integer.
pub fn is_dead(
  data: Data,
  state: AccountState,
  validity_range: ValidityRange,
) -> Bool {
  or {
    account.grant_generation_of(data) < state.grant_generation,
    list.has(state.revoked, account.grant_slot_of(data)),
    if data is grant: Grant {
      starts_after_expiry(validity_range, grant.scope.expires_at)
    } else {
      False
    },
  }
}

/// Whether `grant` is current against `state`: its generation equals
/// the state's and its slot is not in the revoked list. Expiry is not
/// read here; `ends_before_expiry` checks it. Returns `False` otherwise.
/// Never aborts.
pub fn is_current(grant: Grant, state: AccountState) -> Bool {
  grant.generation == state.grant_generation && !list.has(
    state.revoked,
    grant.slot,
  )
}

/// The value of every input at `address` minus the value of every
/// output to it, per asset class in its own unit. The address is
/// compared whole, stake part included. A positive quantity is a net
/// outflow and includes the fee when the account pays it; a negative
/// quantity is a net deposit. Never aborts.
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

/// The quantity of `asset` in `value`, in the asset's own unit; zero
/// when the value holds none of it. Never aborts.
pub fn quantity_of_asset(value: Assets, asset: Asset) -> Int {
  assets.quantity_of(value, asset.policy_id, asset.asset_name)
}

/// Whether `leaving`, a leaving value, stays within `scope`: the scoped
/// asset within its per call cap and its remaining cap, lovelace within
/// its two caps for a token scope, and no other asset class with a
/// positive quantity. A net deposit of the scoped asset or of lovelace
/// passes its caps. Returns `False` when a cap is exceeded or another
/// asset leaves. Never aborts.
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

/// Whether only `asset` and lovelace have a positive quantity in
/// `leaving`. Never aborts.
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

/// Whether every output not at `account_address` goes to one of
/// `recipients`, addresses compared whole, stake part included. An empty
/// list allows any destination. Returns `False` on the first output
/// elsewhere. Never aborts.
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

/// Whether every output at `account_address` that holds no account
/// token is a plain deposit: no datum and no reference script. Outputs
/// elsewhere and outputs holding an account token are not read further.
/// Returns `False` on a deposit with a datum or a reference script.
/// Never aborts.
pub fn deposits_are_plain(
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
        account.holds_account_token(output, script_hash, stake_script_hash),
        output.datum == NoDatum && output.reference_script == None,
      }
    },
  )
}

/// Whether exactly one of `inputs` holds a token of the account, so that
/// the accounting runs over a single grant and never over the control
/// UTxO. Returns `False` on none or several. Never aborts.
pub fn spends_one_account_token(
  inputs: List<Input>,
  script_hash: ScriptHash,
  stake_script_hash: ScriptHash,
) -> Bool {
  account.count_account_token_inputs(inputs, script_hash, stake_script_hash) == 1
}

/// The grant as a spend leaves it: every field as before, `cap` lowered
/// by the net outflow of the scoped asset when that is positive and, for
/// a token scope, `lovelace_cap` lowered by the net outflow of lovelace
/// when positive. A net deposit lowers nothing. For a lovelace scope
/// `lovelace_cap` stays as it is. Per call caps never change. Never
/// aborts.
pub fn grant_after_spend(grant: Grant, leaving: Assets) -> Grant {
  Grant { ..grant, scope: scope_after_spend(grant.scope, leaving) }
}

/// The scope with each remaining cap lowered by max(0, net outflow) of
/// its asset; per call caps never change. Never aborts.
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

/// Whether `output` carries, as its inline datum, `expected` with its
/// remaining caps lowered: every field equal but `cap` and
/// `lovelace_cap`, each at least zero and at most the expected one.
/// `expected` already has its caps reduced by the net outflow, so a
/// grantee may lower its own caps further and never raise them; an
/// exact datum would depend on the fee, which a builder learns only by
/// evaluating the transaction. Returns `False` when the datum is missing
/// or given by hash. Aborts when the inline datum is not a `Grant`.
pub fn carries_grant_within(output: Output, expected: Grant) -> Bool {
  when output.datum is {
    InlineDatum(data) -> {
      expect actual: Grant = data
      is_grant_within(actual, expected)
    }
    _ -> False
  }
}

/// Whether `actual` is `expected` with its remaining caps lowered, each
/// no further than zero: slot, grantee, generation, asset, per call caps,
/// expiry and recipients are equal. Never aborts.
fn is_grant_within(actual: Grant, expected: Grant) -> Bool {
  and {
    Grant {
      ..actual,
      scope: Scope {
        ..actual.scope,
        cap: expected.scope.cap,
        lovelace_cap: expected.scope.lovelace_cap,
      },
    } == expected,
    actual.scope.cap >= 0,
    actual.scope.cap <= expected.scope.cap,
    actual.scope.lovelace_cap >= 0,
    actual.scope.lovelace_cap <= expected.scope.lovelace_cap,
  }
}

/// Whether `output` carries no reference script. Returns `False` when it
/// carries one. Never aborts.
pub fn carries_no_reference_script(output: Output) -> Bool {
  output.reference_script == None
}
