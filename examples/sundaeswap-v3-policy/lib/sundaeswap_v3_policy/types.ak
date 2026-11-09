//// The parts of a SundaeSwap v3 order datum this policy reads, matching
//// only the on-chain data layout: constructor order and field order are
//// the interface. Names are this example's own. References:
//// https://github.com/SundaeSwap-finance/sundae-contracts/blob/be33466b7dbe0f8e6c0e0f46ff23737897f45835/lib/types/order.ak
//// https://github.com/SundaeSwap-finance/sundae-contracts/blob/be33466b7dbe0f8e6c0e0f46ff23737897f45835/lib/shared.ak
//// https://github.com/KtorZ/aicone/blob/a9ae9ef8b6bdb183ea020ea97f6b648f9343924e/lib/sundae/multisig.ak

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

use cardano/address.{Address}
use cardano/transaction.{Datum}

// TYPES ***********************************************************************

/// Who may cancel or update an order. Constructors 0 to 6 in order.
pub type Owner {
  SignatureOwner(ByteArray)
  AllOfOwners(List<Owner>)
  AnyOfOwners(List<Owner>)
  AtLeastOwners(Int, List<Owner>)
  BeforeTime(Int)
  AfterTime(Int)
  ScriptOwner(ByteArray)
}

/// Where the result of an order goes. Constructors 0 and 1 in order.
pub type Destination {
  FixedDestination { address: Address, datum: Datum }
  SelfDestination
}

/// A quantity of one asset: policy id, asset name, amount.
pub type AssetAmount =
  (ByteArray, ByteArray, Int)

/// Order details: constructor 0 is the late-bound strategy, constructor 1
/// the swap. The later constructors, deposit, withdrawal, donation and
/// record, do not decode as this type and are refused.
pub type Details {
  Strategy(Data)
  Swap { offer: AssetAmount, min_received: AssetAmount }
}

/// The order datum, fields in order.
pub type OrderDatum {
  pool_ident: Option<ByteArray>,
  owner: Owner,
  max_protocol_fee: Int,
  destination: Destination,
  details: Details,
  extension: Data,
}

/// An asset class: policy id and asset name.
pub type AssetClass =
  (ByteArray, ByteArray)

/// The settings a recipient entry carries for this policy.
pub type Settings {
  /// The only pool an order may target.
  pool_ident: ByteArray,
  /// The only owner an order may name, compared whole.
  owner: Owner,
  /// The address the destination must be, with no datum.
  receiver: Address,
  /// The only asset an order may offer.
  offer_asset: AssetClass,
  /// The only asset an order may require.
  receive_asset: AssetClass,
  /// The bound `min_received * price_denominator >= offer * price_numerator`.
  price_numerator: Int,
  price_denominator: Int,
  /// The largest `max_protocol_fee` an order may name.
  max_protocol_fee: Int,
  /// The only extension an order may carry. See the README for why.
  extension: Data,
}
