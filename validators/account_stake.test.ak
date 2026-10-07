use account_stake
use aiken/interval
use cardano/address.{Script, VerificationKey}
use cardano/assets
use cardano/certificate.{
  AlwaysAbstain, Certificate, DelegateBlockProduction, DelegateCredential,
  DelegateVote, RegisterAndDelegateCredential, RegisterCredential,
  RegisterDelegateRepresentative, UnregisterCredential,
}
use cardano/governance.{StakePool}
use cardano/script_context.{ScriptContext, Voting}
use cardano/transaction.{Input, NoDatum, Transaction}
use cardano_account_custody_contract/test_helpers.{
  account_address, control_output, control_value, device_key, fund_output, input,
  other_account_address, other_device_key, other_stake_script_hash, output,
  recipient_address, registration, script_hash, stake_script_hash, state_datum,
  stranger_key,
}
use cardano_account_custody_contract/types.{AccountState, Operate}

fn state() -> AccountState {
  AccountState {
    devices: [device_key, other_device_key],
    grants: [],
    grant_generation: 0,
  }
}

fn control_input() -> Input {
  input(0, control_output(state(), 2_000_000))
}

/// A transaction paying a withdrawal of `lovelace` from the account's
/// reward account to the recipient, signed by `signatories`, with the
/// given reference inputs and inputs.
fn withdrawal(
  lovelace: Int,
  inputs: List<Input>,
  reference_inputs: List<Input>,
  signatories: List<ByteArray>,
) -> Transaction {
  let tx = test_helpers.transaction(
    inputs,
    [output(recipient_address(), assets.from_lovelace(lovelace), NoDatum)],
    assets.zero,
    signatories,
    interval.everything,
  )
  Transaction {
    ..tx,
    reference_inputs,
    withdrawals: [Pair(Script(stake_script_hash), lovelace)],
  }
}

fn withdraw(tx: Transaction) -> Bool {
  account_stake.account_stake.withdraw(
    device_key,
    script_hash,
    Operate,
    Script(stake_script_hash),
    tx,
  )
}

/// A transaction publishing `certificate`, signed by `signatories`, with
/// the given reference inputs.
fn publication(
  certificate: Certificate,
  reference_inputs: List<Input>,
  signatories: List<ByteArray>,
) -> Transaction {
  let tx = test_helpers.transaction(
    [],
    [],
    assets.zero,
    signatories,
    interval.everything,
  )
    |> test_helpers.publishing(certificate)
  Transaction { ..tx, reference_inputs }
}

fn publish(certificate: Certificate, tx: Transaction) -> Bool {
  account_stake.account_stake.publish(
    device_key,
    script_hash,
    Operate,
    certificate,
    tx,
  )
}

fn delegation() -> Certificate {
  DelegateCredential {
    credential: Script(stake_script_hash),
    delegate: DelegateBlockProduction { stake_pool: stranger_key },
  }
}

fn deregistration() -> Certificate {
  UnregisterCredential { credential: Script(stake_script_hash), refund: Never }
}

test publish_accepts_a_registration_signed_by_the_owner() {
  publish(
    registration(stake_script_hash),
    publication(registration(stake_script_hash), [], [device_key]),
  )
}

test publish_accepts_a_registration_with_a_delegation_signed_by_the_owner() {
  let delegating = RegisterAndDelegateCredential {
    credential: Script(stake_script_hash),
    delegate: DelegateVote { delegate_representative: AlwaysAbstain },
    deposit: 2_000_000,
  }
  publish(delegating, publication(delegating, [], [stranger_key, device_key]))
}

test publish_rejects_a_registration_without_the_owner_signature() {
  !publish(
    registration(stake_script_hash),
    publication(registration(stake_script_hash), [], [other_device_key]),
  )
}

test publish_rejects_a_registration_signed_by_a_device_over_the_control() {
  !publish(
    registration(stake_script_hash),
    publication(
      registration(stake_script_hash),
      [control_input()],
      [other_device_key],
    ),
  )
}

test publish_rejects_a_registration_of_a_key_credential() {
  let foreign = RegisterCredential {
    credential: VerificationKey(stake_script_hash),
    deposit: Never,
  }
  !publish(foreign, publication(foreign, [], [device_key]))
}

test publish_accepts_a_delegation_signed_by_a_device_over_a_referenced_control() {
  publish(
    delegation(),
    publication(delegation(), [control_input()], [other_device_key]),
  )
}

test publish_accepts_a_delegation_signed_by_a_device_over_a_spent_control() {
  let tx = Transaction {
    ..publication(delegation(), [], [device_key]),
    inputs: [control_input()],
  }
  publish(delegation(), tx)
}

test publish_rejects_a_delegation_without_a_device_signature() {
  !publish(
    delegation(),
    publication(delegation(), [control_input()], [stranger_key]),
  )
}

test publish_rejects_a_delegation_signed_by_the_owner_alone_without_the_control() fail {
  publish(delegation(), publication(delegation(), [], [device_key]))
}

test publish_rejects_a_delegation_over_another_accounts_control() fail {
  let other = input(
    0,
    output(
      other_account_address(),
      control_value(other_stake_script_hash, 2_000_000),
      state_datum(state()),
    ),
  )
  publish(delegation(), publication(delegation(), [other], [device_key]))
}

test publish_accepts_a_deregistration_signed_by_a_device_over_the_control() {
  publish(
    deregistration(),
    publication(deregistration(), [control_input()], [device_key]),
  )
}

test publish_rejects_a_deregistration_without_a_device_signature() {
  !publish(
    deregistration(),
    publication(deregistration(), [control_input()], [stranger_key]),
  )
}

test publish_rejects_a_delegate_representative_registration() {
  let drep = RegisterDelegateRepresentative {
    delegate_representative: Script(stake_script_hash),
    deposit: 500_000_000,
  }
  !publish(drep, publication(drep, [control_input()], [device_key]))
}

test withdraw_accepts_a_device_signature_over_a_referenced_control() {
  withdraw(withdrawal(1_000_000, [], [control_input()], [other_device_key]))
}

test withdraw_accepts_a_device_signature_over_a_spent_control() {
  withdraw(withdrawal(1_000_000, [control_input()], [], [device_key]))
}

test withdraw_accepts_a_withdrawal_of_zero() {
  withdraw(withdrawal(0, [], [control_input()], [device_key]))
}

test withdraw_rejects_a_missing_device_signature() {
  !withdraw(withdrawal(1_000_000, [], [control_input()], [stranger_key]))
}

test withdraw_rejects_the_owner_signature_alone_without_the_control() fail {
  withdraw(withdrawal(1_000_000, [], [], [device_key]))
}

test withdraw_rejects_another_accounts_control() fail {
  let other = input(
    0,
    output(
      other_account_address(),
      control_value(other_stake_script_hash, 2_000_000),
      state_datum(state()),
    ),
  )
  withdraw(withdrawal(1_000_000, [], [other], [device_key]))
}

test withdraw_rejects_a_control_that_lacks_the_state_nft() fail {
  let forged = input(
    0,
    output(
      account_address(),
      assets.from_lovelace(2_000_000),
      state_datum(state()),
    ),
  )
  withdraw(withdrawal(1_000_000, [], [forged], [device_key]))
}

test withdraw_rejects_a_control_without_an_inline_state() fail {
  let bare = input(
    0,
    output(
      account_address(),
      control_value(stake_script_hash, 2_000_000),
      NoDatum,
    ),
  )
  withdraw(withdrawal(1_000_000, [], [bare], [device_key]))
}

test withdraw_rejects_a_deposit_posing_as_the_control() fail {
  let deposit = input(1, fund_output(assets.from_lovelace(5_000_000)))
  withdraw(withdrawal(1_000_000, [deposit], [], [device_key]))
}

test withdraw_rejects_a_key_credential() fail {
  account_stake.account_stake.withdraw(
    device_key,
    script_hash,
    Operate,
    VerificationKey(stake_script_hash),
    withdrawal(1_000_000, [], [control_input()], [device_key]),
  )
}

test else_fails_for_any_other_purpose() fail {
  let redeemer: Data = Operate
  let context = ScriptContext {
    transaction: withdrawal(0, [], [control_input()], [device_key]),
    redeemer,
    info: Voting(StakePool(stranger_key)),
  }
  account_stake.account_stake.else(device_key, script_hash, context)
}
