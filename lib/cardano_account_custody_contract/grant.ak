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

/// Whether the validity range starts at a finite time after `expires_at`,
/// so that the transaction can only apply once the grant has expired; an
/// open lower bound never passes.
pub fn starts_after_expiry(
  validity_range: ValidityRange,
  expires_at: Int,
) -> Bool {
  when validity_range.lower_bound.bound_type is {
    Finite(lower_bound) -> lower_bound > expires_at
    _ -> False
  }
}

/// Whether a grant can no longer be spent against the account's current
/// state, judged from the stable prefix of its datum: issued under an
/// older generation or revoked by slot. Expiry, as the validity range
/// proves it, lives in the scope and so counts only when the datum
/// decodes as a full `Grant`; a grant of another shape, issued under
/// another revision, dies by generation or revocation alone. Fails on a
/// datum without the prefix.
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

/// Whether a grant is current against the account's state: issued under
/// its generation and not revoked by slot. Expiry is the validity range's
/// business.
pub fn is_current(grant: Grant, state: AccountState) -> Bool {
  grant.generation == state.grant_generation && !list.has(
    state.revoked,
    grant.slot,
  )
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

/// Whether every output paid back to the account that holds no account
/// token is a plain deposit: no datum and no reference script. See README,
/// Agent spend checks.
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

/// Whether exactly one input holds a token of the account, so that the
/// accounting runs over a single grant and never over the control UTxO.
pub fn spends_one_account_token(
  inputs: List<Input>,
  script_hash: ScriptHash,
  stake_script_hash: ScriptHash,
) -> Bool {
  account.count_account_token_inputs(inputs, script_hash, stake_script_hash) == 1
}

/// The grant after a spend: unchanged except that its remaining caps are
/// reduced by the net outflow, never increased.
pub fn grant_after_spend(grant: Grant, leaving: Assets) -> Grant {
  Grant { ..grant, scope: scope_after_spend(grant.scope, leaving) }
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

/// Whether the output's inline datum is a grant within `expected`, the
/// grant after the spend: every field equal but the remaining caps, each
/// at most the expected one and at least zero. The fee is part of the
/// outflow, so an exact datum would depend on the execution units a
/// builder only learns by evaluating the transaction; a grantee that
/// decrements its own caps further costs itself headroom and nothing
/// else, and caps still never increase. A datum given by hash or missing
/// never passes.
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
/// expiry and recipients are equal.
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

/// Whether the output carries no reference script. See README, Agent spend
/// checks.
pub fn carries_no_reference_script(output: Output) -> Bool {
  output.reference_script == None
}
