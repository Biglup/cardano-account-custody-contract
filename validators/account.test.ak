use account
use aiken/interval
use cardano/address
use cardano/assets.{Assets}
use cardano/transaction.{DatumHash, InlineDatum, Input, NoDatum, Output}
use cardano_account_custody_contract/test_helpers.{
  account_address, control_output, control_value, device_key, fund_output, input,
  other_account_address, other_device_key, other_stake_key_hash, output,
  output_reference, recipient_address, script_hash, stake_key_hash, state_datum,
  state_nft, stranger_key,
}
use cardano_account_custody_contract/types.{
  AccountState, Asset, CreateAccount, DeleteAccount, Device, Ed25519, Fund,
  Grant, Scope, SpendWithGrant,
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
    "token",
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

fn spend(
  state: Option<AccountState>,
  redeemer: types.AccountRedeemer,
  index: Int,
  inputs: List<Input>,
  outputs: List<Output>,
  minted: Assets,
  signatories: List<ByteArray>,
) -> Bool {
  let datum: Option<Data> = when state is {
    Some(state) -> {
      let data: Data = state
      Some(data)
    }
    None -> None
  }
  spend_with_datum(datum, redeemer, index, inputs, outputs, minted, signatories)
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

test spend_with_grant_is_not_implemented() fail {
  spend(
    Some(state()),
    SpendWithGrant { slot: 0, signature: None },
    0,
    [control_input()],
    [control_output(state(), 2_000_000)],
    assets.zero,
    [device_key],
  )
}
