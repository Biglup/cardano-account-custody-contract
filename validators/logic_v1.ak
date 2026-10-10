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
use aiken/crypto.{ScriptHash}
use cardano/address.{Credential, Script}
use cardano/certificate.{Certificate}
use cardano/transaction.{Input, Transaction}
use cardano_account_custody_contract/logic
use cardano_account_custody_contract/types.{LogicRedeemer}

// VALIDATORS ******************************************************************

/// The first version of the account logic, applied to the proxy's hash.
/// Its script hash is the logic credential a control datum names in
/// field 0. The proxy requires a withdrawal from it at creation and
/// whenever such a control UTxO is spent or referenced, and the ledger
/// runs it once over the whole transaction. The dispatch is written out
/// here instead of calling `logic.validates_withdrawal`, so a change to
/// that function does not change this script.
///
/// Withdraw: exactly one control UTxO naming this logic spent and none
/// referenced is the owner path, `logic.validates_owner_transaction`:
/// the control UTxO carries `Device`, no control output naming this
/// logic sits at another address, the mint under the proxy policy is
/// empty or passes `issue_grants_rule` or `burn_grants_rule` under its
/// redeemer, with `CreateAccount` returning `False`, and every input at
/// the account address passes `device_rule` for `Device` or
/// `sweep_rule` for `SweepGrant`, with `SpendWithGrant` returning
/// `False` and `Fund` left to the proxy. None
/// spent and exactly one referenced is the agent path,
/// `logic.validates_agent_transaction`: nothing is minted or burned
/// under the proxy policy, no output is a control output naming this
/// logic, and every input at the account address passes
/// `grant_spend_rule` for `SpendWithGrant`, with `Device` and
/// `SweepGrant` returning `False`. None in either is an arrival,
/// `logic.validates_arrival`, a creation or an upgrade into this logic:
/// the single control output naming this logic holds only lovelace and
/// the state NFT under a well formed state; a creation mints exactly the
/// state NFT over zero counters, an upgrade withdraws from the leaving
/// logic, raises the generation, keeps the devices and mints nothing.
/// Any other count returns `False`. Aborts on every abort of the path
/// taken.
///
/// Publish accepts `RegisterCredential` of a script credential and
/// returns `False` for every other certificate.
///
/// Every other purpose aborts.
validator logic_v1(proxy_hash: ScriptHash) {
  withdraw(_redeemer: LogicRedeemer, credential: Credential, self: Transaction) {
    expect Script(own_hash) = credential
    let is_own = fn(input: Input) {
      logic.is_own_control(input.output, proxy_hash, own_hash)
    }
    when
      (
        list.filter(self.inputs, is_own),
        list.filter(self.reference_inputs, is_own),
      )
    is {
      ([control], []) ->
        logic.validates_owner_transaction(control, own_hash, proxy_hash, self)
      ([], [control]) ->
        logic.validates_agent_transaction(
          control.output,
          own_hash,
          proxy_hash,
          self,
        )
      ([], []) -> logic.validates_arrival(own_hash, proxy_hash, self)
      _ -> False
    }
  }

  publish(
    _redeemer: LogicRedeemer,
    certificate: Certificate,
    _self: Transaction,
  ) {
    logic.publish(certificate)
  }

  else(_context) {
    fail
  }
}
