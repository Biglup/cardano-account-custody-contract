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
use cardano/certificate.{Certificate, RegisterCredential}
use cardano/transaction.{InlineDatum, Output, Transaction}
use minswap_v2_policy/grant
use minswap_v2_policy/types.{
  NoReceiverDatum, OrderDatum, Settings, SpecificAmount, SwapExactInStep,
}

// VALIDATORS ******************************************************************

/// A grant policy for Minswap v2 orders, run through a zero withdrawal.
/// Parameterised by the account proxy's hash, which finds the grant.
/// `check` holds every order paid to this policy's recipients against the
/// settings of the recipient entry. See the README.
validator minswap_v2_policy(proxy_hash: ScriptHash) {
  withdraw(_redeemer: Data, credential: Credential, self: Transaction) {
    expect Script(own_hash) = credential
    check(proxy_hash, own_hash, self)
  }

  publish(_redeemer: Data, certificate: Certificate, _self: Transaction) {
    when certificate is {
      RegisterCredential { credential: Script(_), .. } -> True
      _ -> False
    }
  }

  else(_context) {
    fail
  }
}

// FUNCTIONS *******************************************************************

/// Whether every output at each recipient naming `own_hash` is an order
/// `settings` allows. Aborts on anything `own_entries` refuses and on an
/// order that does not decode.
pub fn check(
  proxy_hash: ScriptHash,
  own_hash: ScriptHash,
  self: Transaction,
) -> Bool {
  list.all(
    grant.own_entries(proxy_hash, own_hash, self.inputs),
    fn(entry) {
      let Pair(address, data) = entry
      expect settings: Settings = data
      list.all(
        self.outputs,
        fn(output) {
          output.address != address || is_allowed_order(output, settings)
        },
      )
    },
  )
}

/// Whether `output` is a SwapExactIn order of a specific amount within
/// `settings`. Aborts on an order without an inline datum, one that does
/// not decode, another step or `AllExcept`.
fn is_allowed_order(output: Output, s: Settings) -> Bool {
  expect InlineDatum(data) = output.datum
  expect order: OrderDatum = data
  expect step: SwapExactInStep = order.step
  expect SpecificAmount(sold) = step.amount
  and {
    order.canceller == s.canceller,
    order.refund_receiver == s.receiver,
    order.refund_receiver_datum == NoReceiverDatum,
    order.success_receiver == s.receiver,
    order.success_receiver_datum == NoReceiverDatum,
    order.lp_asset == s.lp_asset,
    step.direction_a_to_b == s.direction_a_to_b,
    sold > 0,
    step.minimum_receive > 0,
    step.minimum_receive * s.price_denominator >= sold * s.price_numerator,
    order.max_batcher_fee >= 0,
    order.max_batcher_fee <= s.max_batcher_fee,
    when order.expiry_and_tip is {
      None -> True
      Some((_expiry, tip)) -> tip >= 0 && tip <= s.max_tip
    },
  }
}
