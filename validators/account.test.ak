use account
use aiken/collection/list
use aiken/interval.{Interval}
use cardano/address.{Address}
use cardano/assets.{Assets}
use cardano/transaction.{DatumHash, InlineDatum, Input, NoDatum, Output}
use cardano_account_custody_contract/grant
use cardano_account_custody_contract/test_helpers.{
  account_address, control_output, control_value, device_key, fund_output, input,
  other_account_address, other_device_key, other_stake_key_hash, output,
  output_reference, recipient_address, script_hash, stake_key_hash, state_datum,
  state_nft, stranger_key,
}
use cardano_account_custody_contract/types.{
  AccountState, Asset, CreateAccount, DeleteAccount, Device, Ed25519, Fund,
  Grant, Scope, Secp256k1, SpendWithGrant,
}

fn state() -> AccountState {
  AccountState { devices: [device_key], grants: [], grant_generation: 0 }
}

fn rewritten_state() -> AccountState {
  let scope = Scope {
    asset: Asset {
      policy_id: assets.ada_policy_id,
      asset_name: assets.ada_asset_name,
    },
    per_call_cap: 1_000_000,
    cap: 5_000_000,
    lovelace_cap: 0,
    expires_at: 1_800_000_000_000,
    recipients: [recipient_address()],
  }
  AccountState {
    devices: [device_key, other_device_key],
    grants: [Grant { slot: 0, grantee: Ed25519(stranger_key), scope }],
    grant_generation: 1,
  }
}

fn other_token() -> Assets {
  assets.from_asset(
    #"00000000000000000000000000000000000000000000000000000099",
    "other",
    1,
  )
}

fn control_input() -> Input {
  input(0, control_output(state(), 2_000_000))
}

fn fund_input() -> Input {
  input(1, fund_output(assets.from_lovelace(10_000_000)))
}

fn payout(lovelace: Int) -> Output {
  output(recipient_address(), assets.from_lovelace(lovelace), NoDatum)
}

fn burn() -> Assets {
  assets.from_asset(script_hash, stake_key_hash, -1)
}

fn mint(
  redeemer: types.MintRedeemer,
  inputs: List<Input>,
  outputs: List<Output>,
  minted: Assets,
  signatories: List<ByteArray>,
) -> Bool {
  let tx = test_helpers.transaction(
    inputs,
    outputs,
    minted,
    signatories,
    interval.everything,
  )
  account.account.mint(redeemer, script_hash, tx)
}

fn spend_with_datum(
  datum: Option<Data>,
  redeemer: types.AccountRedeemer,
  index: Int,
  inputs: List<Input>,
  outputs: List<Output>,
  minted: Assets,
  signatories: List<ByteArray>,
) -> Bool {
  let tx = test_helpers.transaction(
    inputs,
    outputs,
    minted,
    signatories,
    interval.everything,
  )
  account.account.spend(datum, redeemer, output_reference(index), tx)
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

fn spend(
  state: Option<AccountState>,
  redeemer: types.AccountRedeemer,
  index: Int,
  inputs: List<Input>,
  outputs: List<Output>,
  minted: Assets,
  signatories: List<ByteArray>,
) -> Bool {
  spend_with_datum(
    state_data(state),
    redeemer,
    index,
    inputs,
    outputs,
    minted,
    signatories,
  )
}

fn spend_within(
  validity_range: Interval,
  state: Option<AccountState>,
  redeemer: types.AccountRedeemer,
  index: Int,
  inputs: List<Input>,
  outputs: List<Output>,
  signatories: List<ByteArray>,
) -> Bool {
  let tx = test_helpers.transaction(
    inputs,
    outputs,
    assets.zero,
    signatories,
    validity_range,
  )
  account.account.spend(
    state_data(state),
    redeemer,
    output_reference(index),
    tx,
  )
}

test create_account_mints_the_state_nft_into_a_control_output() {
  mint(
    CreateAccount,
    [],
    [control_output(state(), 2_000_000)],
    state_nft(stake_key_hash),
    [stake_key_hash],
  )
}

test create_account_accepts_other_outputs_beside_the_control_output() {
  mint(
    CreateAccount,
    [],
    [payout(1), control_output(state(), 2_000_000), payout(2)],
    state_nft(stake_key_hash),
    [stake_key_hash, stranger_key],
  )
}

test create_account_rejects_a_missing_stake_key_signature() {
  !mint(
    CreateAccount,
    [],
    [control_output(state(), 2_000_000)],
    state_nft(stake_key_hash),
    [device_key],
  )
}

test create_account_rejects_a_quantity_of_two() {
  !mint(
    CreateAccount,
    [],
    [control_output(state(), 2_000_000)],
    assets.from_asset(script_hash, stake_key_hash, 2),
    [stake_key_hash],
  )
}

test create_account_rejects_two_asset_names_under_the_policy() fail {
  mint(
    CreateAccount,
    [],
    [control_output(state(), 2_000_000)],
    assets.merge(state_nft(stake_key_hash), state_nft(other_stake_key_hash)),
    [stake_key_hash, other_stake_key_hash],
  )
}

test create_account_rejects_a_burn_beside_the_mint() fail {
  mint(
    CreateAccount,
    [],
    [control_output(state(), 2_000_000)],
    assets.merge(
      state_nft(stake_key_hash),
      assets.from_asset(script_hash, other_stake_key_hash, -1),
    ),
    [stake_key_hash],
  )
}

test create_account_rejects_an_empty_mint_under_the_policy() fail {
  mint(
    CreateAccount,
    [],
    [control_output(state(), 2_000_000)],
    assets.zero,
    [stake_key_hash],
  )
}

test create_account_rejects_a_burn() {
  !mint(CreateAccount, [control_input()], [], burn(), [stake_key_hash])
}

test create_account_rejects_a_missing_control_output() fail {
  mint(
    CreateAccount,
    [],
    [payout(1)],
    state_nft(stake_key_hash),
    [stake_key_hash],
  )
}

test create_account_rejects_two_control_outputs() fail {
  mint(
    CreateAccount,
    [],
    [control_output(state(), 2_000_000), control_output(state(), 2_000_000)],
    state_nft(stake_key_hash),
    [stake_key_hash],
  )
}

test create_account_rejects_a_control_output_at_another_stake_credential() fail {
  let misplaced = output(
    other_account_address(),
    control_value(stake_key_hash, 2_000_000),
    state_datum(state()),
  )
  mint(
    CreateAccount,
    [],
    [misplaced],
    state_nft(stake_key_hash),
    [stake_key_hash],
  )
}

test create_account_rejects_a_control_output_without_a_stake_credential() fail {
  let misplaced = output(
    address.from_script(script_hash),
    control_value(stake_key_hash, 2_000_000),
    state_datum(state()),
  )
  mint(
    CreateAccount,
    [],
    [misplaced],
    state_nft(stake_key_hash),
    [stake_key_hash],
  )
}

test create_account_rejects_a_malformed_state_datum() fail {
  let data: Data = 42
  let malformed = output(
    account_address(),
    control_value(stake_key_hash, 2_000_000),
    InlineDatum(data),
  )
  mint(
    CreateAccount,
    [],
    [malformed],
    state_nft(stake_key_hash),
    [stake_key_hash],
  )
}

test create_account_rejects_a_state_datum_given_by_hash() fail {
  let hashed = output(
    account_address(),
    control_value(stake_key_hash, 2_000_000),
    DatumHash(stranger_key),
  )
  mint(CreateAccount, [], [hashed], state_nft(stake_key_hash), [stake_key_hash])
}

test create_account_rejects_an_ill_formed_state() {
  let no_devices = AccountState { ..state(), devices: [] }
  !mint(
    CreateAccount,
    [],
    [control_output(no_devices, 2_000_000)],
    state_nft(stake_key_hash),
    [stake_key_hash],
  )
}

test create_account_rejects_extra_tokens_on_the_control_output() {
  let parked = output(
    account_address(),
    assets.merge(control_value(stake_key_hash, 2_000_000), other_token()),
    state_datum(state()),
  )
  !mint(
    CreateAccount,
    [],
    [parked],
    state_nft(stake_key_hash),
    [stake_key_hash],
  )
}

test create_account_rejects_a_state_nft_sent_outside_the_account() {
  let stray = output(
    recipient_address(),
    control_value(stake_key_hash, 2_000_000),
    NoDatum,
  )
  !mint(
    CreateAccount,
    [],
    [control_output(state(), 2_000_000), stray],
    state_nft(stake_key_hash),
    [stake_key_hash],
  )
}

test create_account_rejects_a_state_nft_sent_to_another_accounts_address() {
  let exported = output(
    other_account_address(),
    control_value(stake_key_hash, 2_000_000),
    NoDatum,
  )
  !mint(
    CreateAccount,
    [],
    [control_output(state(), 2_000_000), exported],
    state_nft(stake_key_hash),
    [stake_key_hash],
  )
}

test delete_account_burns_the_state_nft_spent_from_the_control_utxo() {
  mint(
    DeleteAccount,
    [control_input()],
    [payout(2_000_000)],
    burn(),
    [device_key],
  )
}

test delete_account_rejects_a_burn_without_the_control_input() {
  !mint(
    DeleteAccount,
    [fund_input()],
    [payout(2_000_000)],
    burn(),
    [device_key],
  )
}

test delete_account_rejects_a_control_input_at_another_stake_credential() {
  let misplaced = input(
    0,
    output(
      other_account_address(),
      control_value(stake_key_hash, 2_000_000),
      state_datum(state()),
    ),
  )
  !mint(DeleteAccount, [misplaced], [payout(2_000_000)], burn(), [device_key])
}

test delete_account_rejects_a_burn_of_two() {
  !mint(
    DeleteAccount,
    [control_input()],
    [],
    assets.from_asset(script_hash, stake_key_hash, -2),
    [device_key],
  )
}

test delete_account_rejects_a_mint() {
  !mint(
    DeleteAccount,
    [control_input()],
    [control_output(state(), 2_000_000)],
    state_nft(stake_key_hash),
    [device_key],
  )
}

test delete_account_rejects_a_burn_beside_another_name() fail {
  mint(
    DeleteAccount,
    [control_input()],
    [],
    assets.merge(
      burn(),
      assets.from_asset(script_hash, other_stake_key_hash, -1),
    ),
    [device_key],
  )
}

test fund_spends_alongside_the_control_utxo() {
  spend(
    None,
    Fund,
    1,
    [control_input(), fund_input()],
    [control_output(state(), 2_000_000), payout(10_000_000)],
    assets.zero,
    [device_key],
  )
}

test fund_spends_a_deposit_carrying_a_foreign_inline_datum() {
  let foreign: Data = 42
  let deposit = input(
    1,
    output(
      account_address(),
      assets.from_lovelace(10_000_000),
      InlineDatum(foreign),
    ),
  )
  spend_with_datum(
    Some(foreign),
    Fund,
    1,
    [control_input(), deposit],
    [control_output(state(), 2_000_000), payout(10_000_000)],
    assets.zero,
    [device_key],
  )
}

test fund_rejects_a_spend_without_the_control_input() {
  !spend(
    None,
    Fund,
    1,
    [fund_input()],
    [payout(10_000_000)],
    assets.zero,
    [device_key],
  )
}

test fund_rejects_the_control_utxo_of_another_account() {
  let foreign = input(
    0,
    output(
      other_account_address(),
      control_value(other_stake_key_hash, 2_000_000),
      state_datum(state()),
    ),
  )
  !spend(
    None,
    Fund,
    1,
    [foreign, fund_input()],
    [payout(10_000_000)],
    assets.zero,
    [device_key],
  )
}

test fund_rejects_a_foreign_state_nft_at_the_account_address() {
  let foreign = input(
    0,
    output(
      account_address(),
      control_value(other_stake_key_hash, 2_000_000),
      state_datum(state()),
    ),
  )
  !spend(
    None,
    Fund,
    1,
    [foreign, fund_input()],
    [payout(10_000_000)],
    assets.zero,
    [device_key],
  )
}

test fund_rejects_the_control_utxo_itself() {
  !spend(
    Some(state()),
    Fund,
    0,
    [control_input(), fund_input()],
    [control_output(state(), 2_000_000), payout(10_000_000)],
    assets.zero,
    [device_key],
  )
}

test spend_rejects_an_input_without_a_stake_key() fail {
  let stray = input(
    1,
    output(address.from_script(script_hash), assets.from_lovelace(5), NoDatum),
  )
  spend(
    None,
    Fund,
    1,
    [control_input(), stray],
    [control_output(state(), 2_000_000)],
    assets.zero,
    [device_key],
  )
}

test device_spends_funds_and_keeps_the_state() {
  spend(
    Some(state()),
    Device,
    0,
    [control_input(), fund_input()],
    [control_output(state(), 2_000_000), payout(10_000_000)],
    assets.zero,
    [device_key],
  )
}

test device_rewrites_the_state() {
  spend(
    Some(state()),
    Device,
    0,
    [control_input()],
    [control_output(rewritten_state(), 2_000_000)],
    assets.zero,
    [device_key],
  )
}

test device_accepts_any_device_signature() {
  let two_devices = AccountState {
    ..state(),
    devices: [device_key, other_device_key],
  }
  spend(
    Some(two_devices),
    Device,
    0,
    [input(0, control_output(two_devices, 2_000_000))],
    [control_output(two_devices, 2_000_000)],
    assets.zero,
    [other_device_key],
  )
}

test device_rejects_a_missing_device_signature() {
  !spend(
    Some(state()),
    Device,
    0,
    [control_input()],
    [control_output(state(), 2_000_000)],
    assets.zero,
    [],
  )
}

test device_rejects_a_signature_from_a_key_that_is_not_a_device() {
  !spend(
    Some(state()),
    Device,
    0,
    [control_input()],
    [control_output(state(), 2_000_000)],
    assets.zero,
    [stranger_key, stake_key_hash],
  )
}

test device_rejects_an_ill_formed_new_state() {
  let no_devices = AccountState { ..state(), devices: [] }
  !spend(
    Some(state()),
    Device,
    0,
    [control_input()],
    [control_output(no_devices, 2_000_000)],
    assets.zero,
    [device_key],
  )
}

test device_rejects_a_malformed_state_datum() fail {
  let data: Data = 42
  let malformed = output(
    account_address(),
    control_value(stake_key_hash, 2_000_000),
    InlineDatum(data),
  )
  spend(
    Some(state()),
    Device,
    0,
    [control_input()],
    [malformed],
    assets.zero,
    [device_key],
  )
}

test device_rejects_extra_tokens_on_the_control_output() {
  let parked = output(
    account_address(),
    assets.merge(control_value(stake_key_hash, 2_000_000), other_token()),
    state_datum(state()),
  )
  !spend(
    Some(state()),
    Device,
    0,
    [control_input()],
    [parked],
    assets.zero,
    [device_key],
  )
}

test device_rejects_a_control_input_whose_datum_is_not_an_account_state() fail {
  let foreign: Data = 42
  spend_with_datum(
    Some(foreign),
    Device,
    0,
    [control_input()],
    [control_output(state(), 2_000_000)],
    assets.zero,
    [device_key],
  )
}

test device_rejects_a_state_nft_sent_outside_the_account() {
  let stray = output(
    recipient_address(),
    control_value(stake_key_hash, 2_000_000),
    NoDatum,
  )
  !spend(
    Some(state()),
    Device,
    0,
    [control_input()],
    [control_output(state(), 2_000_000), stray],
    assets.zero,
    [device_key],
  )
}

test device_accepts_another_accounts_control_output_beside_its_own() {
  let other = output(
    other_account_address(),
    control_value(other_stake_key_hash, 2_000_000),
    state_datum(state()),
  )
  spend(
    Some(state()),
    Device,
    0,
    [control_input()],
    [control_output(state(), 2_000_000), other],
    assets.zero,
    [device_key],
  )
}

test device_rejects_a_state_nft_sent_to_an_enterprise_script_address() {
  let stray = output(
    address.from_script(script_hash),
    control_value(other_stake_key_hash, 2_000_000),
    NoDatum,
  )
  !spend(
    Some(state()),
    Device,
    0,
    [control_input()],
    [control_output(state(), 2_000_000), stray],
    assets.zero,
    [device_key],
  )
}

test device_rejects_forging_another_accounts_control_output_from_a_stray_nft() {
  let other_state = AccountState { ..state(), devices: [stranger_key] }
  let other_control = output(
    other_account_address(),
    control_value(other_stake_key_hash, 2_000_000),
    state_datum(other_state),
  )
  let stray = input(
    1,
    output(
      other_account_address(),
      control_value(stake_key_hash, 2_000_000),
      NoDatum,
    ),
  )
  let forged = output(
    account_address(),
    control_value(stake_key_hash, 2_000_000),
    state_datum(other_state),
  )
  !spend(
    Some(other_state),
    Device,
    0,
    [input(0, other_control), stray],
    [other_control, forged],
    assets.zero,
    [stranger_key],
  )
}

test device_rejects_a_control_output_at_another_stake_credential() fail {
  let misplaced = output(
    other_account_address(),
    control_value(stake_key_hash, 2_000_000),
    state_datum(state()),
  )
  spend(
    Some(state()),
    Device,
    0,
    [control_input()],
    [misplaced],
    assets.zero,
    [device_key],
  )
}

test device_rejects_a_missing_control_output() fail {
  spend(
    Some(state()),
    Device,
    0,
    [control_input()],
    [payout(2_000_000)],
    assets.zero,
    [device_key],
  )
}

test device_rejects_two_control_outputs() fail {
  spend(
    Some(state()),
    Device,
    0,
    [control_input()],
    [control_output(state(), 1_000_000), control_output(state(), 1_000_000)],
    assets.zero,
    [device_key],
  )
}

test device_rejects_a_fund_input() fail {
  spend(
    None,
    Device,
    1,
    [control_input(), fund_input()],
    [control_output(state(), 2_000_000), payout(10_000_000)],
    assets.zero,
    [device_key],
  )
}

test device_rejects_an_input_without_the_state_nft() {
  !spend(
    Some(state()),
    Device,
    1,
    [control_input(), fund_input()],
    [control_output(state(), 2_000_000), payout(10_000_000)],
    assets.zero,
    [device_key],
  )
}

test device_deletes_the_account_when_the_state_nft_is_burned() {
  spend(
    Some(state()),
    Device,
    0,
    [control_input(), fund_input()],
    [payout(12_000_000)],
    burn(),
    [device_key],
  )
}

test device_rejects_a_delete_without_a_device_signature() {
  !spend(
    Some(state()),
    Device,
    0,
    [control_input()],
    [payout(2_000_000)],
    burn(),
    [stake_key_hash],
  )
}

test device_rejects_a_burn_of_two_without_a_control_output() fail {
  spend(
    Some(state()),
    Device,
    0,
    [control_input()],
    [payout(2_000_000)],
    assets.from_asset(script_hash, stake_key_hash, -2),
    [device_key],
  )
}

const expiry = 1_800_000_000_000

/// The 33 byte compressed secp256k1 public key of the test grantee. Its
/// private key is the 32 byte scalar 0x11 repeated, from which the public
/// key was derived with @noble/curves `secp256k1.getPublicKey(key, true)`.
const grantee_key =
  #"034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa"

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
    asset: Asset {
      policy_id: assets.ada_policy_id,
      asset_name: assets.ada_asset_name,
    },
    per_call_cap: 3_000_000,
    cap: 5_000_000,
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
    lovelace_cap: 2_000_000,
    expires_at: expiry,
    recipients: [recipient_address()],
  }
}

fn granted_state() -> AccountState {
  AccountState {
    devices: [device_key],
    grants: [
      Grant { slot: 0, grantee: Ed25519(stranger_key), scope: lovelace_scope() },
      Grant { slot: 1, grantee: Secp256k1(grantee_key), scope: token_scope() },
    ],
    grant_generation: 0,
  }
}

fn token_granted_state() -> AccountState {
  AccountState {
    ..granted_state(),
    grants: list.concat(
      granted_state().grants,
      [Grant { slot: 2, grantee: Ed25519(stranger_key), scope: token_scope() }],
    ),
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

fn granted_control_input() -> Input {
  input(0, control_output(granted_state(), 2_000_000))
}

fn treasury_input() -> Input {
  input(
    1,
    fund_output(assets.merge(assets.from_lovelace(10_000_000), token(20))),
  )
}

fn change(value: Assets) -> Output {
  fund_output(value)
}

fn spend_lovelace(
  validity_range: Interval,
  outputs: List<Output>,
  signatories: List<ByteArray>,
) -> Bool {
  spend_within(
    validity_range,
    Some(granted_state()),
    SpendWithGrant { slot: 0, signature: None },
    0,
    [granted_control_input(), fund_input()],
    outputs,
    signatories,
  )
}

fn lovelace_spend_outputs(lovelace: Int) -> List<Output> {
  [
    control_output(
      with_caps(granted_state(), 0, 5_000_000 - lovelace, 0),
      2_000_000,
    ),
    change(assets.from_lovelace(10_000_000 - lovelace)),
    payout(lovelace),
  ]
}

fn token_spend_outputs() -> List<Output> {
  [
    control_output(with_caps(granted_state(), 1, 40, 0), 2_000_000),
    change(assets.merge(assets.from_lovelace(8_000_000), token(10))),
    output(
      recipient_address(),
      assets.merge(assets.from_lovelace(2_000_000), token(10)),
      NoDatum,
    ),
  ]
}

fn token_spend_transaction(outputs: List<Output>) -> transaction.Transaction {
  test_helpers.transaction(
    [granted_control_input(), treasury_input()],
    outputs,
    assets.zero,
    [],
    interval.before(expiry),
  )
}

/// The 64 byte r||s secp256k1 ECDSA signature of `grantee_key` over the
/// grantee message of `token_spend_transaction(token_spend_outputs())`,
/// which is the blake2b-256 digest
/// 72c8e421c9df7618914257c72d2770c87dff708c74d44cf906e52cb15493a9f2.
/// Produced once with @noble/curves `secp256k1.sign(message, key)`, which
/// signs the given digest as is and yields a low s signature.
const token_spend_signature =
  #"8ed140d804d03766e38ecc5459647f19447616d17eced4c9c89e2a63949c4c652ddd60209604f585f38a5374a61400cbb9a1bc07889b97ef18970f5f3e83eb32"

fn spend_token(outputs: List<Output>, signature: Option<ByteArray>) -> Bool {
  account.account.spend(
    state_data(Some(granted_state())),
    SpendWithGrant { slot: 1, signature },
    output_reference(0),
    token_spend_transaction(outputs),
  )
}

fn spend_token_as_ed25519(outputs: List<Output>) -> Bool {
  spend_within(
    interval.before(expiry - 1),
    Some(token_granted_state()),
    SpendWithGrant { slot: 2, signature: None },
    0,
    [
      input(0, control_output(token_granted_state(), 2_000_000)),
      treasury_input(),
    ],
    outputs,
    [stranger_key],
  )
}

fn ed25519_token_spend_outputs(
  lovelace: Int,
  destination: Address,
) -> List<Output> {
  [
    control_output(
      with_caps(token_granted_state(), 2, 40, 2_000_000 - lovelace),
      2_000_000,
    ),
    change(assets.merge(assets.from_lovelace(10_000_000 - lovelace), token(10))),
    output(
      destination,
      assets.merge(assets.from_lovelace(lovelace), token(10)),
      NoDatum,
    ),
  ]
}

test grantee_message_of_the_fixture_transaction_matches_the_signed_digest() {
  grant.grantee_message(
    output_reference(0),
    token_spend_transaction(token_spend_outputs()),
  ) == #"72c8e421c9df7618914257c72d2770c87dff708c74d44cf906e52cb15493a9f2"
}

test spend_with_grant_ed25519_grantee_spends_within_scope() {
  spend_lovelace(
    interval.before(expiry - 1),
    lovelace_spend_outputs(2_000_000),
    [stranger_key],
  )
}

test spend_with_grant_secp256k1_grantee_spends_within_scope() {
  spend_token(token_spend_outputs(), Some(token_spend_signature))
}

test spend_with_grant_accepts_spending_exactly_the_per_call_cap() {
  spend_lovelace(
    interval.before(expiry - 1),
    lovelace_spend_outputs(3_000_000),
    [stranger_key],
  )
}

test spend_with_grant_rejects_one_lovelace_above_the_per_call_cap() {
  !spend_lovelace(
    interval.before(expiry - 1),
    lovelace_spend_outputs(3_000_001),
    [stranger_key],
  )
}

test spend_with_grant_rejects_spending_above_the_remaining_cap() {
  let nearly_spent = with_caps(granted_state(), 0, 1_000_000, 0)
  let after = with_caps(granted_state(), 0, -1_000_000, 0)
  !spend_within(
    interval.before(expiry - 1),
    Some(nearly_spent),
    SpendWithGrant { slot: 0, signature: None },
    0,
    [input(0, control_output(nearly_spent, 2_000_000)), fund_input()],
    [
      control_output(after, 2_000_000),
      change(assets.from_lovelace(8_000_000)),
      payout(2_000_000),
    ],
    [stranger_key],
  )
}

test spend_with_grant_ed25519_grantee_spends_a_token_scope() {
  spend_token_as_ed25519(
    ed25519_token_spend_outputs(2_000_000, recipient_address()),
  )
}

test spend_with_grant_rejects_lovelace_above_the_lovelace_cap_on_a_token_grant() {
  !spend_token_as_ed25519(
    ed25519_token_spend_outputs(2_000_001, recipient_address()),
  )
}

test spend_with_grant_rejects_a_foreign_asset_leaving() {
  let stocked = input(
    1,
    fund_output(assets.merge(assets.from_lovelace(10_000_000), other_token())),
  )
  !spend_within(
    interval.before(expiry - 1),
    Some(granted_state()),
    SpendWithGrant { slot: 0, signature: None },
    0,
    [granted_control_input(), stocked],
    [
      control_output(with_caps(granted_state(), 0, 3_000_000, 0), 2_000_000),
      change(assets.from_lovelace(8_000_000)),
      output(
        recipient_address(),
        assets.merge(assets.from_lovelace(2_000_000), other_token()),
        NoDatum,
      ),
    ],
    [stranger_key],
  )
}

test spend_with_grant_rejects_an_output_outside_the_recipients() {
  !spend_token_as_ed25519(
    ed25519_token_spend_outputs(
      2_000_000,
      address.from_verification_key(other_device_key),
    ),
  )
}

test spend_with_grant_accepts_any_destination_when_recipients_are_empty() {
  spend_lovelace(
    interval.before(expiry - 1),
    [
      control_output(with_caps(granted_state(), 0, 3_000_000, 0), 2_000_000),
      change(assets.from_lovelace(8_000_000)),
      output(
        address.from_verification_key(other_device_key),
        assets.from_lovelace(2_000_000),
        NoDatum,
      ),
    ],
    [stranger_key],
  )
}

test spend_with_grant_rejects_an_unbounded_validity_range() {
  !spend_lovelace(
    interval.everything,
    lovelace_spend_outputs(2_000_000),
    [stranger_key],
  )
}

test spend_with_grant_rejects_a_validity_range_ending_after_the_expiry() {
  !spend_lovelace(
    interval.before(expiry + 1),
    lovelace_spend_outputs(2_000_000),
    [stranger_key],
  )
}

test spend_with_grant_accepts_a_validity_range_ending_at_the_expiry() {
  spend_lovelace(
    interval.before(expiry),
    lovelace_spend_outputs(2_000_000),
    [stranger_key],
  )
}

test spend_with_grant_accepts_an_exclusive_bound_at_the_expiry() {
  spend_lovelace(
    interval.entirely_before(expiry),
    lovelace_spend_outputs(2_000_000),
    [stranger_key],
  )
}

fn agent_deposit_outputs(after: AccountState) -> List<Output> {
  [
    control_output(after, 2_000_000),
    change(assets.from_lovelace(14_000_000)),
    payout(1_000_000),
  ]
}

fn spend_with_agent_deposit(after: AccountState) -> Bool {
  let agent_funds = input(
    2,
    output(recipient_address(), assets.from_lovelace(5_000_000), NoDatum),
  )
  spend_within(
    interval.before(expiry - 1),
    Some(granted_state()),
    SpendWithGrant { slot: 0, signature: None },
    0,
    [granted_control_input(), fund_input(), agent_funds],
    agent_deposit_outputs(after),
    [stranger_key],
  )
}

test spend_with_grant_keeps_the_caps_on_a_net_deposit() {
  spend_with_agent_deposit(granted_state())
}

test spend_with_grant_rejects_a_cap_raised_by_a_net_deposit() {
  !spend_with_agent_deposit(with_caps(granted_state(), 0, 9_000_000, 0))
}

test spend_with_grant_rejects_a_wrong_cap_decrement() {
  !spend_lovelace(
    interval.before(expiry - 1),
    [
      control_output(with_caps(granted_state(), 0, 4_000_000, 0), 2_000_000),
      change(assets.from_lovelace(8_000_000)),
      payout(2_000_000),
    ],
    [stranger_key],
  )
}

test spend_with_grant_rejects_an_unchanged_cap() {
  !spend_lovelace(
    interval.before(expiry - 1),
    [
      control_output(granted_state(), 2_000_000),
      change(assets.from_lovelace(8_000_000)),
      payout(2_000_000),
    ],
    [stranger_key],
  )
}

test spend_with_grant_rejects_a_changed_grant_generation() {
  let after = with_caps(granted_state(), 0, 3_000_000, 0)
  !spend_lovelace(
    interval.before(expiry - 1),
    [
      control_output(AccountState { ..after, grant_generation: 1 }, 2_000_000),
      change(assets.from_lovelace(8_000_000)),
      payout(2_000_000),
    ],
    [stranger_key],
  )
}

test spend_with_grant_rejects_changed_devices() {
  let after = with_caps(granted_state(), 0, 3_000_000, 0)
  !spend_lovelace(
    interval.before(expiry - 1),
    [
      control_output(
        AccountState { ..after, devices: [device_key, stranger_key] },
        2_000_000,
      ),
      change(assets.from_lovelace(8_000_000)),
      payout(2_000_000),
    ],
    [stranger_key],
  )
}

test spend_with_grant_rejects_another_grants_caps_changed() {
  let after = with_caps(granted_state(), 0, 3_000_000, 0)
  !spend_lovelace(
    interval.before(expiry - 1),
    [
      control_output(with_caps(after, 1, 49, 2_000_000), 2_000_000),
      change(assets.from_lovelace(8_000_000)),
      payout(2_000_000),
    ],
    [stranger_key],
  )
}

test spend_with_grant_rejects_reordered_grants() {
  let after = with_caps(granted_state(), 0, 3_000_000, 0)
  !spend_lovelace(
    interval.before(expiry - 1),
    [
      control_output(
        AccountState { ..after, grants: list.reverse(after.grants) },
        2_000_000,
      ),
      change(assets.from_lovelace(8_000_000)),
      payout(2_000_000),
    ],
    [stranger_key],
  )
}

/// The second control UTxO would already be refused because its state NFT
/// leaves the account, which the scope forbids for any asset other than
/// the scoped one; the explicit single control input check is defence in
/// depth, so the accounting is known to run over one state whatever the
/// scope says.
test spend_with_grant_rejects_two_control_utxos_of_the_account() {
  !spend_within(
    interval.before(expiry - 1),
    Some(granted_state()),
    SpendWithGrant { slot: 0, signature: None },
    0,
    [
      granted_control_input(),
      input(2, control_output(granted_state(), 2_000_000)),
      fund_input(),
    ],
    [
      control_output(with_caps(granted_state(), 0, 3_000_000, 0), 2_000_000),
      change(assets.from_lovelace(10_000_000)),
      payout(2_000_000),
    ],
    [stranger_key],
  )
}

test spend_with_grant_rejects_an_unknown_slot() fail {
  spend_within(
    interval.before(expiry - 1),
    Some(granted_state()),
    SpendWithGrant { slot: 7, signature: None },
    0,
    [granted_control_input(), fund_input()],
    lovelace_spend_outputs(2_000_000),
    [stranger_key],
  )
}

test spend_with_grant_rejects_an_ed25519_grantee_without_its_signature() {
  !spend_lovelace(
    interval.before(expiry - 1),
    lovelace_spend_outputs(2_000_000),
    [device_key],
  )
}

test spend_with_grant_rejects_a_signature_in_the_redeemer_of_an_ed25519_grantee() {
  !spend_within(
    interval.before(expiry - 1),
    Some(granted_state()),
    SpendWithGrant { slot: 0, signature: Some(token_spend_signature) },
    0,
    [granted_control_input(), fund_input()],
    lovelace_spend_outputs(2_000_000),
    [stranger_key],
  )
}

test spend_with_grant_rejects_a_secp256k1_grantee_without_a_signature() {
  !spend_token(token_spend_outputs(), None)
}

test spend_with_grant_rejects_a_secp256k1_signature_over_another_transaction() {
  let marker: Data = 1
  let outputs = [
    control_output(with_caps(granted_state(), 1, 40, 0), 2_000_000),
    change(assets.merge(assets.from_lovelace(8_000_000), token(10))),
    output(
      recipient_address(),
      assets.merge(assets.from_lovelace(2_000_000), token(10)),
      InlineDatum(marker),
    ),
  ]
  !spend_token(outputs, Some(token_spend_signature))
}

test spend_with_grant_rejects_a_fund_input() fail {
  spend_within(
    interval.before(expiry - 1),
    None,
    SpendWithGrant { slot: 0, signature: None },
    1,
    [granted_control_input(), fund_input()],
    lovelace_spend_outputs(2_000_000),
    [stranger_key],
  )
}

test spend_with_grant_rejects_a_missing_control_output() fail {
  spend_lovelace(
    interval.before(expiry - 1),
    [change(assets.from_lovelace(10_000_000)), payout(2_000_000)],
    [stranger_key],
  )
}

test spend_with_grant_rejects_extra_tokens_on_the_control_output() {
  let parked = output(
    account_address(),
    assets.merge(control_value(stake_key_hash, 2_000_000), token(20)),
    state_datum(with_caps(granted_state(), 0, 3_000_000, 0)),
  )
  !spend_within(
    interval.before(expiry - 1),
    Some(granted_state()),
    SpendWithGrant { slot: 0, signature: None },
    0,
    [granted_control_input(), treasury_input()],
    [parked, change(assets.from_lovelace(8_000_000)), payout(2_000_000)],
    [stranger_key],
  )
}

test spend_with_grant_rejects_a_reference_script_on_the_control_output() {
  let weighted = Output {
    ..control_output(with_caps(granted_state(), 0, 3_000_000, 0), 2_000_000),
    reference_script: Some(script_hash),
  }
  !spend_lovelace(
    interval.before(expiry - 1),
    [weighted, change(assets.from_lovelace(8_000_000)), payout(2_000_000)],
    [stranger_key],
  )
}

test spend_with_grant_rejects_a_state_nft_sent_outside_the_account() {
  let stray = output(
    recipient_address(),
    control_value(other_stake_key_hash, 1_000_000),
    NoDatum,
  )
  !spend_lovelace(
    interval.before(expiry - 1),
    [
      control_output(with_caps(granted_state(), 0, 2_000_000, 0), 2_000_000),
      change(assets.from_lovelace(7_000_000)),
      payout(2_000_000),
      stray,
    ],
    [stranger_key],
  )
}

test spend_with_grant_rejects_a_stray_state_nft_among_the_inputs() {
  let stray = input(
    2,
    output(
      recipient_address(),
      control_value(other_stake_key_hash, 1_000_000),
      NoDatum,
    ),
  )
  !spend_within(
    interval.before(expiry - 1),
    Some(granted_state()),
    SpendWithGrant { slot: 0, signature: None },
    0,
    [granted_control_input(), fund_input(), stray],
    [
      control_output(with_caps(granted_state(), 0, 3_000_000, 0), 2_000_000),
      change(assets.from_lovelace(8_000_000)),
      payout(2_000_000),
      output(
        other_account_address(),
        control_value(other_stake_key_hash, 1_000_000),
        NoDatum,
      ),
    ],
    [stranger_key],
  )
}

test device_spends_with_grants_in_the_state() {
  spend(
    Some(granted_state()),
    Device,
    0,
    [granted_control_input(), fund_input()],
    [control_output(granted_state(), 2_000_000), payout(10_000_000)],
    assets.zero,
    [device_key],
  )
}

test device_revokes_all_grants() {
  let revoked = AccountState {
    ..granted_state(),
    grants: [],
    grant_generation: 1,
  }
  spend(
    Some(granted_state()),
    Device,
    0,
    [granted_control_input()],
    [control_output(revoked, 2_000_000)],
    assets.zero,
    [device_key],
  )
}
