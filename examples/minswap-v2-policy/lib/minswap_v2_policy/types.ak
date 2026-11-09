//// The parts of a Minswap v2 order datum this policy reads, matching only
//// the on-chain data layout: constructor order and field order are the
//// interface. Names are this example's own. Reference:
//// https://github.com/minswap/minswap-dex-v2/blob/c3293ad435792ba502f5a2b1691c6736e5f167e6/lib/amm_dex_v2/types.ak

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

// TYPES ***********************************************************************

/// An asset class. Lovelace is the empty pair.
pub type Asset {
  policy_id: ByteArray,
  asset_name: ByteArray,
}

/// Who may cancel an order. Constructors 0 to 3 in order.
pub type Canceller {
  KeyCanceller(VerificationKeyHash)
  SpendScriptCanceller(ScriptHash)
  WithdrawScriptCanceller(ScriptHash)
  MintScriptCanceller(ScriptHash)
}

/// The datum a receiver output must carry. Constructors 0 to 2 in order.
pub type ReceiverDatum {
  NoReceiverDatum
  ReceiverDatumHash(ByteArray)
  ReceiverInlineDatum(ByteArray)
}

/// The amount an order swaps. Constructors 0 and 1 in order.
pub type SwapAmount {
  SpecificAmount(Int)
  AllExcept(Int)
}

/// Order step constructor 0, the only step this policy reads. Any other
/// step has another constructor index and does not decode as this type.
pub type SwapExactInStep {
  direction_a_to_b: Bool,
  amount: SwapAmount,
  minimum_receive: Int,
  killable: Bool,
}

/// The order datum, fields in order. `step` is read as `SwapExactInStep`.
pub type OrderDatum {
  canceller: Canceller,
  refund_receiver: Address,
  refund_receiver_datum: ReceiverDatum,
  success_receiver: Address,
  success_receiver_datum: ReceiverDatum,
  lp_asset: Asset,
  step: Data,
  max_batcher_fee: Int,
  expiry_and_tip: Option<(Int, Int)>,
}

/// The settings a recipient entry carries for this policy.
pub type Settings {
  /// The only canceller an order may name.
  canceller: Canceller,
  /// The LP asset naming the only pool an order may target.
  lp_asset: Asset,
  /// The only direction an order may swap.
  direction_a_to_b: Bool,
  /// The bound `minimum_receive * price_denominator >= sold * price_numerator`.
  price_numerator: Int,
  price_denominator: Int,
  /// The largest `max_batcher_fee` an order may name.
  max_batcher_fee: Int,
  /// The largest cancelling tip an order may name.
  max_tip: Int,
}
