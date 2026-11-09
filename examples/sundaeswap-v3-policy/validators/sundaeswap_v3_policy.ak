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
use cardano/transaction.{InlineDatum, NoDatum, Output, Transaction}
use sundaeswap_v3_policy/grant
use sundaeswap_v3_policy/types.{
  FixedDestination, OrderDatum, Settings, Swap,
}

// VALIDATORS ******************************************************************

/// A grant policy for SundaeSwap v3 orders, run through a zero withdrawal.
/// Parameterised by the account proxy's hash, which finds the grant.
/// `check` holds every order paid to this policy's recipients against the
/// settings of the recipient entry. See the README.
validator sundaeswap_v3_policy(proxy_hash: ScriptHash) {
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

/// Whether `output` is a swap order within `settings`. Aborts on an order
/// without an inline datum, one that does not decode, or details other
/// than a swap.
fn is_allowed_order(output: Output, s: Settings) -> Bool {
  expect InlineDatum(data) = output.datum
  expect order: OrderDatum = data
  expect Swap { offer, min_received } = order.details
  let (offer_policy, offer_name, offer_amount) = offer
  let (receive_policy, receive_name, receive_amount) = min_received
  and {
    order.pool_ident == Some(s.pool_ident),
    order.owner == s.owner,
    order.max_protocol_fee >= 0,
    order.max_protocol_fee <= s.max_protocol_fee,
    order.destination == FixedDestination { address: s.receiver, datum: NoDatum },
    order.extension == s.extension,
    (offer_policy, offer_name) == s.offer_asset,
    (receive_policy, receive_name) == s.receive_asset,
    offer_amount > 0,
    receive_amount > 0,
    receive_amount * s.price_denominator >= offer_amount * s.price_numerator,
  }
}
