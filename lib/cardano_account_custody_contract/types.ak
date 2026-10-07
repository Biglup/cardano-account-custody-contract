use aiken/crypto.{VerificationKeyHash}
use cardano/address.{Address}
use cardano/assets.{AssetName, PolicyId}

/// An asset class: a policy id paired with an asset name. Lovelace is
/// represented by the empty policy id and the empty asset name, mirroring
/// `cardano/assets.ada_policy_id` and `cardano/assets.ada_asset_name`.
pub type Asset {
  policy_id: PolicyId,
  asset_name: AssetName,
}

/// The bounds of a grant: which asset it covers, how much of it may leave
/// the account per call and in total, how much lovelace may leave with it
/// per call and in total, when it stops being usable, and which
/// destinations it allows.
///
/// The fields are serialised as Plutus Data in the order they are declared:
/// asset, per_call_cap, cap, lovelace_per_call_cap, lovelace_cap,
/// expires_at, recipients.
pub type Scope {
  /// The asset class this scope's caps apply to.
  asset: Asset,
  /// The most of `asset` that may leave the account in a single
  /// transaction.
  per_call_cap: Int,
  /// The most of `asset` that may leave the account over the grant's
  /// lifetime, reduced by what has already left.
  cap: Int,
  /// The most lovelace that may leave the account alongside `asset` in a
  /// single transaction. Applies only when `asset` is not lovelace; must
  /// be zero when `asset` is lovelace, since the asset caps already cover
  /// lovelace in that case.
  lovelace_per_call_cap: Int,
  /// The most lovelace that may leave the account alongside `asset` over
  /// the grant's lifetime, reduced by what has already left. Applies only
  /// when `asset` is not lovelace; must be zero when `asset` is lovelace,
  /// since the asset caps already cover lovelace in that case.
  lovelace_cap: Int,
  /// The POSIX time, in milliseconds, after which the grant can no longer
  /// be used. Must be greater than zero; there is no value that means the
  /// grant never expires.
  expires_at: Int,
  /// The addresses funds may be sent to. An empty list means any
  /// destination is allowed.
  recipients: List<Address>,
}

/// A single revocable permission held by a grantee, identified by its slot
/// in `AccountState.grants`. The grantee is the hash of an Ed25519
/// verification key and authorises a spend by signing the transaction as
/// one of its required signers.
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
