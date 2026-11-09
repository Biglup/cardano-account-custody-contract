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

use aiken/builtin
use aiken/primitive/bytearray
use cardano/address.{Address}
use cardano/assets
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction, placeholder,
}
use minswap_v2_policy/grant.{GrantPolicy, Recipient}
use minswap_v2_policy/types.{
  AllExcept, Asset, KeyCanceller, NoReceiverDatum, OrderDatum, ReceiverDatumHash,
  Settings, SpecificAmount, SwapAmount, SwapExactInStep,
}
use minswap_v2_policy

// CONSTANTS *******************************************************************

const proxy = #"11111111111111111111111111111111111111111111111111111111"

const own = #"22222222222222222222222222222222222222222222222222222222"

const other_policy = #"33333333333333333333333333333333333333333333333333333333"

const stake_part = #"44444444444444444444444444444444444444444444444444444444"

const order_script = #"55555555555555555555555555555555555555555555555555555555"

const device = #"66666666666666666666666666666666666666666666666666666666"

const stranger = #"77777777777777777777777777777777777777777777777777777777"

const lp_policy = #"88888888888888888888888888888888888888888888888888888888"

// FIXTURES ********************************************************************

type TestScope {
  asset: Asset,
  per_call_cap: Int,
  cap: Int,
  lovelace_per_call_cap: Int,
  lovelace_cap: Int,
  expires_at: Int,
  recipients: List<Data>,
}

type TestGrant {
  slot: Int,
  grantee: ByteArray,
  generation: Int,
  scope: TestScope,
}

fn order_address() -> Address {
  address.from_script(order_script)
}

fn account_address() -> Address {
  address.from_script(proxy) |> address.with_delegation_script(stake_part)
}

fn receiver() -> Address {
  account_address()
}

fn pool() -> Asset {
  Asset { policy_id: lp_policy, asset_name: #"aabb" }
}

fn settings() -> Settings {
  Settings {
    canceller: KeyCanceller(device),
    receiver: receiver(),
    lp_asset: pool(),
    direction_a_to_b: True,
    price_numerator: 3,
    price_denominator: 1,
    max_batcher_fee: 2_000_000,
    max_tip: 1_000_000,
  }
}

/// The grant datum with its recipients as already encoded data.
fn grant_datum(recipients: List<Data>) -> Data {
  let datum: Data =
    TestGrant {
      slot: 7,
      grantee: stranger,
      generation: 0,
      scope: TestScope {
        asset: Asset { policy_id: #"", asset_name: #"" },
        per_call_cap: 1_000,
        cap: 1_000,
        lovelace_per_call_cap: 0,
        lovelace_cap: 0,
        expires_at: 1,
        recipients,
      },
    }
  datum
}

fn entry(script: ByteArray, settings: Data, at: Address) -> Data {
  let data: Data =
    Recipient {
      address: at,
      policy: Some(GrantPolicy { script, settings }),
    }
  data
}

fn slot_name() -> ByteArray {
  bytearray.concat(stake_part, #"00000007")
}

fn grant_input(recipients: List<Data>) -> Input {
  Input {
    output_reference: OutputReference { transaction_id: #"aa", output_index: 0 },
    output: Output {
      address: account_address(),
      value: assets.from_lovelace(2_000_000)
        |> assets.add(proxy, slot_name(), 1),
      datum: InlineDatum(grant_datum(recipients)),
      reference_script: None,
    },
  }
}

fn order_output(order: Data) -> Output {
  Output {
    address: order_address(),
    value: assets.from_lovelace(10_000_000),
    datum: InlineDatum(order),
    reference_script: None,
  }
}

fn step(amount: SwapAmount, minimum_receive: Int) -> SwapExactInStep {
  SwapExactInStep { direction_a_to_b: True, amount, minimum_receive, killable: False }
}

fn good_order() -> OrderDatum {
  let inner: Data = step(SpecificAmount(4_000_000), 12_000_000)
  OrderDatum {
    canceller: KeyCanceller(device),
    refund_receiver: receiver(),
    refund_receiver_datum: NoReceiverDatum,
    success_receiver: receiver(),
    success_receiver_datum: NoReceiverDatum,
    lp_asset: pool(),
    step: inner,
    max_batcher_fee: 2_000_000,
    expiry_and_tip: Some((1_900_000_000_000, 500_000)),
  }
}

fn tx_of(recipients: List<Data>, outputs: List<Output>) -> Transaction {
  Transaction {
    ..placeholder,
    inputs: [grant_input(recipients)],
    outputs,
  }
}

fn check_order(order: OrderDatum) -> Bool {
  let data: Data = order
  minswap_v2_policy.check(
    proxy,
    own,
    tx_of([entry(own, settings_data(), order_address())], [order_output(data)]),
  )
}

fn settings_data() -> Data {
  let data: Data = settings()
  data
}

// TESTS ***********************************************************************

/// The expiry option of an order, encoded as Minswap's compiled validator
/// reads it: `Some` holding a list of the time and the tip.
test tuple_option_encoding_matches_minswap() {
  let expected: Data = builtin.constr_data(0, [builtin.list_data([builtin.i_data(5), builtin.i_data(7)])])
  let actual: Data = Some((5, 7))
  actual == expected
}

test accepts_a_valid_order() {
  check_order(good_order())
}

test accepts_an_order_with_no_expiry_option() {
  check_order(OrderDatum { ..good_order(), expiry_and_tip: None })
}

test accepts_a_tip_at_the_cap() {
  check_order(OrderDatum { ..good_order(), expiry_and_tip: Some((1, 1_000_000)) })
}

test refuses_a_redirected_success_receiver() {
  !check_order(
    OrderDatum {
      ..good_order(),
      success_receiver: address.from_verification_key(stranger),
    },
  )
}

test refuses_a_redirected_refund_receiver() {
  !check_order(
    OrderDatum {
      ..good_order(),
      refund_receiver: address.from_verification_key(stranger),
    },
  )
}

test refuses_a_wrong_canceller() {
  !check_order(OrderDatum { ..good_order(), canceller: KeyCanceller(stranger) })
}

test refuses_a_wrong_pool() {
  !check_order(
    OrderDatum {
      ..good_order(),
      lp_asset: Asset { policy_id: lp_policy, asset_name: #"ccdd" },
    },
  )
}

test refuses_a_receiver_datum_that_is_not_empty() {
  !check_order(
    OrderDatum {
      ..good_order(),
      success_receiver_datum: ReceiverDatumHash(#"aa"),
    },
  )
}

test refuses_a_wrong_direction() {
  let inner: Data =
    SwapExactInStep {
      direction_a_to_b: False,
      amount: SpecificAmount(4_000_000),
      minimum_receive: 12_000_000,
      killable: False,
    }
  !check_order(OrderDatum { ..good_order(), step: inner })
}

test refuses_a_minimum_receive_below_the_price() {
  let inner: Data = step(SpecificAmount(4_000_000), 11_999_999)
  !check_order(OrderDatum { ..good_order(), step: inner })
}

test refuses_a_zero_sold_amount() {
  let inner: Data = step(SpecificAmount(0), 1)
  !check_order(OrderDatum { ..good_order(), step: inner })
}

test refuses_an_excessive_batcher_fee() {
  !check_order(OrderDatum { ..good_order(), max_batcher_fee: 2_000_001 })
}

test refuses_an_excessive_tip() {
  !check_order(
    OrderDatum { ..good_order(), expiry_and_tip: Some((1, 1_000_001)) },
  )
}

test refuses_all_available_amount() fail {
  let inner: Data = step(AllExcept(0), 12_000_000)
  check_order(OrderDatum { ..good_order(), step: inner })
}

test refuses_a_step_that_is_not_swap_exact_in() fail {
  let other = builtin.constr_data(1, [builtin.i_data(1), builtin.i_data(1), builtin.i_data(1)])
  check_order(OrderDatum { ..good_order(), step: other })
}

test refuses_an_order_without_a_datum() fail {
  minswap_v2_policy.check(
    proxy,
    own,
    tx_of(
      [entry(own, settings_data(), order_address())],
      [
        Output {
          address: order_address(),
          value: assets.from_lovelace(1),
          datum: NoDatum,
          reference_script: None,
        },
      ],
    ),
  )
}

test refuses_an_order_with_a_datum_hash() fail {
  minswap_v2_policy.check(
    proxy,
    own,
    tx_of(
      [entry(own, settings_data(), order_address())],
      [
        Output {
          address: order_address(),
          value: assets.from_lovelace(1),
          datum: transaction.DatumHash(#"aa"),
          reference_script: None,
        },
      ],
    ),
  )
}

test refuses_when_no_grant_input_is_present() fail {
  minswap_v2_policy.check(
    proxy,
    own,
    Transaction { ..placeholder, inputs: [] },
  )
}

test ignores_outputs_at_other_recipients() {
  let bad: Data = 1
  minswap_v2_policy.check(
    proxy,
    own,
    tx_of(
      [entry(own, settings_data(), order_address())],
      [Output { ..order_output(bad), address: address.from_verification_key(device) }],
    ),
  )
}

test does_not_read_settings_of_another_policy() {
  let bad: Data = 1
  let good: Data = settings()
  let order: Data = good_order()
  minswap_v2_policy.check(
    proxy,
    own,
    tx_of(
      [
        entry(other_policy, bad, order_address()),
        entry(own, good, order_address()),
      ],
      [order_output(order)],
    ),
  )
}

test refuses_when_no_entry_names_this_policy() fail {
  let good: Data = settings()
  let order: Data = good_order()
  minswap_v2_policy.check(
    proxy,
    own,
    tx_of([entry(other_policy, good, order_address())], [order_output(order)]),
  )
}

test refuses_every_order_at_any_entry_address() {
  let good: Data = settings()
  let order: Data = good_order()
  let bad: Data = OrderDatum { ..good_order(), canceller: KeyCanceller(stranger) }
  !minswap_v2_policy.check(
    proxy,
    own,
    tx_of(
      [entry(own, good, order_address())],
      [order_output(order), order_output(bad)],
    ),
  )
}
