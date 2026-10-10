//// The datum and redeemer types the proxy, the stake script and every
//// logic version share: the account state of the control UTxO, the grant
//// and its scope, and the redeemers of each handler. The library modules
//// read and write these values; the validators take the redeemers as
//// handler arguments and read the datums from the control and grant
//// UTxOs. Fields serialise as Plutus Data in declaration order, so
//// the stable prefixes named below are positional contracts.

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

use aiken/crypto.{ScriptHash, VerificationKeyHash}
use cardano/address.{Address}
use cardano/assets.{AssetName, PolicyId}

// TYPES ***********************************************************************

/// An asset class: a policy id paired with an asset name. Lovelace is the
/// empty policy id and the empty asset name, as in `cardano/assets`.
pub type Asset {
  /// The script hash of the minting policy, 28 bytes; empty for lovelace.
  policy_id: PolicyId,
  /// The name under the policy, 0 to 32 bytes; empty for lovelace.
  asset_name: AssetName,
}

/// The bounds of a grant: one asset class, a per call cap and a
/// remaining cap on it, lovelace caps for a token scope, an expiry and
/// the allowed destinations. `is_scope_well_formed` bounds it at
/// issuance under `logic_v1`; `grant_spend_rule` enforces it on every
/// spend.
pub type Scope {
  /// The asset class the per call cap and the remaining cap apply to.
  /// Lovelace is the empty policy id and the empty asset name.
  asset: Asset,
  /// The most of `asset`, in its own unit, that may leave the account in
  /// one spend. Under `logic_v1` a spend never changes it. Non negative.
  per_call_cap: Int,
  /// The `asset`, in its own unit, that may still leave over the rest of
  /// the grant's life. Under `logic_v1` each spend lowers it by at least
  /// the net outflow and never raises it. Non negative.
  cap: Int,
  /// For a token scope, the most lovelace that may leave the account in
  /// one spend: the fee when the account pays it and the lovelace sent
  /// with the token. Zero for a lovelace scope, where `per_call_cap`
  /// bounds the lovelace. Under `logic_v1` a spend never changes it. Non
  /// negative.
  lovelace_per_call_cap: Int,
  /// For a token scope, the lovelace that may still leave over the rest
  /// of the grant's life. Under `logic_v1` each spend lowers it by at
  /// least the net outflow of lovelace and never raises it. Zero for a
  /// lovelace scope, where it stays as it is. Non negative.
  lovelace_cap: Int,
  /// The POSIX time in milliseconds after which the grant cannot be
  /// spent: a spend's validity range must end at a finite time no later
  /// than it, and a sweep by expiry needs a range starting after it.
  /// Positive.
  expires_at: Int,
  /// The addresses a spend may pay, compared as whole addresses, stake
  /// part included. Empty allows any destination. Otherwise every
  /// output is at the account address or at a recipient, change
  /// included. Under `logic_v1` at most 8.
  recipients: List<Address>,
}

/// A revocable permission, the inline datum of a grant UTxO, under the
/// grant token named after the account and `slot`. A device issues it
/// under `logic_v1`; a grant spend rewrites only `scope.cap` and
/// `scope.lovelace_cap`; a sweep burns its token once it is dead.
///
/// `slot`, `grantee` and `generation` are a stable prefix: scripts read
/// them by position without decoding the rest, and a sweep of a grant
/// dead by generation or by slot reads nothing else. A later logic
/// version keeps them first, in this order, and appends fields after
/// `scope` only.
pub type Grant {
  /// The grant's number within its account, taken from the account's
  /// `next_slot` at issuance. It ends the grant token's name as 4 big
  /// endian bytes, so it is between 0 and 4294967295. It is a grant
  /// slot, not a chain slot.
  slot: Int,
  /// The verification key hash, 28 bytes, that must be among the
  /// required signers of every spend under the grant.
  grantee: VerificationKeyHash,
  /// The account's `grant_generation` at issuance, as the control output
  /// written in that transaction carries it. The grant is dead once the
  /// account's generation is higher.
  generation: Int,
  /// The bounds of the grant. Every field but `cap` and `lovelace_cap`
  /// stays as issued.
  scope: Scope,
}

/// The account state, the inline datum of the control UTxO. The owner
/// writes it at creation and a device on the owner path; the proxy, the
/// stake script and the logic read it.
///
/// `logic`, `devices` and `grant_generation` are a stable prefix read by
/// position by scripts that never decode the whole state: the proxy
/// reads field 0, the stake script field 1, and a logic an account
/// arrives at fields 0, 1 and 2 of the state it leaves. A later logic
/// version keeps these three first, in this order, and changes only
/// what follows.
pub type AccountState {
  /// The script hash, 28 bytes, of the logic whose rules govern the
  /// account. The proxy requires a withdrawal from it on every spend of
  /// an account token and on every mint under the proxy policy. Writing
  /// another hash is an upgrade, and both logics run.
  logic: ScriptHash,
  /// The verification key hashes with authority over the account. Under
  /// `logic_v1`, one to 8 distinct keys, any one of which may sign an
  /// owner transaction.
  devices: List<VerificationKeyHash>,
  /// The generation current grants carry; a grant issued under a lower
  /// value is dead. Under `logic_v1` it is non negative and never
  /// decreases, and an upgrade into `logic_v1` raises it.
  grant_generation: Int,
  /// The grant slot the next issued grant takes. Under `logic_v1` it is
  /// non negative, grows by the grant tokens minted and never decreases.
  next_slot: Int,
  /// The grant slots of the current generation revoked one by one. Under
  /// `logic_v1` at most 32, and a device may add or remove any slot.
  revoked: List<Int>,
  /// The grant tokens minted and not yet burned. Under `logic_v1` it
  /// moves by the tokens minted minus the tokens burned and is between
  /// 0 and 16.
  outstanding: Int,
}

/// The redeemer for the account proxy's spend handler, which the logic the
/// control UTxO names reads back from the script context.
///
/// `Device` is the owner path on the control UTxO: any device key may
/// rewrite the state freely, as long as the result stays well formed and
/// the counters follow the grant tokens minted and burned, or point the
/// account at another logic. `SpendWithGrant` is the agent path on a grant
/// UTxO: the grantee signs the transaction as a required signer, the
/// control UTxO is referenced, and the grant's remaining caps bound what
/// the transaction may take. `SweepGrant` is the owner path on a dead
/// grant UTxO, burning its token. `Fund` is for a deposit UTxO at the
/// account address, which rides on an account token spent alongside.
pub type AccountRedeemer {
  Device
  SpendWithGrant
  SweepGrant
  Fund
}

/// The redeemer for the account proxy's mint handler. `CreateAccount`
/// mints the account's state NFT, which is never burned. `IssueGrants`
/// mints grant tokens into new grant UTxOs and `BurnGrants` burns the
/// tokens of swept grants, both with the control UTxO spent by a device
/// under the rules of the logic it names.
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

/// The redeemer for a logic script's withdraw and publish handlers. The
/// logic learns what it is validating from the script context, the
/// control UTxO that names it and the proxy redeemers beside its own, so
/// the redeemer carries no choice and `Run` is its only value.
pub type LogicRedeemer {
  Run
}
