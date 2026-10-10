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

/// The first version of the account logic, applied to the account proxy's
/// hash. Its script hash is the credential every account on it names, so
/// the proxy requires a withdrawal from it whenever such a control UTxO is
/// spent or referenced and the ledger runs it once over the transaction.
/// Withdraw: one control UTxO naming this logic spent is the owner path,
/// one referenced the agent path, none an arrival, any other mix is refused.
/// Publish admits only the registration of the credential. The dispatch
/// is spelled out, not called from `logic`: the compiled code is final.
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
