//// Exploit attempts against the account validator, one group per
//// vulnerability class of the Cardano smart contract security curriculum.
//// Every `attack_` test builds a transaction an adversary would submit and
//// asserts that the validator refuses it: with `!` when the handler returns
//// False and as a `fail` test when it aborts on an `expect`. The `budget_`
//// tests build the largest well formed state and the heaviest spends over
//// it so that `aiken check` reports their execution units.

use account
use account_stake
use aiken/builtin
use aiken/cbor
use aiken/collection/list
use aiken/interval.{Interval, IntervalBound, NegativeInfinity}
use aiken/primitive/bytearray
use cardano/address.{Address, Script}
use cardano/assets.{Assets}
use cardano/transaction.{
  DatumHash, InlineDatum, Input, NoDatum, Output, Transaction,
}
use cardano_account_custody_contract/test_helpers.{
  account_address, control_output, control_value, device_key, fund_output, input,
  other_account_address, other_device_key, other_stake_script_hash, output,
  output_reference, publishing, recipient_address, registration, script_hash,
  stake_script_hash, state_datum, state_nft, stranger_key,
}
use cardano_account_custody_contract/types.{
  AccountState, Asset, CreateAccount, Device, Fund, Grant, Operate, Scope,
  SpendWithGrant,
}

const expiry = 1_800_000_000_000

/// The key hash of a party that holds no device, owner or grantee key.
const attacker_key = #"00000000000000000000000000000000000000000000000000000007"

fn attacker_address() -> Address {
  address.from_verification_key(attacker_key)
}

fn lovelace_asset() -> Asset {
  Asset { policy_id: assets.ada_policy_id, asset_name: assets.ada_asset_name }
}

fn token_asset() -> Asset {
  Asset {
    policy_id: #"00000000000000000000000000000000000000000000000000000099",
    asset_name: "token",
  }
}

fn token(quantity: Int) -> Assets {
  assets.from_asset(token_asset().policy_id, token_asset().asset_name, quantity)
}

fn lovelace_scope() -> Scope {
  Scope {
    asset: lovelace_asset(),
    per_call_cap: 3_000_000,
    cap: 5_000_000,
    lovelace_per_call_cap: 0,
    lovelace_cap: 0,
    expires_at: expiry,
    recipients: [],
  }
}

fn token_scope() -> Scope {
  Scope {
    asset: token_asset(),
    per_call_cap: 10,
    cap: 50,
    lovelace_per_call_cap: 2_000_000,
    lovelace_cap: 2_000_000,
    expires_at: expiry,
    recipients: [recipient_address()],
  }
}

fn restricted_scope() -> Scope {
  Scope { ..lovelace_scope(), recipients: [recipient_address()] }
}

fn state() -> AccountState {
  AccountState { devices: [device_key], grants: [], grant_generation: 0 }
}

fn granted_state() -> AccountState {
  AccountState {
    devices: [device_key],
    grants: [
      Grant { slot: 0, grantee: stranger_key, scope: lovelace_scope() },
      Grant { slot: 1, grantee: stranger_key, scope: token_scope() },
    ],
    grant_generation: 0,
  }
}

fn restricted_state() -> AccountState {
  AccountState {
    ..state(),
    grants: [
      Grant { slot: 0, grantee: stranger_key, scope: restricted_scope() },
    ],
  }
}

fn with_caps(
  state: AccountState,
  slot: Int,
  cap: Int,
  lovelace_cap: Int,
) -> AccountState {
  AccountState {
    ..state,
    grants: list.map(
      state.grants,
      fn(grant) {
        if grant.slot == slot {
          Grant { ..grant, scope: Scope { ..grant.scope, cap, lovelace_cap } }
        } else {
          grant
        }
      },
    ),
  }
}

fn other_control_output(state: AccountState, lovelace: Int) -> Output {
  output(
    other_account_address(),
    control_value(other_stake_script_hash, lovelace),
    state_datum(state),
  )
}

fn other_fund_output(value: Assets) -> Output {
  output(other_account_address(), value, NoDatum)
}

fn payout(lovelace: Int) -> Output {
  output(recipient_address(), assets.from_lovelace(lovelace), NoDatum)
}

fn change(lovelace: Int) -> Output {
  fund_output(assets.from_lovelace(lovelace))
}

fn burn() -> Assets {
  assets.from_asset(script_hash, stake_script_hash, -1)
}

fn state_data(state: Option<AccountState>) -> Option<Data> {
  when state is {
    Some(state) -> {
      let data: Data = state
      Some(data)
    }
    None -> None
  }
}

fn transaction(
  inputs: List<Input>,
  outputs: List<Output>,
  minted: Assets,
  signatories: List<ByteArray>,
  validity_range: Interval,
) -> Transaction {
  test_helpers.transaction(inputs, outputs, minted, signatories, validity_range)
}

fn spend(
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

fn mint(redeemer: types.MintRedeemer, tx: Transaction) -> Bool {
  account.account.mint(redeemer, script_hash, tx)
}

/// A transaction creating the account under test with the given outputs,
/// its registration published through the stake script.
fn creation(outputs: List<Output>, signatories: List<ByteArray>) -> Transaction {
  transaction(
    [],
    outputs,
    state_nft(stake_script_hash),
    signatories,
    interval.everything,
  )
    |> publishing(registration(stake_script_hash))
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

/// A transaction in which the Ed25519 grantee of slot 0 spends lovelace
/// from the account's deposit of 10 ADA, with the given outputs.
fn lovelace_grant_transaction(
  state: AccountState,
  outputs: List<Output>,
) -> Transaction {
  transaction(
    [
      input(0, control_output(state, 2_000_000)),
      input(1, fund_output(assets.from_lovelace(10_000_000))),
    ],
    outputs,
    assets.zero,
    [stranger_key],
    interval.before(expiry - 1),
  )
}

/// The outputs of a lovelace grant spend that pays `lovelace` away from
/// the account and records it against slot 0.
fn lovelace_grant_outputs(state: AccountState, lovelace: Int) -> List<Output> {
  [
    control_output(with_caps(state, 0, 5_000_000 - lovelace, 0), 2_000_000),
    change(10_000_000 - lovelace),
    payout(lovelace),
  ]
}

fn spend_lovelace_grant(state: AccountState, outputs: List<Output>) -> Bool {
  spend(
    Some(state),
    SpendWithGrant { slot: 0 },
    0,
    lovelace_grant_transaction(state, outputs),
  )
}

fn treasury_input() -> Input {
  input(
    1,
    fund_output(assets.merge(assets.from_lovelace(10_000_000), token(20))),
  )
}

/// Two accounts grant the same agent, each restricted to the same
/// recipient. One 2 ADA output to that recipient is offered as the payout
/// of both grants and the other 2 ADA go to the attacker. Each handler
/// computes its own net outflow and sees the attacker's output, so both
/// refuse; without the stray output the surplus could only become fee.
test attack_double_satisfaction_one_recipient_output_for_two_accounts() {
  let other = AccountState { ..restricted_state(), devices: [other_device_key] }
  let tx = transaction(
    [
      input(0, control_output(restricted_state(), 2_000_000)),
      input(1, fund_output(assets.from_lovelace(10_000_000))),
      input(2, other_control_output(other, 2_000_000)),
      input(3, other_fund_output(assets.from_lovelace(10_000_000))),
    ],
    [
      control_output(with_caps(restricted_state(), 0, 3_000_000, 0), 2_000_000),
      change(8_000_000),
      other_control_output(with_caps(other, 0, 3_000_000, 0), 2_000_000),
      other_fund_output(assets.from_lovelace(8_000_000)),
      payout(2_000_000),
      output(attacker_address(), assets.from_lovelace(2_000_000), NoDatum),
    ],
    assets.zero,
    [stranger_key],
    interval.before(expiry - 1),
  )
  let redeemer = SpendWithGrant { slot: 0 }
  and {
    !spend(Some(restricted_state()), redeemer, 0, tx),
    !spend(Some(other), redeemer, 2, tx),
  }
}

/// A deposit of another account is spent as if this account's control
/// UTxO authorised it. `Fund` looks for a control UTxO of the deposit's
/// own stake credential, which the transaction does not spend.
test attack_double_satisfaction_fund_of_another_account_rides_on_this_control() {
  let tx = transaction(
    [
      input(0, control_output(state(), 2_000_000)),
      input(3, other_fund_output(assets.from_lovelace(10_000_000))),
    ],
    [control_output(state(), 2_000_000), payout(10_000_000)],
    assets.zero,
    [device_key],
    interval.everything,
  )
  !spend(None, Fund, 3, tx)
}

/// A deposit at the account address carries an inline state naming the
/// attacker as its only device, and is spent on the owner path. It does
/// not hold the state NFT, so it is not the control UTxO.
test attack_missing_utxo_authentication_forged_control_without_the_nft_device() {
  let forged = AccountState { ..state(), devices: [attacker_key] }
  let tx = transaction(
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
  !spend(Some(forged), Device, 1, tx)
}

/// The same forged deposit grants the attacker a huge cap and is spent on
/// the agent path. The real state NFT is not among the inputs, so no
/// output can carry it and the handler aborts looking for the control
/// output.
test attack_missing_utxo_authentication_forged_control_without_the_nft_grant() fail {
  let forged = AccountState {
    ..state(),
    grants: [
      Grant {
        slot: 0,
        grantee: attacker_key,
        scope: Scope { ..lovelace_scope(), per_call_cap: 10_000_000 },
      },
    ],
  }
  let tx = transaction(
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
    interval.before(expiry - 1),
  )
  spend(Some(forged), SpendWithGrant { slot: 0 }, 1, tx)
}

/// The control UTxO is only referenced, not spent, so no handler ever
/// runs on it. `Fund` only accepts a control UTxO among the inputs.
test attack_missing_utxo_authentication_fund_with_the_control_as_a_reference_input() {
  let tx = Transaction {
    ..transaction(
      [input(1, fund_output(assets.from_lovelace(10_000_000)))],
      [output(attacker_address(), assets.from_lovelace(10_000_000), NoDatum)],
      assets.zero,
      [attacker_key],
      interval.everything,
    ),
    reference_inputs: [input(0, control_output(state(), 2_000_000))],
  }
  !spend(None, Fund, 1, tx)
}

/// A token of another policy named after the stake credential sits at the
/// account address and poses as the control UTxO. The state NFT is
/// identified by the account script's own policy id.
test attack_missing_utxo_authentication_lookalike_nft_from_another_policy() {
  let lookalike = assets.merge(
    assets.from_lovelace(2_000_000),
    assets.from_asset(token_asset().policy_id, stake_script_hash, 1),
  )
  let tx = transaction(
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
  !spend(None, Fund, 1, tx)
}

/// The mint handler is asked to burn a state NFT whose only input sits at
/// a key address. The validator's invariant keeps the NFT away from such
/// an address in the first place, and the mint handler refuses every burn
/// regardless.
test attack_missing_utxo_authentication_burn_with_the_nft_at_a_key_address() {
  let tx = transaction(
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
  !mint(CreateAccount, tx)
}

/// The grantee recreates the control UTxO with an extra grant for
/// itself. The recreated state must equal the spent one with only the
/// used grant's caps reduced.
test attack_datum_hijacking_grant_spend_issues_itself_a_grant() {
  let self_issued = Grant {
    slot: 5,
    grantee: stranger_key,
    scope: Scope {
      ..lovelace_scope(),
      per_call_cap: 100_000_000,
      cap: 100_000_000,
    },
  }
  let after = with_caps(granted_state(), 0, 3_000_000, 0)
  !spend_lovelace_grant(
    granted_state(),
    [
      control_output(
        AccountState {
          ..after,
          grants: list.concat(after.grants, [self_issued]),
        },
        2_000_000,
      ),
      change(8_000_000),
      payout(2_000_000),
    ],
  )
}

/// The grantee recreates the control UTxO with its own cap raised.
test attack_datum_hijacking_grant_spend_raises_its_own_cap() {
  !spend_lovelace_grant(
    granted_state(),
    [
      control_output(with_caps(granted_state(), 0, 50_000_000, 0), 2_000_000),
      change(8_000_000),
      payout(2_000_000),
    ],
  )
}

/// The grantee sends the state NFT and the state to another account's
/// address. There is then no control output at this account's address, so
/// the handler aborts, and the NFT placement rule would refuse it as well.
test attack_datum_hijacking_grant_spend_relocates_the_state_to_another_account_address() fail {
  let relocated = output(
    other_account_address(),
    control_value(stake_script_hash, 2_000_000),
    state_datum(with_caps(granted_state(), 0, 3_000_000, 0)),
  )
  spend_lovelace_grant(
    granted_state(),
    [relocated, change(8_000_000), payout(2_000_000)],
  )
}

/// The grantee recreates the control UTxO with the state given by hash
/// instead of inline. The expected state is compared as an inline datum.
test attack_datum_hijacking_grant_spend_control_datum_given_by_hash() {
  let hashed = output(
    account_address(),
    control_value(stake_script_hash, 2_000_000),
    DatumHash(attacker_key),
  )
  !spend_lovelace_grant(
    granted_state(),
    [hashed, change(8_000_000), payout(2_000_000)],
  )
}

/// The owner path is given a control output whose datum is a well formed
/// state followed by an extra constructor field. Decoding it as an
/// `AccountState` aborts, so a padded datum can never be stored.
test attack_datum_hijacking_padded_state_datum_on_a_device_rewrite() fail {
  let devices: Data = state().devices
  let grants: Data = state().grants
  let grant_generation: Data = 0
  let extra_field: Data = 7
  let padded: Data = builtin.constr_data(
    0,
    [devices, grants, grant_generation, extra_field],
  )
  let tx = transaction(
    [input(0, control_output(state(), 2_000_000))],
    [
      output(
        account_address(),
        control_value(stake_script_hash, 2_000_000),
        InlineDatum(padded),
      ),
    ],
    assets.zero,
    [device_key],
    interval.everything,
  )
  spend(Some(state()), Device, 0, tx)
}

/// An account at the victim's address, under the attacker's device, is
/// created with only the attacker's signature. The mint handler accepts
/// the registration it sees, since checking it is the stake script's job,
/// and the stake script refuses to publish a registration the owner did
/// not sign.
test attack_token_forgery_victims_address_with_the_attackers_signature() {
  let tx = creation(
    [control_output(AccountState { ..state(), devices: [attacker_key] }, 2)],
    [attacker_key],
  )
  mint(CreateAccount, tx) && !register(tx)
}

/// A state NFT named after the attacker's own stake credential is minted
/// into an output at the victim's account address. The control output
/// must sit at the account address of the name, so none is found and the
/// handler aborts.
test attack_token_forgery_attackers_name_into_the_victims_address() fail {
  let misplaced = output(
    account_address(),
    control_value(other_stake_script_hash, 2_000_000),
    state_datum(AccountState { ..state(), devices: [attacker_key] }),
  )
  let tx = transaction(
    [],
    [misplaced],
    state_nft(other_stake_script_hash),
    [attacker_key],
    interval.everything,
  )
    |> publishing(registration(other_stake_script_hash))
  mint(CreateAccount, tx)
}

/// A second state NFT of the account is minted in the middle of a grant
/// spend and the only control output carries the grantee's own state. The
/// mint handler demands a registration of the stake credential, which the
/// transaction does not carry and which the ledger would refuse for a
/// credential already registered, and the spend handler finds the state
/// changed beyond the used grant's caps.
test attack_token_forgery_second_nft_minted_during_a_grant_spend() {
  let hijacked = AccountState { ..granted_state(), devices: [stranger_key] }
  let tx = Transaction {
    ..lovelace_grant_transaction(
      granted_state(),
      [
        control_output(hijacked, 2_000_000),
        change(8_000_000),
        payout(2_000_000),
      ],
    ),
    mint: state_nft(stake_script_hash),
  }
  and {
    !mint(CreateAccount, tx),
    !spend(Some(granted_state()), SpendWithGrant { slot: 0 }, 0, tx),
  }
}

/// The control output is minted at an address whose stake part is a
/// verification key credential carrying the stake script hash's bytes.
/// The account address pairs the script with a script stake credential
/// only.
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
    [device_key],
  )
  mint(CreateAccount, tx)
}

/// The owner parks a token of another policy named after the stake
/// credential on the control output. The control output may hold nothing
/// but lovelace and the state NFT, whichever the token's name.
test attack_token_forgery_lookalike_token_named_after_the_stake_credential_on_the_control() {
  let parked = output(
    account_address(),
    assets.merge(
      control_value(stake_script_hash, 2_000_000),
      assets.from_asset(token_asset().policy_id, stake_script_hash, 1),
    ),
    state_datum(state()),
  )
  let tx = transaction(
    [input(0, control_output(state(), 2_000_000))],
    [parked],
    assets.zero,
    [device_key],
    interval.everything,
  )
  !spend(Some(state()), Device, 0, tx)
}

/// The owner key, or anyone, mints a second control UTxO for an existing
/// account under devices of their choosing. The ledger registers a stake
/// credential once, so the transaction cannot carry a registration of the
/// account's credential while the account exists, and without one the
/// mint handler refuses the second creation.
test attack_token_forgery_parallel_control_utxo_without_a_registration() {
  let parallel = AccountState { ..state(), devices: [attacker_key] }
  let tx = transaction(
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
  !mint(CreateAccount, tx)
}

/// The same, with the registration listed among the certificates in the
/// legacy format that needs no witness, so the stake script never runs
/// on it. The mint handler looks for the stake script's redeemer, not for
/// the certificate.
test attack_token_forgery_parallel_control_utxo_with_an_unwitnessed_registration() {
  let parallel = AccountState { ..state(), devices: [attacker_key] }
  let tx = Transaction {
    ..creation([control_output(parallel, 2_000_000)], [attacker_key]),
    redeemers: [],
  }
  !mint(CreateAccount, tx)
}

/// The grantee of slot 0 withdraws the account's rewards with its own
/// signature, referencing the control UTxO. Rewards and delegation answer
/// to the devices only.
test attack_other_redeemer_withdraw_rewards_with_a_grantee_signature() {
  let tx = Transaction {
    ..transaction(
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
    reference_inputs: [input(0, control_output(granted_state(), 2_000_000))],
    withdrawals: [Pair(Script(stake_script_hash), 1_000_000)],
  }
  !withdraw(tx)
}

/// The control UTxO is spent with `Fund`, the redeemer that carries no
/// authorisation of its own.
test attack_other_redeemer_fund_on_the_control_utxo() {
  let tx = transaction(
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
  !spend(Some(state()), Fund, 0, tx)
}

/// A plain deposit is spent with `Device`, which must decode a state
/// datum the deposit does not carry.
test attack_other_redeemer_device_on_a_plain_deposit() fail {
  let tx = transaction(
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
  spend(None, Device, 1, tx)
}

/// A deposit carrying a forged state that grants the attacker is spent
/// with `SpendWithGrant`, beside the real control UTxO so that a control
/// output exists. The deposit does not hold the state NFT.
test attack_other_redeemer_grant_on_a_deposit_with_a_forged_state() {
  let forged = AccountState {
    ..state(),
    grants: [
      Grant {
        slot: 0,
        grantee: attacker_key,
        scope: Scope { ..lovelace_scope(), per_call_cap: 10_000_000 },
      },
    ],
  }
  let tx = transaction(
    [
      input(0, control_output(state(), 2_000_000)),
      input(
        1,
        output(
          account_address(),
          assets.from_lovelace(10_000_000),
          state_datum(forged),
        ),
      ),
    ],
    [
      control_output(state(), 2_000_000),
      output(attacker_address(), assets.from_lovelace(10_000_000), NoDatum),
    ],
    assets.zero,
    [attacker_key],
    interval.before(expiry - 1),
  )
  !spend(Some(forged), SpendWithGrant { slot: 0 }, 1, tx)
}

fn burn_with_the_control_spent_by_grant_transaction() -> Transaction {
  transaction(
    [input(0, control_output(granted_state(), 2_000_000))],
    [payout(2_000_000)],
    burn(),
    [stranger_key],
    interval.before(expiry - 1),
  )
}

/// The grantee tries to retire the account by burning its state NFT: the
/// mint handler refuses every burn, since no redeemer retires an account.
test attack_other_redeemer_burn_with_the_control_spent_by_grant() {
  !mint(CreateAccount, burn_with_the_control_spent_by_grant_transaction())
}

/// The control UTxO's own handler, on the agent path, aborts for lack of
/// a control output; even with one, the remaining cap and carries_state
/// checks would refuse it too, so the missing output is not the only
/// refusal.
test attack_other_redeemer_grant_spend_with_the_state_nft_burned() fail {
  spend(
    Some(granted_state()),
    SpendWithGrant { slot: 0 },
    0,
    burn_with_the_control_spent_by_grant_transaction(),
  )
}

/// `CreateAccount` is used on a burn with everything a creation needs
/// beside it: the control UTxO spent, a device signing and the
/// registration published. The only mint redeemer accepts nothing but a
/// mint of one.
test attack_other_redeemer_create_account_on_a_burn() {
  let burning = transaction(
    [input(0, control_output(state(), 2_000_000))],
    [payout(2_000_000)],
    burn(),
    [device_key],
    interval.everything,
  )
    |> publishing(registration(stake_script_hash))
  !mint(CreateAccount, burning)
}

/// The grantee pays exactly the per call cap to the recipient and lets
/// the account pay the fee on top. The fee is part of what leaves the
/// account, so the outflow exceeds the cap.
test attack_missed_input_validation_fee_paid_by_the_account_beyond_the_cap() {
  let tx = Transaction {
    ..lovelace_grant_transaction(
      granted_state(),
      [
        control_output(with_caps(granted_state(), 0, 1_000_000, 0), 2_000_000),
        change(6_000_000),
        payout(3_000_000),
      ],
    ),
    fee: 1_000_000,
  }
  !spend(Some(granted_state()), SpendWithGrant { slot: 0 }, 0, tx)
}

/// The grantee pays the per call cap from the deposit and also drains
/// lovelace from the control UTxO itself.
test attack_missed_input_validation_control_lovelace_drained_beyond_the_cap() {
  !spend_lovelace_grant(
    granted_state(),
    [
      control_output(with_caps(granted_state(), 0, 1_000_000, 0), 1_000_000),
      change(7_000_000),
      payout(4_000_000),
    ],
  )
}

/// A grant scoped to one asset name is used to move another asset name
/// under the same policy.
test attack_missed_input_validation_token_grant_leaks_a_sibling_asset_name() {
  let sibling = assets.from_asset(token_asset().policy_id, "other", 5)
  let with_sibling = AccountState {
    ..granted_state(),
    grants: [Grant { slot: 2, grantee: stranger_key, scope: token_scope() }],
  }
  let tx = transaction(
    [
      input(0, control_output(with_sibling, 2_000_000)),
      input(
        1,
        fund_output(assets.merge(assets.from_lovelace(10_000_000), sibling)),
      ),
    ],
    [
      control_output(with_caps(with_sibling, 2, 50, 0), 2_000_000),
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
  !spend(Some(with_sibling), SpendWithGrant { slot: 2 }, 0, tx)
}

/// A token grant allows 2 ADA of lovelace over its lifetime but only 1 ADA
/// per call. The grantee moves 10 tokens with the whole 2 ADA in one
/// transaction, within the remaining lovelace cap but above the lovelace
/// per call cap.
test attack_missed_input_validation_token_grant_burns_its_lovelace_budget_in_one_call() {
  let metered = AccountState {
    ..granted_state(),
    grants: [
      Grant {
        slot: 2,
        grantee: stranger_key,
        scope: Scope { ..token_scope(), lovelace_per_call_cap: 1_000_000 },
      },
    ],
  }
  let tx = transaction(
    [input(0, control_output(metered, 2_000_000)), treasury_input()],
    [
      control_output(with_caps(metered, 2, 40, 0), 2_000_000),
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
  !spend(Some(metered), SpendWithGrant { slot: 2 }, 0, tx)
}

/// The grantee pays part of a spend within the per call cap to the bare
/// script address, without the stake part. That address is not the
/// account, so the lovelace counts as leaving and the destination must be
/// a listed recipient.
test attack_missed_input_validation_change_to_the_bare_script_address() {
  let tx = lovelace_grant_transaction(
    restricted_state(),
    [
      control_output(with_caps(restricted_state(), 0, 3_000_000, 0), 2_000_000),
      change(8_000_000),
      output(
        address.from_script(script_hash),
        assets.from_lovelace(1_000_000),
        NoDatum,
      ),
      payout(1_000_000),
    ],
  )
  !spend(Some(restricted_state()), SpendWithGrant { slot: 0 }, 0, tx)
}

/// The owner path is asked to store a grant with a negative cap, a grant
/// with no expiry, a lovelace grant with a separate lovelace cap or
/// lovelace per call cap, and two grants in one slot. Every one of them
/// fails well formedness.
test attack_missed_input_validation_ill_formed_grants_on_a_device_rewrite() {
  let grant = Grant { slot: 0, grantee: stranger_key, scope: lovelace_scope() }
  let rewrites = [
    [Grant { ..grant, scope: Scope { ..lovelace_scope(), cap: -1 } }],
    [Grant { ..grant, scope: Scope { ..lovelace_scope(), expires_at: 0 } }],
    [Grant { ..grant, scope: Scope { ..lovelace_scope(), lovelace_cap: 1 } }],
    [
      Grant {
        ..grant,
        scope: Scope { ..lovelace_scope(), lovelace_per_call_cap: 1 },
      },
    ],
    [grant, Grant { ..grant, scope: token_scope() }],
  ]
  list.all(
    rewrites,
    fn(grants) {
      let tx = transaction(
        [input(0, control_output(state(), 2_000_000))],
        [control_output(AccountState { ..state(), grants }, 2_000_000)],
        assets.zero,
        [device_key],
        interval.everything,
      )
      !spend(Some(state()), Device, 0, tx)
    },
  )
}

/// The validity range has no upper bound at all, so the transaction could
/// be applied after the grant expired.
test attack_time_handling_no_upper_bound() {
  let tx = Transaction {
    ..lovelace_grant_transaction(
      granted_state(),
      lovelace_grant_outputs(granted_state(), 2_000_000),
    ),
    validity_range: interval.everything,
  }
  !spend(Some(granted_state()), SpendWithGrant { slot: 0 }, 0, tx)
}

/// The lower bound lies past the expiry and the upper bound is open: an
/// upper bound is required whatever the lower bound says.
test attack_time_handling_lower_bound_past_expiry_with_no_upper_bound() {
  let tx = Transaction {
    ..lovelace_grant_transaction(
      granted_state(),
      lovelace_grant_outputs(granted_state(), 2_000_000),
    ),
    validity_range: interval.after(expiry + 1),
  }
  !spend(Some(granted_state()), SpendWithGrant { slot: 0 }, 0, tx)
}

/// An exclusive upper bound one past the expiry covers the same instants
/// as an inclusive bound at the expiry, but the bound's value itself is
/// compared, so it is refused.
test attack_time_handling_exclusive_upper_bound_one_past_expiry() {
  let tx = Transaction {
    ..lovelace_grant_transaction(
      granted_state(),
      lovelace_grant_outputs(granted_state(), 2_000_000),
    ),
    validity_range: interval.entirely_before(expiry + 1),
  }
  !spend(Some(granted_state()), SpendWithGrant { slot: 0 }, 0, tx)
}

/// A degenerate range whose upper bound is negative infinity is not a
/// finite bound and is refused like an open one.
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
    ..lovelace_grant_transaction(
      granted_state(),
      lovelace_grant_outputs(granted_state(), 2_000_000),
    ),
    validity_range: degenerate,
  }
  !spend(Some(granted_state()), SpendWithGrant { slot: 0 }, 0, tx)
}

fn key(n: Int) -> ByteArray {
  bytearray.push(#"000000000000000000000000000000000000000000000000000000", n)
}

fn keys(count: Int) -> List<ByteArray> {
  list.range(1, count) |> list.map(key)
}

fn recipients(count: Int) -> List<Address> {
  list.range(1, count)
    |> list.map(fn(n) { address.from_verification_key(key(100 + n)) })
}

fn grants(count: Int, scope: Scope) -> List<Grant> {
  list.range(0, count - 1)
    |> list.map(fn(slot) { Grant { slot, grantee: key(50 + slot), scope } })
}

fn rewrite_as(next: AccountState) -> Bool {
  let tx = transaction(
    [input(0, control_output(state(), 2_000_000))],
    [control_output(next, 2_000_000)],
    assets.zero,
    [device_key],
    interval.everything,
  )
  spend(Some(state()), Device, 0, tx)
}

test attack_unbounded_datum_seventeen_grants_on_a_device_rewrite() {
  !rewrite_as(AccountState { ..state(), grants: grants(17, lovelace_scope()) })
}

test attack_unbounded_datum_nine_devices_on_a_device_rewrite() {
  !rewrite_as(AccountState { ..state(), devices: keys(9) })
}

test attack_unbounded_datum_nine_recipients_on_a_device_rewrite() {
  let scope = Scope { ..lovelace_scope(), recipients: recipients(9) }
  !rewrite_as(AccountState { ..state(), grants: grants(1, scope) })
}

test attack_unbounded_datum_seventeen_grants_at_creation() {
  let tx = creation(
    [
      control_output(
        AccountState { ..state(), grants: grants(17, lovelace_scope()) },
        2_000_000,
      ),
    ],
    [device_key],
  )
  !mint(CreateAccount, tx)
}

/// A bundle of tokens under many policies is parked on the control output
/// at creation.
test attack_unbounded_value_token_bundle_on_the_control_at_creation() {
  let bundle = list.foldl(
    keys(20),
    control_value(stake_script_hash, 2_000_000),
    fn(policy, value) { assets.add(value, policy, "dust", 1) },
  )
  let tx = creation(
    [output(account_address(), bundle, state_datum(state()))],
    [device_key],
  )
  !mint(CreateAccount, tx)
}

/// Twenty deposits are spent at once with `Fund`, none of them alongside
/// the control UTxO.
test attack_unbounded_inputs_deposits_spent_without_a_control() {
  let deposits = list.range(1, 20)
    |> list.map(
        fn(n) { input(n, fund_output(assets.from_lovelace(1_000_000))) },
      )
  let tx = transaction(
    deposits,
    [output(attacker_address(), assets.from_lovelace(20_000_000), NoDatum)],
    assets.zero,
    [attacker_key],
    interval.everything,
  )
  !spend(None, Fund, 7, tx)
}

/// The grantee pays the whole balance back to the account address under a
/// datum hash. Nothing counts as leaving, but a script output under a
/// datum hash can only be spent by whoever knows the preimage. Deposits a
/// grant spend makes must carry no datum.
test attack_locked_value_grant_spend_deposits_under_a_datum_hash() {
  !spend_lovelace_grant(
    granted_state(),
    [
      control_output(granted_state(), 2_000_000),
      output(
        account_address(),
        assets.from_lovelace(10_000_000),
        DatumHash(attacker_key),
      ),
    ],
  )
}

/// The same, under an inline datum, which the owner could still spend but
/// which no deposit has a use for.
test attack_locked_value_grant_spend_deposits_under_an_inline_datum() {
  let marker: Data = 1
  !spend_lovelace_grant(
    granted_state(),
    [
      control_output(granted_state(), 2_000_000),
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
test attack_locked_value_grant_spend_sends_the_balance_to_the_bare_script_address() {
  let tx = lovelace_grant_transaction(
    restricted_state(),
    [
      control_output(restricted_state(), 2_000_000),
      output(
        address.from_script(script_hash),
        assets.from_lovelace(10_000_000),
        NoDatum,
      ),
    ],
  )
  !spend(Some(restricted_state()), SpendWithGrant { slot: 0 }, 0, tx)
}

test attack_locked_value_device_rewrite_removes_every_device() {
  !rewrite_as(AccountState { ..state(), devices: [] })
}

test attack_locked_value_account_created_without_devices() {
  let tx = creation(
    [control_output(AccountState { ..state(), devices: [] }, 2_000_000)],
    [device_key],
  )
  !mint(CreateAccount, tx)
}

/// `Fund` passes on its own as soon as the control UTxO is among the
/// inputs; it is the control UTxO's own handler that refuses the
/// transaction for lack of a device signature. The ledger runs every
/// handler and accepts the transaction only if all pass, so the order in
/// which they run does not matter.
test attack_evaluation_order_fund_passes_only_together_with_the_control_spend() {
  let tx = transaction(
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
  spend(None, Fund, 1, tx) && !spend(Some(state()), Device, 0, tx)
}

/// An Ed25519 key granted by one account signs a spend from another
/// account's control UTxO under the same slot number. The grant is read
/// from the spent state, where that slot names a different grantee.
test attack_signature_replay_ed25519_grantee_of_another_account() {
  let other = AccountState {
    ..state(),
    devices: [other_device_key],
    grants: [Grant { slot: 0, grantee: attacker_key, scope: lovelace_scope() }],
  }
  let tx = transaction(
    [
      input(0, other_control_output(other, 2_000_000)),
      input(1, other_fund_output(assets.from_lovelace(10_000_000))),
    ],
    [
      other_control_output(with_caps(other, 0, 3_000_000, 0), 2_000_000),
      other_fund_output(assets.from_lovelace(8_000_000)),
      payout(2_000_000),
    ],
    assets.zero,
    [stranger_key],
    interval.before(expiry - 1),
  )
  !spend(Some(other), SpendWithGrant { slot: 0 }, 0, tx)
}

fn dust() -> Assets {
  list.foldl(
    keys(3),
    assets.zero,
    fn(policy, value) { assets.add(value, policy, "dust", 1) },
  )
}

fn dusted_deposit() -> Input {
  input(1, fund_output(assets.merge(assets.from_lovelace(10_000_000), dust())))
}

/// An attacker dusts the account with tokens under three policies. A
/// grant spend over the dusted deposit returns all but one unit of dust.
/// Nothing but the scoped asset and lovelace may leave.
test attack_dust_attack_grant_spend_keeps_one_unit_of_dust() {
  let returned = assets.merge(dust(), assets.from_asset(key(1), "dust", -1))
  let tx = transaction(
    [input(0, control_output(granted_state(), 2_000_000)), dusted_deposit()],
    [
      control_output(with_caps(granted_state(), 0, 3_000_000, 0), 2_000_000),
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
  !spend(Some(granted_state()), SpendWithGrant { slot: 0 }, 0, tx)
}

/// The grant spend pushes the dust onto the control output instead.
test attack_dust_attack_dust_pushed_onto_the_control_output() {
  let tx = transaction(
    [input(0, control_output(granted_state(), 2_000_000)), dusted_deposit()],
    [
      output(
        account_address(),
        assets.merge(control_value(stake_script_hash, 2_000_000), dust()),
        state_datum(with_caps(granted_state(), 0, 3_000_000, 0)),
      ),
      change(8_000_000),
      payout(2_000_000),
    ],
    assets.zero,
    [stranger_key],
    interval.before(expiry - 1),
  )
  !spend(Some(granted_state()), SpendWithGrant { slot: 0 }, 0, tx)
}

/// The grantee recreates the control UTxO with a reference script
/// attached. Every later spend of the control UTxO would pay for that
/// script's size, so the control output may carry no reference script.
test attack_resource_exhaustion_reference_script_on_the_control_output() {
  let weighted = Output {
    ..control_output(with_caps(granted_state(), 0, 3_000_000, 0), 2_000_000),
    reference_script: Some(script_hash),
  }
  !spend_lovelace_grant(
    granted_state(),
    [weighted, change(8_000_000), payout(2_000_000)],
  )
}

/// The largest state the validator admits: eight devices and sixteen
/// grants, each with eight recipients. The last two slots are granted to
/// the test grantee, one over a token scope and one over a lovelace scope,
/// so both kinds of agent spend can be exercised over it.
fn largest_state() -> AccountState {
  let scope = Scope {
    ..lovelace_scope(),
    recipients: list.concat(recipients(7), [recipient_address()]),
  }
  let filler = grants(14, scope)
  let token_grant = Grant {
    slot: 14,
    grantee: stranger_key,
    scope: Scope { ..token_scope(), recipients: scope.recipients },
  }
  let lovelace_grant = Grant { slot: 15, grantee: stranger_key, scope }
  AccountState {
    devices: keys(8),
    grants: list.concat(filler, [token_grant, lovelace_grant]),
    grant_generation: 1,
  }
}

fn deposits(count: Int) -> List<Input> {
  list.range(1, count)
    |> list.map(
        fn(n) { input(n, fund_output(assets.from_lovelace(10_000_000))) },
      )
}

fn largest_state_grant_transaction() -> Transaction {
  transaction(
    list.concat(
      [input(0, control_output(largest_state(), 2_000_000))],
      deposits(8),
    ),
    [
      control_output(with_caps(largest_state(), 15, 3_000_000, 0), 2_000_000),
      change(78_000_000),
      payout(2_000_000),
    ],
    assets.zero,
    [stranger_key],
    interval.before(expiry - 1),
  )
}

/// The three tests below build the fixtures without running any handler,
/// so that the cost of building them can be subtracted from the budget
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

test budget_baseline_largest_state_device_rewrite_transaction() {
  let tx = largest_state_device_rewrite_transaction()
  list.length(tx.inputs) == 1 && list.length(tx.outputs) == 1
}

test budget_baseline_largest_state_creation_transaction() {
  list.length(largest_state_creation_transaction().outputs) == 1
}

test budget_largest_state_datum_stays_within_the_transaction_size_limit() {
  let data: Data = largest_state()
  bytearray.length(cbor.serialise(data)) < 16_384
}

test budget_largest_state_grant_spend_lovelace_scope() {
  spend(
    Some(largest_state()),
    SpendWithGrant { slot: 15 },
    0,
    largest_state_grant_transaction(),
  )
}

test budget_largest_state_fund_spend_among_eight_deposits() {
  spend(None, Fund, 8, largest_state_grant_transaction())
}

fn largest_state_device_rewrite_transaction() -> Transaction {
  transaction(
    [input(0, control_output(largest_state(), 2_000_000))],
    [control_output(largest_state(), 2_000_000)],
    assets.zero,
    [key(8)],
    interval.everything,
  )
}

test budget_largest_state_device_rewrite() {
  spend(
    Some(largest_state()),
    Device,
    0,
    largest_state_device_rewrite_transaction(),
  )
}

fn largest_state_creation_transaction() -> Transaction {
  creation([control_output(largest_state(), 2_000_000)], [device_key])
}

test budget_largest_state_account_creation() {
  mint(CreateAccount, largest_state_creation_transaction())
}

fn largest_state_token_grant_transaction() -> Transaction {
  transaction(
    [input(0, control_output(largest_state(), 2_000_000)), treasury_input()],
    [
      control_output(with_caps(largest_state(), 14, 40, 0), 2_000_000),
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
}

test budget_largest_state_grant_spend_token_scope() {
  spend(
    Some(largest_state()),
    SpendWithGrant { slot: 14 },
    0,
    largest_state_token_grant_transaction(),
  )
}

fn forty_deposit_transaction() -> Transaction {
  transaction(
    list.concat(
      [input(0, control_output(granted_state(), 2_000_000))],
      deposits(40),
    ),
    [
      control_output(with_caps(granted_state(), 0, 3_000_000, 0), 2_000_000),
      change(398_000_000),
      payout(2_000_000),
    ],
    assets.zero,
    [stranger_key],
    interval.before(expiry - 1),
  )
}

test budget_grant_spend_over_forty_deposits() {
  spend(
    Some(granted_state()),
    SpendWithGrant { slot: 0 },
    0,
    forty_deposit_transaction(),
  )
}

test budget_fund_spend_among_forty_deposits() {
  spend(None, Fund, 40, forty_deposit_transaction())
}
