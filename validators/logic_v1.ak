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
/// This version is the shared rules of `logic` and nothing beyond them.
/// The dispatch over the control UTxOs is written out in the handler and
/// the path functions come from `logic`: a call to
/// `logic.validates_withdrawal` in its place compiles to different code,
/// and the compiled code of this version is final, since its applied
/// hash is the credential every account on it names.
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
