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
use aiken/collection/list
use aiken/fuzz
use aiken/primitive/bytearray
use cardano/address.{Address, Pointer, Script, VerificationKey}
use cardano/assets
use cardano/certificate.{
  DelegateCredential, RegisterCredential, UnregisterCredential,
}
use cardano/transaction.{
  DatumHash, InlineDatum, Input, NoDatum, Output, OutputReference, Transaction,
  placeholder,
}
use sundaeswap_v3_policy
use sundaeswap_v3_policy/grant.{GrantPolicy, Recipient}
use sundaeswap_v3_policy/types.{
  AfterTime, AllOfOwners, AnyOfOwners, AtLeastOwners, BeforeTime, Destination,
  FixedDestination, OrderDatum, ScriptOwner, SelfDestination, Settings,
  SignatureOwner, Strategy, Swap,
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
    offer_asset: (#"", #""),
    receive_asset: (token_policy, #"aabb"),
    price_numerator: 3,
    price_denominator: 1,
    max_protocol_fee: 2_000_000,
    extension: builtin.constr_data(0, []),
  }
}

fn entry_data(s: Data) -> Data {
  let data: Data = Recipient {
    address: order_address(),
    policy: Some(GrantPolicy { script: own, settings: s }),
  }
  data
}

fn grant_input(recipients: List<Data>) -> Input {
  let datum: Data = TestGrant {
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
  Transaction { ..placeholder, inputs: [grant_input([entry_data(s)])], outputs }
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
  let destination: Destination = FixedDestination {
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
  check_order(
    OrderDatum { ..good_order(), details: Strategy(builtin.i_data(1)) },
  )
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

// ATTACKS *********************************************************************

const other_account_stake =
  #"33333333333333333333333333333333333333333333333333333333"

fn settings_data() -> Data {
  let data: Data = settings()
  data
}

/// An entry at `at` naming `script` with `s`.
fn entry(script: ByteArray, s: Data, at: Address) -> Data {
  let data: Data = Recipient {
    address: at,
    policy: Some(GrantPolicy { script, settings: s }),
  }
  data
}

fn other_account_address() -> Address {
  address.from_script(proxy)
    |> address.with_delegation_script(other_account_stake)
}

fn slot_name() -> ByteArray {
  bytearray.concat(stake_part, #"00000007")
}

/// The default grant input with its value holding `quantity` of `name`
/// under `policy`, sitting at `at`.
fn grant_input_with(
  policy: ByteArray,
  name: ByteArray,
  quantity: Int,
  at: Address,
) -> Input {
  let base = grant_input([entry_data(settings_data())])
  Input {
    ..base,
    output: Output {
      ..base.output,
      address: at,
      value: assets.from_lovelace(2_000_000)
        |> assets.add(policy, name, quantity),
    },
  }
}

fn check_with_inputs(inputs: List<Input>) -> Bool {
  let good: Data = good_order()
  sundaeswap_v3_policy.check(
    proxy,
    own,
    Transaction { ..placeholder, inputs, outputs: [order_output(good)] },
  )
}

fn check_entries(entries: List<Data>, orders: List<Data>) -> Bool {
  sundaeswap_v3_policy.check(
    proxy,
    own,
    Transaction {
      ..placeholder,
      inputs: [grant_input(entries)],
      outputs: list.map(orders, order_output),
    },
  )
}

fn check_with_outputs(outputs: List<Output>) -> Bool {
  sundaeswap_v3_policy.check(proxy, own, tx_of(outputs))
}

fn with_settings(s: Settings) -> List<Data> {
  let data: Data = s
  [entry_data(data)]
}

test attack_grant_lookup_a_fake_grant_token_under_another_policy() fail {
  check_with_inputs(
    [grant_input_with(token_policy, slot_name(), 1, account_address())],
  )
}

/// A real grant token at a key payment credential whose stake part is the
/// account's. The stake part alone is not enough.
test attack_grant_lookup_a_token_at_a_key_payment_credential_with_the_account_stake_part() fail {
  let fake = address.from_verification_key(device)
    |> address.with_delegation_script(stake_part)
  let order: Data = OrderDatum {
    ..good_order(),
    destination: FixedDestination { address: fake, datum: NoDatum },
  }
  sundaeswap_v3_policy.check(
    proxy,
    own,
    Transaction {
      ..placeholder,
      inputs: [grant_input_with(proxy, slot_name(), 1, fake)],
      outputs: [order_output(order)],
    },
  )
}

/// A UTxO holding a grant token and no inline datum is not counted, so
/// the lookup still finds the one real grant. Placement keeps such a
/// UTxO from existing; this pins the shape check on its own.
test grant_lookup_counts_only_utxos_with_an_inline_datum() {
  let real = grant_input([entry_data(settings_data())])
  let bare = grant_input_with(proxy, slot_name(), 1, account_address())
  check_with_inputs(
    [real, Input { ..bare, output: Output { ..bare.output, datum: NoDatum } }],
  )
}

/// No entry naming this script fails rather than passing an empty check.
test attack_grant_lookup_no_entry_names_this_policy() fail {
  let good: Data = good_order()
  check_entries([entry(token_policy, settings_data(), order_address())], [good])
}

test attack_grant_lookup_a_token_named_after_another_account() fail {
  check_with_inputs(
    [
      grant_input_with(
        proxy,
        bytearray.concat(other_account_stake, #"00000007"),
        1,
        account_address(),
      ),
    ],
  )
}

/// A grant token of another account beside the real grant: two grant
/// inputs and the script aborts, closing double satisfaction across
/// two grants.
test attack_grant_lookup_two_accounts_grant_tokens_in_one_transaction() fail {
  check_with_inputs(
    [
      grant_input([entry_data(settings_data())]),
      grant_input_with(
        proxy,
        bytearray.concat(other_account_stake, #"00000007"),
        1,
        other_account_address(),
      ),
    ],
  )
}

test attack_grant_lookup_two_grant_inputs() fail {
  let input = grant_input([entry_data(settings_data())])
  check_with_inputs(
    [
      input,
      Input {
        ..input,
        output_reference: OutputReference {
          transaction_id: #"bb",
          output_index: 0,
        },
      },
    ],
  )
}

test attack_grant_lookup_a_grant_shaped_datum_without_a_token() fail {
  let base = grant_input([entry_data(settings_data())])
  check_with_inputs(
    [
      Input {
        ..base,
        output: Output { ..base.output, value: assets.from_lovelace(2_000_000) },
      },
    ],
  )
}

test attack_grant_lookup_a_grant_only_as_a_reference_input() fail {
  let good: Data = good_order()
  sundaeswap_v3_policy.check(
    proxy,
    own,
    Transaction {
      ..placeholder,
      inputs: [],
      reference_inputs: [grant_input([entry_data(settings_data())])],
      outputs: [order_output(good)],
    },
  )
}

test attack_grant_lookup_a_token_in_quantity_two() fail {
  check_with_inputs(
    [grant_input_with(proxy, slot_name(), 2, account_address())],
  )
}

test attack_grant_lookup_a_token_with_the_state_nft_name_shape() fail {
  check_with_inputs([grant_input_with(proxy, stake_part, 1, account_address())])
}

test attack_grant_lookup_a_grant_input_without_an_inline_datum() fail {
  let base = grant_input([entry_data(settings_data())])
  check_with_inputs(
    [Input { ..base, output: Output { ..base.output, datum: NoDatum } }],
  )
}

test attack_grant_lookup_a_grant_utxo_holding_a_second_token() fail {
  let base = grant_input([entry_data(settings_data())])
  check_with_inputs(
    [
      Input {
        ..base,
        output: Output {
          ..base.output,
          value: assets.add(base.output.value, proxy, stake_part, 1),
        },
      },
    ],
  )
}

/// The destination is another account of the same proxy. The destination
/// is compared with the grant input's own address, so proceeds cannot
/// reach a different account.
test attack_destination_another_account_of_the_proxy() {
  !check_order(
    OrderDatum {
      ..good_order(),
      destination: FixedDestination {
        address: other_account_address(),
        datum: NoDatum,
      },
    },
  )
}

test attack_destination_the_account_without_its_stake_part() {
  !check_order(
    OrderDatum {
      ..good_order(),
      destination: FixedDestination {
        address: address.from_script(proxy),
        datum: NoDatum,
      },
    },
  )
}

test attack_destination_the_account_with_a_pointer_stake_part() {
  !check_order(
    OrderDatum {
      ..good_order(),
      destination: FixedDestination {
        address: Address {
          ..account_address(),
          stake_credential: Some(
            Pointer {
              slot_number: 1,
              transaction_index: 2,
              certificate_index: 3,
            },
          ),
        },
        datum: NoDatum,
      },
    },
  )
}

/// A destination datum given by hash or inline is refused, the deposit
/// would otherwise land at the account under a datum the account refuses.
test attack_destination_with_a_datum() {
  and {
    !check_order(
      OrderDatum {
        ..good_order(),
        destination: FixedDestination {
          address: account_address(),
          datum: DatumHash(#"aa"),
        },
      },
    ),
    !check_order(
      OrderDatum {
        ..good_order(),
        destination: FixedDestination {
          address: account_address(),
          datum: InlineDatum(builtin.i_data(1)),
        },
      },
    ),
  }
}

/// A settings value naming a receiver in its old shape no longer decodes,
/// since the account is derived from the grant input.
test attack_destination_a_settings_value_with_a_receiver_field_does_not_decode() fail {
  let padded = builtin.constr_data(
    0,
    list.push(
      builtin.un_constr_data(settings_data()).2nd,
      {
        let addr: Data = address.from_verification_key(stranger)
        addr
      },
    ),
  )
  let good: Data = good_order()
  check_entries([entry(own, padded, order_address())], [good])
}

test attack_orders_a_valid_then_an_invalid_order() {
  let good: Data = good_order()
  let bad: Data = OrderDatum { ..good_order(), owner: SignatureOwner(stranger) }
  !check_entries([entry_data(settings_data())], [good, bad])
}

test attack_orders_an_invalid_then_a_valid_order() {
  let good: Data = good_order()
  let bad: Data = OrderDatum { ..good_order(), owner: SignatureOwner(stranger) }
  !check_entries([entry_data(settings_data())], [bad, good])
}

test attack_orders_an_invalid_order_behind_many_valid_ones() {
  let good: Data = good_order()
  let bad: Data = OrderDatum { ..good_order(), max_protocol_fee: 2_000_001 }
  !check_entries(
    [entry_data(settings_data())],
    list.concat(list.repeat(good, 5), [bad]),
  )
}

fn strict_settings() -> Data {
  let data: Data = Settings { ..settings(), max_protocol_fee: 1_500_000 }
  data
}

fn order_at(at: Address, order: Data) -> Output {
  Output { ..order_output(order), address: at }
}

fn second_order_address() -> Address {
  address.from_script(token_policy)
}

test same_script_two_settings_each_order_is_judged_by_its_own_entry() {
  let good: Data = good_order()
  let cheap: Data = OrderDatum { ..good_order(), max_protocol_fee: 1_500_000 }
  sundaeswap_v3_policy.check(
    proxy,
    own,
    Transaction {
      ..placeholder,
      inputs: [
        grant_input(
          [
            entry(own, settings_data(), order_address()),
            entry(own, strict_settings(), second_order_address()),
          ],
        ),
      ],
      outputs: [order_output(good), order_at(second_order_address(), cheap)],
    },
  )
}

/// A loose entry's order at the strict entry's address is judged by the
/// strict settings.
test attack_two_settings_a_loose_order_at_the_strict_address() {
  let good: Data = good_order()
  !sundaeswap_v3_policy.check(
    proxy,
    own,
    Transaction {
      ..placeholder,
      inputs: [
        grant_input(
          [
            entry(own, settings_data(), order_address()),
            entry(own, strict_settings(), second_order_address()),
          ],
        ),
      ],
      outputs: [order_output(good), order_at(second_order_address(), good)],
    },
  )
}

/// The same with the entries in the other order.
test attack_two_settings_a_loose_order_at_the_strict_address_entries_swapped() {
  let good: Data = good_order()
  !sundaeswap_v3_policy.check(
    proxy,
    own,
    Transaction {
      ..placeholder,
      inputs: [
        grant_input(
          [
            entry(own, strict_settings(), second_order_address()),
            entry(own, settings_data(), order_address()),
          ],
        ),
      ],
      outputs: [order_output(good), order_at(second_order_address(), good)],
    },
  )
}

/// Every owner kind substituted for the pinned signature, nested multisig
/// forms included. The owner is compared whole, so even an `AnyOf` holding
/// the pinned key among others is refused.
test attack_owner_each_other_variant() {
  and {
    !check_order(
      OrderDatum {
        ..good_order(),
        owner: AllOfOwners([SignatureOwner(device)]),
      },
    ),
    !check_order(
      OrderDatum {
        ..good_order(),
        owner: AnyOfOwners([SignatureOwner(device)]),
      },
    ),
    !check_order(
      OrderDatum {
        ..good_order(),
        owner: AtLeastOwners(1, [SignatureOwner(device)]),
      },
    ),
    !check_order(OrderDatum { ..good_order(), owner: BeforeTime(1) }),
    !check_order(OrderDatum { ..good_order(), owner: AfterTime(1) }),
    !check_order(OrderDatum { ..good_order(), owner: ScriptOwner(device) }),
  }
}

/// Deep nesting does not hide an owner: an `AllOf` of `AnyOf` of the
/// pinned key is compared whole with the pinned value, a plain signature.
test attack_owner_deeply_nested_multisig() {
  !check_order(
    OrderDatum {
      ..good_order(),
      owner: AllOfOwners(
        [
          AnyOfOwners(
            [
              AtLeastOwners(1, [SignatureOwner(device)]),
              SignatureOwner(stranger),
            ],
          ),
        ],
      ),
    },
  )
}

/// A settings owner that is itself a nested multisig matches only the
/// identical structure.
test owner_a_nested_multisig_in_the_settings_matches_only_exactly() {
  let nested = AnyOfOwners([SignatureOwner(device), SignatureOwner(stranger)])
  let s = with_settings(Settings { ..settings(), owner: nested })
  let good: Data = OrderDatum { ..good_order(), owner: nested }
  let flipped: Data = OrderDatum {
    ..good_order(),
    owner: AnyOfOwners([SignatureOwner(stranger), SignatureOwner(device)]),
  }
  and {
    check_entries(s, [good]),
    !check_entries(s, [flipped]),
  }
}

/// Each protocol fee boundary: at the cap, one above and negative.
test attack_fee_protocol_fee_boundaries() {
  and {
    check_order(OrderDatum { ..good_order(), max_protocol_fee: 2_000_000 }),
    !check_order(OrderDatum { ..good_order(), max_protocol_fee: 2_000_001 }),
    !check_order(OrderDatum { ..good_order(), max_protocol_fee: -1 }),
  }
}

fn swap_of(offer: Int, receive: Int) -> OrderDatum {
  OrderDatum {
    ..good_order(),
    details: Swap {
      offer: (#"", #"", offer),
      min_received: (token_policy, #"aabb", receive),
    },
  }
}

/// The offer and the receive asset exchanged: the order would sell the
/// token for lovelace.
test attack_assets_swapped_offer_and_receive() {
  !check_order(
    OrderDatum {
      ..good_order(),
      details: Swap {
        offer: (token_policy, #"aabb", 12_000_000),
        min_received: (#"", #"", 4_000_000),
      },
    },
  )
}

/// Zero or negative amounts on either side of the swap.
test attack_amounts_zero_and_negative() {
  and {
    !check_order(swap_of(0, 12_000_000)),
    !check_order(swap_of(4_000_000, 0)),
    !check_order(swap_of(-4_000_000, -12_000_000)),
    !check_order(swap_of(-1, 12_000_000)),
    !check_order(swap_of(4_000_000, -1)),
  }
}

test attack_price_boundaries() {
  and {
    check_order(swap_of(1, 3)),
    !check_order(swap_of(1_000_000, 2_999_999)),
    check_order(swap_of(1_000_000, 3_000_000)),
    check_order(swap_of(1_000_000, 3_000_001)),
  }
}

test attack_price_very_large_integers_stay_exact() {
  let offer = 340_282_366_920_938_463_463_374_607_431_768_211_456
  and {
    check_order(swap_of(offer, offer * 3)),
    !check_order(swap_of(offer, offer * 3 - 1)),
  }
}

/// A zero numerator would make the price bound vacuous and is refused.
test attack_price_settings_a_zero_numerator() {
  let order: Data = swap_of(1, 1)
  !check_entries(
    with_settings(Settings { ..settings(), price_numerator: 0 }),
    [order],
  )
}

/// A negative denominator with a negative minimum satisfies the price
/// rule arithmetically; the denominator's positivity refuses it.
test attack_price_settings_a_negative_denominator_with_a_negative_minimum() {
  let order: Data = swap_of(1, -1)
  !check_entries(
    with_settings(
      Settings { ..settings(), price_numerator: 1, price_denominator: -1 },
    ),
    [order],
  )
}

test attack_price_settings_a_zero_denominator() {
  let order: Data = good_order()
  !check_entries(
    with_settings(Settings { ..settings(), price_denominator: 0 }),
    [order],
  )
}

/// Negative price terms invert the bound and are refused in each sign.
test attack_price_settings_negative_terms() {
  let order: Data = swap_of(1, 1)
  and {
    !check_entries(
      with_settings(Settings { ..settings(), price_numerator: -3 }),
      [order],
    ),
    !check_entries(
      with_settings(
        Settings { ..settings(), price_numerator: -3, price_denominator: -1 },
      ),
      [order],
    ),
    !check_entries(
      with_settings(Settings { ..settings(), price_denominator: -1 }),
      [order],
    ),
  }
}

test prop_price_rule_is_exact(
  picked via fuzz.tuple4(
    fuzz.int_between(1, 1_000_000_000),
    fuzz.int_between(1, 1_000),
    fuzz.int_between(1, 1_000),
    fuzz.int_between(-3, 3),
  ),
) {
  let (offer, numerator, denominator, offset) = picked
  let bound = ( offer * numerator + denominator - 1 ) / denominator
  let receive = bound + offset
  if receive <= 0 {
    True
  } else {
    let order: Data = swap_of(offer, receive)
    let accepted = check_entries(
      with_settings(
        Settings {
          ..settings(),
          price_numerator: numerator,
          price_denominator: denominator,
        },
      ),
      [order],
    )
    accepted == ( receive * denominator >= offer * numerator )
  }
}

/// `offer` and `min_received` of another amount are bounded at the same
/// settings regardless of which pair of assets the pool holds.
test attack_extension_each_field_change_is_refused() {
  and {
    !check_order(OrderDatum { ..good_order(), extension: builtin.i_data(0) }),
    !check_order(
      OrderDatum { ..good_order(), extension: builtin.list_data([]) },
    ),
  }
}

// Malformed data

fn order_with_field(index: Int, value: Data) -> Data {
  let order: Data = good_order()
  let pair = builtin.un_constr_data(order)
  builtin.constr_data(
    pair.1st,
    list.indexed_map(
      pair.2nd,
      fn(i, field) {
        if i == index {
          value
        } else {
          field
        }
      },
    ),
  )
}

fn check_order_data(order: Data) -> Bool {
  check_entries([entry_data(settings_data())], [order])
}

test attack_malformed_an_order_datum_with_an_extra_field() fail {
  let order: Data = good_order()
  let pair = builtin.un_constr_data(order)
  check_order_data(
    builtin.constr_data(0, list.concat(pair.2nd, [builtin.i_data(0)])),
  )
}

test attack_malformed_an_order_datum_with_a_missing_field() fail {
  let order: Data = good_order()
  let pair = builtin.un_constr_data(order)
  check_order_data(builtin.constr_data(0, list.take(pair.2nd, 5)))
}

test attack_malformed_an_order_datum_with_a_wrong_constructor_tag() fail {
  let order: Data = good_order()
  check_order_data(builtin.constr_data(1, builtin.un_constr_data(order).2nd))
}

test attack_malformed_a_list_where_the_owner_constructor_goes() fail {
  check_order_data(
    order_with_field(1, builtin.list_data([builtin.b_data(device)])),
  )
}

test attack_malformed_bytes_where_the_fee_integer_goes() fail {
  check_order_data(order_with_field(2, builtin.b_data(#"01")))
}

test attack_malformed_a_datum_that_is_not_a_constructor() fail {
  check_order_data(builtin.i_data(1))
}

test attack_malformed_a_swap_with_a_constructor_where_the_offer_tuple_goes() fail {
  check_order_data(
    order_with_field(
      4,
      builtin.constr_data(
        1,
        [
          builtin.constr_data(0, []),
          {
            let received: Data = (token_policy, #"aabb", 12_000_000)
            received
          },
        ],
      ),
    ),
  )
}

test attack_malformed_a_swap_with_an_offer_of_four_elements() fail {
  check_order_data(
    order_with_field(
      4,
      builtin.constr_data(
        1,
        [
          builtin.list_data(
            [
              builtin.b_data(#""),
              builtin.b_data(#""),
              builtin.i_data(4_000_000),
              builtin.i_data(0),
            ],
          ),
          {
            let received: Data = (token_policy, #"aabb", 12_000_000)
            received
          },
        ],
      ),
    ),
  )
}

test attack_malformed_a_swap_with_bytes_where_an_amount_goes() fail {
  check_order_data(
    order_with_field(
      4,
      builtin.constr_data(
        1,
        [
          builtin.list_data(
            [builtin.b_data(#""), builtin.b_data(#""), builtin.b_data(#"04")],
          ),
          {
            let received: Data = (token_policy, #"aabb", 12_000_000)
            received
          },
        ],
      ),
    ),
  )
}

test attack_malformed_a_destination_constructor_out_of_range() fail {
  check_order_data(order_with_field(3, builtin.constr_data(2, [])))
}

test attack_malformed_settings_that_are_an_integer() fail {
  let good: Data = good_order()
  check_entries([entry_data(builtin.i_data(7))], [good])
}

test attack_malformed_settings_with_a_missing_field() fail {
  let pair = builtin.un_constr_data(settings_data())
  let good: Data = good_order()
  check_entries(
    [entry_data(builtin.constr_data(0, list.drop(pair.2nd, 1)))],
    [good],
  )
}

// Economic escapes

test attack_economic_a_plain_lovelace_output_at_the_order_address() fail {
  let good: Data = good_order()
  check_entries([entry_data(settings_data())], [good]) && sundaeswap_v3_policy.check(
    proxy,
    own,
    Transaction {
      ..placeholder,
      inputs: [grant_input([entry_data(settings_data())])],
      outputs: [Output { ..order_output(good), datum: NoDatum }],
    },
  )
}

/// A value far above the declared offer is accepted: the surplus is the
/// grantee's own over spend of its caps and returns to the destination.
test economic_a_value_far_above_the_declared_offer_is_accepted() {
  let good: Data = good_order()
  sundaeswap_v3_policy.check(
    proxy,
    own,
    tx_of(
      [
        Output {
          ..order_output(good),
          value: assets.from_lovelace(1_000_000_000),
        },
      ],
    ),
  )
}

/// Extra tokens are accepted for the same reason; the grant's scope
/// already bounds what can leave the account.
test economic_extra_tokens_in_the_order_output_are_accepted() {
  let good: Data = good_order()
  sundaeswap_v3_policy.check(
    proxy,
    own,
    tx_of(
      [
        Output {
          ..order_output(good),
          value: assets.add(
            assets.from_lovelace(2_000_000),
            token_policy,
            #"bb",
            10,
          ),
        },
      ],
    ),
  )
}

/// A reference script parked on the order output, which the scooper would
/// pay for or refuse.
test attack_economic_an_order_output_carrying_a_reference_script() {
  let good: Data = good_order()
  !sundaeswap_v3_policy.check(
    proxy,
    own,
    tx_of([Output { ..order_output(good), reference_script: Some(own) }]),
  )
}

/// An output at the order script's payment credential under another
/// stake part is not the entry's recipient and is left to the logic.
test ignores_an_output_at_the_order_credential_under_another_stake_part() {
  let bad: Data = 1
  check_with_outputs(
    [
      Output {
        ..order_output(bad),
        address: order_address() |> address.with_delegation_script(stake_part),
      },
    ],
  )
}

/// Many orders each at the protocol fee cap: the aggregate is bounded
/// only by the grant caps.
test economic_many_orders_each_at_the_cap_aggregate_is_bounded_only_by_the_grant_caps() {
  let order: Data = OrderDatum { ..good_order(), max_protocol_fee: 2_000_000 }
  sundaeswap_v3_policy.check(
    proxy,
    own,
    tx_of(list.repeat(order_output(order), 6)),
  )
}

// Handlers

test withdraw_accepts_a_transaction_the_check_accepts() {
  let good: Data = good_order()
  let redeemer: Data = 0
  sundaeswap_v3_policy.sundaeswap_v3_policy.withdraw(
    proxy,
    redeemer,
    Script(own),
    tx_of([order_output(good)]),
  )
}

test attack_handlers_withdraw_with_a_key_credential() fail {
  let redeemer: Data = 0
  sundaeswap_v3_policy.sundaeswap_v3_policy.withdraw(
    proxy,
    redeemer,
    VerificationKey(own),
    tx_of([]),
  )
}

test publish_accepts_the_registration_of_a_script_credential() {
  let redeemer: Data = 0
  sundaeswap_v3_policy.sundaeswap_v3_policy.publish(
    proxy,
    redeemer,
    RegisterCredential { credential: Script(own), deposit: Never },
    placeholder,
  )
}

test attack_handlers_publish_refuses_other_certificates() {
  let redeemer: Data = 0
  let refuse = fn(certificate) {
    !sundaeswap_v3_policy.sundaeswap_v3_policy.publish(
      proxy,
      redeemer,
      certificate,
      placeholder,
    )
  }
  and {
    refuse(UnregisterCredential { credential: Script(own), refund: Never }),
    refuse(
      RegisterCredential { credential: VerificationKey(own), deposit: Never },
    ),
    refuse(
      DelegateCredential {
        credential: Script(own),
        delegate: certificate.DelegateBlockProduction { stake_pool: stranger },
      },
    ),
  }
}

test prop_own_entry_is_found_at_any_position(
  position via fuzz.int_between(0, 7),
) {
  let others = fn(n: Int) {
    entry(
      token_policy,
      builtin.i_data(n),
      address.from_verification_key(stranger),
    )
  }
  let entries = list.concat(
    list.map(list.range(0, position - 1), others),
    [entry_data(settings_data()), ..list.map(list.range(position, 6), others)],
  )
  let good: Data = good_order()
  let bad: Data = OrderDatum { ..good_order(), max_protocol_fee: 2_000_001 }
  and {
    check_entries(entries, [good]),
    !check_entries(entries, [bad]),
  }
}

test prop_a_changed_pool_ident_is_refused(id via fuzz.bytearray_between(0, 28)) {
  if id == pool {
    True
  } else {
    !check_order(OrderDatum { ..good_order(), pool_ident: Some(id) })
  }
}
