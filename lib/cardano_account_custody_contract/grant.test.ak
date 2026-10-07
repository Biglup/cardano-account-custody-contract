use aiken/interval
use cardano/address
use cardano/assets.{Assets}
use cardano/transaction.{DatumHash, InlineDatum, NoDatum}
use cardano_account_custody_contract/grant.{
  carries_no_reference_script, carries_state, deposits_carry_no_datum,
  ends_before_expiry, is_authorised_by_grantee, leaving_value,
  pays_only_recipients, quantity_of_asset, spends_one_control_utxo,
  state_after_spend, stays_within_scope,
}
use cardano_account_custody_contract/test_helpers.{
  account_address, control_output, control_value, device_key, fund_output, input,
  other_account_address, other_stake_script_hash, output, recipient_address,
  script_hash, stake_script_hash, state_datum, stranger_key,
}
use cardano_account_custody_contract/types.{AccountState, Asset, Grant, Scope}

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
    lovelace_per_call_cap: 1_000_000,
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
    lovelace_per_call_cap: 0,
    lovelace_cap: 0,
  }
}

fn state() -> AccountState {
  AccountState {
    devices: [device_key],
    grants: [
      Grant { slot: 0, grantee: stranger_key, scope: lovelace_scope() },
      Grant { slot: 1, grantee: stranger_key, scope: token_scope() },
    ],
    grant_generation: 0,
  }
}

fn leaving(lovelace: Int, tokens: Int) -> Assets {
  assets.merge(assets.from_lovelace(lovelace), token(tokens))
}

test is_authorised_by_grantee_accepts_a_required_signer() {
  is_authorised_by_grantee(stranger_key, [device_key, stranger_key])
}

test is_authorised_by_grantee_rejects_a_grantee_that_did_not_sign() {
  !is_authorised_by_grantee(stranger_key, [device_key])
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
  stays_within_scope(token_scope(), leaving(1_000_000, 10))
}

test stays_within_scope_rejects_one_above_the_per_call_cap() {
  !stays_within_scope(token_scope(), leaving(0, 11))
}

test stays_within_scope_rejects_more_than_the_remaining_cap() {
  let nearly_spent = Scope { ..token_scope(), cap: 5 }
  !stays_within_scope(nearly_spent, leaving(0, 6))
}

test stays_within_scope_accepts_the_lovelace_per_call_cap_exactly() {
  stays_within_scope(token_scope(), leaving(1_000_000, 0))
}

test stays_within_scope_rejects_one_above_the_lovelace_per_call_cap() {
  !stays_within_scope(token_scope(), leaving(1_000_001, 0))
}

test stays_within_scope_rejects_lovelace_above_the_remaining_lovelace_cap() {
  let nearly_spent = Scope { ..token_scope(), lovelace_cap: 500_000 }
  !stays_within_scope(nearly_spent, leaving(500_001, 0))
}

test stays_within_scope_ignores_the_lovelace_caps_for_a_lovelace_scope() {
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
    stake_script_hash,
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
    stake_script_hash,
  )
}

test deposits_carry_no_datum_rejects_a_deposit_under_an_inline_datum() {
  let data: Data = 42
  !deposits_carry_no_datum(
    [output(account_address(), assets.from_lovelace(1), InlineDatum(data))],
    account_address(),
    script_hash,
    stake_script_hash,
  )
}

test spends_one_control_utxo_accepts_a_single_control_input() {
  spends_one_control_utxo(
    [
      input(0, control_output(state(), 2_000_000)),
      input(1, fund_output(assets.from_lovelace(1))),
    ],
    script_hash,
    stake_script_hash,
  )
}

test spends_one_control_utxo_rejects_two_control_inputs() {
  !spends_one_control_utxo(
    [
      input(0, control_output(state(), 2_000_000)),
      input(1, control_output(state(), 2_000_000)),
    ],
    script_hash,
    stake_script_hash,
  )
}

test spends_one_control_utxo_rejects_no_control_input() {
  !spends_one_control_utxo(
    [input(1, fund_output(assets.from_lovelace(1)))],
    script_hash,
    stake_script_hash,
  )
}

test spends_one_control_utxo_ignores_another_accounts_control_input() {
  !spends_one_control_utxo(
    [
      input(
        0,
        output(
          other_account_address(),
          control_value(other_stake_script_hash, 1),
          state_datum(state()),
        ),
      ),
    ],
    script_hash,
    stake_script_hash,
  )
}

test state_after_spend_reduces_only_the_used_grants_caps() {
  let after = state_after_spend(state(), 1, leaving(500_000, 7))
  let expected = AccountState {
    ..state(),
    grants: [
      Grant { slot: 0, grantee: stranger_key, scope: lovelace_scope() },
      Grant {
        slot: 1,
        grantee: stranger_key,
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
        grantee: stranger_key,
        scope: Scope { ..lovelace_scope(), cap: 4_000_000 },
      },
      Grant { slot: 1, grantee: stranger_key, scope: token_scope() },
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
      Grant { slot: 0, grantee: stranger_key, scope: lovelace_scope() },
      Grant {
        slot: 1,
        grantee: stranger_key,
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
    control_value(stake_script_hash, 1),
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
