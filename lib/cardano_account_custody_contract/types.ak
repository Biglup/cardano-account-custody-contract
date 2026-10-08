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

//
// USINGS **********************************************************************

use aiken/crypto.{VerificationKeyHash}
use cardano/address.{Address}
use cardano/assets.{AssetName, PolicyId}

// TYPES ***********************************************************************

/// An asset class: a policy id paired with an asset name. Lovelace is the
/// empty policy id and the empty asset name, as in `cardano/assets`.
pub type Asset {
  policy_id: PolicyId,
  asset_name: AssetName,
}

/// The bounds of a grant: the asset it covers, its caps, its expiry and its
/// allowed destinations. Fields serialise as Plutus Data in declaration
/// order.
pub type Scope {
  /// The asset class the caps apply to.
  asset: Asset,
  /// Most of `asset` that may leave the account in one transaction.
  per_call_cap: Int,
  /// Remaining `asset` that may leave over the grant's lifetime.
  cap: Int,
  /// Lovelace cap per transaction when `asset` is not lovelace; else zero.
  lovelace_per_call_cap: Int,
  /// Remaining lifetime lovelace cap when `asset` is not lovelace; else zero.
  lovelace_cap: Int,
  /// POSIX time in milliseconds after which the grant is unusable; must be > 0.
  expires_at: Int,
  /// Addresses funds may be sent to; an empty list allows any destination.
  recipients: List<Address>,
}

/// A revocable permission living in its own grant UTxO, under the grant
/// token named after the account and `slot`. The grantee is an Ed25519 key
/// hash that must sign as a required signer. `generation` is the account's
/// grant generation at issuance; the grant dies when the account's moves
/// past it or when its slot is revoked.
///
/// The first three fields, `slot`, `grantee` and `generation`, are a stable
/// prefix: other scripts read them positionally, and a sweep of a dead
/// grant needs nothing else, so later revisions must keep them first and
/// in this order and may only append fields after `scope`.
pub type Grant {
  slot: Int,
  grantee: VerificationKeyHash,
  generation: Int,
  scope: Scope,
}

/// The account's on-chain state in the control UTxO: its owner devices and
/// the grant bookkeeping. `grant_generation` only ever grows and kills every
/// grant issued under an older value; `next_slot` is the slot the next
/// issued grant takes; `revoked` lists the slots of the current generation
/// revoked one by one; `outstanding` counts grant tokens minted and not yet
/// burned.
///
/// `devices` is read positionally by other scripts and must stay the first
/// field in later revisions.
pub type AccountState {
  devices: List<VerificationKeyHash>,
  grant_generation: Int,
  next_slot: Int,
  revoked: List<Int>,
  outstanding: Int,
}

/// The redeemer for the account validator's spend handler.
///
/// `Device` is the owner path on the control UTxO: any device key may
/// rewrite the state freely, as long as the result stays well formed and
/// the counters follow the grant tokens minted and burned. `SpendWithGrant`
/// is the agent path on a grant UTxO: the grantee signs the transaction as
/// a required signer, the control UTxO is referenced, and the grant's
/// remaining caps bound what the transaction may take. `SweepGrant` is the
/// owner path on a dead grant UTxO, burning its token. `Fund` is for a
/// deposit UTxO at the account address, which rides on an account token
/// spent alongside.
pub type AccountRedeemer {
  Device
  SpendWithGrant
  SweepGrant
  Fund
}

/// The redeemer for the account validator's mint handler. `CreateAccount`
/// mints the account's state NFT, which is never burned. `IssueGrants`
/// mints grant tokens into new grant UTxOs and `BurnGrants` burns the
/// tokens of swept grants, both with the control UTxO spent by a device.
pub type MintRedeemer {
  CreateAccount
  IssueGrants
  BurnGrants
}

/// The redeemer for the account stake validator's withdraw and publish
/// handlers. Both handlers learn what they are authorising from the script
/// context itself, the credential a withdrawal draws from or the
/// certificate being published, so the redeemer carries no choice and
/// `Operate` is its only value.
pub type StakeRedeemer {
  Operate
}
