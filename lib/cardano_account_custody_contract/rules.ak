//// The rules a logic version applies, one per proxy redeemer:
//// `device_rule` and `sweep_rule` for the inputs of the owner path,
//// `grant_spend_rule` for the input of the agent path, `issue_grants_rule`
//// and `burn_grants_rule` for the mint, with `recreates_control_output`
//// and `issues_grant` as their parts. The owner and agent paths in `logic`
//// call them. Every rule returns `False` or aborts on an `expect` or a
//// `fail`; both make the ledger reject the transaction, and each rule
//// says which violation does what.

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

/// The owner path on the control UTxO. `own` is the spent UTxO, which
/// carries `Device`; `old` is the state of the account's control UTxO,
/// spent in the same transaction; `self` is the transaction;
/// `proxy_hash` and `stake_script_hash` name the account; `own_hash` is
/// the logic running.
///
/// Holds when all of these hold:
///
/// - `own` holds the state NFT of the account.
/// - A device of `old` is among the required signers.
/// - Every account token in the inputs and in the outputs sits, in
///   quantity one, at the address its name denotes.
/// - `recreates_control_output` holds: a single control output recreates
///   the control UTxO, under this logic with a well formed state, a non
///   decreasing generation and counters that follow the grant tokens
///   minted and burned, or under another logic that runs, as an upgrade.
///
/// Aborts, once the earlier checks pass, on every abort of
/// `recreates_control_output`. Every other violation returns `False`.
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

/// The agent path on a grant UTxO. `own` is the spent UTxO, which
/// carries `SpendWithGrant`; `control_state` is the state of the
/// account's control UTxO, referenced in the same transaction; `self` is
/// the transaction; `proxy_hash` and `stake_script_hash` name the
/// account.
///
/// Holds when all of these hold:
///
/// - `own` holds only lovelace and the grant token of the slot in its
///   datum, and is the only input holding a token of the account.
/// - The grant is current against `control_state`.
/// - The grantee is among the required signers.
/// - The validity range has a finite upper bound no later than
///   `expires_at`.
/// - The leaving value at the account address stays within the scope.
/// - With a non empty recipient list, every output is at the account
///   address or at a recipient.
/// - Every output to the account address without an account token has
///   no datum and no reference script.
/// - Every account token in the inputs and in the outputs sits, in
///   quantity one, at the address its name denotes.
/// - The grant output sits at the address of `own`, holds the same
///   value, carries the spent grant with only `cap` and `lovelace_cap`
///   changed, each at least zero and at most the old cap lowered by the
///   net outflow of its asset when that outflow is positive, with
///   `lovelace_cap` left as it is for a lovelace scope, and carries no
///   reference script.
/// - Nothing is minted or burned under the proxy policy.
///
/// Aborts when `own` carries no inline datum or one that is not a
/// `Grant`, when the slot in that datum does not fit 4 bytes, when the
/// grant token of that slot is in no output or in several, and, once
/// the earlier checks pass, when the grant output's inline datum is not
/// a `Grant`. Every other violation returns `False`. Placement already
/// pins the grant output to the account address; the address check on
/// it is defence in depth.
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

/// The owner path on a dead grant UTxO. `own` is the spent UTxO, which
/// carries `SweepGrant`; `control_state` is the state of the account's
/// control UTxO, spent in the same transaction; `self` is the
/// transaction; `proxy_hash` and `stake_script_hash` name the account.
/// The grant is judged from the stable prefix of the datum of `own`,
/// and from its expiry only when the datum decodes as a `Grant`, so a
/// grant of another logic version's shape is swept once its generation
/// or its slot is dead.
///
/// Holds when all of these hold:
///
/// - `own` holds only lovelace and the grant token of the slot in field
///   0 of its datum.
/// - A device of `control_state` is among the required signers.
/// - The grant is dead against `control_state` and the validity range:
///   issued under a lower generation, revoked by slot, or, when the
///   datum is a `Grant`, with a validity range starting after its expiry.
/// - The mint burns exactly one of that grant token.
///
/// Aborts when `own` carries no inline datum, when the datum is not a
/// constructor whose first field is an integer, when the slot does not
/// fit 4 bytes and, once the value and signature checks pass, when the
/// third field of the datum is not an integer. Every other violation
/// returns `False`.
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

/// The `IssueGrants` rule of the owner path. `minted` is the mint under
/// the proxy policy, ascending by name as the ledger lists it; `old` is
/// the state of the spent control UTxO; `self` is the transaction;
/// `proxy_hash` and `stake_script_hash` name the account.
///
/// Holds when all of these hold:
///
/// - A device of `old` is among the required signers.
/// - The entry at index `i` of `minted` passes `issues_grant` for slot
///   `old.next_slot + i` and the generation the single control output
///   carries.
///
/// A grant token name ends in its slot as 4 big endian bytes, so the
/// sorted mint names exactly the next slots, consecutive and in order,
/// or some entry's name differs from the name of its slot and
/// `issues_grant` returns `False` for it once its own aborts are passed.
/// The counters of the new state are checked by
/// `recreates_control_output`, not here.
///
/// Aborts when the outputs hold no single control output of the account,
/// when its inline datum is not an `AccountState`, and on every abort of
/// `issues_grant`. Every other violation returns `False`.
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

/// The `BurnGrants` rule of the owner path. `minted` is the mint under
/// the proxy policy; `old` is the state of the spent control UTxO;
/// `stake_script_hash` names the account; `extra_signatories` are the
/// required signers.
///
/// Holds when all of these hold:
///
/// - A device of `old` is among `extra_signatories`.
/// - Every entry of `minted` is a grant token of the account, a 32 byte
///   name with the stake script hash as prefix, in quantity -1.
///
/// Nothing aborts; every violation returns `False`. Whether each burned
/// grant is dead is checked by `sweep_rule` on its grant UTxO, not here.
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

/// Whether the single control output recreates the control UTxO from
/// `old`, the state of the spent control UTxO. `self` is the
/// transaction; `proxy_hash` and `stake_script_hash` name the account;
/// `own_hash` is the logic running.
///
/// When the output's datum names this logic, holds when all of these
/// hold:
///
/// - The output holds only lovelace and the state NFT.
/// - The new state is well formed.
/// - Its generation is at least the generation of `old`.
/// - Its next slot is the next slot of `old` plus the grant tokens
///   minted.
/// - Its outstanding count is the count of `old` plus the grant tokens
///   minted minus the grant tokens burned.
///
/// When the datum names another logic, the account leaves: holds when
/// the transaction withdraws from that logic and nothing is minted or
/// burned under the proxy policy, so no counter moves while no logic
/// ties the counters to the mint. The arriving logic validates the
/// state.
///
/// Aborts when the outputs hold no single control output of the account
/// and when its inline datum is not a constructor whose first field is a
/// byte string. When that field names this logic, also aborts when the
/// datum is not an `AccountState` and when the mint under the proxy
/// policy holds a token that is not a grant token of the account or a
/// grant token in a quantity other than 1 or -1. Every other violation
/// returns `False`.
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

/// Whether `token`, one entry of the mint under the proxy policy, issues
/// the grant of `slot` under `generation` into `outputs`. `proxy_hash`
/// and `stake_script_hash` name the account.
///
/// Holds when all of these hold:
///
/// - The entry is in quantity 1.
/// - Its name is the grant token name of `slot`.
/// - The single output holding the token sits at the account address.
/// - That output holds only lovelace and the token.
/// - It carries no reference script.
/// - Its inline datum is a `Grant` whose slot is `slot`, whose
///   generation is `generation` and whose scope is well formed.
///
/// Aborts when the token is in no output or in several, when that
/// output's datum is missing, given by hash or not a `Grant`, and, once
/// the quantity check passes, when `slot` does not fit 4 bytes. Every
/// other violation returns `False`.
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
