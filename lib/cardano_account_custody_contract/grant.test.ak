use aiken/cbor
use aiken/crypto
use aiken/interval
use cardano/address
use cardano/assets.{Assets}
use cardano/transaction.{DatumHash, InlineDatum, NoDatum}
use cardano_account_custody_contract/grant.{
  carries_no_reference_script, carries_state, deposits_carry_no_datum,
  ends_before_expiry, grantee_message, is_authorised_by_grantee, leaving_value,
  message_domain, pays_only_recipients, quantity_of_asset,
  spends_one_control_utxo, state_after_spend, stays_within_scope,
}
use cardano_account_custody_contract/test_helpers.{
  account_address, control_output, control_value, device_key, fund_output, input,
  other_account_address, other_stake_key_hash, output, output_reference,
  recipient_address, script_hash, stake_key_hash, state_datum, stranger_key,
}
use cardano_account_custody_contract/types.{
  AccountState, Asset, Ed25519, Grant, Scope, Secp256k1,
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

fn other_token(quantity: Int) -> Assets {
  assets.from_asset(token_asset().policy_id, "other", quantity)
}

fn token_scope() -> Scope {
  Scope {
    asset: token_asset(),
    per_call_cap: 10,
    cap: 50,
    lovelace_cap: 2_000_000,
    expires_at: 1_000,
    recipients: [],
  }
}

fn lovelace_scope() -> Scope {
  Scope {
    ..token_scope(),
    asset: lovelace_asset(),
    per_call_cap: 3_000_000,
    cap: 5_000_000,
    lovelace_cap: 0,
  }
}

fn state() -> AccountState {
  AccountState {
    devices: [device_key],
    grants: [
      Grant { slot: 0, grantee: Ed25519(stranger_key), scope: lovelace_scope() },
      Grant { slot: 1, grantee: Ed25519(stranger_key), scope: token_scope() },
    ],
    grant_generation: 0,
  }
}

fn leaving(lovelace: Int, tokens: Int) -> Assets {
  assets.merge(assets.from_lovelace(lovelace), token(tokens))
}

fn transaction_signed_by(
  signatories: List<ByteArray>,
) -> transaction.Transaction {
  test_helpers.transaction(
    [input(0, control_output(state(), 2_000_000))],
    [control_output(state(), 2_000_000)],
    assets.zero,
    signatories,
    interval.before(1_000),
  )
}

test grantee_message_hashes_the_domain_prefixed_tuple() {
  let tx = transaction_signed_by([])
  let payload: Data = (
    message_domain,
    output_reference(0),
    [output_reference(0)],
    tx.outputs,
    0,
    interval.before(1_000),
    assets.zero,
  )
  grantee_message(output_reference(0), tx) == crypto.blake2b_256(
    cbor.serialise(payload),
  )
}

test grantee_message_changes_with_the_control_reference() {
  let tx = transaction_signed_by([])
  grantee_message(output_reference(0), tx) != grantee_message(
    output_reference(1),
    tx,
  )
}

test grantee_message_changes_with_the_outputs() {
  let tx = transaction_signed_by([])
  let changed = transaction.Transaction {
    ..tx,
    outputs: [control_output(state(), 3_000_000)],
  }
  grantee_message(output_reference(0), tx) != grantee_message(
    output_reference(0),
    changed,
  )
}

test is_authorised_by_grantee_accepts_an_ed25519_required_signer() {
  is_authorised_by_grantee(
    Ed25519(stranger_key),
    None,
    output_reference(0),
    transaction_signed_by([device_key, stranger_key]),
  )
}

test is_authorised_by_grantee_rejects_an_ed25519_grantee_that_did_not_sign() {
  !is_authorised_by_grantee(
    Ed25519(stranger_key),
    None,
    output_reference(0),
    transaction_signed_by([device_key]),
  )
}

test is_authorised_by_grantee_rejects_a_redeemer_signature_for_an_ed25519_grantee() {
  !is_authorised_by_grantee(
    Ed25519(stranger_key),
    Some(#""),
    output_reference(0),
    transaction_signed_by([stranger_key]),
  )
}

test is_authorised_by_grantee_rejects_a_secp256k1_grantee_without_a_signature() {
  !is_authorised_by_grantee(
    Secp256k1(
      #"034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa",
    ),
    None,
    output_reference(0),
    transaction_signed_by([stranger_key]),
  )
}

test ends_before_expiry_accepts_an_upper_bound_before_the_expiry() {
  ends_before_expiry(interval.before(999), 1_000)
}

test ends_before_expiry_accepts_an_upper_bound_at_the_expiry() {
  ends_before_expiry(interval.before(1_000), 1_000) && ends_before_expiry(
    interval.entirely_before(1_000),
    1_000,
  )
}

test ends_before_expiry_rejects_an_upper_bound_after_the_expiry() {
  !ends_before_expiry(interval.before(1_001), 1_000)
}

test ends_before_expiry_rejects_an_unbounded_range() {
  !ends_before_expiry(interval.everything, 1_000) && !ends_before_expiry(
    interval.after(0),
    1_000,
  )
}

test leaving_value_subtracts_what_returns_to_the_address() {
  let inputs = [
    input(0, control_output(state(), 2_000_000)),
    input(1, fund_output(leaving(10_000_000, 20))),
    input(2, output(recipient_address(), assets.from_lovelace(1), NoDatum)),
  ]
  let outputs = [
    control_output(state(), 2_000_000),
    fund_output(leaving(7_000_000, 15)),
    output(recipient_address(), leaving(3_000_000, 5), NoDatum),
  ]
  leaving_value(inputs, outputs, account_address()) == leaving(3_000_000, 5)
}

test leaving_value_is_negative_for_a_deposit() {
  let outputs = [fund_output(assets.from_lovelace(5))]
  leaving_value([], outputs, account_address()) == assets.from_lovelace(-5)
}

test leaving_value_ignores_the_other_accounts_address() {
  let inputs = [
    input(0, output(other_account_address(), assets.from_lovelace(9), NoDatum)),
  ]
  leaving_value(inputs, [], account_address()) == assets.zero
}

test quantity_of_asset_reads_lovelace_and_tokens() {
  let value = leaving(7, 3)
  quantity_of_asset(value, lovelace_asset()) == 7 && quantity_of_asset(
    value,
    token_asset(),
  ) == 3
}

test stays_within_scope_accepts_the_per_call_cap_exactly() {
  stays_within_scope(token_scope(), leaving(2_000_000, 10))
}

test stays_within_scope_rejects_one_above_the_per_call_cap() {
  !stays_within_scope(token_scope(), leaving(0, 11))
}

test stays_within_scope_rejects_more_than_the_remaining_cap() {
  let nearly_spent = Scope { ..token_scope(), cap: 5 }
  !stays_within_scope(nearly_spent, leaving(0, 6))
}

test stays_within_scope_rejects_lovelace_above_the_lovelace_cap() {
  !stays_within_scope(token_scope(), leaving(2_000_001, 0))
}

test stays_within_scope_ignores_the_lovelace_cap_for_a_lovelace_scope() {
  stays_within_scope(lovelace_scope(), assets.from_lovelace(3_000_000))
}

test stays_within_scope_rejects_a_foreign_asset_leaving() {
  !stays_within_scope(
    lovelace_scope(),
    assets.merge(assets.from_lovelace(1), other_token(1)),
  )
}

test stays_within_scope_accepts_a_foreign_asset_entering() {
  stays_within_scope(
    lovelace_scope(),
    assets.merge(assets.from_lovelace(1), other_token(-1)),
  )
}

test stays_within_scope_accepts_a_deposit() {
  stays_within_scope(token_scope(), leaving(-1, -1))
}

test pays_only_recipients_allows_any_destination_when_empty() {
  pays_only_recipients(
    [output(recipient_address(), assets.from_lovelace(1), NoDatum)],
    account_address(),
    [],
  )
}

test pays_only_recipients_accepts_listed_destinations_and_the_account() {
  pays_only_recipients(
    [
      output(recipient_address(), assets.from_lovelace(1), NoDatum),
      fund_output(assets.from_lovelace(1)),
    ],
    account_address(),
    [recipient_address()],
  )
}

test pays_only_recipients_rejects_an_unlisted_destination() {
  !pays_only_recipients(
    [
      output(
        address.from_verification_key(device_key),
        assets.from_lovelace(1),
        NoDatum,
      ),
    ],
    account_address(),
    [recipient_address()],
  )
}

test pays_only_recipients_compares_the_full_address() {
  let staked = recipient_address() |> address.with_delegation_key(device_key)
  !pays_only_recipients(
    [output(staked, assets.from_lovelace(1), NoDatum)],
    account_address(),
    [recipient_address()],
  )
}

test deposits_carry_no_datum_accepts_the_control_and_plain_deposits() {
  deposits_carry_no_datum(
    [
      control_output(state(), 2_000_000),
      fund_output(assets.from_lovelace(1)),
      output(
        recipient_address(),
        assets.from_lovelace(1),
        DatumHash(device_key),
      ),
    ],
    account_address(),
    script_hash,
    stake_key_hash,
  )
}

test deposits_carry_no_datum_rejects_a_deposit_under_a_datum_hash() {
  !deposits_carry_no_datum(
    [
      control_output(state(), 2_000_000),
      output(account_address(), assets.from_lovelace(1), DatumHash(device_key)),
    ],
    account_address(),
    script_hash,
    stake_key_hash,
  )
}

test deposits_carry_no_datum_rejects_a_deposit_under_an_inline_datum() {
  let data: Data = 42
  !deposits_carry_no_datum(
    [output(account_address(), assets.from_lovelace(1), InlineDatum(data))],
    account_address(),
    script_hash,
    stake_key_hash,
  )
}

test spends_one_control_utxo_accepts_a_single_control_input() {
  spends_one_control_utxo(
    [
      input(0, control_output(state(), 2_000_000)),
      input(1, fund_output(assets.from_lovelace(1))),
    ],
    script_hash,
    stake_key_hash,
  )
}

test spends_one_control_utxo_rejects_two_control_inputs() {
  !spends_one_control_utxo(
    [
      input(0, control_output(state(), 2_000_000)),
      input(1, control_output(state(), 2_000_000)),
    ],
    script_hash,
    stake_key_hash,
  )
}

test spends_one_control_utxo_rejects_no_control_input() {
  !spends_one_control_utxo(
    [input(1, fund_output(assets.from_lovelace(1)))],
    script_hash,
    stake_key_hash,
  )
}

test spends_one_control_utxo_ignores_another_accounts_control_input() {
  !spends_one_control_utxo(
    [
      input(
        0,
        output(
          other_account_address(),
          control_value(other_stake_key_hash, 1),
          state_datum(state()),
        ),
      ),
    ],
    script_hash,
    stake_key_hash,
  )
}

test state_after_spend_reduces_only_the_used_grants_caps() {
  let after = state_after_spend(state(), 1, leaving(500_000, 7))
  let expected = AccountState {
    ..state(),
    grants: [
      Grant { slot: 0, grantee: Ed25519(stranger_key), scope: lovelace_scope() },
      Grant {
        slot: 1,
        grantee: Ed25519(stranger_key),
        scope: Scope { ..token_scope(), cap: 43, lovelace_cap: 1_500_000 },
      },
    ],
  }
  after == expected
}

test state_after_spend_keeps_the_lovelace_cap_of_a_lovelace_grant() {
  let after = state_after_spend(state(), 0, assets.from_lovelace(1_000_000))
  let expected = AccountState {
    ..state(),
    grants: [
      Grant {
        slot: 0,
        grantee: Ed25519(stranger_key),
        scope: Scope { ..lovelace_scope(), cap: 4_000_000 },
      },
      Grant { slot: 1, grantee: Ed25519(stranger_key), scope: token_scope() },
    ],
  }
  after == expected
}

test state_after_spend_leaves_an_unknown_slot_untouched() {
  state_after_spend(state(), 7, leaving(1, 1)) == state()
}

test state_after_spend_keeps_the_scope_on_a_net_deposit() {
  state_after_spend(state(), 1, leaving(-500_000, -7)) == state()
}

test state_after_spend_ignores_a_lovelace_deposit_beside_a_token_withdrawal() {
  let after = state_after_spend(state(), 1, leaving(-500_000, 7))
  let expected = AccountState {
    ..state(),
    grants: [
      Grant { slot: 0, grantee: Ed25519(stranger_key), scope: lovelace_scope() },
      Grant {
        slot: 1,
        grantee: Ed25519(stranger_key),
        scope: Scope { ..token_scope(), cap: 43, lovelace_cap: 2_000_000 },
      },
    ],
  }
  after == expected
}

test carries_state_accepts_the_matching_inline_datum() {
  carries_state(control_output(state(), 1), state())
}

test carries_state_rejects_a_different_state() {
  let changed = AccountState { ..state(), grant_generation: 1 }
  !carries_state(control_output(state(), 1), changed)
}

test carries_state_rejects_a_datum_given_by_hash() {
  let hashed = output(
    account_address(),
    control_value(stake_key_hash, 1),
    DatumHash(stranger_key),
  )
  !carries_state(hashed, state())
}

test carries_no_reference_script_accepts_a_plain_control_output() {
  carries_no_reference_script(control_output(state(), 1))
}

test carries_no_reference_script_rejects_a_reference_script() {
  let weighted = transaction.Output {
    ..control_output(state(), 1),
    reference_script: Some(script_hash),
  }
  !carries_no_reference_script(weighted)
}
