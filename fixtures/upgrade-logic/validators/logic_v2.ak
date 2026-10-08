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

/// The most tokens one transaction may mint or burn under the account
/// policy here: the size of an issuance or a sweep, which the deployed
/// logic leaves to the execution budget. Eight grants with eight
/// recipients each issue or sweep within half of the memory limit and
/// sixteen exceed it, so the bound is the batch the off-chain builders
/// already apply; see the security review, Resource exhaustion.
pub const max_grant_batch = 8

// VALIDATORS ******************************************************************

/// The second logic of the upgrade proof, applied to the account proxy's
/// hash like the deployed one. It is the shared rules of `logic`, the
/// owner, agent and arrival paths with the one control UTxO per
/// transaction rule, plus one bound a user can see: at most
/// `max_grant_batch` tokens are minted or burned under the account
/// policy in one transaction, so an issuance or a sweep of more grants
/// is refused here where the deployed logic accepts whatever fits the
/// budget. The shared rules admit only grant tokens of the account on
/// the owner path and the state NFT alone at creation, so the bound is a
/// bound on grants issued or swept. The bound is visible from the
/// outside, which is what makes the move observable; it is not a rule
/// the contract wants.
///
/// An account moves here from the deployed logic with the upgrade the
/// shared arrival path validates, the generation bumped so that every
/// grant issued before is dead, and moves back the same way.
///
/// Publish: the credential may be registered by anyone, which the
/// withdrawal needs once; every other certificate is refused.
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

/// Whether the mint under the account policy holds at most
/// `max_grant_batch` entries, each a token minted or burned.
fn mints_within_batch(mint: Assets, policy_id: PolicyId) -> Bool {
  dict.size(assets.tokens(mint, policy_id)) <= max_grant_batch
}
