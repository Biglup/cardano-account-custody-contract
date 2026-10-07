use aiken/crypto.{VerificationKeyHash}
use cardano/address.{Address}
use cardano/assets.{AssetName, PolicyId}

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

/// A revocable permission identified by its slot in `AccountState.grants`.
/// The grantee is an Ed25519 key hash that must sign as a required signer.
pub type Grant {
  slot: Int,
  grantee: VerificationKeyHash,
  scope: Scope,
}

/// The account's on-chain state: its owner devices, its outstanding grants,
/// and a counter bumped whenever grants are replaced wholesale.
pub type AccountState {
  devices: List<VerificationKeyHash>,
  grants: List<Grant>,
  grant_generation: Int,
}

/// The redeemer for the account validator's spend handler.
///
/// `Device` is the owner path: any device key may rewrite the state freely,
/// as long as the result stays well formed. `SpendWithGrant` is the agent
/// path: the grantee of the named grant signs the transaction as a required
/// signer, and the grant's remaining caps bound what the transaction may
/// take. `Fund` is for a plain deposit UTxO at the account address, which
/// only requires that the account's own state NFT is spent alongside it.
pub type AccountRedeemer {
  Device
  SpendWithGrant { slot: Int }
  Fund
}

/// The redeemer for the account validator's mint handler, which creates
/// the account's state NFT. The NFT is never burned, so creation is the
/// handler's only purpose and `CreateAccount` its only value.
pub type MintRedeemer {
  CreateAccount
}

/// The redeemer for the account stake validator's withdraw and publish
/// handlers. Both handlers learn what they are authorising from the script
/// context itself, the credential a withdrawal draws from or the
/// certificate being published, so the redeemer carries no choice and
/// `Operate` is its only value.
pub type StakeRedeemer {
  Operate
}
