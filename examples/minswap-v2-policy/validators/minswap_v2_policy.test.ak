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
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction, placeholder,
}
use minswap_v2_policy
use minswap_v2_policy/grant.{GrantPolicy, Recipient}
use minswap_v2_policy/types.{
  AllExcept, Asset, KeyCanceller, MintScriptCanceller, NoReceiverDatum,
  OrderDatum, ReceiverDatumHash, ReceiverInlineDatum, Settings, SpecificAmount,
  SpendScriptCanceller, SwapAmount, SwapExactInStep, WithdrawScriptCanceller,
}

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
  let datum: Data = TestGrant {
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
  let data: Data = Recipient {
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
  SwapExactInStep {
    direction_a_to_b: True,
    amount,
    minimum_receive,
    killable: False,
  }
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
  Transaction { ..placeholder, inputs: [grant_input(recipients)], outputs }
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
  let expected: Data = builtin.constr_data(
    0,
    [builtin.list_data([builtin.i_data(5), builtin.i_data(7)])],
  )
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
  check_order(
    OrderDatum { ..good_order(), expiry_and_tip: Some((1, 1_000_000)) },
  )
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
  let inner: Data = SwapExactInStep {
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
  let other = builtin.constr_data(
    1,
    [builtin.i_data(1), builtin.i_data(1), builtin.i_data(1)],
  )
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
  minswap_v2_policy.check(proxy, own, Transaction { ..placeholder, inputs: [] })
}

test ignores_outputs_at_other_recipients() {
  let bad: Data = 1
  minswap_v2_policy.check(
    proxy,
    own,
    tx_of(
      [entry(own, settings_data(), order_address())],
      [
        Output {
          ..order_output(bad),
          address: address.from_verification_key(device),
        },
      ],
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
  let bad: Data = OrderDatum {
    ..good_order(),
    canceller: KeyCanceller(stranger),
  }
  !minswap_v2_policy.check(
    proxy,
    own,
    tx_of(
      [entry(own, good, order_address())],
      [order_output(order), order_output(bad)],
    ),
  )
}

// ATTACKS *********************************************************************

/// The address of another account under the same proxy.
fn other_account_address() -> Address {
  address.from_script(proxy) |> address.with_delegation_script(other_policy)
}

/// A grant input carrying `token` under `policy` at `at`, with the
/// recipients of the default entry.
fn grant_input_with(
  policy: ByteArray,
  name: ByteArray,
  quantity: Int,
  at: Address,
) -> Input {
  let base = grant_input([entry(own, settings_data(), order_address())])
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

/// A transaction with `inputs` in place of the default grant input and
/// the default good order among its outputs.
fn check_with_inputs(inputs: List<Input>) -> Bool {
  let good: Data = good_order()
  minswap_v2_policy.check(
    proxy,
    own,
    Transaction { ..placeholder, inputs, outputs: [order_output(good)] },
  )
}

/// A token under another policy named like a grant token poses as the
/// grant. Only a token under the proxy policy counts, so no grant input is
/// found and the script aborts.
test attack_grant_lookup_a_fake_grant_token_under_another_policy() fail {
  check_with_inputs(
    [grant_input_with(other_policy, slot_name(), 1, account_address())],
  )
}

/// A real grant token sits in an input whose payment credential is a key
/// but whose stake part is the account's. Placement would forbid it and
/// the lookup requires the proxy's own payment credential, so no grant
/// is found. The stake part alone is not enough.
test attack_grant_lookup_a_token_at_a_key_payment_credential_with_the_account_stake_part() fail {
  let fake = address.from_verification_key(device)
    |> address.with_delegation_script(stake_part)
  let order: Data = OrderDatum {
    ..good_order(),
    refund_receiver: fake,
    success_receiver: fake,
  }
  minswap_v2_policy.check(
    proxy,
    own,
    Transaction {
      ..placeholder,
      inputs: [grant_input_with(proxy, slot_name(), 1, fake)],
      outputs: [order_output(order)],
    },
  )
}

/// A UTxO holding a grant token and no inline datum is not read as a
/// grant, so beside the real grant the lookup still finds one grant and
/// accepts the valid order. Placement and the proxy keep such a UTxO from
/// existing; this pins the shape check on its own.
test grant_lookup_counts_only_utxos_with_an_inline_datum() {
  let real = grant_input([entry(own, settings_data(), order_address())])
  let bare = grant_input_with(proxy, slot_name(), 1, account_address())
  check_with_inputs(
    [real, Input { ..bare, output: Output { ..bare.output, datum: NoDatum } }],
  )
}

/// The token name carries the account prefix of another account than the
/// address it sits at. Only a name denoting its own address counts.
test attack_grant_lookup_a_token_named_after_another_account() fail {
  check_with_inputs(
    [
      grant_input_with(
        proxy,
        bytearray.concat(other_policy, #"00000007"),
        1,
        account_address(),
      ),
    ],
  )
}

/// A grant token of another account, sitting at that other account's
/// own address, is shaped exactly like a grant and is counted. Beside
/// the real grant there are two grant inputs and the script aborts,
/// which closes double satisfaction across two grants.
test attack_grant_lookup_two_accounts_grant_tokens_in_one_transaction() fail {
  check_with_inputs(
    [
      grant_input([entry(own, settings_data(), order_address())]),
      grant_input_with(
        proxy,
        bytearray.concat(other_policy, #"00000007"),
        1,
        other_account_address(),
      ),
    ],
  )
}

/// Two grant inputs of the same account: the lookup expects exactly one.
test attack_grant_lookup_two_grant_inputs() fail {
  let input = grant_input([entry(own, settings_data(), order_address())])
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

/// A UTxO with a Grant-shaped inline datum and no token under the proxy
/// policy poses as the grant, at the right address.
test attack_grant_lookup_a_grant_shaped_datum_without_a_token() fail {
  let base = grant_input([entry(own, settings_data(), order_address())])
  check_with_inputs(
    [
      Input {
        ..base,
        output: Output { ..base.output, value: assets.from_lovelace(2_000_000) },
      },
    ],
  )
}

/// The real grant is offered only as a reference input. The lookup reads
/// spent inputs alone, so the script finds no grant.
test attack_grant_lookup_a_grant_only_as_a_reference_input() fail {
  let good: Data = good_order()
  minswap_v2_policy.check(
    proxy,
    own,
    Transaction {
      ..placeholder,
      inputs: [],
      reference_inputs: [
        grant_input([entry(own, settings_data(), order_address())]),
      ],
      outputs: [order_output(good)],
    },
  )
}

/// A UTxO holding two units of the grant token poses as a grant. A
/// token in quantity two is not a grant token, so no grant is found.
test attack_grant_lookup_a_token_in_quantity_two() fail {
  check_with_inputs(
    [grant_input_with(proxy, slot_name(), 2, account_address())],
  )
}

/// A token whose name has the 28 byte state NFT shape or some other length
/// is not a grant token.
test attack_grant_lookup_a_token_with_the_state_nft_name_shape() fail {
  check_with_inputs([grant_input_with(proxy, stake_part, 1, account_address())])
}

/// A grant input without an inline datum is not read as a grant.
test attack_grant_lookup_a_grant_input_without_an_inline_datum() fail {
  let base = grant_input([entry(own, settings_data(), order_address())])
  check_with_inputs(
    [Input { ..base, output: Output { ..base.output, datum: NoDatum } }],
  )
}

/// A grant input with a token beside its grant token does not have the
/// single token shape a grant UTxO keeps and is not read as a grant.
test attack_grant_lookup_a_grant_utxo_holding_a_second_token() fail {
  let base = grant_input([entry(own, settings_data(), order_address())])
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

/// The order's receivers name another account of the same proxy. They
/// are compared with the grant input's own address, so proceeds cannot
/// be pointed at a different account, even another custody account.
test attack_receiver_the_success_receiver_names_another_account() {
  !check_order(
    OrderDatum { ..good_order(), success_receiver: other_account_address() },
  )
}

/// The refund receiver names another account of the same proxy.
test attack_receiver_the_refund_receiver_names_another_account() {
  !check_order(
    OrderDatum { ..good_order(), refund_receiver: other_account_address() },
  )
}

/// The receiver is the account's payment credential under no stake part:
/// a near duplicate of the account address, which is not the account.
test attack_receiver_the_account_without_its_stake_part() {
  !check_order(
    OrderDatum { ..good_order(), success_receiver: address.from_script(proxy) },
  )
}

/// The receiver is the account's payment credential with a pointer stake
/// part in place of the inline one.
test attack_receiver_the_account_with_a_pointer_stake_part() {
  !check_order(
    OrderDatum {
      ..good_order(),
      refund_receiver: Address {
        ..account_address(),
        stake_credential: Some(
          Pointer { slot_number: 1, transaction_index: 2, certificate_index: 3 },
        ),
      },
    },
  )
}

/// `settings` carried a receiver in an earlier shape; a settings value
/// naming a receiver at all is no longer honoured, because the account
/// is derived from the grant input. With the settings' extra field the
/// settings no longer decode.
test attack_receiver_a_settings_value_with_a_receiver_field_does_not_decode() fail {
  let with_receiver = builtin.constr_data(
    0,
    list.push(
      builtin.un_constr_data(settings_data()).2nd,
      {
        let addr: Data = address.from_verification_key(stranger)
        addr
      },
    ),
  )
  let order: Data = good_order()
  minswap_v2_policy.check(
    proxy,
    own,
    tx_of([entry(own, with_receiver, order_address())], [order_output(order)]),
  )
}

/// Two orders at the recipient, valid then invalid. Every output at the
/// recipient is checked, in either order.
test attack_orders_a_valid_then_an_invalid_order() {
  let good: Data = good_order()
  let bad: Data = OrderDatum {
    ..good_order(),
    canceller: KeyCanceller(stranger),
  }
  !minswap_v2_policy.check(
    proxy,
    own,
    tx_of(
      [entry(own, settings_data(), order_address())],
      [order_output(good), order_output(bad)],
    ),
  )
}

test attack_orders_an_invalid_then_a_valid_order() {
  let good: Data = good_order()
  let bad: Data = OrderDatum {
    ..good_order(),
    canceller: KeyCanceller(stranger),
  }
  !minswap_v2_policy.check(
    proxy,
    own,
    tx_of(
      [entry(own, settings_data(), order_address())],
      [order_output(bad), order_output(good)],
    ),
  )
}

/// An invalid order hidden behind several valid ones.
test attack_orders_an_invalid_order_behind_many_valid_ones() {
  let good: Data = good_order()
  let bad: Data = OrderDatum { ..good_order(), max_batcher_fee: 2_000_001 }
  let outputs = list.concat(
    list.repeat(order_output(good), 5),
    [order_output(bad)],
  )
  !minswap_v2_policy.check(
    proxy,
    own,
    tx_of([entry(own, settings_data(), order_address())], outputs),
  )
}

/// The first of two entries names this script with the good settings and
/// the second names it with settings that refuse the good order. Each
/// output is judged only by the settings of its own address.
fn two_address_recipients(settings_a: Data, settings_b: Data) -> List<Data> {
  [
    entry(own, settings_a, order_address()),
    entry(own, settings_b, address.from_script(lp_policy)),
  ]
}

fn strict_settings() -> Data {
  let data: Data = Settings { ..settings(), max_batcher_fee: 1_500_000 }
  data
}

fn order_at(at: Address, order: Data) -> Output {
  Output { ..order_output(order), address: at }
}

test same_script_two_settings_each_order_is_judged_by_its_own_entry() {
  let good: Data = good_order()
  let cheap: Data = OrderDatum { ..good_order(), max_batcher_fee: 1_500_000 }
  minswap_v2_policy.check(
    proxy,
    own,
    tx_of(
      two_address_recipients(settings_data(), strict_settings()),
      [order_output(good), order_at(address.from_script(lp_policy), cheap)],
    ),
  )
}

/// An order that the first entry's settings allow is refused at the
/// second entry's address, whose settings it breaks: a looser entry
/// cannot stand in for a stricter one at another address.
test attack_two_settings_a_loose_order_at_the_strict_address() {
  let good: Data = good_order()
  !minswap_v2_policy.check(
    proxy,
    own,
    tx_of(
      two_address_recipients(settings_data(), strict_settings()),
      [order_output(good), order_at(address.from_script(lp_policy), good)],
    ),
  )
}

/// The same with the entries swapped, so the entry order makes no
/// difference.
test attack_two_settings_a_loose_order_at_the_strict_address_entry_swapped() {
  let good: Data = good_order()
  !minswap_v2_policy.check(
    proxy,
    own,
    tx_of(
      [
        entry(own, strict_settings(), address.from_script(lp_policy)),
        entry(own, settings_data(), order_address()),
      ],
      [order_output(good), order_at(address.from_script(lp_policy), good)],
    ),
  )
}

/// A canceller of each other kind, with the same hash as the pinned key:
/// `SpendScriptCanceller` of the device's bytes is not `KeyCanceller` of
/// them, so the kind is pinned too.
test attack_canceller_each_other_variant_with_the_pinned_hash() {
  and {
    !check_order(
      OrderDatum { ..good_order(), canceller: SpendScriptCanceller(device) },
    ),
    !check_order(
      OrderDatum { ..good_order(), canceller: WithdrawScriptCanceller(device) },
    ),
    !check_order(
      OrderDatum { ..good_order(), canceller: MintScriptCanceller(device) },
    ),
  }
}

/// A receiver datum of each other kind on each receiver.
test attack_receiver_datum_each_variant_on_each_receiver() {
  and {
    !check_order(
      OrderDatum {
        ..good_order(),
        refund_receiver_datum: ReceiverDatumHash(#"aa"),
      },
    ),
    !check_order(
      OrderDatum {
        ..good_order(),
        refund_receiver_datum: ReceiverInlineDatum(#"aa"),
      },
    ),
    !check_order(
      OrderDatum {
        ..good_order(),
        success_receiver_datum: ReceiverInlineDatum(#"aa"),
      },
    ),
  }
}

/// The LP asset under another policy, the other half of the pair.
test attack_lp_asset_under_another_policy() {
  !check_order(
    OrderDatum {
      ..good_order(),
      lp_asset: Asset { policy_id: other_policy, asset_name: #"aabb" },
    },
  )
}

/// A negative sold amount with a negative minimum receive: both pass a
/// naive price comparison if the amounts are not bounded below.
test attack_amounts_negative_sold_and_minimum() {
  let inner: Data = step(SpecificAmount(-4_000_000), -12_000_000)
  !check_order(OrderDatum { ..good_order(), step: inner })
}

/// A zero minimum receive on a sold amount at the price.
test attack_amounts_a_zero_minimum_receive() {
  let inner: Data = step(SpecificAmount(4_000_000), 0)
  !check_order(OrderDatum { ..good_order(), step: inner })
}

/// A negative sold amount with a positive minimum receive.
test attack_amounts_a_negative_sold_amount() {
  let inner: Data = step(SpecificAmount(-1), 1)
  !check_order(OrderDatum { ..good_order(), step: inner })
}

/// A negative batcher fee.
test attack_fee_a_negative_max_batcher_fee() {
  !check_order(OrderDatum { ..good_order(), max_batcher_fee: -1 })
}

test accepts_a_max_batcher_fee_at_the_cap() {
  check_order(OrderDatum { ..good_order(), max_batcher_fee: 2_000_000 })
}

/// A tip one over the cap on the expiry option.
test attack_tip_one_above_the_cap() {
  !check_order(
    OrderDatum { ..good_order(), expiry_and_tip: Some((1, 1_000_001)) },
  )
}

/// A negative tip.
test attack_tip_a_negative_tip() {
  !check_order(OrderDatum { ..good_order(), expiry_and_tip: Some((1, -1)) })
}

/// `step.killable` is not read: either value is accepted, since a killable
/// order that cannot fill only returns its value to the pinned receivers.
test killable_is_not_pinned() {
  let inner: Data = SwapExactInStep {
    direction_a_to_b: True,
    amount: SpecificAmount(4_000_000),
    minimum_receive: 12_000_000,
    killable: True,
  }
  check_order(OrderDatum { ..good_order(), step: inner })
}

/// The minimum receive exactly at the limit is the same as the good
/// order's; one above passes, one below is refused.
test attack_price_one_below_the_limit_boundary() {
  let below: Data = step(SpecificAmount(1_000_000), 2_999_999)
  let at: Data = step(SpecificAmount(1_000_000), 3_000_000)
  let above: Data = step(SpecificAmount(1_000_000), 3_000_001)
  and {
    !check_order(OrderDatum { ..good_order(), step: below }),
    check_order(OrderDatum { ..good_order(), step: at }),
    check_order(OrderDatum { ..good_order(), step: above }),
  }
}

/// Very large integers do not overflow the price comparison: Plutus
/// integers are unbounded, so the rule stays exact at any magnitude.
test attack_price_very_large_integers_stay_exact() {
  let sold = 340_282_366_920_938_463_463_374_607_431_768_211_456
  let at: Data = step(SpecificAmount(sold), sold * 3)
  let below: Data = step(SpecificAmount(sold), sold * 3 - 1)
  and {
    check_order(OrderDatum { ..good_order(), step: at }),
    !check_order(OrderDatum { ..good_order(), step: below }),
  }
}

/// A settings value with a zero numerator makes the price bound vacuous:
/// any minimum receive would satisfy it. The script refuses the settings.
test attack_price_settings_a_zero_numerator_is_refused() {
  let order: Data = OrderDatum {
    ..good_order(),
    step: step(SpecificAmount(1), 1),
  }
  let s: Data = Settings { ..settings(), price_numerator: 0 }
  !minswap_v2_policy.check(
    proxy,
    own,
    tx_of([entry(own, s, order_address())], [order_output(order)]),
  )
}

/// A zero denominator is refused for the same reason; the price bound
/// would otherwise be a division by zero the check never performs.
/// A negative denominator with a negative minimum receive satisfies the
/// price rule arithmetically. The denominator's positivity refuses it.
test attack_price_settings_a_negative_denominator_with_a_negative_minimum_receive() {
  let inner: Data = step(SpecificAmount(1), -1)
  let order: Data = OrderDatum { ..good_order(), step: inner }
  let s: Data = Settings {
    ..settings(),
    price_numerator: 1,
    price_denominator: -1,
  }
  !minswap_v2_policy.check(
    proxy,
    own,
    tx_of([entry(own, s, order_address())], [order_output(order)]),
  )
}

test attack_price_settings_a_zero_denominator_is_refused() {
  let order: Data = good_order()
  let s: Data = Settings { ..settings(), price_denominator: 0 }
  !minswap_v2_policy.check(
    proxy,
    own,
    tx_of([entry(own, s, order_address())], [order_output(order)]),
  )
}

/// Negative price terms turn the bound upside down, accepting a price
/// below the limit. Each sign is refused.
test attack_price_settings_negative_terms_are_refused() {
  let order: Data = OrderDatum {
    ..good_order(),
    step: step(SpecificAmount(1), 1),
  }
  let negative: Data = Settings { ..settings(), price_numerator: -3 }
  let flipped: Data = Settings {
    ..settings(),
    price_numerator: -3,
    price_denominator: -1,
  }
  let negative_denominator: Data = Settings {
    ..settings(),
    price_denominator: -1,
  }
  and {
    !minswap_v2_policy.check(
      proxy,
      own,
      tx_of([entry(own, negative, order_address())], [order_output(order)]),
    ),
    !minswap_v2_policy.check(
      proxy,
      own,
      tx_of([entry(own, flipped, order_address())], [order_output(order)]),
    ),
    !minswap_v2_policy.check(
      proxy,
      own,
      tx_of(
        [entry(own, negative_denominator, order_address())],
        [order_output(order)],
      ),
    ),
  }
}

/// For any sold amount, price and offset, the order passes exactly when
/// the minimum receive reaches the bound.
test prop_price_rule_is_exact(
  picked via fuzz.tuple4(
    fuzz.int_between(1, 1_000_000_000),
    fuzz.int_between(1, 1_000),
    fuzz.int_between(1, 1_000),
    fuzz.int_between(-3, 3),
  ),
) {
  let (sold, numerator, denominator, offset) = picked
  let bound = ( sold * numerator + denominator - 1 ) / denominator
  let minimum = bound + offset
  if minimum <= 0 {
    True
  } else {
    let s: Data = Settings {
      ..settings(),
      price_numerator: numerator,
      price_denominator: denominator,
    }
    let inner: Data = step(SpecificAmount(sold), minimum)
    let order: Data = OrderDatum { ..good_order(), step: inner }
    let accepted = minswap_v2_policy.check(
      proxy,
      own,
      tx_of([entry(own, s, order_address())], [order_output(order)]),
    )
    accepted == ( minimum * denominator >= sold * numerator )
  }
}

// Malformed data

/// The good order as data with field `index` replaced by `value`.
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
  minswap_v2_policy.check(
    proxy,
    own,
    tx_of([entry(own, settings_data(), order_address())], [order_output(order)]),
  )
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
  check_order_data(builtin.constr_data(0, list.take(pair.2nd, 8)))
}

test attack_malformed_an_order_datum_with_a_wrong_constructor_tag() fail {
  let order: Data = good_order()
  check_order_data(builtin.constr_data(1, builtin.un_constr_data(order).2nd))
}

test attack_malformed_a_list_where_the_canceller_constructor_goes() fail {
  check_order_data(
    order_with_field(0, builtin.list_data([builtin.b_data(device)])),
  )
}

test attack_malformed_bytes_where_the_batcher_fee_integer_goes() fail {
  check_order_data(order_with_field(7, builtin.b_data(#"01")))
}

test attack_malformed_a_datum_that_is_not_a_constructor() fail {
  check_order_data(builtin.i_data(1))
}

test attack_malformed_a_step_with_an_extra_field() fail {
  let inner: Data = step(SpecificAmount(4_000_000), 12_000_000)
  let pair = builtin.un_constr_data(inner)
  check_order_data(
    order_with_field(
      6,
      builtin.constr_data(0, list.concat(pair.2nd, [builtin.i_data(0)])),
    ),
  )
}

test attack_malformed_a_step_with_a_list_where_the_amount_constructor_goes() fail {
  let inner: Data = step(SpecificAmount(4_000_000), 12_000_000)
  let pair = builtin.un_constr_data(inner)
  check_order_data(
    order_with_field(
      6,
      builtin.constr_data(
        0,
        list.indexed_map(
          pair.2nd,
          fn(i, field) {
            if i == 1 {
              builtin.list_data([builtin.i_data(4_000_000)])
            } else {
              field
            }
          },
        ),
      ),
    ),
  )
}

/// A specific amount carrying bytes where the integer goes.
test attack_malformed_bytes_inside_the_specific_amount() fail {
  let inner: Data = step(SpecificAmount(4_000_000), 12_000_000)
  let pair = builtin.un_constr_data(inner)
  check_order_data(
    order_with_field(
      6,
      builtin.constr_data(
        0,
        list.indexed_map(
          pair.2nd,
          fn(i, field) {
            if i == 1 {
              builtin.constr_data(0, [builtin.b_data(#"01")])
            } else {
              field
            }
          },
        ),
      ),
    ),
  )
}

/// Minswap's on-chain shape of the expiry option holds a list of two
/// integers under `Some`, the form this script decodes. Its off-chain
/// encoder at the pinned commit writes the two integers as fields of
/// `Some`, which Minswap's compiled validator itself refuses. Field 8 of
/// the order is replaced by each form.
test expiry_option_in_the_list_shape_decodes() {
  let some: Data = builtin.constr_data(
    0,
    [builtin.list_data([builtin.i_data(1), builtin.i_data(500_000)])],
  )
  check_order_data(order_with_field(8, some))
}

/// The two-field form of `Some` does not decode.
test attack_malformed_the_expiry_option_in_the_two_field_shape() fail {
  let some: Data = builtin.constr_data(
    0,
    [builtin.i_data(1), builtin.i_data(500_000)],
  )
  check_order_data(order_with_field(8, some))
}

/// `Some` with a list of three integers does not decode.
test attack_malformed_the_expiry_option_with_three_integers() fail {
  let some: Data = builtin.constr_data(
    0,
    [
      builtin.list_data(
        [builtin.i_data(1), builtin.i_data(2), builtin.i_data(3)],
      ),
    ],
  )
  check_order_data(order_with_field(8, some))
}

/// A settings value of the wrong shape aborts the script: an owner who
/// issues a bad entry bricks only that recipient, never relaxes it.
test attack_malformed_settings_that_are_an_integer() fail {
  let order: Data = good_order()
  minswap_v2_policy.check(
    proxy,
    own,
    tx_of(
      [entry(own, builtin.i_data(7), order_address())],
      [order_output(order)],
    ),
  )
}

test attack_malformed_settings_with_a_missing_field() fail {
  let order: Data = good_order()
  let pair = builtin.un_constr_data(settings_data())
  minswap_v2_policy.check(
    proxy,
    own,
    tx_of(
      [
        entry(
          own,
          builtin.constr_data(0, list.drop(pair.2nd, 1)),
          order_address(),
        ),
      ],
      [order_output(order)],
    ),
  )
}

// Economic escapes

/// An output at the order address that is not an order: no datum.
test attack_economic_a_plain_lovelace_output_at_the_order_address() fail {
  minswap_v2_policy.check(
    proxy,
    own,
    tx_of(
      [entry(own, settings_data(), order_address())],
      [Output { ..order_output(builtin.i_data(0)), datum: NoDatum }],
    ),
  )
}

/// The order's value is far more than its sold amount. Accepted: the
/// surplus is the grantee's own over spend of its grant caps, the caps
/// bound the outflow, and the surplus returns to the pinned receivers
/// when the order is filled or cancelled.
test economic_a_value_far_above_the_declared_sold_amount_is_accepted() {
  let order: Data = good_order()
  minswap_v2_policy.check(
    proxy,
    own,
    tx_of(
      [entry(own, settings_data(), order_address())],
      [
        Output {
          ..order_output(order),
          value: assets.from_lovelace(1_000_000_000),
        },
      ],
    ),
  )
}

/// Extra tokens in the order output. Accepted: the grant's scope already
/// limits what may leave the account, and tokens added by the grantee
/// are the grantee's to lose.
test economic_extra_tokens_in_the_order_output_are_accepted() {
  let order: Data = good_order()
  minswap_v2_policy.check(
    proxy,
    own,
    tx_of(
      [entry(own, settings_data(), order_address())],
      [
        Output {
          ..order_output(order),
          value: assets.add(
            assets.from_lovelace(2_000_000),
            other_policy,
            #"bb",
            10,
          ),
        },
      ],
    ),
  )
}

/// A reference script parked on an order output, which the batcher would
/// pay for or refuse, and which the order script never needs.
test attack_economic_an_order_output_carrying_a_reference_script() {
  let order: Data = good_order()
  !minswap_v2_policy.check(
    proxy,
    own,
    tx_of(
      [entry(own, settings_data(), order_address())],
      [Output { ..order_output(order), reference_script: Some(own) }],
    ),
  )
}

/// An output at the order script's payment credential under another
/// stake part is not at the recipient the entry names, so it is not
/// this script's concern; the logic refuses it because it reaches no
/// listed recipient.
test ignores_an_output_at_the_order_credential_under_another_stake_part() {
  let bad: Data = 1
  minswap_v2_policy.check(
    proxy,
    own,
    tx_of(
      [entry(own, settings_data(), order_address())],
      [
        Output {
          ..order_output(bad),
          address: order_address()
            |> address.with_delegation_script(stake_part),
        },
      ],
    ),
  )
}

/// Many orders each at the fee and tip cap: the script allows it, the
/// grant caps are the aggregate backstop, and the tip and fee add up to
/// orders times the cap at most.
test economic_many_orders_each_at_the_cap_aggregate_is_bounded_only_by_the_grant_caps() {
  let order: Data = OrderDatum {
    ..good_order(),
    max_batcher_fee: 2_000_000,
    expiry_and_tip: Some((1, 1_000_000)),
  }
  minswap_v2_policy.check(
    proxy,
    own,
    tx_of(
      [entry(own, settings_data(), order_address())],
      list.repeat(order_output(order), 6),
    ),
  )
}

/// An expired time with the tip at the cap is accepted. Anyone can cancel
/// the expired order and claim the tip, which the cap bounds per order;
/// the expiry time itself is not bounded. See the README.
test economic_an_already_expired_time_at_the_tip_cap_is_accepted() {
  check_order(
    OrderDatum { ..good_order(), expiry_and_tip: Some((0, 1_000_000)) },
  )
}

// Handlers

test withdraw_accepts_a_transaction_the_check_accepts() {
  let good: Data = good_order()
  let tx = tx_of(
    [entry(own, settings_data(), order_address())],
    [order_output(good)],
  )
  let redeemer: Data = 0
  minswap_v2_policy.minswap_v2_policy.withdraw(proxy, redeemer, Script(own), tx)
}

/// The withdraw handler refuses a key credential outright.
test attack_handlers_withdraw_with_a_key_credential() fail {
  let good: Data = good_order()
  let redeemer: Data = 0
  minswap_v2_policy.minswap_v2_policy.withdraw(
    proxy,
    redeemer,
    VerificationKey(own),
    tx_of([entry(own, settings_data(), order_address())], [order_output(good)]),
  )
}

test publish_accepts_the_registration_of_a_script_credential() {
  let redeemer: Data = 0
  minswap_v2_policy.minswap_v2_policy.publish(
    proxy,
    redeemer,
    RegisterCredential { credential: Script(own), deposit: Never },
    placeholder,
  )
}

/// A deregistration would remove the credential every future spend needs,
/// so the policy's `publish` refuses it, and every other certificate.
test attack_handlers_publish_refuses_other_certificates() {
  let redeemer: Data = 0
  let refuse = fn(certificate) {
    !minswap_v2_policy.minswap_v2_policy.publish(
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

/// For an entry at any of 8 positions among entries naming other
/// scripts, the order is judged only by its own entry's settings. A
/// valid order passes and a refused one fails at every position.
test prop_own_entry_is_found_at_any_position(
  position via fuzz.int_between(0, 7),
) {
  let others = fn(n: Int) {
    entry(
      other_policy,
      builtin.i_data(n),
      address.from_verification_key(stranger),
    )
  }
  let entries = list.concat(
    list.map(list.range(0, position - 1), others),
    [
      entry(own, settings_data(), order_address()),
      ..list.map(list.range(position, 6), others)
    ],
  )
  let good: Data = good_order()
  let bad: Data = OrderDatum { ..good_order(), max_batcher_fee: 2_000_001 }
  and {
    minswap_v2_policy.check(proxy, own, tx_of(entries, [order_output(good)])),
    !minswap_v2_policy.check(proxy, own, tx_of(entries, [order_output(bad)])),
  }
}

/// For any canceller hash, an order naming a different canceller than
/// the pinned one is refused, compared whole.
test prop_a_changed_canceller_is_refused(
  hash via fuzz.bytearray_between(28, 28),
) {
  if hash == device {
    True
  } else {
    !check_order(OrderDatum { ..good_order(), canceller: KeyCanceller(hash) })
  }
}
