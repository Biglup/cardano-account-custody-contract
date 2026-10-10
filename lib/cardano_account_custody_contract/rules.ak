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
use cardano/assets.{AssetName}
use cardano/transaction.{Output, Transaction}
use cardano_account_custody_contract/account as custody
use cardano_account_custody_contract/grant.{
  carries_grant_within, carries_no_reference_script, deposits_are_plain,
  ends_before_expiry, grant_after_spend, is_authorised_by_grantee, is_current,
  is_dead, leaving_value, pays_only_recipients, spends_one_account_token,
  stays_within_scope,
}
use cardano_account_custody_contract/state
use cardano_account_custody_contract/types.{AccountState}

// FUNCTIONS *******************************************************************

/// The owner path on the control UTxO: `own` is the spent UTxO carrying
/// the `Device` redeemer and `old` the state of the account's control
/// UTxO, which the logic found spent and pointing at `own_hash`. The UTxO
/// is the control UTxO; a device signs; every account token in the inputs
/// and outputs sits at its own account address; a single valid control
/// output recreates the NFT, under this logic with a non decreasing
/// generation and counters that follow the grant tokens minted and
/// burned, or under another logic as an upgrade.
pub fn device_rule(
  own: Output,
  old: AccountState,
  self: Transaction,
  proxy_hash: ScriptHash,
  stake_script_hash: ScriptHash,
  own_hash: ScriptHash,
) -> Bool {
  and {
    custody.holds_state_nft(own.value, proxy_hash, stake_script_hash),
    custody.is_signed_by_a_device(old, self.extra_signatories),
    custody.tokens_sit_at_their_own_addresses(
      list.map(self.inputs, fn(input) { input.output }),
      proxy_hash,
    ),
    custody.tokens_sit_at_their_own_addresses(self.outputs, proxy_hash),
    recreates_control_output(old, self, proxy_hash, stake_script_hash, own_hash),
  }
}

/// The agent path on a grant UTxO: `own` is the spent UTxO carrying the
/// `SpendWithGrant` redeemer and `control_state` the state of the
/// account's control UTxO, which the logic found referenced and pointing
/// at itself. The UTxO holds only lovelace and its token and is the only
/// account token among the inputs; the grant is current against the
/// control state; the grantee signs; the validity range ends before the
/// grant expires; the leaving value stays within the scope caps; outputs
/// away from the account go to allowed recipients; deposits paid back are
/// plain; placement holds; the single grant output sits at the same
/// address with the same value, carries the grant with every field as
/// spent but its remaining caps, each reduced by at least what left and
/// never below zero, and no reference script; nothing is minted under the
/// policy. Placement already pins the grant output to the account
/// address, so the address rule on it is defence in depth.
pub fn grant_spend_rule(
  own: Output,
  control_state: AccountState,
  self: Transaction,
  proxy_hash: ScriptHash,
  stake_script_hash: ScriptHash,
) -> Bool {
  let grant = custody.grant_datum(own)
  let address = own.address
  let leaving = leaving_value(self.inputs, self.outputs, address)
  expect Some(grant_output) = custody.find_grant_output(
    self.outputs,
    proxy_hash,
    stake_script_hash,
    grant.slot,
  )
  and {
    custody.holds_only_lovelace_and_grant_token(
      own.value,
      proxy_hash,
      stake_script_hash,
      grant.slot,
    ),
    spends_one_account_token(self.inputs, proxy_hash, stake_script_hash),
    is_current(grant, control_state),
    is_authorised_by_grantee(grant.grantee, self.extra_signatories),
    ends_before_expiry(self.validity_range, grant.scope.expires_at),
    stays_within_scope(grant.scope, leaving),
    pays_only_recipients(self.outputs, address, grant.scope.recipients),
    deposits_are_plain(self.outputs, address, proxy_hash, stake_script_hash),
    custody.tokens_sit_at_their_own_addresses(
      list.map(self.inputs, fn(input) { input.output }),
      proxy_hash,
    ),
    custody.tokens_sit_at_their_own_addresses(self.outputs, proxy_hash),
    grant_output.address == address,
    grant_output.value == own.value,
    carries_grant_within(grant_output, grant_after_spend(grant, leaving)),
    carries_no_reference_script(grant_output),
    custody.holds_no_account_token(self.mint, proxy_hash),
  }
}

/// The owner path on a dead grant UTxO: `own` is the spent UTxO carrying
/// the `SweepGrant` redeemer and `control_state` the state of the
/// account's control UTxO, which the logic found spent. The UTxO holds
/// only lovelace and its token, a device signs, the grant is dead and its
/// token is burned. The grant is read through the stable prefix of its
/// datum, so a grant issued under another revision of the grant shape is
/// swept once its generation or its slot is dead.
pub fn sweep_rule(
  own: Output,
  control_state: AccountState,
  self: Transaction,
  proxy_hash: ScriptHash,
  stake_script_hash: ScriptHash,
) -> Bool {
  let data = custody.inline_datum(own)
  let slot = custody.grant_slot_of(data)
  and {
    custody.holds_only_lovelace_and_grant_token(
      own.value,
      proxy_hash,
      stake_script_hash,
      slot,
    ),
    custody.is_signed_by_a_device(control_state, self.extra_signatories),
    is_dead(data, control_state, self.validity_range),
    assets.quantity_of(
      self.mint,
      proxy_hash,
      custody.grant_token_name(stake_script_hash, slot),
    ) == -1,
  }
}

/// The `IssueGrants` mint over `minted`, the tokens minted under the
/// policy, with `old` the state of the account's spent control UTxO: a
/// device signs; the minted names are the next slots in order, each in
/// quantity one, each in exactly one output at the account address
/// holding only lovelace and that token, with no reference script and a
/// well formed grant of that slot and the recreated control's generation.
pub fn issue_grants_rule(
  minted: Pairs<AssetName, Int>,
  old: AccountState,
  self: Transaction,
  proxy_hash: ScriptHash,
  stake_script_hash: ScriptHash,
) -> Bool {
  expect Some(control) = custody.find_control_output(
    self.outputs,
    proxy_hash,
    stake_script_hash,
  )
  let new = custody.state_datum(control)
  and {
    custody.is_signed_by_a_device(old, self.extra_signatories),
    list.indexed_foldr(
      minted,
      True,
      fn(index, token, ok) {
        ok && issues_grant(
          token,
          old.next_slot + index,
          new.grant_generation,
          self.outputs,
          proxy_hash,
          stake_script_hash,
        )
      },
    ),
  }
}

/// The `BurnGrants` mint over `minted`, the tokens minted under the
/// policy, with `old` the state of the account's spent control UTxO: a
/// device signs and every entry burns one grant token of the account.
pub fn burn_grants_rule(
  minted: Pairs<AssetName, Int>,
  old: AccountState,
  stake_script_hash: ScriptHash,
  extra_signatories: List<VerificationKeyHash>,
) -> Bool {
  and {
    custody.is_signed_by_a_device(old, extra_signatories),
    list.all(
      minted,
      fn(token) {
        let Pair(name, quantity) = token
        and {
          quantity == -1,
          custody.is_grant_name(name),
          custody.account_of_name(name) == stake_script_hash,
        }
      },
    ),
  }
}

/// Whether exactly one output at the account address holds the state NFT
/// and recreates the control UTxO. When its datum names this logic, the
/// output is a valid control output whose state follows from `old`: a
/// non decreasing generation, and counters moved by the grant tokens
/// minted and burned. When it names another logic, the account is
/// leaving: this logic only requires that the new logic runs, through a
/// withdrawal, and that nothing is minted or burned under the policy
/// while no logic ties the counters to the mint; the arriving logic
/// validates the state. Fails when no single control output exists or
/// its datum has no logic field.
pub fn recreates_control_output(
  old: AccountState,
  self: Transaction,
  proxy_hash: ScriptHash,
  stake_script_hash: ScriptHash,
  own_hash: ScriptHash,
) -> Bool {
  expect Some(control) = custody.find_control_output(
    self.outputs,
    proxy_hash,
    stake_script_hash,
  )
  let data = custody.inline_datum(control)
  let next_logic = custody.logic_of(data)
  if next_logic == own_hash {
    expect new: AccountState = data
    let (minted, burned) = custody.grant_mint_delta(
      self.mint,
      proxy_hash,
      stake_script_hash,
    )
    and {
      custody.holds_only_lovelace_and_state_nft(
        control.value,
        proxy_hash,
        stake_script_hash,
      ),
      state.is_well_formed(new),
      new.grant_generation >= old.grant_generation,
      new.next_slot == old.next_slot + minted,
      new.outstanding == old.outstanding + minted - burned,
    }
  } else {
    and {
      custody.withdraws_from(self.withdrawals, next_logic),
      custody.holds_no_account_token(self.mint, proxy_hash),
    }
  }
}

/// Whether a minted entry is one grant token named after `slot`, landing in
/// exactly one output at the account address that holds only lovelace and
/// that token, carries no reference script, and carries a well formed grant
/// of that slot issued under `generation`. Fails when the token lands in no
/// output or in several, or under a datum that is not a grant.
pub fn issues_grant(
  token: Pair<AssetName, Int>,
  slot: Int,
  generation: Int,
  outputs: List<Output>,
  proxy_hash: ScriptHash,
  stake_script_hash: ScriptHash,
) -> Bool {
  let Pair(name, quantity) = token
  expect Some(grant_output) = custody.find_token_output(
    outputs,
    proxy_hash,
    name,
  )
  let grant = custody.grant_datum(grant_output)
  and {
    quantity == 1,
    name == custody.grant_token_name(stake_script_hash, slot),
    grant_output.address == custody.account_address(
      proxy_hash,
      stake_script_hash,
    ),
    assets.has_nft_strict(grant_output.value, proxy_hash, name),
    carries_no_reference_script(grant_output),
    grant.slot == slot,
    grant.generation == generation,
    state.is_grant_well_formed(grant),
  }
}
