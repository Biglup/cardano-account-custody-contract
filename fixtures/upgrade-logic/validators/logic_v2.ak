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

// A throwaway logic script, built only to prove the owner upgrade path of
// the account custody contract against a chain. It is not a version of
// the contract: no account runs it, it is absent from the contract's
// blueprint and it is shipped nowhere. The upgrade rewrites the logic
// hash in an account's control datum while the logic the account leaves
// and the logic it arrives at both run, so proving it needs a second
// logic script whose code differs from the deployed one. This is that
// second script, and the bound below is the whole of the difference.

// USINGS **********************************************************************

use aiken/collection/dict
use aiken/crypto.{ScriptHash}
use cardano/address.{Credential, Script}
use cardano/assets.{Assets, PolicyId}
use cardano/certificate.{Certificate}
use cardano/transaction.{Transaction}
use cardano_account_custody_contract/logic
use cardano_account_custody_contract/types.{LogicRedeemer}

// CONSTANTS *******************************************************************

/// The most tokens one transaction may mint or burn under the proxy
/// policy while an account names this logic. Every such token is a
/// grant token on the owner path or the state NFT at creation, so it
/// bounds the grants one issuance or one sweep handles. `logic_v1` has
/// no such bound. `mints_within_batch` enforces it on every withdrawal.
pub const max_grant_batch = 8

// VALIDATORS ******************************************************************

/// The second logic of the upgrade proof, applied to the proxy's hash
/// like `logic_v1`. Its script hash is the logic credential a control
/// datum names in field 0 while an account runs it.
///
/// Withdraw: `logic.validates_withdrawal` holds, the owner, agent and
/// arrival paths with the one control UTxO per transaction rule, and the
/// mint under the proxy policy holds at most `max_grant_batch` entries.
/// The shared rules admit only grant tokens of the account on the owner
/// path and the state NFT alone at creation, so the bound is a bound on
/// grants issued or swept; an issuance or a sweep of more grants returns
/// `False` here where `logic_v1` has no such bound. The bound is visible
/// from the outside, which is what makes the move observable; it is not
/// a rule the contract wants. Aborts on every abort of the path taken.
///
/// An account moves here from `logic_v1` with the upgrade the shared
/// arrival path validates, the generation raised so that every grant
/// issued before is dead, and moves back the same way.
///
/// Publish accepts `RegisterCredential` of a script credential and
/// returns `False` for every other certificate.
///
/// Every other purpose aborts.
validator logic_v2(proxy_hash: ScriptHash) {
  withdraw(_redeemer: LogicRedeemer, credential: Credential, self: Transaction) {
    expect Script(own_hash) = credential
    and {
      logic.validates_withdrawal(own_hash, proxy_hash, self),
      mints_within_batch(self.mint, proxy_hash),
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

// FUNCTIONS *******************************************************************

/// Whether the mint under the proxy policy holds at most
/// `max_grant_batch` entries, each a token minted or burned.
fn mints_within_batch(mint: Assets, policy_id: PolicyId) -> Bool {
  dict.size(assets.tokens(mint, policy_id)) <= max_grant_batch
}
