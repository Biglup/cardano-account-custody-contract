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
use sundaeswap_v3_policy
use sundaeswap_v3_policy/grant.{GrantPolicy, Recipient}
use sundaeswap_v3_policy/types.{
  AnyOfOwners, Destination, FixedDestination, OrderDatum, SelfDestination,
  Settings, SignatureOwner, Strategy, Swap,
}

// CONSTANTS *******************************************************************

const proxy = #"11111111111111111111111111111111111111111111111111111111"

const own = #"22222222222222222222222222222222222222222222222222222222"

const stake_part = #"44444444444444444444444444444444444444444444444444444444"

const order_script = #"55555555555555555555555555555555555555555555555555555555"

const device = #"66666666666666666666666666666666666666666666666666666666"

const stranger = #"77777777777777777777777777777777777777777777777777777777"

const token_policy = #"88888888888888888888888888888888888888888888888888888888"

const pool = #"aabbcc"

// FIXTURES ********************************************************************

type TestScope {
  asset: (ByteArray, ByteArray),
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

fn settings() -> Settings {
  Settings {
    pool_ident: pool,
    owner: SignatureOwner(device),
    receiver: account_address(),
    offer_asset: (#"", #""),
    receive_asset: (token_policy, #"aabb"),
    price_numerator: 3,
    price_denominator: 1,
    max_protocol_fee: 2_000_000,
    extension: builtin.constr_data(0, []),
  }
}

fn entry_data(s: Data) -> Data {
  let data: Data =
    Recipient {
      address: order_address(),
      policy: Some(GrantPolicy { script: own, settings: s }),
    }
  data
}

fn grant_input(recipients: List<Data>) -> Input {
  let datum: Data =
    TestGrant {
      slot: 7,
      grantee: stranger,
      generation: 0,
      scope: TestScope {
        asset: (#"", #""),
        per_call_cap: 1_000,
        cap: 1_000,
        lovelace_per_call_cap: 0,
        lovelace_cap: 0,
        expires_at: 1,
        recipients,
      },
    }
  Input {
    output_reference: OutputReference { transaction_id: #"aa", output_index: 0 },
    output: Output {
      address: account_address(),
      value: assets.from_lovelace(2_000_000)
        |> assets.add(proxy, bytearray.concat(stake_part, #"00000007"), 1),
      datum: InlineDatum(datum),
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

fn tx_of(outputs: List<Output>) -> Transaction {
  let s: Data = settings()
  Transaction {
    ..placeholder,
    inputs: [grant_input([entry_data(s)])],
    outputs,
  }
}

fn good_order() -> OrderDatum {
  OrderDatum {
    pool_ident: Some(pool),
    owner: SignatureOwner(device),
    max_protocol_fee: 2_000_000,
    destination: FixedDestination { address: account_address(), datum: NoDatum },
    details: Swap {
      offer: (#"", #"", 4_000_000),
      min_received: (token_policy, #"aabb", 12_000_000),
    },
    extension: builtin.constr_data(0, []),
  }
}

fn check_order(order: OrderDatum) -> Bool {
  let data: Data = order
  sundaeswap_v3_policy.check(proxy, own, tx_of([order_output(data)]))
}

// TESTS ***********************************************************************

/// The swap amounts of an order, encoded as SundaeSwap's blueprint lists
/// them: a list of the policy id, the asset name and the amount.
test asset_amount_is_encoded_as_a_list() {
  let actual: Data = (#"aa", #"bb", 3)
  actual == builtin.list_data(
    [builtin.b_data(#"aa"), builtin.b_data(#"bb"), builtin.i_data(3)],
  )
}

test accepts_a_valid_order() {
  check_order(good_order())
}

test accepts_a_price_at_the_bound() {
  check_order(
    OrderDatum {
      ..good_order(),
      details: Swap {
        offer: (#"", #"", 1),
        min_received: (token_policy, #"aabb", 3),
      },
    },
  )
}

test refuses_no_pool_ident() {
  !check_order(OrderDatum { ..good_order(), pool_ident: None })
}

test refuses_another_pool_ident() {
  !check_order(OrderDatum { ..good_order(), pool_ident: Some(#"ff") })
}

test refuses_a_changed_owner() {
  !check_order(OrderDatum { ..good_order(), owner: SignatureOwner(stranger) })
}

test refuses_a_nested_owner_with_another_signer() {
  !check_order(
    OrderDatum {
      ..good_order(),
      owner: AnyOfOwners([SignatureOwner(device), SignatureOwner(stranger)]),
    },
  )
}

test refuses_an_excessive_protocol_fee() {
  !check_order(OrderDatum { ..good_order(), max_protocol_fee: 2_000_001 })
}

test refuses_the_self_destination() {
  !check_order(OrderDatum { ..good_order(), destination: SelfDestination })
}

test refuses_a_destination_with_a_datum() {
  let destination: Destination =
    FixedDestination {
      address: account_address(),
      datum: InlineDatum(builtin.i_data(1)),
    }
  !check_order(OrderDatum { ..good_order(), destination })
}

test refuses_a_redirected_destination() {
  !check_order(
    OrderDatum {
      ..good_order(),
      destination: FixedDestination {
        address: address.from_verification_key(stranger),
        datum: NoDatum,
      },
    },
  )
}

test refuses_a_strategy() fail {
  check_order(OrderDatum { ..good_order(), details: Strategy(builtin.i_data(1)) })
}

test refuses_a_deposit() fail {
  let order: Data = good_order()
  sundaeswap_v3_policy.check(
    proxy,
    own,
    tx_of([order_output(raw_details(order, builtin.constr_data(2, [])))]),
  )
}

test refuses_a_bad_price() {
  !check_order(
    OrderDatum {
      ..good_order(),
      details: Swap {
        offer: (#"", #"", 4_000_000),
        min_received: (token_policy, #"aabb", 11_999_999),
      },
    },
  )
}

test refuses_another_offer_asset() {
  !check_order(
    OrderDatum {
      ..good_order(),
      details: Swap {
        offer: (token_policy, #"ffff", 4_000_000),
        min_received: (token_policy, #"aabb", 12_000_000),
      },
    },
  )
}

test refuses_another_receive_asset() {
  !check_order(
    OrderDatum {
      ..good_order(),
      details: Swap {
        offer: (#"", #"", 4_000_000),
        min_received: (token_policy, #"ffff", 12_000_000),
      },
    },
  )
}

test refuses_a_changed_extension() {
  !check_order(OrderDatum { ..good_order(), extension: builtin.i_data(1) })
}

/// The order datum with its `details` field, position 4, replaced.
fn raw_details(order: Data, details: Data) -> Data {
  let pair = builtin.un_constr_data(order)
  when pair.2nd is {
    [a, b, c, d, _e, f] -> builtin.constr_data(0, [a, b, c, d, details, f])
    _ -> fail
  }
}
