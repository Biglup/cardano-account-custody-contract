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

// Exploit attempts against the account proxy, the logic and the stake
// script, one group per vulnerability class of the Cardano smart contract
// security curriculum. Every `attack_` test builds a transaction an
// adversary would submit and asserts that a validator refuses it: with
// `!` when the handler returns False and as a `fail` test when it aborts
// on an `expect`. The `budget_` tests build the largest well formed state
// and the heaviest transactions over it so that `aiken check` reports
// their execution units, the proxy's per input and the logic's per
// transaction.

// USINGS **********************************************************************

use account
use account_stake
use aiken/builtin
use aiken/cbor
use aiken/collection/list
use aiken/fuzz
use aiken/interval.{Interval, IntervalBound, NegativeInfinity}
use aiken/primitive/bytearray
use cardano/address.{Address, Pointer, Script, VerificationKey}
use cardano/assets.{Assets}
use cardano/certificate.{UnregisterCredential}
use cardano/transaction.{
  DatumHash, InlineDatum, Input, NoDatum, Output, Transaction,
}
use cardano_account_custody_contract/account as custody
use cardano_account_custody_contract/state as account_state
use cardano_account_custody_contract/test_helpers.{
  account_address, burn, change, control_output, control_reference,
  control_value, creation, delegation, device_key, expiry, fund_output,
  grant_burn, grant_data, grant_datum, grant_output, grant_token, grant_value,
  granted_state, input, issued_state, logic_hash, logic_transaction,
  lovelace_grant, lovelace_scope, next_logic_hash, other_account_address,
  other_control_output, other_device_key, other_fund_output, other_grant_output,
  other_stake_script_hash, output, output_reference, owner_transaction, payout,
  plain_recipient, publishing, recipient_address, referencing, registration,
  script_hash, spending, stake_script_hash, state, state_data, state_datum,
  state_nft, stranger_key, token, token_asset, token_grant, token_scope,
  treasury_input, upgrade_into, upgraded_state, with_caps, with_proxy_redeemers,
  withdrawing, without_withdrawals,
}
use cardano_account_custody_contract/types.{
  AccountState, Asset, BurnGrants, CreateAccount, Device, Fund, Grant,
  GrantPolicy, IssueGrants, Operate, Recipient, Run, Scope, SpendWithGrant,
  SweepGrant,
}
use logic_v1

// CONSTANTS *******************************************************************

/// The key hash of a party that holds no device, owner or grantee key.
const attacker_key = #"00000000000000000000000000000000000000000000000000000007"

/// The hash of a logic script the attacker controls.
const attacker_logic_hash =
  #"0000000000000000000000000000000000000000000000000000000b"

/// The stake credential of an account the attacker created under its own
/// logic and device. It sorts before every other account's, so its token
/// names come first in a mint shared with a victim's.
const attacker_stake_script_hash =
  #"00000000000000000000000000000000000000000000000000000000"

/// The slot of the largest lovelace grant: past the revoked list of the
/// largest state, which fills slots 1 to `max_revoked`, with the largest
/// token grant one slot below it.
const largest_grant_slot = account_state.max_revoked + 7

/// The next slot of the largest state, the first an issuance over it
/// takes.
const largest_next_slot = largest_grant_slot + 1

// FUNCTIONS *******************************************************************

/// The key address of the attacker.
fn attacker_address() -> Address {
  address.from_verification_key(attacker_key)
}

/// The address of the attacker's account at the test proxy.
fn attacker_account_address() -> Address {
  custody.account_address(script_hash, attacker_stake_script_hash)
}

/// The state of the attacker's account: the attacker's logic, which
/// approves anything, and the attacker's device.
fn attacker_state() -> AccountState {
  AccountState {
    logic: attacker_logic_hash,
    devices: [attacker_key],
    grant_generation: 0,
    next_slot: 0,
    revoked: [],
    outstanding: 0,
  }
}

/// The control UTxO of the attacker's account with `state` inline.
fn attacker_control_output(state: AccountState, lovelace: Int) -> Output {
  output(
    attacker_account_address(),
    control_value(attacker_stake_script_hash, lovelace),
    state_datum(state),
  )
}

/// The grant of slot 0 of the attacker's account, to the attacker.
fn attacker_grant() -> Grant {
  Grant { ..lovelace_grant(), grantee: attacker_key }
}

/// The grant UTxO of slot 0 of the attacker's account, at its address.
fn attacker_grant_output() -> Output {
  output(
    attacker_account_address(),
    grant_value(attacker_stake_script_hash, 0, 2_000_000),
    grant_datum(attacker_grant()),
  )
}

/// The grant UTxO of slot 0 of the attacker's account misplaced at the
/// victim's address.
fn misplaced_attacker_grant_output() -> Output {
  output(
    account_address(),
    grant_value(attacker_stake_script_hash, 0, 2_000_000),
    grant_datum(attacker_grant()),
  )
}

/// A transaction in which the attacker spends the given UTxOs of its own
/// account into the given outputs and mint, signed by the attacker and
/// run under the attacker's logic, whose approval is taken for granted.
fn attacker_spend(
  inputs: List<Input>,
  outputs: List<Output>,
  minted: Assets,
) -> Transaction {
  test_helpers.transaction(
    inputs,
    outputs,
    minted,
    [attacker_key],
    interval.everything,
  )
    |> with_proxy_redeemers()
    |> withdrawing([attacker_logic_hash])
}

/// A transaction in which the attacker spends the control UTxO of its own
/// account, with the given outputs and mint.
fn attacker_transaction(outputs: List<Output>, minted: Assets) -> Transaction {
  attacker_spend(
    [input(0, attacker_control_output(attacker_state(), 2_000_000))],
    outputs,
    minted,
  )
}

/// The attacker's account once it has issued its slot 0.
fn attacker_issued_state() -> AccountState {
  AccountState { ..attacker_state(), next_slot: 1, outstanding: 1 }
}

/// The lovelace scope restricted to the recipient.
fn restricted_scope() -> Scope {
  Scope {
    ..lovelace_scope(),
    recipients: [plain_recipient(recipient_address())],
  }
}

/// The granted state of the other account, under the next logic and the
/// other device, so that it shares a transaction with this account.
fn other_state() -> AccountState {
  AccountState {
    ..granted_state(),
    logic: next_logic_hash,
    devices: [other_device_key],
  }
}

/// The lovelace grant under the restricted scope.
fn restricted_grant() -> Grant {
  Grant { ..lovelace_grant(), scope: restricted_scope() }
}

/// Whether the proxy's spend handler accepts `redeemer` with an optional
/// account state datum for the input at `index` of `tx`.
fn proxy_spend(
  state: Option<AccountState>,
  redeemer: types.AccountRedeemer,
  index: Int,
  tx: Transaction,
) -> Bool {
  account.account.spend(
    state_data(state),
    redeemer,
    output_reference(index),
    tx,
  )
}

/// Whether the proxy's spend handler accepts `redeemer` with `grant` as
/// datum for the input at `index` of `tx`.
fn proxy_spend_grant(
  grant: Grant,
  redeemer: types.AccountRedeemer,
  index: Int,
  tx: Transaction,
) -> Bool {
  account.account.spend(
    grant_data(grant),
    redeemer,
    output_reference(index),
    tx,
  )
}

/// Whether the proxy's mint handler accepts `redeemer` over `tx` under the
/// test proxy.
fn proxy_mint(redeemer: types.MintRedeemer, tx: Transaction) -> Bool {
  account.account.mint(redeemer, script_hash, tx)
}

/// Whether the logic, run as `logic` over the test proxy, accepts `tx`.
fn run_as(logic: ByteArray, tx: Transaction) -> Bool {
  logic_v1.logic_v1.withdraw(script_hash, Run, Script(logic), tx)
}

/// Whether the test logic accepts `tx`.
fn run(tx: Transaction) -> Bool {
  run_as(logic_hash, tx)
}

/// Whether the stake script of the account under test, owned by
/// `device_key`, accepts publishing the registration of its credential.
fn register(tx: Transaction) -> Bool {
  account_stake.account_stake.publish(
    device_key,
    script_hash,
    Operate,
    registration(stake_script_hash),
    tx,
  )
}

/// Whether the stake script of the account under test accepts a
/// withdrawal from its reward account.
fn withdraw(tx: Transaction) -> Bool {
  account_stake.account_stake.withdraw(
    device_key,
    script_hash,
    Operate,
    Script(stake_script_hash),
    tx,
  )
}

/// Whether the stake script of the account under test accepts publishing
/// the delegation of its credential over `tx`.
fn delegate(tx: Transaction) -> Bool {
  account_stake.account_stake.publish(
    device_key,
    script_hash,
    Operate,
    delegation(),
    tx,
  )
}

/// The control UTxO of `state` as a reference input, at an index no spent
/// input uses.
fn control_reference_of(state: AccountState) -> Input {
  input(100, control_output(state, 2_000_000))
}

/// A transaction in which the Ed25519 grantee of `grant` spends from the
/// account's deposit of 10 ADA, with the given outputs, referencing the
/// control UTxO of the granted state.
fn grant_transaction(grant: Grant, outputs: List<Output>) -> Transaction {
  test_helpers.transaction(
    [
      input(0, grant_output(grant, 2_000_000)),
      input(1, fund_output(assets.from_lovelace(10_000_000))),
    ],
    outputs,
    assets.zero,
    [stranger_key],
    interval.before(expiry - 1),
  )
    |> referencing([control_reference()])
    |> with_proxy_redeemers()
    |> withdrawing([logic_hash])
}

/// The outputs of a lovelace grant spend that pays `lovelace` away from
/// the account and records it against the grant.
fn lovelace_grant_outputs(grant: Grant, lovelace: Int) -> List<Output> {
  [
    grant_output(with_caps(grant, 5_000_000 - lovelace, 0), 2_000_000),
    change(10_000_000 - lovelace),
    payout(lovelace),
  ]
}

/// Whether the logic accepts `grant` spending the 10 ADA deposit into the
/// given outputs as the grantee, referencing the granted control UTxO.
fn spend_lovelace_grant(grant: Grant, outputs: List<Output>) -> Bool {
  run(grant_transaction(grant, outputs))
}

/// A transaction in which the agent granted by both accounts spends
/// through the lovelace grant of each at once, under open recipient lists,
/// from a 10 ADA deposit of each, with `extra_inputs` beside them, into
/// `outputs`, referencing both control UTxOs and running both logics. The
/// other account is under the next logic, since one logic validates one
/// account per transaction.
fn two_account_grant_transaction(
  extra_inputs: List<Input>,
  outputs: List<Output>,
) -> Transaction {
  test_helpers.transaction(
    list.concat(
      [
        input(0, grant_output(lovelace_grant(), 2_000_000)),
        input(1, fund_output(assets.from_lovelace(10_000_000))),
        input(2, other_grant_output(lovelace_grant(), 2_000_000)),
        input(3, other_fund_output(assets.from_lovelace(10_000_000))),
      ],
      extra_inputs,
    ),
    outputs,
    assets.zero,
    [stranger_key],
    interval.before(expiry - 1),
  )
    |> referencing(
        [
          control_reference(),
          input(101, other_control_output(other_state(), 2_000_000)),
        ],
      )
    |> with_proxy_redeemers()
    |> withdrawing([logic_hash, next_logic_hash])
}

/// A 28 byte key hash ending in `n`.
fn key(n: Int) -> ByteArray {
  bytearray.push(#"000000000000000000000000000000000000000000000000000000", n)
}

/// `count` distinct key hashes.
fn keys(count: Int) -> List<ByteArray> {
  list.range(1, count) |> list.map(key)
}

/// `count` distinct key addresses.
fn recipients(count: Int) -> List<Recipient> {
  list.range(1, count)
    |> list.map(
        fn(n) { plain_recipient(address.from_verification_key(key(100 + n))) },
      )
}

/// Whether the logic accepts a device rewrite of the fresh control UTxO
/// into `next`.
fn rewrite_as(next: AccountState) -> Bool {
  run(
    owner_transaction(
      state(),
      [],
      [control_output(next, 2_000_000)],
      assets.zero,
    ),
  )
}

// TESTS ***********************************************************************

/// Two accounts grant the same agent under open recipient lists and the
/// agent spends through both at once, returning each deposit 2 ADA short.
/// One 2 ADA output to the recipient is offered as the payout of both
/// spends and recorded against the first account's grant only, the other
/// 2 ADA riding out to the attacker, which an open list allows. Each
/// logic nets its own account's address: the first account's grant
/// records what left it and passes, the second's sees 2 ADA leaving that
/// its unchanged grant does not record, and that rule alone refuses the
/// transaction.
/// Proves INV-39.
test attack_double_satisfaction_one_recipient_output_for_two_accounts() {
  let tx = two_account_grant_transaction(
    [],
    [
      grant_output(with_caps(lovelace_grant(), 3_000_000, 0), 2_000_000),
      change(8_000_000),
      other_grant_output(lovelace_grant(), 2_000_000),
      other_fund_output(assets.from_lovelace(8_000_000)),
      payout(2_000_000),
      output(attacker_address(), assets.from_lovelace(2_000_000), NoDatum),
    ],
  )
  and {
    run(tx),
    !run_as(next_logic_hash, tx),
  }
}

/// The agent takes 2 ADA out of the first account for the recipient and
/// puts 2 ADA of its own into the second, so that across the two accounts,
/// which share the payment script, nothing leaves, and hands both grants
/// back unchanged. The netting runs per account address, stake part
/// included: the second account's logic sees a deposit and passes, the
/// first's sees 2 ADA leaving unrecorded and refuses.
/// Proves INV-39.
test attack_double_satisfaction_a_deposit_into_another_account_offsets_the_outflow() {
  let tx = two_account_grant_transaction(
    [
      input(
        4,
        output(attacker_address(), assets.from_lovelace(2_000_000), NoDatum),
      ),
    ],
    [
      grant_output(lovelace_grant(), 2_000_000),
      change(8_000_000),
      other_grant_output(lovelace_grant(), 2_000_000),
      other_fund_output(assets.from_lovelace(12_000_000)),
      payout(2_000_000),
    ],
  )
  and {
    run_as(next_logic_hash, tx),
    !run(tx),
  }
}

/// A deposit of another account is spent as if this account's control
/// UTxO authorised it. `Fund` looks for an account token of the deposit's
/// own stake credential, which the transaction does not spend.
/// Proves INV-11.
test attack_double_satisfaction_fund_of_another_account_rides_on_this_control() {
  let tx = logic_transaction(
    [
      input(0, control_output(state(), 2_000_000)),
      input(3, other_fund_output(assets.from_lovelace(10_000_000))),
    ],
    [control_output(state(), 2_000_000), payout(10_000_000)],
    assets.zero,
    [device_key],
    interval.everything,
  )
  !proxy_spend(None, Fund, 3, tx)
}

/// The same with a grant UTxO of this account standing in for the other
/// account's authority.
/// Proves INV-11.
test attack_double_satisfaction_fund_of_another_account_rides_on_this_grant() {
  let tx = logic_transaction(
    [
      input(0, grant_output(lovelace_grant(), 2_000_000)),
      input(3, other_fund_output(assets.from_lovelace(10_000_000))),
    ],
    [grant_output(lovelace_grant(), 2_000_000), payout(10_000_000)],
    assets.zero,
    [stranger_key],
    interval.before(expiry - 1),
  )
    |> referencing([control_reference()])
  !proxy_spend(None, Fund, 3, tx)
}

/// A deposit at the account address carries an inline state naming the
/// attacker as its only device, and is spent on the owner path. It does
/// not hold the state NFT, so it is not the control UTxO: the proxy finds
/// no control UTxO of the account and refuses before any logic runs.
/// Proves INV-10.
test attack_missing_utxo_authentication_forged_control_without_the_nft_device() {
  let forged = AccountState { ..state(), devices: [attacker_key] }
  let tx = logic_transaction(
    [
      input(
        1,
        output(
          account_address(),
          assets.from_lovelace(2_000_000),
          state_datum(forged),
        ),
      ),
      input(2, fund_output(assets.from_lovelace(10_000_000))),
    ],
    [
      output(
        account_address(),
        assets.from_lovelace(2_000_000),
        state_datum(forged),
      ),
      output(attacker_address(), assets.from_lovelace(10_000_000), NoDatum),
    ],
    assets.zero,
    [attacker_key],
    interval.everything,
  )
    |> spending(1, Device)
  !proxy_spend(Some(forged), Device, 1, tx)
}

/// A deposit carrying a forged grant with a huge cap for the attacker is
/// spent on the agent path over the real control UTxO. The grant token is
/// not among the inputs, so no output can carry it and the logic aborts
/// looking for the grant output; with one, the missing token on the spent
/// input would refuse it as well.
/// Proves INV-31 and INV-38.
test attack_missing_utxo_authentication_forged_grant_without_the_token() fail {
  let forged = Grant {
    ..lovelace_grant(),
    grantee: attacker_key,
    scope: Scope { ..lovelace_scope(), per_call_cap: 10_000_000 },
  }
  let tx = logic_transaction(
    [
      input(
        1,
        output(
          account_address(),
          assets.from_lovelace(2_000_000),
          grant_datum(forged),
        ),
      ),
      input(2, fund_output(assets.from_lovelace(10_000_000))),
    ],
    [
      output(
        account_address(),
        assets.from_lovelace(2_000_000),
        grant_datum(forged),
      ),
      output(attacker_address(), assets.from_lovelace(10_000_000), NoDatum),
    ],
    assets.zero,
    [attacker_key],
    interval.before(expiry - 1),
  )
    |> referencing([control_reference()])
    |> spending(1, SpendWithGrant)
  run(tx)
}

/// A deposit carrying a forged grant is spent beside the real grant UTxO,
/// so that a grant output exists. The deposit does not hold the token.
/// Proves INV-31.
test attack_missing_utxo_authentication_forged_grant_beside_the_real_one() {
  let forged = Grant {
    ..lovelace_grant(),
    grantee: attacker_key,
    scope: Scope { ..lovelace_scope(), per_call_cap: 10_000_000 },
  }
  let tx = logic_transaction(
    [
      input(0, grant_output(lovelace_grant(), 2_000_000)),
      input(
        1,
        output(
          account_address(),
          assets.from_lovelace(10_000_000),
          grant_datum(forged),
        ),
      ),
    ],
    [
      grant_output(lovelace_grant(), 2_000_000),
      output(attacker_address(), assets.from_lovelace(10_000_000), NoDatum),
    ],
    assets.zero,
    [attacker_key],
    interval.before(expiry - 1),
  )
    |> referencing([control_reference()])
    |> spending(1, SpendWithGrant)
  !run(tx)
}

/// The control UTxO is only referenced, not spent, so no handler ever
/// runs on it. `Fund` only accepts an account token among the inputs.
/// Proves INV-11.
test attack_missing_utxo_authentication_fund_with_the_control_as_a_reference_input() {
  let tx = logic_transaction(
    [input(1, fund_output(assets.from_lovelace(10_000_000)))],
    [output(attacker_address(), assets.from_lovelace(10_000_000), NoDatum)],
    assets.zero,
    [attacker_key],
    interval.everything,
  )
    |> referencing([control_reference_of(state())])
  !proxy_spend(None, Fund, 1, tx)
}

/// A token of another policy named after the stake credential sits at the
/// account address and poses as the control UTxO. Account tokens are
/// identified by the proxy's own policy id.
/// Proves INV-10 and INV-11.
test attack_missing_utxo_authentication_lookalike_nft_from_another_policy() {
  let lookalike = assets.merge(
    assets.from_lovelace(2_000_000),
    assets.from_asset(token_asset().policy_id, stake_script_hash, 1),
  )
  let tx = logic_transaction(
    [
      input(0, output(account_address(), lookalike, state_datum(state()))),
      input(1, fund_output(assets.from_lovelace(10_000_000))),
    ],
    [
      output(account_address(), lookalike, state_datum(state())),
      output(attacker_address(), assets.from_lovelace(10_000_000), NoDatum),
    ],
    assets.zero,
    [attacker_key],
    interval.everything,
  )
  and {
    !proxy_spend(None, Fund, 1, tx),
    !proxy_spend(Some(state()), Device, 0, tx),
  }
}

/// The same with a lookalike grant token: a token of another policy named
/// like a grant token is no grant UTxO, so the attacker's grant datum is
/// never consulted and the deposit beside it cannot ride on it.
/// Proves INV-11.
test attack_missing_utxo_authentication_lookalike_grant_token_from_another_policy() {
  let forged = Grant { ..lovelace_grant(), grantee: attacker_key }
  let lookalike = assets.merge(
    assets.from_lovelace(2_000_000),
    assets.from_asset(
      token_asset().policy_id,
      custody.grant_token_name(stake_script_hash, 0),
      1,
    ),
  )
  let tx = logic_transaction(
    [
      input(0, output(account_address(), lookalike, grant_datum(forged))),
      input(1, fund_output(assets.from_lovelace(10_000_000))),
    ],
    [
      output(account_address(), lookalike, grant_datum(forged)),
      output(attacker_address(), assets.from_lovelace(3_000_000), NoDatum),
      change(7_000_000),
    ],
    assets.zero,
    [attacker_key],
    interval.before(expiry - 1),
  )
    |> referencing([control_reference()])
  !proxy_spend(None, Fund, 1, tx)
}

/// The mint handler is asked to burn a state NFT whose only input sits at
/// a key address. The placement invariant keeps the NFT away from such an
/// address in the first place, and the creation redeemer refuses every
/// burn regardless.
/// Proves INV-2 and INV-4.
test attack_missing_utxo_authentication_burn_with_the_nft_at_a_key_address() {
  !proxy_mint(CreateAccount, stray_nft_burn_transaction())
}

/// The same under `BurnGrants`: the control UTxO of the account the name
/// denotes is not present, so the proxy refuses.
/// Proves INV-3 and INV-10.
test attack_missing_utxo_authentication_burn_grants_with_the_nft_at_a_key_address() {
  !proxy_mint(BurnGrants, stray_nft_burn_transaction())
}

/// A transaction burning the state NFT out of a UTxO parked at the
/// attacker's key address, signed by the attacker.
fn stray_nft_burn_transaction() -> Transaction {
  logic_transaction(
    [
      input(
        0,
        output(attacker_address(), control_value(stake_script_hash, 2), NoDatum),
      ),
    ],
    [],
    burn(),
    [attacker_key],
    interval.everything,
  )
}

/// The grantee recreates its grant UTxO with its own cap raised. The
/// recreated grant must keep every field of the spent one but the
/// remaining caps, which may only fall, by at least the outflow.
/// Proves INV-39.
test attack_datum_hijacking_grant_spend_raises_its_own_cap() {
  !spend_lovelace_grant(
    lovelace_grant(),
    [
      grant_output(with_caps(lovelace_grant(), 50_000_000, 0), 2_000_000),
      change(8_000_000),
      payout(2_000_000),
    ],
  )
}

/// The grantee rewrites its grant with a later generation, so that a
/// revoke all that raises the generation would not reach it.
/// Proves INV-39.
test attack_datum_hijacking_grant_spend_advances_its_own_generation() {
  !spend_lovelace_grant(
    lovelace_grant(),
    [
      grant_output(
        Grant { ..with_caps(lovelace_grant(), 3_000_000, 0), generation: 1 },
        2_000_000,
      ),
      change(8_000_000),
      payout(2_000_000),
    ],
  )
}

/// The grantee hands its grant to another key.
/// Proves INV-39.
test attack_datum_hijacking_grant_spend_rewrites_its_grantee() {
  !spend_lovelace_grant(
    lovelace_grant(),
    [
      grant_output(
        Grant {
          ..with_caps(lovelace_grant(), 3_000_000, 0),
          grantee: attacker_key,
        },
        2_000_000,
      ),
      change(8_000_000),
      payout(2_000_000),
    ],
  )
}

/// The grantee sends the grant token and the grant to another account's
/// address. The grant output is found by its token wherever it sits, and
/// must sit at the spent input's own address; the placement rule refuses
/// it as well.
/// Proves INV-38 and INV-40.
test attack_datum_hijacking_grant_spend_relocates_the_grant_to_another_account_address() {
  let relocated = output(
    other_account_address(),
    grant_value(stake_script_hash, 0, 2_000_000),
    grant_datum(with_caps(lovelace_grant(), 3_000_000, 0)),
  )
  !spend_lovelace_grant(
    lovelace_grant(),
    [relocated, change(8_000_000), payout(2_000_000)],
  )
}

/// The grantee recreates the grant UTxO with the grant given by hash
/// instead of inline. The expected grant is compared as an inline datum.
/// Proves INV-39.
test attack_datum_hijacking_grant_spend_grant_datum_given_by_hash() {
  let hashed = output(
    account_address(),
    grant_value(stake_script_hash, 0, 2_000_000),
    DatumHash(attacker_key),
  )
  !spend_lovelace_grant(
    lovelace_grant(),
    [hashed, change(8_000_000), payout(2_000_000)],
  )
}

/// The owner path is given a control output whose datum is a well formed
/// state followed by an extra constructor field. It names this logic, so
/// decoding it as an `AccountState` aborts, and a padded datum can never
/// be stored under this logic.
/// Proves INV-46.
test attack_datum_hijacking_padded_state_datum_on_a_device_rewrite() fail {
  let logic: Data = logic_hash
  let devices: Data = state().devices
  let grant_generation: Data = 0
  let next_slot: Data = 0
  let revoked: Data = state().revoked
  let outstanding: Data = 0
  let extra_field: Data = 7
  let padded: Data = builtin.constr_data(
    0,
    [
      logic, devices, grant_generation, next_slot, revoked, outstanding,
      extra_field,
    ],
  )
  let tx = owner_transaction(
    state(),
    [],
    [
      output(
        account_address(),
        control_value(stake_script_hash, 2_000_000),
        InlineDatum(padded),
      ),
    ],
    assets.zero,
  )
  run(tx)
}

/// The same for a grant datum at issuance: a padded grant aborts the
/// issuance rule's decoding.
/// Proves INV-46.
test attack_datum_hijacking_padded_grant_datum_at_issuance() fail {
  let slot: Data = 0
  let grantee: Data = stranger_key
  let generation: Data = 0
  let scope: Data = lovelace_scope()
  let extra_field: Data = 7
  let padded: Data = builtin.constr_data(
    0,
    [slot, grantee, generation, scope, extra_field],
  )
  let tx = owner_transaction(
    state(),
    [],
    [
      control_output(
        AccountState { ..state(), next_slot: 1, outstanding: 1 },
        2_000_000,
      ),
      output(
        account_address(),
        grant_value(stake_script_hash, 0, 2_000_000),
        InlineDatum(padded),
      ),
    ],
    grant_token(stake_script_hash, 0),
  )
  run(tx)
}

/// The grantee offers a padded `SpendWithGrant` redeemer on its grant
/// UTxO, the right constructor index with an extra field. The logic reads
/// the proxy redeemers from the script context through a soft cast and
/// leaves a value it cannot read alone, so a padded redeemer the ledger
/// accepted would carry a grant spend past the grant rule; the proxy's
/// redeemer is a typed parameter, and the cast the ledger applies to it
/// refuses the padded constructor before the handler runs. The padded
/// datum cases above are the same question asked of the datum.
/// Proves INV-30.
test attack_datum_hijacking_padded_grant_redeemer_on_a_grant_spend() fail {
  let extra_field: Data = 7
  let padded: Data = builtin.constr_data(1, [extra_field])
  expect redeemer: types.AccountRedeemer = padded
  let grant = lovelace_grant()
  proxy_spend_grant(
    grant,
    redeemer,
    0,
    grant_transaction(grant, lovelace_grant_outputs(grant, 3_000_000)),
  )
}

/// An account at the victim's address, under the attacker's device, is
/// created with only the attacker's signature. The proxy and the logic
/// accept the registration they see, since checking it is the stake
/// script's job, and the stake script refuses to publish a registration
/// the owner did not sign.
/// Proves INV-14.
test attack_token_forgery_victims_address_with_the_attackers_signature() {
  let tx = creation(
    [control_output(AccountState { ..state(), devices: [attacker_key] }, 2)],
    state_nft(stake_script_hash),
    [attacker_key],
  )
  and {
    proxy_mint(CreateAccount, tx),
    run(tx),
    !register(tx),
  }
}

/// A dApp builds the creation of the owner's account with its own key as
/// the only device and the owner, who cannot inspect the datum, signs it.
/// The proxy and the logic accept the state, which is well formed, and
/// the stake script refuses the registration because the owner is missing
/// from the devices of the control output.
/// Proves INV-14.
test attack_token_forgery_owner_signed_creation_without_the_owner_as_a_device() {
  let tx = creation(
    [
      control_output(
        AccountState { ..state(), devices: [attacker_key] },
        2_000_000,
      ),
    ],
    state_nft(stake_script_hash),
    [device_key],
  )
  and {
    proxy_mint(CreateAccount, tx),
    run(tx),
    !register(tx),
  }
}

/// A state NFT named after the attacker's own stake credential is minted
/// into an output at the victim's account address. The control output
/// must sit at the account address of the name, so none is found and the
/// proxy aborts.
/// Proves INV-6.
test attack_token_forgery_attackers_name_into_the_victims_address() fail {
  let misplaced = output(
    account_address(),
    control_value(other_stake_script_hash, 2_000_000),
    state_datum(AccountState { ..state(), devices: [attacker_key] }),
  )
  let tx = logic_transaction(
    [],
    [misplaced],
    state_nft(other_stake_script_hash),
    [attacker_key],
    interval.everything,
  )
    |> publishing(registration(other_stake_script_hash))
  proxy_mint(CreateAccount, tx)
}

/// A second state NFT of the account is minted in the middle of a grant
/// spend, with a control output carrying the grantee's own state. The
/// proxy demands a registration of the stake credential, which the
/// transaction does not carry and which the ledger would refuse for a
/// credential already registered, and the agent path admits no mint under
/// the policy at all.
/// Proves INV-5 and INV-30.
test attack_token_forgery_second_nft_minted_during_a_grant_spend() {
  let hijacked = AccountState { ..granted_state(), devices: [stranger_key] }
  let tx = Transaction {
    ..grant_transaction(
      lovelace_grant(),
      [
        grant_output(with_caps(lovelace_grant(), 3_000_000, 0), 2_000_000),
        control_output(hijacked, 2_000_000),
        change(6_000_000),
        payout(2_000_000),
      ],
    ),
    mint: state_nft(stake_script_hash),
  }
    |> with_proxy_redeemers()
  and {
    !proxy_mint(CreateAccount, tx),
    !run(tx),
  }
}

/// The grantee mints itself a second grant token during a grant spend.
/// The agent path admits no mint under the policy.
/// Proves INV-30.
test attack_token_forgery_grant_token_minted_during_a_grant_spend() {
  let self_issued = Grant {
    ..lovelace_grant(),
    slot: 2,
    scope: Scope {
      ..lovelace_scope(),
      per_call_cap: 100_000_000,
      cap: 100_000_000,
    },
  }
  let tx = Transaction {
    ..grant_transaction(
      lovelace_grant(),
      [
        grant_output(with_caps(lovelace_grant(), 3_000_000, 0), 2_000_000),
        grant_output(self_issued, 2_000_000),
        change(6_000_000),
        payout(2_000_000),
      ],
    ),
    mint: grant_token(stake_script_hash, 2),
  }
    |> with_proxy_redeemers()
  !run(tx)
}

/// `IssueGrants` over a referenced control UTxO passes the proxy, which
/// only asks that the control UTxO is present and its logic runs; the
/// logic's agent path admits no mint.
/// Proves INV-30.
test attack_token_forgery_issue_grants_without_the_control_utxo_spent() {
  let tx = Transaction {
    ..grant_transaction(
      lovelace_grant(),
      [
        grant_output(with_caps(lovelace_grant(), 3_000_000, 0), 2_000_000),
        grant_output(Grant { ..lovelace_grant(), slot: 2 }, 2_000_000),
        change(6_000_000),
        payout(2_000_000),
      ],
    ),
    mint: grant_token(stake_script_hash, 2),
  }
    |> with_proxy_redeemers()
  and {
    proxy_mint(IssueGrants, tx),
    !run(tx),
  }
}

/// The grantee spends the control UTxO on the owner path to issue itself
/// a grant, signing with its own key only.
/// Proves INV-20 and INV-26.
test attack_token_forgery_issue_grants_with_the_grantee_signature() {
  let tx = Transaction {
    ..owner_transaction(
      granted_state(),
      [],
      [
        control_output(
          AccountState { ..granted_state(), next_slot: 3, outstanding: 3 },
          2_000_000,
        ),
        grant_output(Grant { ..lovelace_grant(), slot: 2 }, 2_000_000),
      ],
      grant_token(stake_script_hash, 2),
    ),
    extra_signatories: [stranger_key],
  }
  !run(tx)
}

/// The owner of another account mints a grant token named after this
/// account, under its own control UTxO. The proxy looks for the control
/// UTxO of the account the name denotes, which is not present; the other
/// account's logic refuses the name as well.
/// Proves INV-10 and INV-26.
test attack_token_forgery_grant_token_named_after_another_account() {
  let other = AccountState { ..state(), devices: [attacker_key] }
  let tx = logic_transaction(
    [input(0, other_control_output(other, 2_000_000))],
    [
      other_control_output(
        AccountState { ..other, next_slot: 1, outstanding: 1 },
        2_000_000,
      ),
      output(
        other_account_address(),
        grant_value(stake_script_hash, 0, 2_000_000),
        grant_datum(Grant { ..lovelace_grant(), grantee: attacker_key }),
      ),
    ],
    grant_token(stake_script_hash, 0),
    [attacker_key],
    interval.everything,
  )
  and {
    !proxy_mint(IssueGrants, tx),
    !run(tx),
  }
}

/// The owner reissues a slot that has already been issued, which would
/// put two grant UTxOs under one token name. The minted names must start
/// at the next slot.
/// Proves INV-26.
test attack_token_forgery_grant_token_reusing_an_issued_slot() {
  let tx = owner_transaction(
    granted_state(),
    [],
    [
      control_output(
        AccountState { ..granted_state(), next_slot: 3, outstanding: 3 },
        2_000_000,
      ),
      grant_output(lovelace_grant(), 2_000_000),
    ],
    grant_token(stake_script_hash, 0),
  )
  !run(tx)
}

/// The owner issues a grant while writing a control state whose counters
/// do not move, so the slot could be reissued later.
/// Proves INV-24.
test attack_token_forgery_issue_grants_without_moving_the_counters() {
  let tx = owner_transaction(
    granted_state(),
    [],
    [
      control_output(granted_state(), 2_000_000),
      grant_output(Grant { ..lovelace_grant(), slot: 2 }, 2_000_000),
    ],
    grant_token(stake_script_hash, 2),
  )
  !run(tx)
}

/// The control output is minted at an address whose stake part is a
/// verification key credential carrying the stake script hash's bytes.
/// The account address pairs the proxy with a script stake credential
/// only.
/// Proves INV-6.
test attack_token_forgery_create_account_with_a_key_stake_credential() fail {
  let address = address.from_script(script_hash)
    |> address.with_delegation_key(stake_script_hash)
  let tx = creation(
    [
      output(
        address,
        control_value(stake_script_hash, 2_000_000),
        state_datum(state()),
      ),
    ],
    state_nft(stake_script_hash),
    [device_key],
  )
  proxy_mint(CreateAccount, tx)
}

/// The owner parks a token of another policy named after the stake
/// credential on the control output. The control output may hold nothing
/// but lovelace and the state NFT, whichever the token's name.
/// Proves INV-24.
test attack_token_forgery_lookalike_token_named_after_the_stake_credential_on_the_control() {
  let parked = output(
    account_address(),
    assets.merge(
      control_value(stake_script_hash, 2_000_000),
      assets.from_asset(token_asset().policy_id, stake_script_hash, 1),
    ),
    state_datum(state()),
  )
  !run(owner_transaction(state(), [], [parked], assets.zero))
}

/// The owner key, or anyone, mints a second control UTxO for an existing
/// account under devices of their choosing. The ledger registers a stake
/// credential once, so the transaction cannot carry a registration of the
/// account's credential while the account exists, and without one the
/// proxy refuses the second creation.
/// Proves INV-5.
test attack_token_forgery_parallel_control_utxo_without_a_registration() {
  let parallel = AccountState { ..state(), devices: [attacker_key] }
  let tx = logic_transaction(
    [
      input(
        5,
        output(attacker_address(), assets.from_lovelace(3_000_000), NoDatum),
      ),
    ],
    [control_output(parallel, 2_000_000)],
    state_nft(stake_script_hash),
    [device_key, attacker_key],
    interval.everything,
  )
  !proxy_mint(CreateAccount, tx)
}

/// The same, with the registration listed among the certificates in the
/// legacy format that needs no witness, so the stake script never runs
/// on it. The proxy looks for the stake script's redeemer, not for the
/// certificate; the logic's withdrawal stays in place so only that rule
/// refuses.
/// Proves INV-5.
test attack_token_forgery_parallel_control_utxo_with_an_unwitnessed_registration() {
  let parallel = AccountState { ..state(), devices: [attacker_key] }
  let tx = Transaction {
    ..creation(
      [control_output(parallel, 2_000_000)],
      state_nft(stake_script_hash),
      [attacker_key],
    ),
    redeemers: [],
  }
  !proxy_mint(CreateAccount, tx)
}

/// A state NFT is minted under `IssueGrants`. The proxy admits grant
/// names only under the grant redeemers, and the account the name denotes
/// has no control UTxO present either way.
/// Proves INV-3 and INV-10.
test attack_token_forgery_state_nft_minted_as_a_grant() {
  let tx = owner_transaction(
    state(),
    [],
    [
      control_output(
        AccountState { ..state(), next_slot: 1, outstanding: 1 },
        2_000_000,
      ),
      other_control_output(
        AccountState { ..state(), devices: [attacker_key] },
        2_000_000,
      ),
    ],
    state_nft(other_stake_script_hash),
  )
    |> test_helpers.minting(IssueGrants)
  !proxy_mint(IssueGrants, tx)
}

/// The attacker, owning an account under a logic that approves anything,
/// mints a grant token of the victim's account beside its own, into a
/// forged grant UTxO at the victim's address naming itself as grantee
/// under the victim's current generation. The attacker's name sorts
/// first, so its control UTxO is the one present; the proxy requires
/// every minted name to belong to that account and refuses, whatever the
/// attacker's logic approves.
/// Proves INV-3.
test attack_token_forgery_victims_grant_token_minted_beside_the_attackers_own() {
  let forged = output(
    account_address(),
    grant_value(stake_script_hash, 2, 2_000_000),
    grant_datum(
      Grant {
        ..lovelace_grant(),
        slot: 2,
        grantee: attacker_key,
        scope: Scope {
          ..lovelace_scope(),
          per_call_cap: 100_000_000,
          cap: 100_000_000,
        },
      },
    ),
  )
  let tx = attacker_transaction(
    [
      attacker_control_output(attacker_issued_state(), 2_000_000),
      attacker_grant_output(),
      forged,
    ],
    assets.merge(
      grant_token(attacker_stake_script_hash, 0),
      grant_token(stake_script_hash, 2),
    ),
  )
  !proxy_mint(IssueGrants, tx)
}

/// The same with the victim's state NFT name minted beside the attacker's
/// grant token, into a second control UTxO of the victim under the
/// attacker's devices and logic, which would also satisfy the stake
/// script's device rule. A 28 byte name is never a grant name, so only
/// `CreateAccount` mints one and the proxy refuses.
/// Proves INV-3.
test attack_token_forgery_victims_state_nft_minted_beside_the_attackers_grant() {
  let hijacked = AccountState {
    ..granted_state(),
    logic: attacker_logic_hash,
    devices: [attacker_key],
  }
  let tx = attacker_transaction(
    [
      attacker_control_output(attacker_issued_state(), 2_000_000),
      attacker_grant_output(),
      control_output(hijacked, 2_000_000),
    ],
    assets.merge(
      grant_token(attacker_stake_script_hash, 0),
      state_nft(stake_script_hash),
    ),
  )
    |> test_helpers.minting(IssueGrants)
  !proxy_mint(IssueGrants, tx)
}

/// The attacker burns the state NFT of its own account under `BurnGrants`
/// with its logic approving, which would let a later mint recreate the
/// account under new terms. No redeemer but `CreateAccount` admits a 28
/// byte name, and that one admits no burn.
/// Proves INV-3 and INV-4.
test attack_token_forgery_state_nft_burned_under_burn_grants() {
  let tx = attacker_transaction(
    [payout(2_000_000)],
    assets.from_asset(script_hash, attacker_stake_script_hash, -1),
  )
  !proxy_mint(BurnGrants, tx)
}

/// The attacker mints its own grant token under `BurnGrants`, where no
/// placement rule runs, into an output at the victim's address, and
/// burns one under `IssueGrants`. The proxy ties the quantity to the
/// redeemer: one under `IssueGrants`, minus one under `BurnGrants`.
/// Proves INV-3.
test attack_token_forgery_grant_token_minted_under_burn_grants() {
  let tx = attacker_transaction(
    [
      attacker_control_output(attacker_issued_state(), 2_000_000),
      misplaced_attacker_grant_output(),
    ],
    grant_token(attacker_stake_script_hash, 0),
  )
    |> test_helpers.minting(BurnGrants)
  !proxy_mint(BurnGrants, tx)
}

/// The attacker burns its own grant token under `IssueGrants`, with
/// its logic approving. The proxy admits a quantity of one only under
/// that redeemer.
/// Proves INV-3.
test attack_token_forgery_grant_token_burned_under_issue_grants() {
  let tx = test_helpers.transaction(
    [
      input(0, attacker_control_output(attacker_issued_state(), 2_000_000)),
      input(1, attacker_grant_output()),
    ],
    [attacker_control_output(attacker_state(), 2_000_000), payout(2_000_000)],
    assets.from_asset(
      script_hash,
      custody.grant_token_name(attacker_stake_script_hash, 0),
      -1,
    ),
    [attacker_key],
    interval.everything,
  )
    |> with_proxy_redeemers()
    |> withdrawing([attacker_logic_hash])
    |> test_helpers.minting(IssueGrants)
  !proxy_mint(IssueGrants, tx)
}

/// The attacker mints two tokens under one grant name of its own account,
/// which its logic approves; one could then sit at a foreign address
/// unseen. The proxy admits a quantity of one only.
/// Proves INV-3.
test attack_token_forgery_grant_token_minted_in_quantity_two() {
  let doubled = output(
    attacker_account_address(),
    assets.merge(
      assets.from_lovelace(2_000_000),
      assets.from_asset(
        script_hash,
        custody.grant_token_name(attacker_stake_script_hash, 0),
        2,
      ),
    ),
    grant_datum(Grant { ..lovelace_grant(), grantee: attacker_key }),
  )
  let tx = attacker_transaction(
    [attacker_control_output(attacker_issued_state(), 2_000_000), doubled],
    assets.from_asset(
      script_hash,
      custody.grant_token_name(attacker_stake_script_hash, 0),
      2,
    ),
  )
  !proxy_mint(IssueGrants, tx)
}

/// The attacker issues its own grant token into an output at the victim's
/// address, with its logic approving, so that a UTxO carrying an account
/// token of another account sits among the victim's. Under `IssueGrants`
/// the proxy places every account token at its own account address.
/// Proves INV-8.
test attack_token_forgery_attackers_grant_token_placed_at_the_victims_address() {
  let tx = attacker_transaction(
    [
      attacker_control_output(attacker_issued_state(), 2_000_000),
      misplaced_attacker_grant_output(),
    ],
    grant_token(attacker_stake_script_hash, 0),
  )
  !proxy_mint(IssueGrants, tx)
}

/// The attacker spends the control UTxO and the grant UTxO of its own
/// account under its logic, burns nothing and sends its grant token into
/// an output at the victim's address, where no path spends it. The proxy
/// places every account token at its own account address on every spend
/// of an account token, whatever the logic approves.
/// Proves INV-8.
test attack_token_forgery_attackers_grant_token_swept_to_the_victims_address() {
  let tx = attacker_spend(
    [
      input(0, attacker_control_output(attacker_issued_state(), 2_000_000)),
      input(1, attacker_grant_output()),
    ],
    [
      attacker_control_output(attacker_issued_state(), 2_000_000),
      misplaced_attacker_grant_output(),
    ],
    assets.zero,
  )
  !proxy_spend_grant(attacker_grant(), SweepGrant, 1, tx)
}

/// The same on the agent path: the attacker, grantee of its own account,
/// spends the grant UTxO with its control UTxO referenced.
/// Proves INV-8.
test attack_token_forgery_attackers_grant_token_spent_to_the_victims_address() {
  let tx = test_helpers.transaction(
    [input(0, attacker_grant_output())],
    [misplaced_attacker_grant_output()],
    assets.zero,
    [attacker_key],
    interval.before(expiry - 1),
  )
    |> referencing(
        [
          input(
            100,
            attacker_control_output(attacker_issued_state(), 2_000_000),
          ),
        ],
      )
    |> with_proxy_redeemers()
    |> withdrawing([attacker_logic_hash])
  !proxy_spend_grant(attacker_grant(), SpendWithGrant, 0, tx)
}

/// The attacker spends the control UTxO of its own account under its
/// logic and sends the state NFT to the victim's address, to a key
/// address, into an output carrying a reference script or beside another
/// token. The proxy pins the NFT to one output at the same address
/// holding only lovelace and the NFT, with no reference script, whatever
/// the logic approves.
/// Proves INV-9.
test attack_token_forgery_control_nft_relocated_under_the_attackers_logic() {
  let value = control_value(attacker_stake_script_hash, 2_000_000)
  list.all(
    [account_address(), attacker_address(), address.from_script(script_hash)],
    fn(destination) {
      !proxy_spend(
        Some(attacker_state()),
        Device,
        0,
        attacker_transaction(
          [output(destination, value, state_datum(attacker_state()))],
          assets.zero,
        ),
      )
    },
  )
}

/// The attacker recreates the control UTxO of its own account with a
/// reference script attached, with its logic approving. The proxy admits
/// no reference script on the control output.
/// Proves INV-9.
test attack_token_forgery_reference_script_on_the_control_under_the_attackers_logic() {
  let encumbered = Output {
    ..attacker_control_output(attacker_state(), 2_000_000),
    reference_script: Some(attacker_logic_hash),
  }
  !proxy_spend(
    Some(attacker_state()),
    Device,
    0,
    attacker_transaction([encumbered], assets.zero),
  )
}

/// The attacker parks a token beside the state NFT on the control output
/// of its own account, with its logic approving. The proxy admits nothing
/// but lovelace beside the NFT.
/// Proves INV-9.
test attack_token_forgery_extra_token_on_the_control_under_the_attackers_logic() {
  let parked = output(
    attacker_account_address(),
    assets.merge(control_value(attacker_stake_script_hash, 2_000_000), token(1)),
    state_datum(attacker_state()),
  )
  !proxy_spend(
    Some(attacker_state()),
    Device,
    0,
    attacker_transaction([parked], assets.zero),
  )
}

/// The grantee of slot 0 withdraws the account's rewards with its own
/// signature, referencing the control UTxO. Rewards and delegation answer
/// to the devices only.
/// Proves INV-15.
test attack_other_redeemer_withdraw_rewards_with_a_grantee_signature() {
  let tx = Transaction {
    ..logic_transaction(
      [
        input(
          5,
          output(attacker_address(), assets.from_lovelace(3_000_000), NoDatum),
        ),
      ],
      [payout(3_000_000)],
      assets.zero,
      [stranger_key],
      interval.everything,
    ),
    reference_inputs: [control_reference()],
    withdrawals: [Pair(Script(stake_script_hash), 1_000_000)],
  }
  !withdraw(tx)
}

/// The grantee offers its grant UTxO, whose datum names it, to the stake
/// script in place of the control UTxO. The device rule reads devices from
/// the control UTxO only and aborts without one.
/// Proves INV-15.
test attack_other_redeemer_withdraw_rewards_over_a_grant_utxo() fail {
  let tx = Transaction {
    ..logic_transaction(
      [
        input(
          5,
          output(attacker_address(), assets.from_lovelace(3_000_000), NoDatum),
        ),
      ],
      [payout(3_000_000)],
      assets.zero,
      [stranger_key],
      interval.everything,
    ),
    reference_inputs: [input(0, grant_output(lovelace_grant(), 2_000_000))],
    withdrawals: [Pair(Script(stake_script_hash), 1_000_000)],
  }
  withdraw(tx)
}

/// The control UTxO is spent with `Fund`, the redeemer that carries no
/// authorisation of its own. The proxy refuses `Fund` on a UTxO holding
/// an account token, and the logic requires `Device` on the control UTxO.
/// Proves INV-11 and INV-20.
test attack_other_redeemer_fund_on_the_control_utxo() {
  let tx = logic_transaction(
    [
      input(0, control_output(state(), 2_000_000)),
      input(1, fund_output(assets.from_lovelace(10_000_000))),
    ],
    [
      control_output(state(), 2_000_000),
      output(attacker_address(), assets.from_lovelace(10_000_000), NoDatum),
    ],
    assets.zero,
    [attacker_key],
    interval.everything,
  )
    |> spending(0, Fund)
  and {
    !proxy_spend(Some(state()), Fund, 0, tx),
    !run(tx),
  }
}

/// A grant UTxO is spent with `Fund` beside the control UTxO, dodging the
/// grant's checks.
/// Proves INV-11.
test attack_other_redeemer_fund_on_a_grant_utxo() {
  let tx = logic_transaction(
    [
      input(0, control_output(granted_state(), 2_000_000)),
      input(1, grant_output(lovelace_grant(), 2_000_000)),
    ],
    [
      control_output(granted_state(), 2_000_000),
      output(attacker_address(), assets.from_lovelace(2_000_000), NoDatum),
    ],
    assets.zero,
    [attacker_key],
    interval.everything,
  )
  !proxy_spend_grant(lovelace_grant(), Fund, 1, tx)
}

/// A plain deposit is spent with `Device`, which the owner rule refuses
/// for lack of the state NFT on it.
/// Proves INV-20.
test attack_other_redeemer_device_on_a_plain_deposit() {
  let tx = logic_transaction(
    [
      input(0, control_output(state(), 2_000_000)),
      input(1, fund_output(assets.from_lovelace(10_000_000))),
    ],
    [
      control_output(state(), 2_000_000),
      output(attacker_address(), assets.from_lovelace(10_000_000), NoDatum),
    ],
    assets.zero,
    [attacker_key],
    interval.everything,
  )
    |> spending(1, Device)
  !run(tx)
}

/// The control UTxO is spent with `SpendWithGrant`, which the owner path
/// never admits.
/// Proves INV-20 and INV-21.
test attack_other_redeemer_grant_on_the_control_utxo() {
  let tx = logic_transaction(
    [
      input(0, control_output(granted_state(), 2_000_000)),
      input(1, fund_output(assets.from_lovelace(10_000_000))),
    ],
    [
      control_output(granted_state(), 2_000_000),
      output(attacker_address(), assets.from_lovelace(10_000_000), NoDatum),
    ],
    assets.zero,
    [attacker_key],
    interval.before(expiry - 1),
  )
    |> spending(0, SpendWithGrant)
  !run(tx)
}

/// The grantee sweeps its own live grant with `SweepGrant`, spending the
/// control UTxO alongside and signing with its own key. The sweep needs a
/// device of the control state and a dead grant, and the control UTxO's
/// own rule needs a device signature.
/// Proves INV-20 and INV-28.
test attack_other_redeemer_sweep_with_the_grantee_signature() {
  let tx = Transaction {
    ..owner_transaction(
      granted_state(),
      [input(1, grant_output(lovelace_grant(), 2_000_000))],
      [
        control_output(
          AccountState { ..granted_state(), outstanding: 1 },
          2_000_000,
        ),
        output(attacker_address(), assets.from_lovelace(2_000_000), NoDatum),
      ],
      grant_burn(0),
    ),
    extra_signatories: [stranger_key],
  }
  !run(tx)
}

/// The grantee burns its own grant token on the agent path. The agent
/// path admits no mint under the policy.
/// Proves INV-30.
test attack_other_redeemer_grant_spend_with_its_token_burned() {
  let tx = Transaction {
    ..grant_transaction(
      lovelace_grant(),
      [change(10_000_000), payout(2_000_000)],
    ),
    mint: grant_burn(0),
  }
    |> with_proxy_redeemers()
  !run(tx)
}

/// `BurnGrants` over a referenced control UTxO passes the proxy and is
/// refused by the logic's agent path.
/// Proves INV-30.
test attack_other_redeemer_burn_grants_without_the_control_utxo_spent() {
  let tx = Transaction {
    ..grant_transaction(
      lovelace_grant(),
      [change(10_000_000), payout(2_000_000)],
    ),
    mint: grant_burn(0),
  }
    |> with_proxy_redeemers()
  and {
    proxy_mint(BurnGrants, tx),
    !run(tx),
  }
}

/// `CreateAccount` is used on a burn with everything a creation needs
/// beside it: the control UTxO spent, a device signing, the registration
/// published and the logic running. The creation redeemer accepts nothing
/// but a mint of one.
/// Proves INV-2 and INV-4.
test attack_other_redeemer_create_account_on_a_burn() {
  let burning = logic_transaction(
    [input(0, control_output(state(), 2_000_000))],
    [payout(2_000_000)],
    burn(),
    [device_key],
    interval.everything,
  )
    |> publishing(registration(stake_script_hash))
  !proxy_mint(CreateAccount, burning)
}

/// Anyone may register the logic credential, but nobody may deregister it,
/// which would stall every account on that version until re-registered.
/// Proves INV-19.
test attack_other_redeemer_logic_deregistration() {
  !logic_v1.logic_v1.publish(
    script_hash,
    Run,
    UnregisterCredential { credential: Script(logic_hash), refund: Never },
    owner_transaction(
      state(),
      [],
      [control_output(state(), 2_000_000)],
      assets.zero,
    ),
  )
}

/// The grantee pays exactly the per call cap to the recipient and lets
/// the account pay the fee on top. The fee is part of what leaves the
/// account, so the outflow exceeds the cap.
/// Proves INV-35.
test attack_missed_input_validation_fee_paid_by_the_account_beyond_the_cap() {
  let tx = Transaction {
    ..grant_transaction(
      lovelace_grant(),
      [
        grant_output(with_caps(lovelace_grant(), 1_000_000, 0), 2_000_000),
        change(6_000_000),
        payout(3_000_000),
      ],
    ),
    fee: 1_000_000,
  }
  !run(tx)
}

/// The grantee pays the per call cap from the deposit and also drains
/// lovelace from the grant UTxO itself. The grant output must carry the
/// spent value exactly, and the outflow exceeds the cap besides.
/// Proves INV-35 and INV-38.
test attack_missed_input_validation_grant_lovelace_drained_beyond_the_cap() {
  !spend_lovelace_grant(
    lovelace_grant(),
    [
      grant_output(with_caps(lovelace_grant(), 1_000_000, 0), 1_000_000),
      change(7_000_000),
      payout(4_000_000),
    ],
  )
}

/// A grant scoped to one asset name is used to move another asset name
/// under the same policy.
/// Proves INV-35.
test attack_missed_input_validation_token_grant_leaks_a_sibling_asset_name() {
  let sibling = assets.from_asset(token_asset().policy_id, "other", 5)
  let tx = logic_transaction(
    [
      input(0, grant_output(token_grant(), 2_000_000)),
      input(
        1,
        fund_output(assets.merge(assets.from_lovelace(10_000_000), sibling)),
      ),
    ],
    [
      grant_output(with_caps(token_grant(), 50, 0), 2_000_000),
      change(8_000_000),
      output(
        recipient_address(),
        assets.merge(assets.from_lovelace(2_000_000), sibling),
        NoDatum,
      ),
    ],
    assets.zero,
    [stranger_key],
    interval.before(expiry - 1),
  )
    |> referencing([control_reference()])
  !run(tx)
}

/// A token grant allows 2 ADA of lovelace over its lifetime but only 1 ADA
/// per call. The grantee moves 10 tokens with the whole 2 ADA in one
/// transaction, within the remaining lovelace cap but above the lovelace
/// per call cap.
/// Proves INV-35.
test attack_missed_input_validation_token_grant_burns_its_lovelace_budget_in_one_call() {
  let metered = Grant {
    ..token_grant(),
    scope: Scope { ..token_scope(), lovelace_per_call_cap: 1_000_000 },
  }
  let tx = logic_transaction(
    [input(0, grant_output(metered, 2_000_000)), treasury_input()],
    [
      grant_output(with_caps(metered, 40, 0), 2_000_000),
      fund_output(assets.merge(assets.from_lovelace(8_000_000), token(10))),
      output(
        recipient_address(),
        assets.merge(assets.from_lovelace(2_000_000), token(10)),
        NoDatum,
      ),
    ],
    assets.zero,
    [stranger_key],
    interval.before(expiry - 1),
  )
    |> referencing([control_reference()])
  !run(tx)
}

/// The grantee pays part of a spend within the per call cap to the bare
/// script address, without the stake part. That address is not the
/// account, so the lovelace counts as leaving and the destination must be
/// a listed recipient.
/// Proves INV-36.
test attack_missed_input_validation_change_to_the_bare_script_address() {
  !spend_lovelace_grant(
    restricted_grant(),
    [
      grant_output(with_caps(restricted_grant(), 3_000_000, 0), 2_000_000),
      change(8_000_000),
      output(
        address.from_script(script_hash),
        assets.from_lovelace(1_000_000),
        NoDatum,
      ),
      payout(1_000_000),
    ],
  )
}

/// The owner issues a grant with a negative cap, with no expiry, a
/// lovelace grant with a separate lovelace cap or lovelace per call cap,
/// and a grant with nine recipients. Every one of them fails well
/// formedness at issuance.
/// Proves INV-26 and INV-45.
test attack_missed_input_validation_ill_formed_grants_at_issuance() {
  let scopes = [
    Scope { ..lovelace_scope(), cap: -1 },
    Scope { ..lovelace_scope(), expires_at: 0 },
    Scope { ..lovelace_scope(), lovelace_cap: 1 },
    Scope { ..lovelace_scope(), lovelace_per_call_cap: 1 },
    Scope { ..lovelace_scope(), recipients: recipients(9) },
  ]
  list.all(
    scopes,
    fn(scope) {
      let tx = owner_transaction(
        state(),
        [],
        [
          control_output(
            AccountState { ..state(), next_slot: 1, outstanding: 1 },
            2_000_000,
          ),
          grant_output(Grant { ..lovelace_grant(), scope }, 2_000_000),
        ],
        grant_token(stake_script_hash, 0),
      )
      !run(tx)
    },
  )
}

/// The owner path is asked to store a state with negative counters, a
/// negative generation, or a generation lower than before. Every one of
/// them is refused.
/// Proves INV-24 and INV-44.
test attack_missed_input_validation_ill_formed_counters_on_a_device_rewrite() {
  let current = AccountState { ..granted_state(), grant_generation: 1 }
  let rewrites = [
    AccountState { ..current, grant_generation: -1 },
    AccountState { ..current, grant_generation: 0 },
    AccountState { ..current, next_slot: 1 },
    AccountState { ..current, outstanding: 1 },
    AccountState { ..current, next_slot: 3 },
    AccountState { ..current, outstanding: 3 },
  ]
  list.all(
    rewrites,
    fn(next) {
      let tx = owner_transaction(
        current,
        [],
        [control_output(next, 2_000_000)],
        assets.zero,
      )
      !run(tx)
    },
  )
}

/// The validity range has no upper bound at all, so the transaction could
/// be applied after the grant expired.
/// Proves INV-34.
test attack_time_handling_no_upper_bound() {
  let tx = Transaction {
    ..grant_transaction(
      lovelace_grant(),
      lovelace_grant_outputs(lovelace_grant(), 2_000_000),
    ),
    validity_range: interval.everything,
  }
  !run(tx)
}

/// The lower bound lies past the expiry and the upper bound is open: an
/// upper bound is required whatever the lower bound says.
/// Proves INV-34.
test attack_time_handling_lower_bound_past_expiry_with_no_upper_bound() {
  let tx = Transaction {
    ..grant_transaction(
      lovelace_grant(),
      lovelace_grant_outputs(lovelace_grant(), 2_000_000),
    ),
    validity_range: interval.after(expiry + 1),
  }
  !run(tx)
}

/// An exclusive upper bound one past the expiry covers the same instants
/// as an inclusive bound at the expiry, but the bound's value itself is
/// compared, so it is refused.
/// Proves INV-34.
test attack_time_handling_exclusive_upper_bound_one_past_expiry() {
  let tx = Transaction {
    ..grant_transaction(
      lovelace_grant(),
      lovelace_grant_outputs(lovelace_grant(), 2_000_000),
    ),
    validity_range: interval.entirely_before(expiry + 1),
  }
  !run(tx)
}

/// A degenerate range whose upper bound is negative infinity is not a
/// finite bound and is refused like an open one.
/// Proves INV-34.
test attack_time_handling_negative_infinity_upper_bound() {
  let degenerate = Interval {
    lower_bound: IntervalBound {
      bound_type: NegativeInfinity,
      is_inclusive: True,
    },
    upper_bound: IntervalBound {
      bound_type: NegativeInfinity,
      is_inclusive: True,
    },
  }
  let tx = Transaction {
    ..grant_transaction(
      lovelace_grant(),
      lovelace_grant_outputs(lovelace_grant(), 2_000_000),
    ),
    validity_range: degenerate,
  }
  !run(tx)
}

/// The owner sweeps a grant that has not expired, under a range whose
/// lower bound sits exactly at the expiry or is open. The sweep requires
/// a finite lower bound strictly past the expiry when the grant is
/// neither revoked nor superseded.
/// Proves INV-28 and INV-29.
test attack_time_handling_sweep_of_a_live_grant() {
  let ranges = [
    interval.everything,
    interval.after(expiry),
    interval.before(expiry + 1),
  ]
  list.all(
    ranges,
    fn(validity_range) {
      let tx = Transaction {
        ..owner_transaction(
          granted_state(),
          [input(1, grant_output(lovelace_grant(), 2_000_000))],
          [
            control_output(
              AccountState { ..granted_state(), outstanding: 1 },
              2_000_000,
            ),
            change(2_000_000),
          ],
          grant_burn(0),
        ),
        validity_range,
      }
      !run(tx)
    },
  )
}

/// Sixteen grants are outstanding and the owner issues a seventeenth.
/// Proves INV-44.
test attack_unbounded_datum_seventeenth_outstanding_grant() {
  let full = AccountState { ..state(), next_slot: 16, outstanding: 16 }
  let tx = owner_transaction(
    full,
    [],
    [
      control_output(
        AccountState { ..full, next_slot: 17, outstanding: 17 },
        2_000_000,
      ),
      grant_output(Grant { ..lovelace_grant(), slot: 16 }, 2_000_000),
    ],
    grant_token(stake_script_hash, 16),
  )
  !run(tx)
}

/// The owner rewrites the state with nine devices, one past the bound.
/// Proves INV-44.
test attack_unbounded_datum_nine_devices_on_a_device_rewrite() {
  !rewrite_as(AccountState { ..state(), devices: keys(9) })
}

/// The owner rewrites the state with thirty three revoked slots, one
/// past the bound.
/// Proves INV-44.
test attack_unbounded_datum_thirty_three_revoked_slots_on_a_device_rewrite() {
  !rewrite_as(AccountState { ..state(), revoked: list.range(1, 33) })
}

/// The proxy reads nothing of the state at creation; the logic validates
/// it as fresh and refuses counters already moved.
/// Proves INV-42.
test attack_unbounded_datum_outstanding_grants_at_creation() {
  let tx = creation(
    [
      control_output(
        AccountState { ..state(), next_slot: 17, outstanding: 17 },
        2_000_000,
      ),
    ],
    state_nft(stake_script_hash),
    [device_key],
  )
  and {
    proxy_mint(CreateAccount, tx),
    !run(tx),
  }
}

/// A bundle of tokens under many policies is parked on the control output
/// at creation. The proxy pins the control output to lovelace and the NFT
/// permanently, and the logic refuses it as well.
/// Proves INV-6 and INV-41.
test attack_unbounded_value_token_bundle_on_the_control_at_creation() {
  let bundle = list.foldl(
    keys(20),
    control_value(stake_script_hash, 2_000_000),
    fn(policy, value) { assets.add(value, policy, "dust", 1) },
  )
  let tx = creation(
    [output(account_address(), bundle, state_datum(state()))],
    state_nft(stake_script_hash),
    [device_key],
  )
  and {
    !proxy_mint(CreateAccount, tx),
    !run(tx),
  }
}

/// The same bundle parked on a grant output at issuance.
/// Proves INV-26.
test attack_unbounded_value_token_bundle_on_a_grant_at_issuance() {
  let bundle = list.foldl(
    keys(20),
    grant_value(stake_script_hash, 0, 2_000_000),
    fn(policy, value) { assets.add(value, policy, "dust", 1) },
  )
  let tx = owner_transaction(
    state(),
    [],
    [
      control_output(
        AccountState { ..state(), next_slot: 1, outstanding: 1 },
        2_000_000,
      ),
      output(account_address(), bundle, grant_datum(lovelace_grant())),
    ],
    grant_token(stake_script_hash, 0),
  )
  !run(tx)
}

/// Twenty deposits are spent at once with `Fund`, none of them alongside
/// an account token.
/// Proves INV-11.
test attack_unbounded_inputs_deposits_spent_without_an_account_token() {
  let deposits = list.range(1, 20)
    |> list.map(
        fn(n) { input(n, fund_output(assets.from_lovelace(1_000_000))) },
      )
  let tx = logic_transaction(
    deposits,
    [output(attacker_address(), assets.from_lovelace(20_000_000), NoDatum)],
    assets.zero,
    [attacker_key],
    interval.everything,
  )
  !proxy_spend(None, Fund, 7, tx)
}

/// The grantee pays the whole balance back to the account address under a
/// datum hash. Nothing counts as leaving, but a script output under a
/// datum hash can only be spent by whoever knows the preimage. Deposits a
/// grant spend makes must carry no datum.
/// Proves INV-37.
test attack_locked_value_grant_spend_deposits_under_a_datum_hash() {
  !spend_lovelace_grant(
    lovelace_grant(),
    [
      grant_output(lovelace_grant(), 2_000_000),
      output(
        account_address(),
        assets.from_lovelace(10_000_000),
        DatumHash(attacker_key),
      ),
    ],
  )
}

/// The same, under an inline datum, which would turn the balance into an
/// owner only reserve the agent cannot spend again.
/// Proves INV-37.
test attack_locked_value_grant_spend_deposits_under_an_inline_datum() {
  let marker: Data = 1
  !spend_lovelace_grant(
    lovelace_grant(),
    [
      grant_output(lovelace_grant(), 2_000_000),
      output(
        account_address(),
        assets.from_lovelace(10_000_000),
        InlineDatum(marker),
      ),
    ],
  )
}

/// The grantee sends the whole balance to the bare script address, where
/// no handler can ever spend it. The outflow exceeds the per call cap,
/// which is what refuses it; with a recipient list the destination is
/// refused as well, and the loss through an open grant stays bounded by
/// the caps.
/// Proves INV-35 and INV-36.
test attack_locked_value_grant_spend_sends_the_balance_to_the_bare_script_address() {
  !spend_lovelace_grant(
    restricted_grant(),
    [
      grant_output(restricted_grant(), 2_000_000),
      output(
        address.from_script(script_hash),
        assets.from_lovelace(10_000_000),
        NoDatum,
      ),
    ],
  )
}

/// The grantee moves its grant token onto a plain deposit without a datum,
/// so that no grant UTxO with a decodable grant remains. The grant output
/// is found by its token and must carry the accounted grant inline.
/// Proves INV-39.
test attack_locked_value_grant_spend_strands_its_token_on_a_plain_deposit() {
  !spend_lovelace_grant(
    lovelace_grant(),
    [
      fund_output(grant_value(stake_script_hash, 0, 2_000_000)),
      change(8_000_000),
      payout(2_000_000),
    ],
  )
}

/// The owner rewrites the state with no device at all, which would leave
/// nobody able to spend the control UTxO again.
/// Proves INV-44.
test attack_locked_value_device_rewrite_removes_every_device() {
  !rewrite_as(AccountState { ..state(), devices: [] })
}

/// The account is created with no device at all; the arrival path
/// refuses the state as ill formed.
/// Proves INV-41 and INV-44.
test attack_locked_value_account_created_without_devices() {
  let tx = creation(
    [control_output(AccountState { ..state(), devices: [] }, 2_000_000)],
    state_nft(stake_script_hash),
    [device_key],
  )
  !run(tx)
}

/// A builder registers the credential in a transaction the owner signs
/// without minting the state NFT. The ledger registers a credential once,
/// so the account could never be created afterwards and every deposit to
/// its address would be locked; the stake script refuses a registration
/// that mints no state NFT, before it looks for a control output.
/// Proves INV-14.
test attack_locked_value_registration_without_the_state_nft_mint() {
  let tx = Transaction {
    ..creation([], state_nft(stake_script_hash), [device_key]),
    mint: assets.zero,
  }
  !register(tx)
}

/// The owner burns a grant token while leaving the outstanding count as
/// it was, which would let a future close strand the remaining grant
/// UTxOs; the owner rule ties the count to the mint field.
/// Proves INV-24.
test attack_locked_value_sweep_without_the_outstanding_decrement() {
  let revoked = AccountState { ..granted_state(), revoked: [0] }
  let tx = owner_transaction(
    revoked,
    [input(1, grant_output(lovelace_grant(), 2_000_000))],
    [control_output(revoked, 2_000_000), change(2_000_000)],
    grant_burn(0),
  )
  !run(tx)
}

/// An account is pointed at a logic that never ran: the owner rewrites
/// the control datum's logic field without the new logic's withdrawal.
/// The old logic refuses the handover; the proxy would require the new
/// logic on every later spend regardless.
/// Proves INV-25.
test attack_locked_value_upgrade_to_a_logic_that_does_not_run() {
  let tx = upgrade_into(upgraded_state())
    |> without_withdrawals()
    |> withdrawing([logic_hash])
  !run(tx)
}

/// `Fund` passes on its own as soon as the control UTxO is among the
/// inputs; it is the logic, run for the control UTxO, that refuses the
/// transaction for lack of a device signature. The ledger runs every
/// handler and accepts the transaction only if all pass, so the order in
/// which they run does not matter.
/// Proves INV-20.
test attack_evaluation_order_fund_passes_only_together_with_the_control_spend() {
  let tx = logic_transaction(
    [
      input(0, control_output(state(), 2_000_000)),
      input(1, fund_output(assets.from_lovelace(10_000_000))),
    ],
    [
      control_output(state(), 2_000_000),
      output(attacker_address(), assets.from_lovelace(10_000_000), NoDatum),
    ],
    assets.zero,
    [attacker_key],
    interval.everything,
  )
  and {
    proxy_spend(None, Fund, 1, tx),
    proxy_spend(Some(state()), Device, 0, tx),
    !run(tx),
  }
}

/// The same on the agent path: a plain deposit passes beside the grant
/// UTxO, the proxy passes the grant UTxO whose control is present, and it
/// is the logic that refuses the spend for lack of the grantee's
/// signature.
/// Proves INV-33.
test attack_evaluation_order_fund_passes_only_together_with_the_grant_spend() {
  let tx = Transaction {
    ..grant_transaction(
      lovelace_grant(),
      lovelace_grant_outputs(lovelace_grant(), 2_000_000),
    ),
    extra_signatories: [attacker_key],
  }
  and {
    proxy_spend(None, Fund, 1, tx),
    proxy_spend_grant(lovelace_grant(), SpendWithGrant, 0, tx),
    !run(tx),
  }
}

/// A reserve, a deposit carrying a datum, is spent beside the grant UTxO
/// on an otherwise valid agent spend. The logic passes, since `Fund` is
/// the proxy's, and the reserve's own proxy handler refuses, since a
/// reserve only rides on the control UTxO. This is what keeps the owner's
/// fee reserve out of an agent's reach.
/// Proves INV-11.
test attack_evaluation_order_reserve_spent_beside_a_grant_utxo() {
  let marker: Data = 1
  let reserve = input(
    2,
    output(
      account_address(),
      assets.from_lovelace(5_000_000),
      InlineDatum(marker),
    ),
  )
  let tx = Transaction {
    ..grant_transaction(
      lovelace_grant(),
      [
        grant_output(with_caps(lovelace_grant(), 3_000_000, 0), 2_000_000),
        change(13_000_000),
        payout(2_000_000),
      ],
    ),
    inputs: list.concat(
      grant_transaction(lovelace_grant(), []).inputs,
      [reserve],
    ),
  }
    |> with_proxy_redeemers()
  and {
    run(tx),
    !account.account.spend(Some(marker), Fund, output_reference(2), tx),
  }
}

/// An Ed25519 key granted by one account signs a spend from another
/// account's grant UTxO under the same slot number. The grant is read
/// from the spent grant UTxO, where the grantee is a different key.
/// Proves INV-33.
test attack_signature_replay_ed25519_grantee_of_another_account() {
  let other = AccountState { ..granted_state(), devices: [other_device_key] }
  let other_grant = Grant { ..lovelace_grant(), grantee: attacker_key }
  let tx = logic_transaction(
    [
      input(0, other_grant_output(other_grant, 2_000_000)),
      input(1, other_fund_output(assets.from_lovelace(10_000_000))),
    ],
    [
      other_grant_output(with_caps(other_grant, 3_000_000, 0), 2_000_000),
      other_fund_output(assets.from_lovelace(8_000_000)),
      payout(2_000_000),
    ],
    assets.zero,
    [stranger_key],
    interval.before(expiry - 1),
  )
    |> referencing([input(100, other_control_output(other, 2_000_000))])
  !run(tx)
}

/// The grantee builds its spend against the control UTxO as it was before
/// the owner revoked the slot. On the ledger that reference fails in phase
/// one once the owner's transaction lands; here the current control UTxO
/// is referenced and the revoked slot refuses the spend.
/// Proves INV-32.
test attack_utxo_contention_grant_spend_after_a_revoke() {
  let revoked = AccountState { ..granted_state(), revoked: [0] }
  let tx = Transaction {
    ..grant_transaction(
      lovelace_grant(),
      lovelace_grant_outputs(lovelace_grant(), 2_000_000),
    ),
    reference_inputs: [control_reference_of(revoked)],
  }
  !run(tx)
}

/// The same after a revoke all, which raises the generation instead.
/// Proves INV-32.
test attack_utxo_contention_grant_spend_after_a_generation_bump() {
  let bumped = AccountState {
    ..granted_state(),
    grant_generation: 1,
    revoked: [],
  }
  let tx = Transaction {
    ..grant_transaction(
      lovelace_grant(),
      lovelace_grant_outputs(lovelace_grant(), 2_000_000),
    ),
    reference_inputs: [control_reference_of(bumped)],
  }
  !run(tx)
}

/// The same after an upgrade, which raises the generation under the new
/// logic: the grant issued before is dead whichever logic the agent
/// attaches.
/// Proves INV-10 and INV-32.
test attack_utxo_contention_grant_spend_after_an_upgrade() {
  let tx = Transaction {
    ..grant_transaction(
      lovelace_grant(),
      lovelace_grant_outputs(lovelace_grant(), 2_000_000),
    ),
    reference_inputs: [control_reference_of(upgraded_state())],
  }
    |> withdrawing([next_logic_hash])
  and {
    !proxy_spend_grant(
      lovelace_grant(),
      SpendWithGrant,
      0,
      tx |> without_withdrawals() |> withdrawing([logic_hash]),
    ),
    !run_as(next_logic_hash, tx),
  }
}

/// The grantee spends the control UTxO in its own transaction, to churn
/// it and race the owner's revoke, offering it back unchanged. With the
/// control UTxO spent the logic is on the owner path, which admits no
/// `SpendWithGrant` and needs a device signature.
/// Proves INV-20 and INV-21.
test attack_utxo_contention_grant_spend_spends_the_control_utxo() {
  let tx = Transaction {
    ..grant_transaction(
      lovelace_grant(),
      [
        control_output(granted_state(), 2_000_000),
        ..lovelace_grant_outputs(lovelace_grant(), 2_000_000)
      ],
    ),
    inputs: [
      input(0, grant_output(lovelace_grant(), 2_000_000)),
      input(1, fund_output(assets.from_lovelace(10_000_000))),
      input(2, control_output(granted_state(), 2_000_000)),
    ],
    reference_inputs: [],
  }
    |> with_proxy_redeemers()
  !run(tx)
}

/// The control UTxO is spent and referenced at once. The proxy finds two
/// and refuses, and the logic refuses the same.
/// Proves INV-10 and INV-18.
test attack_utxo_contention_grant_spend_spends_and_references_the_control_utxo() {
  let tx = Transaction {
    ..grant_transaction(
      lovelace_grant(),
      [
        control_output(granted_state(), 2_000_000),
        ..lovelace_grant_outputs(lovelace_grant(), 2_000_000)
      ],
    ),
    inputs: [
      input(0, grant_output(lovelace_grant(), 2_000_000)),
      input(1, fund_output(assets.from_lovelace(10_000_000))),
      input(2, control_output(granted_state(), 2_000_000)),
    ],
  }
    |> with_proxy_redeemers()
  and {
    !proxy_spend_grant(lovelace_grant(), SpendWithGrant, 0, tx),
    !proxy_spend(Some(granted_state()), Device, 2, tx),
    !run(tx),
  }
}

/// The grantee spends another grant UTxO of the account beside its own, to
/// keep that grantee's UTxO moving or to fold its caps into one spend.
/// Proves INV-31.
test attack_utxo_contention_grant_spend_spends_a_second_grant_utxo() {
  let tx = Transaction {
    ..grant_transaction(
      lovelace_grant(),
      [
        grant_output(token_grant(), 2_000_000),
        ..lovelace_grant_outputs(lovelace_grant(), 2_000_000)
      ],
    ),
    inputs: [
      input(0, grant_output(lovelace_grant(), 2_000_000)),
      input(1, fund_output(assets.from_lovelace(10_000_000))),
      input(2, grant_output(token_grant(), 2_000_000)),
    ],
  }
    |> with_proxy_redeemers()
  !run(tx)
}

/// The grantee attaches a withdrawal from a logic of its own instead of
/// the logic the control UTxO names. The proxy reads the logic from the
/// control datum and refuses; nothing the attacker's script decides is
/// ever asked.
/// Proves INV-10.
test attack_logic_substitution_grant_spend_under_the_attackers_logic() {
  let tx = grant_transaction(
    lovelace_grant(),
    lovelace_grant_outputs(lovelace_grant(), 2_000_000),
  )
    |> without_withdrawals()
    |> withdrawing([attacker_logic_hash])
  !proxy_spend_grant(lovelace_grant(), SpendWithGrant, 0, tx)
}

/// The same on the owner path, with the attacker's logic approving a
/// control spend signed by the attacker.
/// Proves INV-10.
test attack_logic_substitution_device_spend_under_the_attackers_logic() {
  let tx = logic_transaction(
    [
      input(0, control_output(state(), 2_000_000)),
      input(1, fund_output(assets.from_lovelace(10_000_000))),
    ],
    [
      control_output(
        AccountState { ..state(), devices: [attacker_key] },
        2_000_000,
      ),
      output(attacker_address(), assets.from_lovelace(10_000_000), NoDatum),
    ],
    assets.zero,
    [attacker_key],
    interval.everything,
  )
    |> without_withdrawals()
    |> withdrawing([attacker_logic_hash])
  !proxy_spend(Some(state()), Device, 0, tx)
}

/// An account is created under the attacker's logic with a withdrawal
/// from the logic the owner expects, or the other way round: the proxy
/// ties the withdrawal to the logic the control datum names.
/// Proves INV-7.
test attack_logic_substitution_creation_under_a_logic_that_does_not_run() {
  let tx = creation(
    [
      control_output(
        AccountState { ..state(), logic: attacker_logic_hash },
        2_000_000,
      ),
    ],
    state_nft(stake_script_hash),
    [device_key],
  )
  and {
    !proxy_mint(CreateAccount, tx),
    !proxy_mint(
      CreateAccount,
      creation(
        [control_output(state(), 2_000_000)],
        state_nft(stake_script_hash),
        [device_key],
      )
        |> without_withdrawals()
        |> withdrawing([attacker_logic_hash]),
    ),
  }
}

/// The grantee cannot move the account to another logic: on the owner
/// path it lacks a device signature, and on the grant path the control
/// UTxO is never spent.
/// Proves INV-20.
test attack_logic_substitution_grantee_rewrites_the_logic_pointer() {
  let hijacked = AccountState { ..upgraded_state(), logic: attacker_logic_hash }
  let tx = Transaction {
    ..upgrade_into(hijacked),
    extra_signatories: [stranger_key],
  }
    |> withdrawing([attacker_logic_hash])
  and {
    !run(tx),
    !run(tx |> spending(0, SpendWithGrant)),
  }
}

/// A stranger offers the upgrade with both logics running and no device
/// signature.
/// Proves INV-20.
test attack_logic_substitution_stranger_rewrites_the_logic_pointer() {
  let tx = Transaction {
    ..upgrade_into(upgraded_state()),
    extra_signatories: [attacker_key],
  }
  !run(tx)
}

/// The owner moves the account without the old logic running: the proxy
/// requires the logic the spent control UTxO names, and the arriving
/// logic requires the leaving one as well.
/// Proves INV-10 and INV-43.
test attack_logic_substitution_upgrade_without_the_old_logic() {
  let tx = upgrade_into(upgraded_state())
    |> without_withdrawals()
    |> withdrawing([next_logic_hash])
  and {
    !proxy_spend(Some(granted_state()), Device, 0, tx),
    !run_as(next_logic_hash, tx),
  }
}

/// The owner moves the account to a new logic while keeping the
/// generation, so grants issued under the old logic would stay current
/// under rules that never issued them.
/// Proves INV-43.
test attack_logic_substitution_upgrade_keeps_the_generation() {
  !run_as(
    next_logic_hash,
    upgrade_into(AccountState { ..upgraded_state(), grant_generation: 0 }),
  )
}

/// The upgrade swaps the devices on the way, which would let a device
/// rewrite ride on the new logic's arrival rules alone.
/// Proves INV-43.
test attack_logic_substitution_upgrade_swaps_the_devices() {
  !run_as(
    next_logic_hash,
    upgrade_into(AccountState { ..upgraded_state(), devices: [attacker_key] }),
  )
}

/// The owner moves the account to the next logic with the devices
/// swapped, the generation kept and the counters past their bound, and
/// references another account's control UTxO under that logic, which
/// needs no authorisation, so the arriving logic runs its agent path over
/// the other account instead of validating the arrival. The leaving
/// logic accepts, as it only asks the next one to run; the arriving
/// logic's agent path admits no control output naming it.
/// Proves INV-30.
test attack_logic_substitution_arrival_hidden_behind_a_referenced_control() {
  let unvalidated = AccountState {
    ..upgraded_state(),
    devices: [attacker_key],
    grant_generation: 0,
    outstanding: 17,
  }
  let tx = upgrade_into(unvalidated)
    |> referencing([input(100, other_control_output(other_state(), 2_000_000))])
  and {
    run(tx),
    !run_as(next_logic_hash, tx),
  }
}

/// The same with the owner's second account, already under the next
/// logic, spent and recreated unchanged beside the arrival, so the
/// arriving logic runs its owner path over the second account. The owner
/// path pins every control output naming the logic to the spent account's
/// address.
/// Proves INV-22.
test attack_logic_substitution_arrival_hidden_behind_a_spent_control() {
  let unvalidated = AccountState {
    ..upgraded_state(),
    devices: [attacker_key],
    grant_generation: 0,
    outstanding: 17,
  }
  let second = AccountState { ..other_state(), devices: [device_key] }
  let tx = test_helpers.transaction(
    [
      input(0, control_output(granted_state(), 2_000_000)),
      input(1, other_control_output(second, 2_000_000)),
    ],
    [
      control_output(unvalidated, 2_000_000),
      other_control_output(second, 2_000_000),
    ],
    assets.zero,
    [device_key],
    interval.everything,
  )
    |> with_proxy_redeemers()
    |> withdrawing([logic_hash, next_logic_hash])
  and {
    run(tx),
    !run_as(next_logic_hash, tx),
  }
}

/// Two accounts under one logic are operated in one transaction, so that
/// one validation could cover both. The logic refuses two control UTxOs
/// naming it.
/// Proves INV-18.
test attack_logic_substitution_two_accounts_under_one_logic() {
  let tx = logic_transaction(
    [
      input(0, control_output(state(), 2_000_000)),
      input(
        1,
        other_control_output(
          AccountState { ..state(), devices: [attacker_key] },
          2_000_000,
        ),
      ),
      input(2, other_fund_output(assets.from_lovelace(10_000_000))),
    ],
    [
      control_output(state(), 2_000_000),
      other_control_output(
        AccountState { ..state(), devices: [attacker_key] },
        2_000_000,
      ),
      output(attacker_address(), assets.from_lovelace(10_000_000), NoDatum),
    ],
    assets.zero,
    [device_key],
    interval.everything,
  )
  !run(tx)
}

/// One unit of dust under each of three foreign policies.
fn dust() -> Assets {
  list.foldl(
    keys(3),
    assets.zero,
    fn(policy, value) { assets.add(value, policy, "dust", 1) },
  )
}

/// A deposit of 10 ADA carrying the dust, spent at index 1.
fn dusted_deposit() -> Input {
  input(1, fund_output(assets.merge(assets.from_lovelace(10_000_000), dust())))
}

/// An attacker dusts the account with tokens under three policies. A
/// grant spend over the dusted deposit returns all but one unit of dust.
/// Nothing but the scoped asset and lovelace may leave.
/// Proves INV-35.
test attack_dust_attack_grant_spend_keeps_one_unit_of_dust() {
  let returned = assets.merge(dust(), assets.from_asset(key(1), "dust", -1))
  let tx = logic_transaction(
    [input(0, grant_output(lovelace_grant(), 2_000_000)), dusted_deposit()],
    [
      grant_output(with_caps(lovelace_grant(), 3_000_000, 0), 2_000_000),
      fund_output(assets.merge(assets.from_lovelace(8_000_000), returned)),
      output(
        recipient_address(),
        assets.merge(
          assets.from_lovelace(2_000_000),
          assets.from_asset(key(1), "dust", 1),
        ),
        NoDatum,
      ),
    ],
    assets.zero,
    [stranger_key],
    interval.before(expiry - 1),
  )
    |> referencing([control_reference()])
  !run(tx)
}

/// The grant spend pushes the dust onto the grant output instead. The
/// grant output must carry the spent value exactly.
/// Proves INV-38.
test attack_dust_attack_dust_pushed_onto_the_grant_output() {
  let tx = logic_transaction(
    [input(0, grant_output(lovelace_grant(), 2_000_000)), dusted_deposit()],
    [
      output(
        account_address(),
        assets.merge(grant_value(stake_script_hash, 0, 2_000_000), dust()),
        grant_datum(with_caps(lovelace_grant(), 3_000_000, 0)),
      ),
      change(8_000_000),
      payout(2_000_000),
    ],
    assets.zero,
    [stranger_key],
    interval.before(expiry - 1),
  )
    |> referencing([control_reference()])
  !run(tx)
}

/// The grantee recreates its grant UTxO with a reference script attached.
/// Every later spend of it, the owner's sweep included, would pay for that
/// script's size, so the grant output may carry no reference script.
/// Proves INV-38.
test attack_resource_exhaustion_reference_script_on_the_grant_output() {
  let weighted = Output {
    ..grant_output(with_caps(lovelace_grant(), 3_000_000, 0), 2_000_000),
    reference_script: Some(script_hash),
  }
  !spend_lovelace_grant(
    lovelace_grant(),
    [weighted, change(8_000_000), payout(2_000_000)],
  )
}

/// The same on a deposit the grant spend pays back to the account.
/// Proves INV-37.
test attack_resource_exhaustion_reference_script_on_a_returned_deposit() {
  let weighted = Output {
    ..change(8_000_000),
    reference_script: Some(script_hash),
  }
  !spend_lovelace_grant(
    lovelace_grant(),
    [
      grant_output(with_caps(lovelace_grant(), 3_000_000, 0), 2_000_000),
      weighted,
      payout(2_000_000),
    ],
  )
}

/// The largest control state the logic admits: eight devices,
/// `max_revoked` revoked slots from 1 up, sixteen outstanding grants and
/// a generation past zero. The next slot follows the largest grants.
fn largest_state() -> AccountState {
  AccountState {
    logic: logic_hash,
    devices: keys(8),
    grant_generation: 1,
    next_slot: largest_next_slot,
    revoked: list.range(1, account_state.max_revoked),
    outstanding: 16,
  }
}

/// A scope with the most recipients a grant may list, the test recipient
/// among them.
fn largest_scope(scope: Scope) -> Scope {
  Scope {
    ..scope,
    recipients: list.concat(
      recipients(7),
      [plain_recipient(recipient_address())],
    ),
  }
}

/// The largest lovelace grant: the largest grant slot, eight recipients,
/// issued under the current generation.
fn largest_lovelace_grant() -> Grant {
  Grant {
    slot: largest_grant_slot,
    grantee: stranger_key,
    generation: 1,
    scope: largest_scope(lovelace_scope()),
  }
}

/// The largest token grant: the slot below the largest grant slot, eight
/// recipients, issued under the current generation.
fn largest_token_grant() -> Grant {
  Grant {
    slot: largest_grant_slot - 1,
    grantee: stranger_key,
    generation: 1,
    scope: largest_scope(token_scope()),
  }
}

/// `count` deposits of 10 ADA at the account address, spent at indices 1
/// to `count`.
fn deposits(count: Int) -> List<Input> {
  list.range(1, count)
    |> list.map(
        fn(n) { input(n, fund_output(assets.from_lovelace(10_000_000))) },
      )
}

/// A lovelace grant spend at the largest state over eight deposits,
/// paying 2 ADA to the recipient and referencing the largest control UTxO.
fn largest_state_grant_transaction() -> Transaction {
  logic_transaction(
    list.concat(
      [input(0, grant_output(largest_lovelace_grant(), 2_000_000))],
      deposits(8),
    ),
    [
      grant_output(with_caps(largest_lovelace_grant(), 3_000_000, 0), 2_000_000),
      change(78_000_000),
      payout(2_000_000),
    ],
    assets.zero,
    [stranger_key],
    interval.before(expiry - 1),
  )
    |> referencing([control_reference_of(largest_state())])
}

/// The baseline tests build the fixtures without running any handler, so
/// that the cost of building them can be subtracted from the budget
/// tests that follow.
test budget_baseline_largest_state_grant_transaction() {
  list.length(largest_state_grant_transaction().inputs) == 9
}

test budget_baseline_largest_state_token_grant_transaction() {
  list.length(largest_state_token_grant_transaction().inputs) == 2
}

test budget_baseline_forty_deposit_transaction() {
  list.length(forty_deposit_transaction().inputs) == 41
}

test budget_baseline_largest_state_device_revoke_transaction() {
  let tx = largest_state_device_revoke_transaction()
  list.length(tx.inputs) == 1 && list.length(tx.outputs) == 1
}

test budget_baseline_largest_state_issue_transaction() {
  list.length(largest_state_issue_transaction().outputs) == 2
}

test budget_baseline_largest_state_sweep_transaction() {
  list.length(largest_state_sweep_transaction().inputs) == 2
}

test budget_baseline_largest_state_creation_transaction() {
  list.length(largest_state_creation_transaction().outputs) == 1
}

test budget_baseline_largest_state_rewrite_transaction() {
  let tx = largest_state_rewrite_transaction()
  list.length(tx.inputs) == 1 && list.length(tx.outputs) == 1
}

test budget_baseline_largest_state_upgrade_transaction() {
  let tx = largest_state_upgrade_transaction()
  list.length(tx.inputs) == 1 && list.length(tx.withdrawals) == 2
}

test budget_baseline_largest_state_reserve_transaction() {
  list.length(largest_state_reserve_transaction().inputs) == 2
}

test budget_baseline_largest_state_withdrawal_transaction() {
  list.length(largest_state_withdrawal_transaction().reference_inputs) == 1
}

test budget_baseline_largest_state_delegation_transaction() {
  list.length(largest_state_delegation_transaction().certificates) == 1
}

test budget_baseline_largest_state_eight_grant_issue_transaction() {
  list.length(largest_state_grant_issue_transaction(8).outputs) == 9
}

test budget_baseline_largest_state_sixteen_grant_issue_transaction() {
  list.length(largest_state_grant_issue_transaction(16).outputs) == 17
}

test budget_baseline_largest_state_eight_grant_sweep_transaction() {
  list.length(largest_state_grant_sweep_transaction(8).inputs) == 9
}

test budget_baseline_largest_state_sixteen_grant_sweep_transaction() {
  list.length(largest_state_grant_sweep_transaction(16).inputs) == 17
}

/// The largest control datum and the largest grant datum travel together
/// in every issuance and sweep, and a transaction must stay under the
/// 16 KiB size limit. The bound asserted is 2 KiB, far tighter, so that
/// growth of either datum trips it long before the limit does.
test budget_largest_state_datums_stay_within_the_transaction_size_limit() {
  let control: Data = largest_state()
  let grant: Data = largest_lovelace_grant()
  bytearray.length(cbor.serialise(control)) + bytearray.length(
    cbor.serialise(grant),
  ) < 2_048
}

test budget_proxy_largest_state_grant_spend_lovelace_scope() {
  proxy_spend(None, SpendWithGrant, 0, largest_state_grant_transaction())
}

test budget_logic_largest_state_grant_spend_lovelace_scope() {
  run(largest_state_grant_transaction())
}

test budget_proxy_largest_state_fund_spend_among_eight_deposits() {
  proxy_spend(None, Fund, 8, largest_state_grant_transaction())
}

/// A revoke of the largest lovelace grant over the full revoked list: the
/// oldest slot is dropped to make room, as the owner would before raising
/// the generation.
fn largest_state_device_revoke_transaction() -> Transaction {
  let next = AccountState {
    ..largest_state(),
    revoked: list.concat(
      list.range(2, account_state.max_revoked),
      [largest_grant_slot],
    ),
  }
  logic_transaction(
    [input(0, control_output(largest_state(), 2_000_000))],
    [control_output(next, 2_000_000)],
    assets.zero,
    [key(8)],
    interval.everything,
  )
}

test budget_proxy_largest_state_device_revoke() {
  proxy_spend(None, Device, 0, largest_state_device_revoke_transaction())
}

test budget_logic_largest_state_device_revoke() {
  run(largest_state_device_revoke_transaction())
}

/// A device rewrite over the largest state: the last device replaced by
/// the owner, the full revoked list kept and the generation raised.
fn largest_state_rewrite_transaction() -> Transaction {
  let next = AccountState {
    ..largest_state(),
    devices: list.concat(keys(7), [device_key]),
    grant_generation: 2,
  }
  logic_transaction(
    [input(0, control_output(largest_state(), 2_000_000))],
    [control_output(next, 2_000_000)],
    assets.zero,
    [key(8)],
    interval.everything,
  )
}

test budget_proxy_largest_state_device_rewrite() {
  proxy_spend(None, Device, 0, largest_state_rewrite_transaction())
}

test budget_logic_largest_state_device_rewrite() {
  run(largest_state_rewrite_transaction())
}

/// The upgrade of the largest state to the next logic: the full revoked
/// list and the outstanding count kept, the generation raised, both logics
/// withdrawing.
fn largest_state_upgrade_transaction() -> Transaction {
  let next = AccountState {
    ..largest_state(),
    logic: next_logic_hash,
    grant_generation: 2,
  }
  test_helpers.transaction(
    [input(0, control_output(largest_state(), 2_000_000))],
    [control_output(next, 2_000_000)],
    assets.zero,
    [key(8)],
    interval.everything,
  )
    |> with_proxy_redeemers()
    |> withdrawing([logic_hash, next_logic_hash])
}

test budget_proxy_largest_state_upgrade() {
  proxy_spend(None, Device, 0, largest_state_upgrade_transaction())
}

test budget_old_logic_largest_state_upgrade() {
  run(largest_state_upgrade_transaction())
}

test budget_new_logic_largest_state_upgrade() {
  run_as(next_logic_hash, largest_state_upgrade_transaction())
}

/// An owner spend of a reserve, a deposit carrying a datum, beside the
/// largest control UTxO.
fn largest_state_reserve_transaction() -> Transaction {
  let marker: Data = 1
  logic_transaction(
    [
      input(0, control_output(largest_state(), 2_000_000)),
      input(
        1,
        output(
          account_address(),
          assets.from_lovelace(10_000_000),
          InlineDatum(marker),
        ),
      ),
    ],
    [control_output(largest_state(), 2_000_000), payout(10_000_000)],
    assets.zero,
    [key(8)],
    interval.everything,
  )
}

test budget_proxy_largest_state_fund_spend_of_a_reserve_beside_the_control() {
  let marker: Data = 1
  account.account.spend(
    Some(marker),
    Fund,
    output_reference(1),
    largest_state_reserve_transaction(),
  )
}

test budget_logic_largest_state_reserve_spend() {
  run(largest_state_reserve_transaction())
}

/// A withdrawal of 1 ADA from the reward account, signed by the last
/// device, over the largest control UTxO referenced.
fn largest_state_withdrawal_transaction() -> Transaction {
  let tx = logic_transaction(
    [
      input(
        5,
        output(attacker_address(), assets.from_lovelace(3_000_000), NoDatum),
      ),
    ],
    [payout(4_000_000)],
    assets.zero,
    [key(8)],
    interval.everything,
  )
  Transaction {
    ..tx,
    reference_inputs: [control_reference_of(largest_state())],
    withdrawals: [Pair(Script(stake_script_hash), 1_000_000)],
  }
}

test budget_largest_state_withdrawal() {
  withdraw(largest_state_withdrawal_transaction())
}

/// A delegation of the stake credential, signed by the last device, over
/// the largest control UTxO referenced.
fn largest_state_delegation_transaction() -> Transaction {
  let tx = logic_transaction([], [], assets.zero, [key(8)], interval.everything)
    |> publishing(delegation())
  Transaction {
    ..tx,
    reference_inputs: [control_reference_of(largest_state())],
  }
}

test budget_largest_state_delegation() {
  delegate(largest_state_delegation_transaction())
}

/// An issuance at the largest state once one grant has been swept, so
/// that a sixteenth may be issued: the control UTxO in and out and one
/// grant UTxO of the next slot with eight recipients.
fn largest_state_issue_transaction() -> Transaction {
  let current = AccountState { ..largest_state(), outstanding: 15 }
  let next = AccountState {
    ..current,
    next_slot: largest_next_slot + 1,
    outstanding: 16,
  }
  let grant = Grant { ..largest_lovelace_grant(), slot: largest_next_slot }
  logic_transaction(
    [input(0, control_output(current, 2_000_000))],
    [control_output(next, 2_000_000), grant_output(grant, 2_000_000)],
    grant_token(stake_script_hash, largest_next_slot),
    [key(8)],
    interval.everything,
  )
}

test budget_proxy_largest_state_device_issue() {
  proxy_spend(None, Device, 0, largest_state_issue_transaction())
}

test budget_proxy_largest_state_issue_grants() {
  proxy_mint(IssueGrants, largest_state_issue_transaction())
}

test budget_logic_largest_state_issue() {
  run(largest_state_issue_transaction())
}

/// An issuance of `count` grants at once over the largest state with no
/// grant outstanding: the control UTxO in and out and `count` grant UTxOs
/// from the next slot up with eight recipients each.
fn largest_state_grant_issue_transaction(count: Int) -> Transaction {
  let slots = list.range(largest_next_slot, largest_next_slot + count - 1)
  let current = AccountState { ..largest_state(), outstanding: 0 }
  let next = AccountState {
    ..current,
    next_slot: largest_next_slot + count,
    outstanding: count,
  }
  logic_transaction(
    [input(0, control_output(current, 2_000_000))],
    [
      control_output(next, 2_000_000),
      ..list.map(
        slots,
        fn(slot) {
          grant_output(Grant { ..largest_lovelace_grant(), slot }, 2_000_000)
        },
      )
    ],
    list.foldl(
      slots,
      assets.zero,
      fn(slot, minted) {
        assets.merge(minted, grant_token(stake_script_hash, slot))
      },
    ),
    [key(8)],
    interval.everything,
  )
}

test budget_proxy_largest_state_device_issue_eight_grants() {
  proxy_spend(None, Device, 0, largest_state_grant_issue_transaction(8))
}

test budget_proxy_largest_state_issue_eight_grants() {
  proxy_mint(IssueGrants, largest_state_grant_issue_transaction(8))
}

test budget_logic_largest_state_issue_eight_grants() {
  run(largest_state_grant_issue_transaction(8))
}

test budget_proxy_largest_state_device_issue_sixteen_grants() {
  proxy_spend(None, Device, 0, largest_state_grant_issue_transaction(16))
}

test budget_proxy_largest_state_issue_sixteen_grants() {
  proxy_mint(IssueGrants, largest_state_grant_issue_transaction(16))
}

test budget_logic_largest_state_issue_sixteen_grants() {
  run(largest_state_grant_issue_transaction(16))
}

/// A sweep of the revoked slot 1 at the largest state: the control UTxO
/// and the dead grant UTxO in, the token burned.
fn largest_state_sweep_transaction() -> Transaction {
  let grant = Grant { ..largest_lovelace_grant(), slot: 1 }
  let next = AccountState { ..largest_state(), outstanding: 15 }
  logic_transaction(
    [
      input(0, control_output(largest_state(), 2_000_000)),
      input(1, grant_output(grant, 2_000_000)),
    ],
    [control_output(next, 2_000_000), change(2_000_000)],
    grant_burn(1),
    [key(8)],
    interval.everything,
  )
}

test budget_proxy_largest_state_device_sweep() {
  proxy_spend(None, Device, 0, largest_state_sweep_transaction())
}

test budget_proxy_largest_state_sweep_grant() {
  proxy_spend(None, SweepGrant, 1, largest_state_sweep_transaction())
}

test budget_proxy_largest_state_burn_grants() {
  proxy_mint(BurnGrants, largest_state_sweep_transaction())
}

test budget_logic_largest_state_sweep() {
  run(largest_state_sweep_transaction())
}

/// A sweep of the `count` revoked grants of slots 1 up at once over the
/// largest state: the control UTxO and the dead grant UTxOs in, their
/// tokens burned and their lovelace returned as one deposit.
fn largest_state_grant_sweep_transaction(count: Int) -> Transaction {
  let slots = list.range(1, count)
  let next = AccountState { ..largest_state(), outstanding: 16 - count }
  logic_transaction(
    [
      input(0, control_output(largest_state(), 2_000_000)),
      ..list.map(
        slots,
        fn(slot) {
          input(
            slot,
            grant_output(Grant { ..largest_lovelace_grant(), slot }, 2_000_000),
          )
        },
      )
    ],
    [control_output(next, 2_000_000), change(2_000_000 * count)],
    list.foldl(
      slots,
      assets.zero,
      fn(slot, burned) { assets.merge(burned, grant_burn(slot)) },
    ),
    [key(8)],
    interval.everything,
  )
}

test budget_proxy_largest_state_device_sweep_eight_grants() {
  proxy_spend(None, Device, 0, largest_state_grant_sweep_transaction(8))
}

/// The last of the eight swept grants, whose input the proxy finds after
/// scanning the eight before it.
test budget_proxy_largest_state_sweep_grant_among_eight() {
  proxy_spend(None, SweepGrant, 8, largest_state_grant_sweep_transaction(8))
}

test budget_proxy_largest_state_burn_eight_grants() {
  proxy_mint(BurnGrants, largest_state_grant_sweep_transaction(8))
}

test budget_logic_largest_state_sweep_eight_grants() {
  run(largest_state_grant_sweep_transaction(8))
}

test budget_proxy_largest_state_device_sweep_sixteen_grants() {
  proxy_spend(None, Device, 0, largest_state_grant_sweep_transaction(16))
}

/// The last of the sixteen swept grants, whose input the proxy finds
/// after scanning the sixteen before it.
test budget_proxy_largest_state_sweep_grant_among_sixteen() {
  proxy_spend(None, SweepGrant, 16, largest_state_grant_sweep_transaction(16))
}

test budget_proxy_largest_state_burn_sixteen_grants() {
  proxy_mint(BurnGrants, largest_state_grant_sweep_transaction(16))
}

test budget_logic_largest_state_sweep_sixteen_grants() {
  run(largest_state_grant_sweep_transaction(16))
}

/// A creation whose control output carries the largest state with its
/// counters and revoked list cleared and the owner last among its devices.
fn largest_state_creation_transaction() -> Transaction {
  creation(
    [
      control_output(
        AccountState {
          ..largest_state(),
          devices: list.concat(keys(7), [device_key]),
          next_slot: 0,
          revoked: [],
          outstanding: 0,
        },
        2_000_000,
      ),
    ],
    state_nft(stake_script_hash),
    [device_key],
  )
}

test budget_proxy_largest_state_account_creation() {
  proxy_mint(CreateAccount, largest_state_creation_transaction())
}

test budget_logic_largest_state_account_creation() {
  run(largest_state_creation_transaction())
}

/// The stake script's registration over the same creation, with the owner
/// last among the eight devices.
test budget_largest_state_registration() {
  register(largest_state_creation_transaction())
}

/// A token grant spend at the largest state over the treasury deposit,
/// paying 10 tokens and 2 ADA to the recipient.
fn largest_state_token_grant_transaction() -> Transaction {
  logic_transaction(
    [input(0, grant_output(largest_token_grant(), 2_000_000)), treasury_input()],
    [
      grant_output(with_caps(largest_token_grant(), 40, 0), 2_000_000),
      fund_output(assets.merge(assets.from_lovelace(8_000_000), token(10))),
      output(
        recipient_address(),
        assets.merge(assets.from_lovelace(2_000_000), token(10)),
        NoDatum,
      ),
    ],
    assets.zero,
    [stranger_key],
    interval.before(expiry),
  )
    |> referencing([control_reference_of(largest_state())])
}

test budget_proxy_largest_state_grant_spend_token_scope() {
  proxy_spend(None, SpendWithGrant, 0, largest_state_token_grant_transaction())
}

test budget_logic_largest_state_grant_spend_token_scope() {
  run(largest_state_token_grant_transaction())
}

/// A lovelace grant spend at the largest state over forty deposits, paying
/// 2 ADA to the recipient.
fn forty_deposit_transaction() -> Transaction {
  logic_transaction(
    list.concat(
      [input(0, grant_output(largest_lovelace_grant(), 2_000_000))],
      deposits(40),
    ),
    [
      grant_output(with_caps(largest_lovelace_grant(), 3_000_000, 0), 2_000_000),
      change(398_000_000),
      payout(2_000_000),
    ],
    assets.zero,
    [stranger_key],
    interval.before(expiry - 1),
  )
    |> referencing([control_reference_of(largest_state())])
}

test budget_proxy_grant_spend_over_forty_deposits() {
  proxy_spend(None, SpendWithGrant, 0, forty_deposit_transaction())
}

test budget_logic_grant_spend_over_forty_deposits() {
  run(forty_deposit_transaction())
}

test budget_proxy_fund_spend_among_forty_deposits() {
  proxy_spend(None, Fund, 40, forty_deposit_transaction())
}

// RECIPIENT POLICY ATTACKS ****************************************************

/// The hash standing in for the first recipient policy script.
const first_policy_hash =
  #"a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"

/// The hash standing in for the second recipient policy script.
const second_policy_hash =
  #"a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2"

/// The hash standing in for the third recipient policy script.
const third_policy_hash =
  #"a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3"

/// The hash of a key whose 28 bytes equal the first policy script's hash.
const first_policy_as_key = first_policy_hash

/// The key address of a policied recipient, `n` of up to 8.
fn policied_address(n: Int) -> Address {
  address.from_verification_key(key(120 + n))
}

/// A policy entry at `address` running `script`, with `settings`.
fn policied_entry(
  address: Address,
  script: ByteArray,
  settings: Int,
) -> Recipient {
  let data: Data = settings
  Recipient { address, policy: Some(GrantPolicy { script, settings: data }) }
}

/// A plain entry at the recipient address.
fn plain_entry() -> Recipient {
  plain_recipient(recipient_address())
}

/// The lovelace grant with its scope listing `recipients`.
fn grant_listing(recipients: List<Recipient>) -> Grant {
  Grant { ..lovelace_grant(), scope: Scope { ..lovelace_scope(), recipients } }
}

/// The lovelace grant whose only recipient is the recipient address under
/// the first policy, with settings 1.
fn single_policied_grant() -> Grant {
  grant_listing([policied_entry(recipient_address(), first_policy_hash, 1)])
}

/// The outputs of a spend of `grant` paying `lovelace` to `at`: the
/// recreated grant, the change of the 10 ADA deposit and the payment.
fn outputs_paying(grant: Grant, lovelace: Int, at: Address) -> List<Output> {
  [
    grant_output(with_caps(grant, 5_000_000 - lovelace, 0), 2_000_000),
    change(10_000_000 - lovelace),
    output(at, assets.from_lovelace(lovelace), NoDatum),
  ]
}

/// A spend of `grant` from the 10 ADA deposit into `outputs`, the logic
/// and `scripts` withdrawing.
fn policied_spend_tx(
  grant: Grant,
  outputs: List<Output>,
  scripts: List<ByteArray>,
) -> Transaction {
  grant_transaction(grant, outputs) |> withdrawing(scripts)
}

/// Whether the logic accepts a spend of `grant` into `outputs` with
/// `scripts` withdrawing.
fn policied_spend(
  grant: Grant,
  outputs: List<Output>,
  scripts: List<ByteArray>,
) -> Bool {
  run(policied_spend_tx(grant, outputs, scripts))
}

/// Whether the logic accepts the issuance of the lovelace grant listing
/// `recipients` as slot 0 of the fresh account, signed by the device.
fn issue_listing(recipients: List<Recipient>) -> Bool {
  run(
    owner_transaction(
      state(),
      [],
      [
        control_output(issued_state(1), 2_000_000),
        grant_output(grant_listing(recipients), 2_000_000),
      ],
      grant_token(stake_script_hash, 0),
    ),
  )
}

/// A control state at generation `generation` with slot 0 outstanding and
/// `revoked` as its revoked slots.
fn sweep_state(generation: Int, revoked: List<Int>) -> AccountState {
  AccountState {
    ..issued_state(1),
    grant_generation: generation,
    revoked,
    next_slot: 1,
    outstanding: 1,
  }
}

/// A sweep of the grant UTxO of `grant`, by the device, under `state`
/// and `range`.
fn sweep_transaction(
  grant_utxo: Output,
  state: AccountState,
  range: Interval,
) -> Transaction {
  logic_transaction(
    [input(0, control_output(state, 2_000_000)), input(1, grant_utxo)],
    [
      control_output(AccountState { ..state, outstanding: 0 }, 2_000_000),
      change(2_000_000),
    ],
    grant_burn(0),
    [device_key],
    range,
  )
}

/// An old shape grant: its recipients are a list of addresses, as issued
/// before a recipient could name a policy.
fn old_shape_grant_data() -> Data {
  let old_recipient: Data = recipient_address()
  let scope = builtin.constr_data(
    0,
    [
      {
        let asset: Data = lovelace_asset_data()
        asset
      },
      builtin.i_data(3_000_000),
      builtin.i_data(5_000_000),
      builtin.i_data(0),
      builtin.i_data(0),
      builtin.i_data(expiry),
      builtin.list_data([old_recipient]),
    ],
  )
  builtin.constr_data(
    0,
    [builtin.i_data(0), builtin.b_data(stranger_key), builtin.i_data(0), scope],
  )
}

/// The lovelace asset as data.
fn lovelace_asset_data() -> Data {
  let asset: Data = Asset { policy_id: #"", asset_name: #"" }
  asset
}

/// The grant UTxO of slot 0 carrying the old shape grant inline.
fn old_shape_grant_output() -> Output {
  output(
    account_address(),
    grant_value(stake_script_hash, 0, 2_000_000),
    InlineDatum(old_shape_grant_data()),
  )
}

// Dodging the check

/// The grantee pays the policied recipient's payment credential under a
/// stake part the grant does not list, hoping the logic matches on the
/// payment credential alone and asks for no policy. The whole address
/// is compared, the output reaches no recipient and pays_only_recipients
/// returns False.
/// Proves INV-36.
test attack_recipient_policy_dodging_same_payment_credential_with_another_stake_part() {
  let grant = single_policied_grant()
  !policied_spend(
    grant,
    outputs_paying(
      grant,
      2_000_000,
      recipient_address() |> address.with_delegation_key(key(99)),
    ),
    [first_policy_hash],
  )
}

/// The grantee pays the policied recipient's payment credential with a
/// pointer stake part. A pointer is a distinct address and is not listed.
/// Proves INV-36.
test attack_recipient_policy_dodging_a_pointer_stake_part() {
  let grant = single_policied_grant()
  !policied_spend(
    grant,
    outputs_paying(
      grant,
      2_000_000,
      Address {
        ..recipient_address(),
        stake_credential: Some(
          Pointer { slot_number: 1, transaction_index: 2, certificate_index: 3 },
        ),
      },
    ),
    [first_policy_hash],
  )
}

/// The grant lists the recipient with a stake part; the grantee pays its
/// enterprise form, the same payment credential with no stake part. That
/// is another address and is not listed.
/// Proves INV-36.
test attack_recipient_policy_dodging_the_enterprise_form_of_a_staked_recipient() {
  let staked = recipient_address() |> address.with_delegation_key(key(98))
  let grant = grant_listing([policied_entry(staked, first_policy_hash, 1)])
  !policied_spend(
    grant,
    outputs_paying(grant, 2_000_000, recipient_address()),
    [first_policy_hash],
  )
}

/// The grant lists the policied recipient without a stake part and the
/// grantee pays the staked form. Same payment credential, listed nowhere.
/// Proves INV-36.
test attack_recipient_policy_dodging_a_staked_form_of_an_enterprise_recipient() {
  let grant = single_policied_grant()
  !policied_spend(
    grant,
    outputs_paying(
      grant,
      2_000_000,
      recipient_address() |> address.with_delegation_key(key(98)),
    ),
    [first_policy_hash],
  )
}

/// The grantee hides one payment to the policied recipient in the middle
/// of a run of payments to a plain recipient and attaches no policy
/// withdrawal, hoping only the first outputs are read. Every output is
/// checked, so the hidden one still requires the script.
/// Proves the recipient policy rule of `grant_spend_rule`.
test attack_recipient_policy_dodging_an_output_hidden_among_many() {
  let grant = grant_listing(
    [plain_entry(), policied_entry(policied_address(1), first_policy_hash, 1)],
  )
  let padding = list.map(
    list.range(1, 12),
    fn(_) {
      output(recipient_address(), assets.from_lovelace(100_000), NoDatum)
    },
  )
  let outputs = list.concat(
    list.concat(
      [grant_output(with_caps(grant, 2_750_000, 0), 2_000_000)],
      padding,
    ),
    [
      output(policied_address(1), assets.from_lovelace(1_050_000), NoDatum),
      change(7_750_000),
      ..padding
    ],
  )
  !policied_spend(grant, outputs, [])
}

/// The same hidden payment accompanied by the withdrawal is accepted, so
/// the check above refuses for the missing run and not for the padding.
test recipient_policy_output_hidden_among_many_runs_the_named_policy() {
  let grant = grant_listing(
    [plain_entry(), policied_entry(policied_address(1), first_policy_hash, 1)],
  )
  let padding = list.map(
    list.range(1, 12),
    fn(_) {
      output(recipient_address(), assets.from_lovelace(100_000), NoDatum)
    },
  )
  let outputs = list.concat(
    list.concat(
      [grant_output(with_caps(grant, 2_750_000, 0), 2_000_000)],
      padding,
    ),
    [
      output(policied_address(1), assets.from_lovelace(1_050_000), NoDatum),
      change(7_750_000),
      ..padding
    ],
  )
  policied_spend(grant, outputs, [first_policy_hash])
}

/// A device lists two recipients with the same payment credential and
/// different stake parts, one plain and one policied. They are distinct
/// recipients; paying the plain one runs no policy, as listed.
test recipient_policy_same_payment_credential_under_another_stake_part_is_another_recipient() {
  let staked = recipient_address() |> address.with_delegation_key(key(97))
  let grant = grant_listing(
    [
      plain_recipient(recipient_address()),
      policied_entry(staked, first_policy_hash, 1),
    ],
  )
  policied_spend(
    grant,
    outputs_paying(grant, 2_000_000, recipient_address()),
    [],
  )
}

/// A device lists the account address itself under a policy. The grant
/// UTxO written back and the change are outputs at the account address, so
/// every spend pays that recipient and must run the policy, with or
/// without an outflow. The grantee cannot dodge by paying only the account.
/// Proves the recipient policy rule of `grant_spend_rule`.
test attack_recipient_policy_on_the_account_address_runs_on_every_spend() {
  let grant = grant_listing(
    [policied_entry(account_address(), first_policy_hash, 1)],
  )
  !policied_spend(
    grant,
    [
      grant_output(with_caps(grant, 5_000_000, 0), 2_000_000),
      change(10_000_000),
    ],
    [],
  )
}

/// A recipient at the account address under a policy accepts a spend
/// once the policy runs, the logic asking only for the run.
test recipient_policy_on_the_account_address_is_satisfied_by_its_run() {
  let grant = grant_listing(
    [policied_entry(account_address(), first_policy_hash, 1)],
  )
  policied_spend(
    grant,
    [
      grant_output(with_caps(grant, 5_000_000, 0), 2_000_000),
      change(10_000_000),
    ],
    [first_policy_hash],
  )
}

// Wrong script

/// The grantee attaches a zero withdrawal from another script, one it
/// controls, instead of the script the recipient names. `withdraws_from`
/// looks for exactly the named credential.
/// Proves the recipient policy rule of `grant_spend_rule`.
test attack_recipient_policy_wrong_script_withdrawal_from_another_script() {
  let grant = single_policied_grant()
  !policied_spend(
    grant,
    outputs_paying(grant, 2_000_000, recipient_address()),
    [second_policy_hash],
  )
}

/// The grantee withdraws from a key credential carrying the same 28 bytes
/// as the policy script. A reward account of a key hash runs no script.
/// `withdraws_from` compares the credential as `Script(hash)`, so the
/// key form does not count and the policy never ran.
/// Proves the recipient policy rule of `grant_spend_rule`.
test attack_recipient_policy_wrong_script_key_credential_with_the_policy_hash() {
  let grant = single_policied_grant()
  let tx = policied_spend_tx(
    grant,
    outputs_paying(grant, 2_000_000, recipient_address()),
    [],
  )
  !run(
    Transaction {
      ..tx,
      withdrawals: [
        Pair(VerificationKey(first_policy_as_key), 0),
        ..tx.withdrawals
      ],
    },
  )
}

/// The same spend with the `Script` credential is accepted, so the
/// refusal above comes from the credential kind alone.
test recipient_policy_a_script_withdrawal_with_the_policy_hash_is_accepted() {
  let grant = single_policied_grant()
  policied_spend(
    grant,
    outputs_paying(grant, 2_000_000, recipient_address()),
    [first_policy_hash],
  )
}

/// A nonzero withdrawal from the policy script. The logic does not read
/// the amount: the ledger runs the script for any withdrawal and rejects
/// an amount other than the reward balance, which is zero since the
/// script refuses delegation certificates.
test recipient_policy_a_nonzero_withdrawal_runs_the_script_like_a_zero_one() {
  let grant = single_policied_grant()
  let tx = policied_spend_tx(
    grant,
    outputs_paying(grant, 2_000_000, recipient_address()),
    [],
  )
  run(
    Transaction {
      ..tx,
      withdrawals: [
        Pair(Script(first_policy_hash), 5_000_000),
        ..tx.withdrawals
      ],
    },
  )
}

/// Three recipients name three scripts and all three are paid. Each
/// subset that leaves one script out must be refused, whichever is left
/// out: every paid policied recipient is checked.
/// Proves the recipient policy rule of `grant_spend_rule`.
test attack_recipient_policy_wrong_script_only_some_scripts_run() {
  let grant = grant_listing(
    [
      policied_entry(policied_address(1), first_policy_hash, 1),
      policied_entry(policied_address(2), second_policy_hash, 2),
      policied_entry(policied_address(3), third_policy_hash, 3),
    ],
  )
  let outputs = [
    grant_output(with_caps(grant, 2_000_000, 0), 2_000_000),
    change(7_000_000),
    output(policied_address(1), assets.from_lovelace(1_000_000), NoDatum),
    output(policied_address(2), assets.from_lovelace(1_000_000), NoDatum),
    output(policied_address(3), assets.from_lovelace(1_000_000), NoDatum),
  ]
  and {
    !policied_spend(grant, outputs, [first_policy_hash, second_policy_hash]),
    !policied_spend(grant, outputs, [first_policy_hash, third_policy_hash]),
    !policied_spend(grant, outputs, [second_policy_hash, third_policy_hash]),
    !policied_spend(grant, outputs, [first_policy_hash]),
    !policied_spend(grant, outputs, []),
    policied_spend(
      grant,
      outputs,
      [first_policy_hash, second_policy_hash, third_policy_hash],
    ),
  }
}

/// Two recipients share one policy script. One run of the script, one
/// withdrawal, is enough for both, the script reads both entries; the
/// logic does not demand a run per recipient.
test recipient_policy_one_run_covers_two_recipients_naming_the_same_script() {
  let grant = grant_listing(
    [
      policied_entry(policied_address(1), first_policy_hash, 1),
      policied_entry(policied_address(2), first_policy_hash, 2),
    ],
  )
  policied_spend(
    grant,
    [
      grant_output(with_caps(grant, 3_000_000, 0), 2_000_000),
      change(8_000_000),
      output(policied_address(1), assets.from_lovelace(1_000_000), NoDatum),
      output(policied_address(2), assets.from_lovelace(1_000_000), NoDatum),
    ],
    [first_policy_hash],
  )
}

/// A recipient that is listed and not paid requires no run, even with a
/// policy, so the other recipient's script alone is enough.
test recipient_policy_unpaid_policied_recipient_requires_no_run() {
  let grant = grant_listing(
    [
      policied_entry(policied_address(1), first_policy_hash, 1),
      policied_entry(policied_address(2), second_policy_hash, 2),
    ],
  )
  policied_spend(
    grant,
    outputs_paying(grant, 2_000_000, policied_address(2)),
    [second_policy_hash],
  )
}

// Tampering

/// The three recipients a spend's recreated grant must carry unchanged
/// in every tamper test.
fn tamper_recipients() -> List<Recipient> {
  [
    policied_entry(policied_address(1), first_policy_hash, 1),
    plain_recipient(policied_address(2)),
    policied_entry(policied_address(3), second_policy_hash, 3),
  ]
}

/// Whether the logic accepts a spend of the grant listing
/// `tamper_recipients` into a recreated grant listing `recreated`.
fn accepts_recreated_recipients(recreated: List<Recipient>) -> Bool {
  let grant = grant_listing(tamper_recipients())
  policied_spend(
    grant,
    [
      grant_output(
        with_caps(
          Grant {
            ..grant,
            scope: Scope { ..grant.scope, recipients: recreated },
          },
          3_000_000,
          0,
        ),
        2_000_000,
      ),
      change(8_000_000),
      output(policied_address(1), assets.from_lovelace(2_000_000), NoDatum),
    ],
    [first_policy_hash],
  )
}

test recipient_policy_recreated_grant_keeping_every_recipient_is_accepted() {
  accepts_recreated_recipients(tamper_recipients())
}

/// A spend that changes the address of one recipient in the recreated
/// grant, at each of three positions, would let a later spend pay
/// the new address. `is_grant_within` compares the whole recipient list,
/// so every position is covered.
/// Proves INV-39.
test attack_recipient_policy_tamper_a_recipient_address_at_each_position() {
  expect [a, b, c] = tamper_recipients()
  let moved = fn(entry: Recipient) {
    Recipient { ..entry, address: address.from_verification_key(key(77)) }
  }
  and {
    !accepts_recreated_recipients([moved(a), b, c]),
    !accepts_recreated_recipients([a, moved(b), c]),
    !accepts_recreated_recipients([a, b, moved(c)]),
  }
}

/// The recreated grant swaps a policy script for one the attacker runs,
/// at each policied position.
/// Proves INV-39.
test attack_recipient_policy_tamper_a_policy_script_at_each_position() {
  expect [a, b, c] = tamper_recipients()
  let rescripted = fn(entry: Recipient, n: Int) {
    Recipient {
      ..entry,
      policy: Some(
        GrantPolicy {
          script: second_policy_hash,
          settings: {
            let d: Data = n
            d
          },
        },
      ),
    }
  }
  and {
    !accepts_recreated_recipients([rescripted(a, 1), b, c]),
    !accepts_recreated_recipients(
      [a, b, policied_entry(policied_address(3), first_policy_hash, 3)],
    ),
  }
}

/// The recreated grant changes the settings a policy script reads, at
/// each policied position.
/// Proves INV-39.
test attack_recipient_policy_tamper_settings_at_each_position() {
  expect [a, b, c] = tamper_recipients()
  and {
    !accepts_recreated_recipients(
      [policied_entry(policied_address(1), first_policy_hash, 9), b, c],
    ),
    !accepts_recreated_recipients(
      [a, b, policied_entry(policied_address(3), second_policy_hash, 9)],
    ),
  }
}

/// The recreated grant drops a policy, at each policied position, or
/// adds one to the plain recipient.
/// Proves INV-39.
test attack_recipient_policy_tamper_dropping_or_adding_a_policy() {
  expect [a, b, c] = tamper_recipients()
  and {
    !accepts_recreated_recipients([plain_recipient(policied_address(1)), b, c]),
    !accepts_recreated_recipients(
      [a, policied_entry(policied_address(2), first_policy_hash, 1), c],
    ),
    !accepts_recreated_recipients([a, b, plain_recipient(policied_address(3))]),
  }
}

/// The recreated grant reorders the recipients, adds one or removes one.
/// Proves INV-39.
test attack_recipient_policy_tamper_reordering_adding_or_removing_recipients() {
  expect [a, b, c] = tamper_recipients()
  and {
    !accepts_recreated_recipients([b, a, c]),
    !accepts_recreated_recipients([c, b, a]),
    !accepts_recreated_recipients([a, c, b]),
    !accepts_recreated_recipients([a, b]),
    !accepts_recreated_recipients([a, c]),
    !accepts_recreated_recipients([b, c]),
    !accepts_recreated_recipients(
      [a, b, c, plain_recipient(address.from_verification_key(key(66)))],
    ),
  }
}

/// A tamper of the given kind at the given position of an 8 entry
/// recipient list. Kinds: 0 rewrites the address, 1 the script, 2 the
/// settings, 3 clears the policy, 4 sets one on a plain entry, 5 removes
/// the entry, 6 swaps it with the next, 7 inserts a duplicate entry.
fn tampered_at(
  recipients: List<Recipient>,
  position: Int,
  kind: Int,
) -> List<Recipient> {
  let index = position % list.length(recipients)
  let entry = when list.at(recipients, index) is {
    Some(entry) -> entry
    None -> fail
  }
  let rebuild = fn(replacement: List<Recipient>) {
    list.concat(
      list.take(recipients, index),
      list.concat(replacement, list.drop(recipients, index + 1)),
    )
  }
  when kind is {
    0 -> rebuild([Recipient { ..entry, address: policied_address(50) }])
    1 -> rebuild([policied_entry(entry.address, third_policy_hash, 1)])
    2 -> rebuild([policied_entry(entry.address, first_policy_hash, 777)])
    3 -> rebuild([plain_recipient(entry.address)])
    4 -> rebuild([policied_entry(entry.address, second_policy_hash, 42)])
    5 -> rebuild([])
    6 ->
      if index + 1 < list.length(recipients) {
        let next = when list.at(recipients, index + 1) is {
          Some(n) -> n
          None -> fail
        }
        list.concat(
          list.take(recipients, index),
          [next, entry, ..list.drop(recipients, index + 2)],
        )
      } else {
        rebuild([Recipient { ..entry, address: policied_address(60) }])
      }
    _ -> rebuild([entry, entry])
  }
}

/// A shape of 8 entries, alternating policied and plain, whose tampers
/// are all observable at every position.
fn eight_tamper_recipients() -> List<Recipient> {
  list.map(
    list.range(0, 7),
    fn(n) {
      if n % 2 == 0 {
        policied_entry(policied_address(n + 1), first_policy_hash, n)
      } else {
        plain_recipient(policied_address(n + 1))
      }
    },
  )
}

/// Whether the two lists differ at any position, the precondition for the
/// tamper below: a tamper that lands on an entry equal to its replacement
/// is the same list, not a tamper.
fn differs(left: List<Recipient>, right: List<Recipient>) -> Bool {
  list.length(left) != list.length(right) || list.any(
    list.zip(left, right),
    fn(pair) { pair.1st != pair.2nd },
  )
}

/// For any position in the list and any kind of change that actually
/// alters it, a recreated grant whose recipients differ from the spent
/// grant's is refused.
/// Proves INV-39.
test prop_recipient_policy_tamper_at_any_position_is_refused(
  picked via fuzz.tuple(fuzz.int_between(0, 7), fuzz.int_between(0, 7)),
) {
  let (position, kind) = picked
  let recipients = eight_tamper_recipients()
  let tampered = tampered_at(recipients, position, kind)
  let grant = grant_listing(recipients)
  let recreated = Grant {
    ..with_caps(grant, 3_000_000, 0),
    scope: Scope {
      ..with_caps(grant, 3_000_000, 0).scope,
      recipients: tampered,
    },
  }
  if differs(recipients, tampered) {
    !policied_spend(
      grant,
      [
        grant_output(recreated, 2_000_000),
        change(8_000_000),
        output(policied_address(1), assets.from_lovelace(2_000_000), NoDatum),
      ],
      [first_policy_hash],
    )
  } else {
    True
  }
}

/// For any address a grantee can name, an output there is refused unless
/// the address equals a listed recipient or the account, and the grant
/// accepts it when it does, whole address compared.
/// Proves INV-36.
test prop_recipient_policy_recipient_matching_compares_whole_addresses(
  key_index via fuzz.int_between(0, 255),
) {
  let listed = policied_address(1)
  let destination = address.from_verification_key(key(key_index))
  let grant = grant_listing([policied_entry(listed, first_policy_hash, 1)])
  let accepted = policied_spend(
    grant,
    outputs_paying(grant, 1_000_000, destination),
    [first_policy_hash],
  )
  accepted == ( destination == listed )
}

/// For any subset of 8 policied recipients being paid and any subset of
/// their scripts withdrawn, the spend is accepted exactly when every paid
/// recipient's own script is among the withdrawals.
/// Proves the recipient policy rule of `grant_spend_rule`.
test prop_recipient_policy_runs_exactly_the_named_scripts(
  picked via fuzz.tuple(
    fuzz.set_between(fuzz.int_between(1, 8), 0, 8),
    fuzz.set_between(fuzz.int_between(1, 8), 0, 8),
  ),
) {
  let (paid, withdrawn) = picked
  let hash_of = fn(n: Int) {
    bytearray.push(#"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", n)
  }
  let grant = grant_listing(
    list.map(
      list.range(1, 8),
      fn(n) { policied_entry(policied_address(n), hash_of(n), n) },
    ),
  )
  let total = list.length(paid) * 100_000
  let outputs = list.concat(
    [
      grant_output(with_caps(grant, 5_000_000 - total, 0), 2_000_000),
      change(10_000_000 - total),
    ],
    list.map(
      paid,
      fn(n) {
        output(policied_address(n), assets.from_lovelace(100_000), NoDatum)
      },
    ),
  )
  let scripts = list.map(withdrawn, hash_of)
  let should_pass = list.all(paid, fn(n) { list.has(withdrawn, n) })
  policied_spend(grant, outputs, scripts) == should_pass
}

// Multiple accounts and grants

/// Two accounts both grant the agent. The first account's grant names a
/// policy on the recipient, the second names another policy on the same
/// recipient, and the transaction runs only the second's. The first
/// account's logic reads only its own grant's entries, so the other
/// account's policy run cannot satisfy it.
/// Proves the recipient policy rule of `grant_spend_rule` and INV-31.
test attack_recipient_policy_one_run_of_another_accounts_policy_does_not_satisfy_this_account() {
  let tx = test_helpers.transaction(
    [
      input(0, grant_output(single_policied_grant(), 2_000_000)),
      input(1, fund_output(assets.from_lovelace(10_000_000))),
      input(
        2,
        other_grant_output(
          grant_listing(
            [policied_entry(recipient_address(), second_policy_hash, 1)],
          ),
          2_000_000,
        ),
      ),
      input(3, other_fund_output(assets.from_lovelace(10_000_000))),
    ],
    [
      grant_output(with_caps(single_policied_grant(), 3_000_000, 0), 2_000_000),
      change(8_000_000),
      other_grant_output(
        with_caps(
          grant_listing(
            [policied_entry(recipient_address(), second_policy_hash, 1)],
          ),
          3_000_000,
          0,
        ),
        2_000_000,
      ),
      other_fund_output(assets.from_lovelace(8_000_000)),
      output(recipient_address(), assets.from_lovelace(4_000_000), NoDatum),
    ],
    assets.zero,
    [stranger_key],
    interval.before(expiry - 1),
  )
    |> referencing(
        [
          control_reference(),
          input(101, other_control_output(other_state(), 2_000_000)),
        ],
      )
    |> with_proxy_redeemers()
    |> withdrawing([logic_hash, next_logic_hash, second_policy_hash])
  !run(tx)
}

/// Two accounts each grant the agent the policied recipient under the
/// same script. The agent pays one 2 ADA output there as the supposed
/// payment of both grants and sends the other 2 ADA to itself, relying on
/// the single policy run to approve both. Each logic nets its own
/// account's address, and the second 2 ADA reaches no listed recipient,
/// so `pays_only_recipients` refuses both spends; the policy itself
/// additionally refuses two grant inputs.
/// Proves INV-36.
test attack_recipient_policy_two_grants_paying_one_output_is_netted_per_account() {
  let policied_a = single_policied_grant()
  let policied_b = grant_listing(
    [policied_entry(recipient_address(), first_policy_hash, 2)],
  )
  let tx = test_helpers.transaction(
    [
      input(0, grant_output(policied_a, 2_000_000)),
      input(1, fund_output(assets.from_lovelace(10_000_000))),
      input(2, other_grant_output(policied_b, 2_000_000)),
      input(3, other_fund_output(assets.from_lovelace(10_000_000))),
    ],
    [
      grant_output(with_caps(policied_a, 3_000_000, 0), 2_000_000),
      change(8_000_000),
      other_grant_output(with_caps(policied_b, 3_000_000, 0), 2_000_000),
      other_fund_output(assets.from_lovelace(8_000_000)),
      output(recipient_address(), assets.from_lovelace(2_000_000), NoDatum),
      output(attacker_address(), assets.from_lovelace(2_000_000), NoDatum),
    ],
    assets.zero,
    [stranger_key],
    interval.before(expiry - 1),
  )
    |> referencing(
        [
          control_reference(),
          input(101, other_control_output(other_state(), 2_000_000)),
        ],
      )
    |> with_proxy_redeemers()
    |> withdrawing([logic_hash, next_logic_hash, first_policy_hash])
  and {
    !run(tx),
    !run_as(next_logic_hash, tx),
  }
}

/// Two grants of one account spent together. The logic allows one
/// account token input per transaction, whichever recipients they name.
/// Proves INV-31.
test attack_recipient_policy_two_grants_of_one_account_in_one_transaction() {
  let a = single_policied_grant()
  let b = Grant {
    ..token_grant(),
    slot: 1,
    scope: Scope { ..lovelace_scope(), recipients: [plain_entry()] },
  }
  let tx = test_helpers.transaction(
    [
      input(0, grant_output(a, 2_000_000)),
      input(1, grant_output(b, 2_000_000)),
      input(2, fund_output(assets.from_lovelace(10_000_000))),
    ],
    [grant_output(a, 2_000_000), grant_output(b, 2_000_000), change(10_000_000)],
    assets.zero,
    [stranger_key],
    interval.before(expiry - 1),
  )
    |> referencing([control_reference()])
    |> with_proxy_redeemers()
    |> withdrawing([logic_hash, first_policy_hash])
  !run(tx)
}

// Other exits

/// A foreign token is minted by the transaction and paid to the policied
/// recipient without the policy. The mint brings its value from outside
/// the account, but the payment still names the recipient, so the script
/// must run on every output there.
/// Proves the recipient policy rule of `grant_spend_rule`.
test attack_recipient_policy_other_exit_foreign_mint_paid_to_the_policied_recipient() {
  let grant = single_policied_grant()
  let tx = test_helpers.transaction(
    [
      input(0, grant_output(grant, 2_000_000)),
      input(1, fund_output(assets.from_lovelace(10_000_000))),
    ],
    [
      grant_output(with_caps(grant, 5_000_000, 0), 2_000_000),
      change(10_000_000),
      output(recipient_address(), token(5), NoDatum),
    ],
    token(5),
    [stranger_key],
    interval.before(expiry - 1),
  )
    |> referencing([control_reference()])
    |> with_proxy_redeemers()
    |> withdrawing([logic_hash])
  !run(tx)
}

/// An account token minted beside a policied spend. Issuance needs the
/// control UTxO spent, and the agent path admits no mint under the policy.
/// Proves INV-30.
test attack_recipient_policy_other_exit_account_token_minted_on_the_agent_path() {
  let grant = single_policied_grant()
  let tx = test_helpers.transaction(
    [
      input(0, grant_output(grant, 2_000_000)),
      input(1, fund_output(assets.from_lovelace(10_000_000))),
    ],
    [
      grant_output(with_caps(grant, 5_000_000, 0), 2_000_000),
      change(10_000_000),
      output(account_address(), grant_token(stake_script_hash, 5), NoDatum),
    ],
    grant_token(stake_script_hash, 5),
    [stranger_key],
    interval.before(expiry - 1),
  )
    |> referencing([control_reference()])
    |> with_proxy_redeemers()
    |> withdrawing([logic_hash, first_policy_hash])
  !run(tx)
}

/// The grantee attaches a certificate instead of the withdrawal, hoping
/// that some other credential's script runs in its place. A certificate
/// is no withdrawal, so the check still fails.
/// Proves the recipient policy rule of `grant_spend_rule`.
test attack_recipient_policy_other_exit_a_certificate_does_not_stand_in_for_the_withdrawal() {
  let grant = single_policied_grant()
  let tx = policied_spend_tx(
    grant,
    outputs_paying(grant, 2_000_000, recipient_address()),
    [],
  )
  !run(tx |> publishing(registration(first_policy_hash)))
}

/// A withdrawal from the account's own stake script instead of the
/// policy's. That credential is not the one the recipient names, whether
/// or not the stake script approves it.
/// Proves the recipient policy rule of `grant_spend_rule`.
test attack_recipient_policy_other_exit_a_withdrawal_from_another_credential() {
  let grant = single_policied_grant()
  !policied_spend(
    grant,
    outputs_paying(grant, 2_000_000, recipient_address()),
    [stake_script_hash],
  )
}

/// A reference script parked on the output to the policied recipient
/// still requires the script to run. The value of the script is
/// not visible as an exit; the policy decides what may be parked there.
/// Proves the recipient policy rule of `grant_spend_rule`.
test attack_recipient_policy_other_exit_a_reference_script_on_the_policied_output() {
  let grant = single_policied_grant()
  let tx = policied_spend_tx(
    grant,
    [
      grant_output(with_caps(grant, 3_000_000, 0), 2_000_000),
      change(8_000_000),
      Output {
        address: recipient_address(),
        value: assets.from_lovelace(2_000_000),
        datum: NoDatum,
        reference_script: Some(first_policy_hash),
      },
    ],
    [],
  )
  !run(tx)
}

/// A contract call beside the policied spend: an input at a foreign
/// script carrying a redeemer that decodes as `SpendWithGrant`. The foreign
/// input is not at the account address, so the logic leaves it to its
/// own script, and the payment to the policied recipient still needs
/// the policy.
/// Proves the recipient policy rule of `grant_spend_rule`.
test attack_recipient_policy_other_exit_foreign_script_input_in_a_contract_call() {
  let grant = single_policied_grant()
  let foreign = Input {
    output_reference: output_reference(50),
    output: output(
      address.from_script(second_policy_hash),
      assets.from_lovelace(4_000_000),
      NoDatum,
    ),
  }
  let tx = policied_spend_tx(
    grant,
    outputs_paying(grant, 2_000_000, recipient_address()),
    [],
  )
  let redeemer: Data = SpendWithGrant
  let with_foreign = Transaction {
    ..tx,
    inputs: list.concat(tx.inputs, [foreign]),
    redeemers: list.concat(
      tx.redeemers,
      [Pair(transaction.Spend(output_reference(50)), redeemer)],
    ),
  }
  !run(with_foreign)
}

// Interactions with the rest of the contract

/// A device sweeps a policied grant dead by generation. The sweep reads
/// the stable prefix, so the policy on the recipient is not in the way.
test recipient_policy_grant_sweeps_when_dead_by_generation() {
  let grant = single_policied_grant()
  run(
    sweep_transaction(
      grant_output(grant, 2_000_000),
      sweep_state(1, []),
      interval.everything,
    ),
  )
}

/// A device sweeps a policied grant dead by revocation.
test recipient_policy_grant_sweeps_when_dead_by_revocation() {
  let grant = single_policied_grant()
  run(
    sweep_transaction(
      grant_output(grant, 2_000_000),
      sweep_state(0, [0]),
      interval.everything,
    ),
  )
}

/// A device sweeps a policied grant dead by expiry. Expiry is read through
/// a full decode, so the `Recipient` list must decode there too.
test recipient_policy_grant_sweeps_when_dead_by_expiry() {
  let grant = single_policied_grant()
  run(
    sweep_transaction(
      grant_output(grant, 2_000_000),
      sweep_state(0, []),
      interval.after(expiry + 1),
    ),
  )
}

/// The agent cannot spend a policied grant once it is dead by revocation,
/// whatever policies it runs.
/// Proves INV-32.
test attack_recipient_policy_revoked_grant_spend_is_refused_with_its_policy_running() {
  let grant = single_policied_grant()
  let tx = policied_spend_tx(
    grant,
    outputs_paying(grant, 2_000_000, recipient_address()),
    [first_policy_hash],
  )
  !run(
    Transaction {
      ..tx,
      reference_inputs: [control_reference_of(sweep_state(0, [0]))],
    },
  )
}

/// A grant datum in the old shape, recipients as bare addresses, is
/// swept by generation: the sweep reads only the stable prefix.
test recipient_policy_old_shape_grant_sweeps_by_generation() {
  run(
    sweep_transaction(
      old_shape_grant_output(),
      sweep_state(1, []),
      interval.everything,
    ),
  )
}

/// An old shape grant cannot be swept by expiry. Expiry needs a full
/// decode, the old shape does not decode as `Grant`, and it is not dead
/// by generation or slot, so the sweep falls to the `else` and refuses.
/// Proves INV-29.
test attack_recipient_policy_old_shape_grant_is_not_swept_by_expiry() {
  !run(
    sweep_transaction(
      old_shape_grant_output(),
      sweep_state(0, []),
      interval.after(expiry + 1),
    ),
  )
}

/// An old shape grant cannot be spent: `grant_datum` decodes the grant
/// strictly and aborts on the bare address list.
/// Proves INV-46.
test attack_recipient_policy_old_shape_grant_spend_aborts() fail {
  let tx = test_helpers.transaction(
    [
      input(0, old_shape_grant_output()),
      input(1, fund_output(assets.from_lovelace(10_000_000))),
    ],
    [old_shape_grant_output(), change(10_000_000)],
    assets.zero,
    [stranger_key],
    interval.before(expiry - 1),
  )
    |> referencing([control_reference()])
    |> with_proxy_redeemers()
    |> withdrawing([logic_hash])
  run(tx)
}

/// An upgrade raises the generation while a policied grant is live. The
/// old grant is dead under the new generation, whatever the new logic
/// is and whatever policy runs: the spend is refused and the sweep by
/// the new logic is accepted.
/// Proves INV-32 and INV-43.
test attack_recipient_policy_upgrade_kills_live_policied_grants() {
  let grant = single_policied_grant()
  let spend = test_helpers.transaction(
    [
      input(0, grant_output(grant, 2_000_000)),
      input(1, fund_output(assets.from_lovelace(10_000_000))),
    ],
    outputs_paying(grant, 2_000_000, recipient_address()),
    assets.zero,
    [stranger_key],
    interval.before(expiry - 1),
  )
    |> referencing([control_reference_of(upgraded_state())])
    |> with_proxy_redeemers()
    |> withdrawing([next_logic_hash, first_policy_hash])
  !run_as(next_logic_hash, spend)
}

/// A device upgrades the account while a policied grant is live. The
/// proxy and the logic never read the recipient policies on that path,
/// so a live policy cannot hold the owner hostage.
test recipient_policy_upgrade_is_not_blocked_by_a_live_policied_grant() {
  let next = AccountState { ..upgraded_state(), grant_generation: 1 }
  run(upgrade_into(next))
}

/// `Fund` beside a policied spend. The deposits pay in as usual; the
/// grant accounting nets the account and the withdrawal runs the policy.
test recipient_policy_a_fund_input_beside_a_policied_spend_is_accepted() {
  let grant = single_policied_grant()
  policied_spend(
    grant,
    outputs_paying(grant, 2_000_000, recipient_address()),
    [first_policy_hash],
  )
}

/// A deposit spent under `Device` beside a policied grant spend on the
/// agent path. Only `SpendWithGrant` and `Fund` may ride on the agent
/// path, whatever policy runs.
/// Proves INV-30.
test attack_recipient_policy_device_redeemer_beside_a_policied_spend() {
  let grant = single_policied_grant()
  !run(
    policied_spend_tx(
      grant,
      outputs_paying(grant, 2_000_000, recipient_address()),
      [first_policy_hash],
    )
      |> spending(1, Device),
  )
}

/// A `SweepGrant` on the deposit beside a policied spend on the agent path
/// fails the same way.
/// Proves INV-30.
test attack_recipient_policy_sweep_redeemer_beside_a_policied_spend() {
  let grant = single_policied_grant()
  !run(
    policied_spend_tx(
      grant,
      outputs_paying(grant, 2_000_000, recipient_address()),
      [first_policy_hash],
    )
      |> spending(1, SweepGrant),
  )
}

// Issuance

/// Issuing a grant whose two recipients share an address, the first
/// policied and the second plain: if a duplicate slipped in, a payment
/// could match the plain entry and dodge the policy.
/// Proves the recipient policy rule of `grant_spend_rule`.
test attack_recipient_policy_issuance_duplicate_address_with_and_without_a_policy() {
  !issue_listing(
    [
      policied_entry(policied_address(1), first_policy_hash, 1),
      plain_recipient(policied_address(1)),
    ],
  )
}

/// Issuing a grant whose two policied entries share an address under
/// different scripts: the first entry would satisfy the check and the
/// second would be meaningless.
/// Proves the recipient policy rule of `grant_spend_rule`.
test attack_recipient_policy_issuance_duplicate_address_under_two_scripts() {
  !issue_listing(
    [
      policied_entry(policied_address(1), first_policy_hash, 1),
      policied_entry(policied_address(1), second_policy_hash, 1),
    ],
  )
}

/// Issuing a policy whose script hash is not 28 bytes names no script a
/// withdrawal could run, so the grant would be unspendable toward that
/// recipient. Too short, too long and empty are all refused.
/// Proves INV-45.
test attack_recipient_policy_issuance_malformed_policy_hash() {
  and {
    !issue_listing([policied_entry(policied_address(1), #"a1a1a1", 1)]),
    !issue_listing([policied_entry(policied_address(1), #"", 1)]),
    !issue_listing(
      [
        policied_entry(
          policied_address(1),
          #"a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
          1,
        ),
      ],
    ),
  }
}

/// `count` recipients, each policied, each naming its own script and an
/// address of its own.
fn fully_policied_recipients(count: Int, settings: Int) -> List<Recipient> {
  list.map(
    list.range(1, count),
    fn(n) {
      policied_entry(
        policied_address(n),
        bytearray.push(
          #"c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0",
          n,
        ),
        settings,
      )
    },
  )
}

/// A grant may list 8 policied recipients, the most a scope may hold.
test recipient_policy_issuance_of_eight_policied_recipients_is_accepted() {
  issue_listing(fully_policied_recipients(8, 1))
}

/// A ninth policied recipient breaks the recipient bound, whatever its
/// policy says.
/// Proves INV-45.
test attack_recipient_policy_issuance_nine_policied_recipients() {
  !issue_listing(fully_policied_recipients(9, 1))
}

/// The settings a policy reads are opaque Data of any size: a very long
/// settings value is well formed for the logic. Bounding its size would
/// have to serialise it on chain, and its only cost falls on the issuing
/// device's own grant.
test recipient_policy_issuance_with_large_opaque_settings_is_accepted() {
  let big: Data = builtin.b_data(#"aa")
  let wrapped: Data = builtin.list_data(
    list.map(list.range(1, 64), fn(_) { big }),
  )
  let entry = Recipient {
    address: policied_address(1),
    policy: Some(GrantPolicy { script: first_policy_hash, settings: wrapped }),
  }
  issue_listing([entry])
}

// RECIPIENT POLICY BUDGETS ****************************************************

/// A 28 byte policy script hash ending in `n`.
fn policy_hash(n: Int) -> ByteArray {
  bytearray.push(#"c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0", n)
}

/// A settings value shaped like the example policies' settings: eleven
/// fields, about 200 bytes of CBOR, with a key and two script hashes, two
/// pinned asset classes, a price and three caps.
fn realistic_settings() -> Data {
  builtin.constr_data(
    0,
    [
      builtin.constr_data(0, [builtin.b_data(key(55))]),
      builtin.constr_data(0, [builtin.b_data(key(56))]),
      builtin.constr_data(
        0,
        [builtin.b_data(key(57)), builtin.b_data(#"aabbccddeeff")],
      ),
      builtin.constr_data(1, []),
      builtin.i_data(3),
      builtin.i_data(1),
      builtin.i_data(2_000_000),
      builtin.i_data(1_000_000),
      builtin.constr_data(0, [builtin.b_data(key(58))]),
      builtin.b_data(#"aabbcc"),
      builtin.i_data(1_900_000_000_000),
    ],
  )
}

/// `count` recipients at key addresses of their own, each under a policy
/// of its own carrying `settings`.
fn recipients_with_settings(count: Int, settings: Data) -> List<Recipient> {
  list.map(
    list.range(1, count),
    fn(n) {
      Recipient {
        address: address.from_verification_key(key(180 + n)),
        policy: Some(GrantPolicy { script: policy_hash(n), settings }),
      }
    },
  )
}

/// The largest lovelace grant, listing `recipients`.
fn largest_grant_listing(recipients: List<Recipient>) -> Grant {
  Grant {
    ..largest_lovelace_grant(),
    scope: Scope { ..largest_lovelace_grant().scope, recipients },
  }
}

/// A spend of `grant` over the largest state paying each of `paid`
/// recipients, with every named script withdrawing, as the heaviest
/// policied spend has it.
fn largest_state_policied_spend_transaction(
  grant: Grant,
  paid: List<Recipient>,
) -> Transaction {
  logic_transaction(
    [
      input(0, grant_output(grant, 2_000_000)),
      input(1, fund_output(assets.from_lovelace(10_000_000))),
    ],
    list.concat(
      [
        grant_output(with_caps(grant, 3_000_000, 0), 2_000_000),
        change(10_000_000 - list.length(paid) * 100_000),
      ],
      list.map(
        paid,
        fn(recipient) {
          output(recipient.address, assets.from_lovelace(100_000), NoDatum)
        },
      ),
    ),
    assets.zero,
    [stranger_key],
    interval.before(expiry - 1),
  )
    |> referencing([control_reference_of(largest_state())])
    |> withdrawing(
        list.filter_map(
          paid,
          fn(recipient) {
            when recipient.policy is {
              Some(policy) -> Some(policy.script)
              None -> None
            }
          },
        ),
      )
}

/// The issuance over the largest state of `grant` as its next slot.
fn largest_state_policied_issue_transaction(grant: Grant) -> Transaction {
  let current = AccountState { ..largest_state(), outstanding: 0 }
  let issued = Grant { ..grant, slot: largest_next_slot }
  let next = AccountState {
    ..current,
    next_slot: largest_next_slot + 1,
    outstanding: 1,
  }
  logic_transaction(
    [input(0, control_output(current, 2_000_000))],
    [control_output(next, 2_000_000), grant_output(issued, 2_000_000)],
    grant_token(stake_script_hash, largest_next_slot),
    [key(8)],
    interval.everything,
  )
}

/// A settings value of about 1 kilobyte, far beyond what a real policy
/// reads, to bound how settings size scales the spend.
fn oversized_settings() -> Data {
  builtin.list_data(
    list.map(
      list.range(1, 32),
      fn(_) {
        builtin.b_data(
          #"aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
        )
      },
    ),
  )
}

test budget_logic_largest_state_issue_eight_policied_recipients() {
  let grant = largest_grant_listing(
    recipients_with_settings(8, realistic_settings()),
  )
  run(largest_state_policied_issue_transaction(grant))
}

test budget_logic_largest_state_spend_eight_policied_recipients() {
  let recipients = recipients_with_settings(8, realistic_settings())
  let grant = largest_grant_listing(recipients)
  run(largest_state_policied_spend_transaction(grant, recipients))
}

test budget_logic_largest_state_spend_one_of_eight_policied_recipients() {
  let recipients = recipients_with_settings(8, realistic_settings())
  let grant = largest_grant_listing(recipients)
  expect [first, ..] = recipients
  run(largest_state_policied_spend_transaction(grant, [first]))
}

test budget_logic_largest_state_spend_eight_policied_with_oversized_settings() {
  let recipients = recipients_with_settings(8, oversized_settings())
  let grant = largest_grant_listing(recipients)
  run(largest_state_policied_spend_transaction(grant, recipients))
}

/// The datum of a grant with 8 policied recipients at a realistic size:
/// a spend writes the grant back inline, so it counts against the 16 KB
/// transaction limit alongside the witnesses and other outputs.
test budget_eight_policied_grant_datum_is_within_the_transaction_size_limit() {
  let grant: Data = largest_grant_listing(
    recipients_with_settings(8, realistic_settings()),
  )
  bytearray.length(cbor.serialise(grant)) <= 4_096
}
