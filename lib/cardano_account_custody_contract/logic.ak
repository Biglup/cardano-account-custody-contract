//// The rules a logic version shares: the withdraw dispatch, the publish
//// handler, the owner, agent and arrival paths and the walk over the
//// proxy redeemers. A logic runs once per transaction through a
//// withdrawal from its credential. It reads the control UTxO that names
//// it, the proxy redeemers and the transaction, and returns `False` or
//// aborts on an `expect`; either makes the ledger reject the
//// transaction. `logic_v1` writes the dispatch out in its own handler
//// and calls the path functions here.

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

use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{ScriptHash}
use cardano/address.{Address, Inline, Script}
use cardano/assets
use cardano/certificate.{Certificate, RegisterCredential}
use cardano/transaction.{InlineDatum, Input, Output, Spend, Transaction}
use cardano_account_custody_contract/account as custody
use cardano_account_custody_contract/rules
use cardano_account_custody_contract/state
use cardano_account_custody_contract/types.{
  AccountRedeemer, BurnGrants, CreateAccount, Device, Fund, IssueGrants,
  SpendWithGrant, SweepGrant,
}

// FUNCTIONS *******************************************************************

/// The withdraw handler of a logic version, run as the logic whose
/// script hash is `own_hash` over the proxy at `proxy_hash`; `self` is
/// the transaction. It looks for control UTxOs whose datum names this
/// logic among the inputs and the reference inputs. Exactly one among
/// the inputs and none referenced is the owner path,
/// `validates_owner_transaction`; none among the inputs and exactly one
/// referenced is the agent path, `validates_agent_transaction`; none in
/// either is an arrival, `validates_arrival`, which creates the account
/// or receives it from another logic. Any other count, a control UTxO
/// spent and referenced at once or two accounts naming this logic,
/// returns `False`: one account per logic per transaction. `logic_v1`
/// writes this dispatch out in its own handler instead of calling it, so
/// a change here leaves its script unchanged. Aborts on every abort of
/// `is_own_control` over the inputs and the reference inputs and on
/// every abort of the path taken.
pub fn validates_withdrawal(
  own_hash: ScriptHash,
  proxy_hash: ScriptHash,
  self: Transaction,
) -> Bool {
  let is_own = fn(input: Input) {
    is_own_control(input.output, proxy_hash, own_hash)
  }
  when
    (
      list.filter(self.inputs, is_own),
      list.filter(self.reference_inputs, is_own),
    )
  is {
    ([control], []) ->
      validates_owner_transaction(control, own_hash, proxy_hash, self)
    ([], [control]) ->
      validates_agent_transaction(control.output, own_hash, proxy_hash, self)
    ([], []) -> validates_arrival(own_hash, proxy_hash, self)
    _ -> False
  }
}

/// The publish handler every logic version shares. `RegisterCredential`
/// of a script credential returns `True`, so anyone may register the
/// logic credential, which the withdrawal needs once per network.
/// `UnregisterCredential`, `DelegateCredential`,
/// `RegisterAndDelegateCredential` and every other certificate return
/// `False`, so the credential stays registered for every account on the
/// version.
pub fn publish(certificate: Certificate) -> Bool {
  when certificate is {
    RegisterCredential { credential: Script(_), .. } -> True
    _ -> False
  }
}

/// Whether `output` is the control UTxO of an account under the proxy at
/// `proxy_hash` whose datum names `own_hash`: it carries an inline datum,
/// sits at an account address, holds the state NFT of that address and
/// names the logic in its first field. The datum shape is checked first,
/// since a control UTxO always carries its state inline and a deposit
/// without a datum returns `False` on one match. Aborts when the output
/// sits at an account address, holds the state NFT of that address and
/// carries an inline datum that is not a constructor whose first field
/// is a byte string.
pub fn is_own_control(
  output: Output,
  proxy_hash: ScriptHash,
  own_hash: ScriptHash,
) -> Bool {
  when output.datum is {
    InlineDatum(data) ->
      when
        (output.address.payment_credential, output.address.stake_credential)
      is {
        (Script(payment), Some(Inline(Script(stake_script_hash)))) -> and {
            payment == proxy_hash,
            custody.holds_state_nft(output.value, proxy_hash, stake_script_hash),
            custody.logic_of(data) == own_hash,
          }
        _ -> False
      }
    _ -> False
  }
}

/// The owner path. `control` is the account's control UTxO, spent,
/// whose datum names `own_hash`, the logic running; `proxy_hash` is the
/// proxy; `self` is the transaction.
///
/// Holds when all of these hold:
///
/// - The proxy spend redeemer of `control` is `Device`.
/// - Every output that is a control output naming this logic sits at
///   the spent account's address, so the `Device` rule covers it and no
///   other account arrives at this logic unvalidated.
/// - The mint under the proxy policy is empty, or its redeemer is
///   `IssueGrants` and `issue_grants_rule` holds, or `BurnGrants` and
///   `burn_grants_rule` holds. `CreateAccount` returns `False`.
/// - Every input at the account address spent under a proxy redeemer
///   other than `Fund` passes `device_rule` for `Device` or `sweep_rule`
///   for `SweepGrant`. `SpendWithGrant` returns `False`. `Fund` is left
///   to the proxy.
///
/// Aborts when the inline datum of `control` is not an `AccountState`,
/// when the redeemers hold no spend entry for `control` or one that is
/// not an `AccountRedeemer`, on every abort of `is_own_control` over the
/// outputs away from the account address, when the mint under the proxy
/// policy is not empty and the redeemers hold no mint entry for the
/// policy or one that is not a `MintRedeemer`, and on every abort of the
/// rules it calls. Every other violation returns `False`.
pub fn validates_owner_transaction(
  control: Input,
  own_hash: ScriptHash,
  proxy_hash: ScriptHash,
  self: Transaction,
) -> Bool {
  let address = control.output.address
  let stake_script_hash = custody.stake_script_hash_of(address)
  let state = custody.state_datum(control.output)
  and {
    custody.spend_redeemer_of(self.redeemers, control.output_reference) == Device,
    list.all(
      self.outputs,
      fn(output) {
        output.address == address || !is_own_control(
          output,
          proxy_hash,
          own_hash,
        )
      },
    ),
    when assets.tokens(self.mint, proxy_hash) |> dict.to_pairs is {
      [] -> True
      minted ->
        when custody.mint_redeemer_of(self.redeemers, proxy_hash) is {
          IssueGrants ->
            rules.issue_grants_rule(
              minted,
              state,
              self,
              proxy_hash,
              stake_script_hash,
            )
          BurnGrants ->
            rules.burn_grants_rule(
              minted,
              state,
              stake_script_hash,
              self.extra_signatories,
            )
          CreateAccount -> False
        }
    },
    validates_spends(
      self,
      address,
      fn(redeemer, own) {
        when redeemer is {
          Device ->
            rules.device_rule(
              own,
              state,
              self,
              proxy_hash,
              stake_script_hash,
              own_hash,
            )
          SweepGrant ->
            rules.sweep_rule(own, state, self, proxy_hash, stake_script_hash)
          _ -> False
        }
      },
    ),
  }
}

/// The agent path. `control` is the account's control UTxO, referenced,
/// whose datum names `own_hash`, the logic running; `proxy_hash` is the
/// proxy; `self` is the transaction.
///
/// Holds when all of these hold:
///
/// - Nothing is minted or burned under the proxy policy.
/// - No output is a control output naming this logic. A referenced
///   control UTxO is never recreated and an arrival needs the arrival
///   path.
/// - Every input at the account address spent under a proxy redeemer
///   other than `Fund` carries `SpendWithGrant` and passes
///   `grant_spend_rule`. `Device` and `SweepGrant` return `False`. `Fund`
///   is left to the proxy.
///
/// Aborts when the inline datum of `control` is not an `AccountState`,
/// on every abort of `is_own_control` over the outputs, and on every
/// abort of `grant_spend_rule`. Every other violation returns `False`.
pub fn validates_agent_transaction(
  control: Output,
  own_hash: ScriptHash,
  proxy_hash: ScriptHash,
  self: Transaction,
) -> Bool {
  let address = control.address
  let stake_script_hash = custody.stake_script_hash_of(address)
  let state = custody.state_datum(control)
  and {
    custody.holds_no_account_token(self.mint, proxy_hash),
    !list.any(
      self.outputs,
      fn(output) { is_own_control(output, proxy_hash, own_hash) },
    ),
    validates_spends(
      self,
      address,
      fn(redeemer, own) {
        when redeemer is {
          SpendWithGrant ->
            rules.grant_spend_rule(
              own,
              state,
              self,
              proxy_hash,
              stake_script_hash,
            )
          _ -> False
        }
      },
    ),
  }
}

/// Whether every input at `address` spent under a proxy redeemer other
/// than `Fund` passes `rule` for that redeemer. The redeemers are walked
/// rather than the inputs, so a `Fund` deposit costs one comparison and
/// no scan: `Fund` is validated by the proxy, an input paying to the proxy
/// always carries a proxy redeemer, and a redeemer of another shape or
/// for an input elsewhere belongs to another script or account. Aborts
/// only on an abort of `rule`; every other violation returns `False`.
pub fn validates_spends(
  self: Transaction,
  address: Address,
  rule: fn(AccountRedeemer, Output) -> Bool,
) -> Bool {
  let fund: Data = Fund
  list.all(
    self.redeemers,
    fn(entry) {
      let Pair(purpose, data) = entry
      when purpose is {
        Spend(output_reference) ->
          data == fund || if data is redeemer: AccountRedeemer {
            when redeemer is {
              Fund -> True
              _ ->
                when transaction.find_input(self.inputs, output_reference) is {
                  Some(own) ->
                    own.output.address != address || rule(redeemer, own.output)
                  None -> True
                }
            }
          } else {
            True
          }
        _ -> True
      }
    },
  )
}

/// The arrival path: no control UTxO naming this logic is present, so an
/// account arrives at the logic whose script hash is `own_hash`, over
/// the proxy at `proxy_hash`; `self` is the transaction.
///
/// Holds when all of these hold:
///
/// - The single control output naming this logic holds only lovelace
///   and the state NFT.
/// - Its state is well formed.
/// - Without a control UTxO of that account among the inputs, the
///   account is created: the mint under the proxy policy is exactly the
///   state NFT in quantity 1 and the state has zero counters.
/// - With one, the account leaves another logic: the transaction
///   withdraws from the logic the spent control datum names, the new
///   generation is greater than the one it carries, the devices are the
///   same and nothing is minted or burned under the proxy policy.
///
/// No signature is checked here: at creation the stake script requires
/// the owner's, at an upgrade the leaving logic decides. Aborts on every
/// abort of `is_own_control` over the outputs, when no single output is
/// a control output naming this logic, when that output's inline datum
/// is not an `AccountState`, and, at an upgrade, once the earlier checks
/// pass, when the spent control datum is not a constructor whose first
/// field is a byte string, third an integer and second a list of byte
/// strings. Every other violation returns `False`.
pub fn validates_arrival(
  own_hash: ScriptHash,
  proxy_hash: ScriptHash,
  self: Transaction,
) -> Bool {
  expect [next] = list.filter(
    self.outputs,
    fn(output) { is_own_control(output, proxy_hash, own_hash) },
  )
  let stake_script_hash = custody.stake_script_hash_of(next.address)
  let new = custody.state_datum(next)
  and {
    custody.holds_only_lovelace_and_state_nft(
      next.value,
      proxy_hash,
      stake_script_hash,
    ),
    state.is_well_formed(new),
    when
      custody.find_control_input(self.inputs, proxy_hash, stake_script_hash)
    is {
      Some(previous) -> {
        let left = custody.inline_datum(previous.output)
        and {
          custody.withdraws_from(self.withdrawals, custody.logic_of(left)),
          new.grant_generation > custody.generation_of(left),
          new.devices == custody.devices_of(left),
          custody.holds_no_account_token(self.mint, proxy_hash),
        }
      }
      None -> and {
          ( assets.tokens(self.mint, proxy_hash) |> dict.to_pairs ) == [
            Pair(stake_script_hash, 1),
          ],
          state.has_zero_counters(new),
        }
    },
  }
}
