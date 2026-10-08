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
use cardano/address.{Address, Credential, Inline, Script}
use cardano/assets
use cardano/certificate.{Certificate, RegisterCredential}
use cardano/transaction.{InlineDatum, Input, Output, Spend, Transaction}
use cardano_account_custody_contract/account as custody
use cardano_account_custody_contract/rules
use cardano_account_custody_contract/state
use cardano_account_custody_contract/types.{
  AccountRedeemer, BurnGrants, CreateAccount, Device, Fund, IssueGrants,
  LogicRedeemer, SpendWithGrant, SweepGrant,
}

// VALIDATORS ******************************************************************

/// The first version of the account logic, applied to the account proxy's
/// hash. Its script hash is a stake credential the proxy requires a
/// withdrawal from whenever a control UTxO naming it is spent or
/// referenced, so the ledger runs it once per transaction with the whole
/// transaction as context. The withdrawal's amount is not read: zero in
/// practice, a non zero amount is accepted and harmless, since the
/// reward account is the logic's own. An owner points an account at a
/// later version with a device rewrite of the first field of the control
/// datum, carrying a withdrawal from this logic and from the next one;
/// any registered script credential may be named, and the signer's list
/// of known logic hashes is the gate against an unknown one. See README,
/// Design.
///
/// Withdraw: the control UTxOs whose datum names this logic are looked up
/// among the inputs and the reference inputs. Exactly one, spent, is the
/// owner path: the control UTxO carries `Device`, every other input at the
/// account address carries `Fund`, validated by the proxy, or `SweepGrant`,
/// which reads only the stable prefix of the grant datum, so a grant of
/// another shape is swept by generation or revocation and never by expiry,
/// and a mint under the policy carries `IssueGrants` or `BurnGrants`; the
/// `Device` rule recreates the control output under this logic or, when
/// the output names another logic, requires that logic to run as well;
/// every control output naming this logic sits at the spent account's
/// address, so no other account arrives at this logic on the side.
/// Exactly one, referenced, is the agent path: every input at the account
/// address carries `Fund` or `SpendWithGrant`, nothing is minted under
/// the policy and no control output names this logic, so no account
/// arrives on the side. None is an arrival, the only path that admits a
/// control output naming this logic for an account whose control UTxO
/// this logic did not find: exactly one control output names this logic
/// and carries a well formed state; at creation, the state NFT is the
/// only mint and the counters are zero; at an upgrade, the account's
/// control UTxO is spent under another logic, which must run as well, the
/// generation grows strictly so every grant issued before is dead, the
/// devices stay the same and nothing is minted under the policy. Two
/// control UTxOs naming this logic, spent and referenced at once or of two
/// accounts, are refused: one account per logic version per transaction,
/// so two accounts under different logics cannot share a transaction when
/// either mints, since each logic validates the mint as its own account's.
///
/// Publish: the credential may be registered by anyone, which the
/// withdrawal needs once; every other certificate is refused, so the
/// credential stays registered for every account on this version.
validator logic_v1(proxy_hash: ScriptHash) {
  withdraw(_redeemer: LogicRedeemer, credential: Credential, self: Transaction) {
    expect Script(own_hash) = credential
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

  publish(
    _redeemer: LogicRedeemer,
    certificate: Certificate,
    _self: Transaction,
  ) {
    when certificate is {
      RegisterCredential { credential: Script(_), .. } -> True
      _ -> False
    }
  }

  else(_context) {
    fail
  }
}

// FUNCTIONS *******************************************************************

/// Whether an output is the control UTxO of an account under the proxy
/// whose datum names `own_hash`: it carries an inline datum, sits at an
/// account address, holds the state NFT of that address and names the
/// logic in its first field. The datum shape is checked first, since a
/// control UTxO always carries its state inline and a deposit fails on
/// one match.
fn is_own_control(
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

/// The owner path: `control` is the account's control UTxO, spent. It
/// carries `Device`; every control output naming this logic sits at the
/// account address, so the `Device` rule covers it and no other account
/// arrives at this logic unvalidated; the mint under the policy, if any,
/// passes the rule its proxy redeemer names; every input at the account
/// address passes the rule its proxy redeemer names, with
/// `SpendWithGrant` refused and `Fund` left to the proxy.
fn validates_owner_transaction(
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

/// The agent path: `control` is the account's control UTxO, referenced.
/// Nothing is minted under the policy, no control output names this
/// logic, since a referenced control UTxO is never recreated and an
/// arrival needs the arrival path, and every input at the account
/// address carries `Fund`, validated by the proxy, or `SpendWithGrant`
/// and passes its rule.
fn validates_agent_transaction(
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
/// for an input elsewhere belongs to another script or account.
fn validates_spends(
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

/// No control UTxO naming this logic is present, so an account arrives:
/// exactly one control output names this logic, holds only lovelace and
/// the state NFT and carries a well formed state. Without a control UTxO
/// of that account among the inputs the account is being created and the
/// state NFT must be the only mint under the policy, over zero counters.
/// With one, the account leaves another logic, which must run as well;
/// the generation grows strictly, the devices stay the same and nothing
/// is minted under the policy. Fails without a single such output.
fn validates_arrival(
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
