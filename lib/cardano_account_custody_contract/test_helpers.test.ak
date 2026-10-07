use aiken/interval
use cardano/address.{Inline, Script}
use cardano/assets
use cardano/certificate.{RegisterCredential}
use cardano/transaction.{InlineDatum, NoDatum, Publish}
use cardano_account_custody_contract/test_helpers.{
  account_address, control_output, control_value, device_key, fund_output, input,
  other_stake_script_hash, output_reference, publishing, registration,
  script_hash, stake_script_hash, state_nft,
}
use cardano_account_custody_contract/types.{AccountState, Operate}

fn state() -> AccountState {
  AccountState { devices: [device_key], grants: [], grant_generation: 0 }
}

test account_address_pays_to_the_script_and_stakes_to_the_stake_script() {
  let address = account_address()
  address.payment_credential == Script(script_hash) && address.stake_credential == Some(
    Inline(Script(stake_script_hash)),
  )
}

test output_references_differ_by_index() {
  output_reference(0) != output_reference(1) && output_reference(1).output_index == 1
}

test input_resolves_to_the_given_output() {
  let fund = fund_output(assets.from_lovelace(5))
  let built = input(3, fund)
  built.output_reference == output_reference(3) && built.output == fund
}

test control_output_carries_the_state_nft_and_the_inline_state() {
  let control = control_output(state(), 2_000_000)
  let data: Data = state()
  and {
    control.address == account_address(),
    control.value == control_value(stake_script_hash, 2_000_000),
    assets.quantity_of(control.value, script_hash, stake_script_hash) == 1,
    assets.lovelace_of(control.value) == 2_000_000,
    control.datum == InlineDatum(data),
    control.reference_script == None,
  }
}

test fund_output_carries_no_datum() {
  let fund = fund_output(assets.from_lovelace(5))
  fund.address == account_address() && fund.datum == NoDatum
}

test transaction_carries_the_given_parts() {
  let control = input(0, control_output(state(), 2_000_000))
  let payout = fund_output(assets.from_lovelace(1))
  let mint = state_nft(stake_script_hash)
  let range = interval.before(10)
  let built = test_helpers.transaction(
    [control],
    [payout],
    mint,
    [device_key],
    range,
  )
  and {
    built.inputs == [control],
    built.outputs == [payout],
    built.mint == mint,
    built.extra_signatories == [device_key],
    built.validity_range == range,
    built.reference_inputs == [],
    built.fee == 0,
  }
}

test registration_registers_the_script_credential() {
  registration(stake_script_hash) == RegisterCredential {
    credential: Script(stake_script_hash),
    deposit: Never,
  }
}

test publishing_appends_the_certificate_and_its_redeemer() {
  let first = registration(stake_script_hash)
  let second = registration(other_stake_script_hash)
  let redeemer: Data = Operate
  let built = test_helpers.transaction(
    [],
    [],
    assets.zero,
    [device_key],
    interval.everything,
  )
    |> publishing(first)
    |> publishing(second)
  and {
    built.certificates == [first, second],
    built.redeemers == [
      Pair(Publish { at: 0, certificate: first }, redeemer),
      Pair(Publish { at: 1, certificate: second }, redeemer),
    ],
    built.extra_signatories == [device_key],
  }
}
