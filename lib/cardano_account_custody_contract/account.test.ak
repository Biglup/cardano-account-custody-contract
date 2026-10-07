use cardano/address.{Address, Inline, Pointer, Script, VerificationKey}
use cardano/assets
use cardano/certificate.{
  DelegateBlockProduction, DelegateCredential, RegisterAndDelegateCredential,
  RegisterDelegateRepresentative, UnregisterCredential,
}
use cardano/transaction.{DatumHash, Mint, NoDatum}
use cardano_account_custody_contract/account.{
  account_address, find_control_input, find_control_output, has_control_input,
  holds_only_lovelace_and_state_nft, holds_state_nft, is_authorised_by_a_device,
  is_control_output, is_valid_control_output, own_input, registers_credential,
  registers_stake_credential, script_hash_of, stake_script_hash_of, state_datum,
  state_nfts_sit_at_their_own_addresses,
}
use cardano_account_custody_contract/test_helpers.{
  control_output, control_value, device_key, fund_output, input,
  other_account_address, other_stake_script_hash, output, output_reference,
  publishing, recipient_address, registration, script_hash, stake_script_hash,
  state_nft, stranger_key,
}
use cardano_account_custody_contract/types.{AccountState, Operate}

fn state() -> AccountState {
  AccountState { devices: [device_key], grants: [], grant_generation: 0 }
}

fn control() -> transaction.Output {
  control_output(state(), 2_000_000)
}

fn other_token() -> assets.Assets {
  assets.from_asset(
    #"00000000000000000000000000000000000000000000000000000099",
    "token",
    1,
  )
}

test own_input_finds_the_input_by_output_reference() {
  let control = input(0, control())
  let fund = input(1, fund_output(assets.from_lovelace(5)))
  own_input([fund, control], output_reference(0)) == control
}

test own_input_fails_when_the_reference_is_not_spent() fail {
  let fund = input(1, fund_output(assets.from_lovelace(5)))
  own_input([fund], output_reference(0)) == fund
}

test script_hash_of_returns_the_payment_script() {
  script_hash_of(test_helpers.account_address()) == script_hash
}

test script_hash_of_fails_for_a_key_address() fail {
  script_hash_of(recipient_address()) == script_hash
}

test stake_script_hash_of_returns_the_inline_stake_script() {
  stake_script_hash_of(test_helpers.account_address()) == stake_script_hash
}

test stake_script_hash_of_fails_without_a_stake_credential() fail {
  stake_script_hash_of(address.from_script(script_hash)) == stake_script_hash
}

test stake_script_hash_of_fails_for_a_key_stake_credential() fail {
  let address = address.from_script(script_hash)
    |> address.with_delegation_key(stake_script_hash)
  stake_script_hash_of(address) == stake_script_hash
}

test stake_script_hash_of_fails_for_a_pointer_stake_credential() fail {
  let address = Address {
    payment_credential: Script(script_hash),
    stake_credential: Some(
      Pointer { slot_number: 1, transaction_index: 2, certificate_index: 3 },
    ),
  }
  stake_script_hash_of(address) == stake_script_hash
}

test account_address_pairs_the_script_with_the_stake_script() {
  account_address(script_hash, stake_script_hash) == Address {
    payment_credential: Script(script_hash),
    stake_credential: Some(Inline(Script(stake_script_hash))),
  }
}

test account_address_differs_from_the_key_stake_form_of_the_same_bytes() {
  account_address(script_hash, stake_script_hash) != Address {
    payment_credential: Script(script_hash),
    stake_credential: Some(Inline(VerificationKey(stake_script_hash))),
  }
}

test holds_state_nft_accepts_one_token_of_the_account() {
  holds_state_nft(
    control_value(stake_script_hash, 1),
    script_hash,
    stake_script_hash,
  )
}

test holds_state_nft_rejects_a_missing_token() {
  !holds_state_nft(assets.from_lovelace(1), script_hash, stake_script_hash)
}

test holds_state_nft_rejects_another_accounts_token() {
  !holds_state_nft(
    control_value(other_stake_script_hash, 1),
    script_hash,
    stake_script_hash,
  )
}

test holds_state_nft_rejects_a_quantity_of_two() {
  let value = assets.from_asset(script_hash, stake_script_hash, 2)
  !holds_state_nft(value, script_hash, stake_script_hash)
}

test holds_only_lovelace_and_state_nft_accepts_lovelace_with_the_nft() {
  holds_only_lovelace_and_state_nft(
    control_value(stake_script_hash, 1),
    script_hash,
    stake_script_hash,
  )
}

test holds_only_lovelace_and_state_nft_accepts_the_nft_alone() {
  holds_only_lovelace_and_state_nft(
    state_nft(stake_script_hash),
    script_hash,
    stake_script_hash,
  )
}

test holds_only_lovelace_and_state_nft_rejects_an_extra_token() {
  let value = assets.merge(control_value(stake_script_hash, 1), other_token())
  !holds_only_lovelace_and_state_nft(value, script_hash, stake_script_hash)
}

test holds_only_lovelace_and_state_nft_rejects_a_second_token_of_the_policy() {
  let value = assets.merge(
    control_value(stake_script_hash, 1),
    state_nft(other_stake_script_hash),
  )
  !holds_only_lovelace_and_state_nft(value, script_hash, stake_script_hash)
}

test holds_only_lovelace_and_state_nft_rejects_lovelace_alone() {
  !holds_only_lovelace_and_state_nft(
    assets.from_lovelace(1),
    script_hash,
    stake_script_hash,
  )
}

test is_control_output_accepts_the_control_utxo() {
  is_control_output(control(), script_hash, stake_script_hash)
}

test is_control_output_rejects_a_fund_utxo() {
  !is_control_output(
    fund_output(assets.from_lovelace(5)),
    script_hash,
    stake_script_hash,
  )
}

test is_control_output_rejects_the_nft_at_another_address() {
  let stray = output(
    recipient_address(),
    control_value(stake_script_hash, 1),
    NoDatum,
  )
  !is_control_output(stray, script_hash, stake_script_hash)
}

test find_control_output_returns_the_single_control_output() {
  let payout = output(recipient_address(), assets.from_lovelace(1), NoDatum)
  find_control_output([payout, control()], script_hash, stake_script_hash) == Some(
    control(),
  )
}

test find_control_output_returns_none_without_a_control_output() {
  let payout = output(recipient_address(), assets.from_lovelace(1), NoDatum)
  find_control_output([payout], script_hash, stake_script_hash) == None
}

test find_control_output_returns_none_for_two_control_outputs() {
  find_control_output([control(), control()], script_hash, stake_script_hash) == None
}

test has_control_input_accepts_a_spent_control_utxo() {
  let fund = input(1, fund_output(assets.from_lovelace(5)))
  has_control_input([fund, input(0, control())], script_hash, stake_script_hash)
}

test has_control_input_rejects_fund_inputs_alone() {
  let fund = input(1, fund_output(assets.from_lovelace(5)))
  !has_control_input([fund], script_hash, stake_script_hash)
}

test state_nfts_sit_at_their_own_addresses_accepts_control_and_plain_outputs() {
  let payout = output(recipient_address(), assets.from_lovelace(1), NoDatum)
  state_nfts_sit_at_their_own_addresses([payout, control()], script_hash)
}

test state_nfts_sit_at_their_own_addresses_accepts_another_accounts_control_output() {
  let other = output(
    other_account_address(),
    control_value(other_stake_script_hash, 1),
    NoDatum,
  )
  state_nfts_sit_at_their_own_addresses([control(), other], script_hash)
}

test state_nfts_sit_at_their_own_addresses_accepts_no_outputs() {
  state_nfts_sit_at_their_own_addresses([], script_hash)
}

test state_nfts_sit_at_their_own_addresses_rejects_the_nft_at_a_key_address() {
  let stray = output(
    recipient_address(),
    control_value(stake_script_hash, 1),
    NoDatum,
  )
  !state_nfts_sit_at_their_own_addresses([control(), stray], script_hash)
}

test state_nfts_sit_at_their_own_addresses_rejects_another_name_at_a_key_address() {
  let stray = output(
    recipient_address(),
    state_nft(other_stake_script_hash),
    NoDatum,
  )
  !state_nfts_sit_at_their_own_addresses([control(), stray], script_hash)
}

test state_nfts_sit_at_their_own_addresses_rejects_the_nft_at_another_accounts_address() {
  let exported = output(
    other_account_address(),
    control_value(stake_script_hash, 1),
    NoDatum,
  )
  !state_nfts_sit_at_their_own_addresses([control(), exported], script_hash)
}

test state_nfts_sit_at_their_own_addresses_rejects_the_nft_at_an_enterprise_script_address() {
  let stray = output(
    address.from_script(script_hash),
    control_value(stake_script_hash, 1),
    NoDatum,
  )
  !state_nfts_sit_at_their_own_addresses([control(), stray], script_hash)
}

test state_nfts_sit_at_their_own_addresses_rejects_a_quantity_of_two() {
  let doubled = output(
    test_helpers.account_address(),
    assets.from_asset(script_hash, stake_script_hash, 2),
    NoDatum,
  )
  !state_nfts_sit_at_their_own_addresses([doubled], script_hash)
}

test state_datum_decodes_the_inline_state() {
  state_datum(control()) == state()
}

test state_datum_fails_without_a_datum() fail {
  state_datum(fund_output(assets.from_lovelace(5))) == state()
}

test state_datum_fails_for_a_datum_hash() fail {
  let hashed = output(
    test_helpers.account_address(),
    control_value(stake_script_hash, 1),
    DatumHash(stranger_key),
  )
  state_datum(hashed) == state()
}

test state_datum_fails_for_a_malformed_datum() fail {
  let data: Data = 42
  let malformed = output(
    test_helpers.account_address(),
    control_value(stake_script_hash, 1),
    transaction.InlineDatum(data),
  )
  state_datum(malformed) == state()
}

test is_valid_control_output_accepts_a_well_formed_state() {
  is_valid_control_output(control(), script_hash, stake_script_hash)
}

test is_valid_control_output_rejects_an_ill_formed_state() {
  let empty = AccountState { ..state(), devices: [] }
  !is_valid_control_output(
    control_output(empty, 2_000_000),
    script_hash,
    stake_script_hash,
  )
}

test is_valid_control_output_rejects_an_extra_token() {
  let parked = output(
    test_helpers.account_address(),
    assets.merge(control_value(stake_script_hash, 1), other_token()),
    test_helpers.state_datum(state()),
  )
  !is_valid_control_output(parked, script_hash, stake_script_hash)
}

test find_control_input_returns_the_control_input() {
  let fund = input(1, fund_output(assets.from_lovelace(5)))
  find_control_input(
    [fund, input(0, control())],
    script_hash,
    stake_script_hash,
  ) == Some(input(0, control()))
}

test find_control_input_returns_none_without_a_control_input() {
  let fund = input(1, fund_output(assets.from_lovelace(5)))
  find_control_input([fund], script_hash, stake_script_hash) == None
}

test find_control_input_ignores_another_accounts_control_input() {
  let other = input(
    0,
    output(
      other_account_address(),
      control_value(other_stake_script_hash, 1),
      test_helpers.state_datum(state()),
    ),
  )
  find_control_input([other], script_hash, stake_script_hash) == None
}

test is_authorised_by_a_device_accepts_a_device_over_a_referenced_control() {
  is_authorised_by_a_device(
    [],
    [input(0, control())],
    [device_key],
    script_hash,
    stake_script_hash,
  )
}

test is_authorised_by_a_device_accepts_a_device_over_a_spent_control() {
  is_authorised_by_a_device(
    [input(0, control())],
    [],
    [stranger_key, device_key],
    script_hash,
    stake_script_hash,
  )
}

test is_authorised_by_a_device_rejects_a_missing_device_signature() {
  !is_authorised_by_a_device(
    [],
    [input(0, control())],
    [stranger_key],
    script_hash,
    stake_script_hash,
  )
}

test is_authorised_by_a_device_fails_without_a_control_utxo() fail {
  is_authorised_by_a_device(
    [input(1, fund_output(assets.from_lovelace(5)))],
    [],
    [device_key],
    script_hash,
    stake_script_hash,
  )
}

test is_authorised_by_a_device_fails_for_a_control_without_a_state() fail {
  let bare = output(
    test_helpers.account_address(),
    control_value(stake_script_hash, 1),
    NoDatum,
  )
  is_authorised_by_a_device(
    [],
    [input(0, bare)],
    [device_key],
    script_hash,
    stake_script_hash,
  )
}

test registers_credential_accepts_a_registration() {
  registers_credential(
    registration(stake_script_hash),
    Script(stake_script_hash),
  )
}

test registers_credential_accepts_a_registration_with_a_delegation() {
  registers_credential(
    RegisterAndDelegateCredential {
      credential: Script(stake_script_hash),
      delegate: DelegateBlockProduction { stake_pool: stranger_key },
      deposit: 2_000_000,
    },
    Script(stake_script_hash),
  )
}

test registers_credential_rejects_another_credential() {
  !registers_credential(
    registration(other_stake_script_hash),
    Script(stake_script_hash),
  )
}

test registers_credential_rejects_a_key_credential_of_the_same_bytes() {
  !registers_credential(
    registration(stake_script_hash),
    VerificationKey(stake_script_hash),
  )
}

test registers_credential_rejects_other_certificate_kinds() {
  let credential = Script(stake_script_hash)
  and {
    !registers_credential(
      UnregisterCredential { credential, refund: Never },
      credential,
    ),
    !registers_credential(
      DelegateCredential {
        credential,
        delegate: DelegateBlockProduction { stake_pool: stranger_key },
      },
      credential,
    ),
    !registers_credential(
      RegisterDelegateRepresentative {
        delegate_representative: credential,
        deposit: 500_000_000,
      },
      credential,
    ),
  }
}

test registers_stake_credential_accepts_a_published_registration() {
  let tx = publishing(transaction.placeholder, registration(stake_script_hash))
  registers_stake_credential(tx.redeemers, stake_script_hash)
}

test registers_stake_credential_accepts_a_registration_among_other_redeemers() {
  let minting: Data = Operate
  let tx = publishing(
    transaction.placeholder,
    registration(other_stake_script_hash),
  )
    |> publishing(registration(stake_script_hash))
  registers_stake_credential(
    [Pair(Mint(script_hash), minting), ..tx.redeemers],
    stake_script_hash,
  )
}

test registers_stake_credential_rejects_no_redeemers() {
  !registers_stake_credential([], stake_script_hash)
}

test registers_stake_credential_rejects_another_credentials_registration() {
  let tx = publishing(
    transaction.placeholder,
    registration(other_stake_script_hash),
  )
  !registers_stake_credential(tx.redeemers, stake_script_hash)
}

test registers_stake_credential_rejects_a_published_delegation() {
  let tx = publishing(
    transaction.placeholder,
    DelegateCredential {
      credential: Script(stake_script_hash),
      delegate: DelegateBlockProduction { stake_pool: stranger_key },
    },
  )
  !registers_stake_credential(tx.redeemers, stake_script_hash)
}

test registers_stake_credential_ignores_a_certificate_without_a_redeemer() {
  let tx = publishing(transaction.placeholder, registration(stake_script_hash))
  and {
    tx.certificates == [registration(stake_script_hash)],
    !registers_stake_credential([], stake_script_hash),
  }
}
