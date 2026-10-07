# Security review

An adversarial review of the account validator, organised by the
vulnerability classes of the Cardano developer portal's smart contract
security curriculum. Every class was attacked with concrete transactions
written as Aiken tests in `validators/attacks.test.ak`; each `attack_` test
asserts that the validator refuses the transaction. The document only
claims what those tests and the reasoning below establish.

## Scope and versions

- Validator: `validators/account.ak`, the multi purpose validator with the
  mint handler (`CreateAccount`, `DeleteAccount`) and the spend handler
  (`Device`, `SpendWithGrant`, `Fund`).
- Libraries: `lib/cardano_account_custody_contract/{types,state,account,grant}.ak`.
- Toolchain: Aiken v1.1.24, Plutus V3, aiken-lang/stdlib v4.0.0.
- Tests: 274 checks under `aiken check -D`, of which 70 live in
  `validators/attacks.test.ak`: 54 `attack_` tests, 1 `trust_assumption_`
  test, 14 `budget_` tests and 1 sanity check of the signature fixture.
  The remaining 204 are the functional suite in
  `validators/account.test.ak` and the `lib/**/*.test.ak` files, several
  of which are cited below where they already cover an attack variant.
- Out of scope: the off-chain transaction builder, key management, and
  the ledger rules the validator relies on (balance, witnesses, datum
  availability, validity interval enforcement). Those rules are named
  where a mitigation depends on them.

Two conventions for the tests: an `attack_` test asserts `!handler(...)`
when the handler returns False, and is declared `fail` when the handler
aborts on an `expect`. Both outcomes make the ledger reject the
transaction in phase two. The `!handler` form is preferred and used
wherever the attack reaches a returned False.

## Threat model

Keys and who holds them:

- Device keys (`AccountState.devices`, up to eight). Held by the owner,
  in the intended deployment derived from a passkey. Any one device key
  has full authority: it can spend every deposit, rewrite the state
  (add or remove devices, issue, revoke or revoke all grants) and delete
  the account. Nothing bounds a device spend except well formedness of
  the new state.
- Stake key (the account's stake credential and the name of its state
  NFT). Held by the owner, in the intended deployment derived from the
  same passkey as the devices. It signs `CreateAccount` and is the only
  key that can withdraw the account's staking rewards or deregister the
  stake credential, which the validator does not constrain. See the
  trust assumption below for what else it can do.
- Grantee keys (`Grant.grantee`). An Ed25519 key hash held by an agent,
  or a secp256k1 public key held by a custody or signing service. A
  grantee can spend only within its grant's scope: the per call cap and
  the remaining cap of one asset, the remaining lovelace cap when that
  asset is not lovelace, nothing of any other asset, before the expiry,
  only to the listed recipients when the list is non empty, and only by
  recreating the state with its own caps reduced. A grantee cannot
  change devices or grants, cannot delete the account, and cannot
  create a control UTxO.
- A dApp or transaction builder with no key. It can assemble and submit
  transactions, add inputs from its own wallet and choose which deposits
  of the account to include, but every path needs one of the keys above.
  For a secp256k1 grantee the builder sees the signature in the
  redeemer; the signature covers the inputs, outputs, fee, validity
  range and mint, so the builder cannot alter any of them.

Trust assumption. `CreateAccount` cannot prove that a state NFT named
after the stake key does not already exist, so whoever holds the stake
key can always mint a parallel control UTxO at the account address with
devices of their choosing, and from then on spend every deposit through
it. Stake key compromise is therefore full account compromise,
independently of the device keys. In the intended deployment the stake
key and the device keys derive from the same passkey, so this adds no
trust beyond what the devices already carry. The test
`trust_assumption_stake_key_holder_mints_a_parallel_control_utxo` records
that the validator accepts such a mint. Off-chain code must check that no
state NFT of the stake key exists before building `CreateAccount`.

The invariant the validator does enforce about its tokens: a state NFT
named N only ever sits at the account address of N (payment script plus
stake key N), in exactly one control UTxO, or is burned
(`account.state_nfts_sit_at_their_own_addresses`, checked on every
creation and on the inputs and outputs of every device and grant spend).

## Double satisfaction

Attack. Two accounts grant the same agent and restrict it to the same
recipient. One 2 ADA output to that recipient is offered as the payout of
both grants and the other 2 ADA go to the attacker. A second variant
spends a deposit of account B with `Fund` while only account A's control
UTxO is in the transaction.

Mitigation. The grant accounting never matches outputs against a claim:
`grant.leaving_value` sums every input at the account's full address and
subtracts every output paid back to it, so each account sees its own net
outflow whatever the other outputs are. Any surplus has to appear in an
output, which `grant.pays_only_recipients` refuses when it is not a
listed recipient, or in the fee, which still counts as leaving. `Fund`
looks for a control UTxO of the deposit's own stake key
(`account.has_control_input`), so another account's control UTxO never
authorises it.

Tests. `attack_double_satisfaction_one_recipient_output_for_two_accounts`
(both handlers return False),
`attack_double_satisfaction_fund_of_another_account_rides_on_this_control`
(`!`). The companion in the functional suite is
`fund_rejects_the_control_utxo_of_another_account`.

## Missing UTxO authentication

Attack. A deposit at the account address carries an inline state naming
the attacker as the only device, or granting the attacker a huge cap,
and is spent on the owner or the agent path. Other variants: the control
UTxO is only a reference input; a token of another policy named after
the stake key hash poses as the state NFT; `DeleteAccount` burns an NFT
whose input sits at a key address.

Mitigation. The control UTxO is identified by the state NFT, not by its
datum: `Device` and `SpendWithGrant` require `account.holds_state_nft` on
the spent input, with the policy id equal to the validator's own script
hash. `Fund` and `DeleteAccount` require the control UTxO among
`inputs`, where the ledger runs its handler, never among
`reference_inputs`. The NFT cannot be forged (see token forgery) and by
the placement invariant it never sits at a key address.

Tests.
`attack_missing_utxo_authentication_forged_control_without_the_nft_device`
(`!`),
`attack_missing_utxo_authentication_forged_control_without_the_nft_grant`
(`fail`: without the NFT among the inputs no output can carry it, and
the handler aborts in `find_control_output`),
`attack_missing_utxo_authentication_fund_with_the_control_as_a_reference_input`
(`!`),
`attack_missing_utxo_authentication_lookalike_nft_from_another_policy`
(`!`),
`attack_missing_utxo_authentication_delete_with_the_nft_at_a_key_address`
(`!`).

## Datum hijacking

Attack. A grant spend recreates the control UTxO with a state that
issues the grantee a new grant, or raises its own cap; moves the NFT and
the state to another account's address; gives the state by hash; and a
device rewrite stores a state padded with an extra constructor field.

Mitigation. On the agent path `grant.carries_state` compares the control
output's inline datum, as data, with `grant.state_after_spend` applied to
the spent state, so only the used grant's caps may differ, and only
downwards. `account.find_control_output` demands exactly one output
holding the NFT at the account address of the spent stake key.
`account.state_datum` and the `expect state: AccountState` in the
validator decode the datum strictly, so a datum with trailing fields
aborts.

Tests. `attack_datum_hijacking_grant_spend_issues_itself_a_grant` (`!`),
`attack_datum_hijacking_grant_spend_raises_its_own_cap` (`!`),
`attack_datum_hijacking_grant_spend_relocates_the_state_to_another_account_address`
(`fail`),
`attack_datum_hijacking_grant_spend_control_datum_given_by_hash` (`!`),
`attack_datum_hijacking_padded_state_datum_on_a_device_rewrite` (`fail`).
Functional companions: `spend_with_grant_rejects_changed_devices`,
`spend_with_grant_rejects_another_grants_caps_changed`,
`spend_with_grant_rejects_reordered_grants`,
`spend_with_grant_rejects_a_changed_grant_generation`.

The datum hijacking of the account's own deposits, where a grant spend
returned the balance to the account address under a datum hash, is the
finding recorded under Locked value.

## Token forgery and other token names

Attack. Mint a state NFT named after the victim's stake key with the
attacker's signature; mint one named after the attacker's stake key into
the victim's address; mint a second NFT of the account during a grant
spend to end up with a control UTxO under the grantee's state; create
the control output at an address whose stake part is a script credential
with the stake key hash's bytes; park a token of another policy named
after the stake key hash on the control output.

Mitigation. The mint handler accepts exactly one asset name per
transaction (`expect [Pair(stake_key_hash, quantity)]`), requires that
name among `extra_signatories` for `CreateAccount`, and requires exactly
one control output at `account.account_address(policy, name)`, whose
stake part is an inline verification key credential only. The control
output's value must satisfy `account.holds_only_lovelace_and_state_nft`
(`assets.has_nft_strict`), which refuses any other token whatever its
name or policy. Re-minting an existing account is the trust assumption
above and cannot be refused on chain.

Tests. `attack_token_forgery_victims_name_with_the_attackers_signature`
(`!`), `attack_token_forgery_attackers_name_into_the_victims_address`
(`fail`), `attack_token_forgery_second_nft_minted_during_a_grant_spend`
(both handlers return False),
`attack_token_forgery_create_account_with_a_script_stake_credential`
(`fail`),
`attack_token_forgery_lookalike_token_named_after_the_stake_key_on_the_control`
(`!`), `trust_assumption_stake_key_holder_mints_a_parallel_control_utxo`
(accepted, by design). Functional companions:
`create_account_rejects_a_quantity_of_two`,
`create_account_rejects_two_asset_names_under_the_policy`,
`create_account_rejects_a_burn_beside_the_mint`.

## Other redeemer

Attack. Spend the control UTxO with `Fund`, the redeemer that carries no
authorisation; spend a plain deposit with `Device`; spend a deposit
carrying a forged state with `SpendWithGrant`; delete the account with
the control UTxO spent on the agent path; use `CreateAccount` on a burn
and `DeleteAccount` on a mint.

Mitigation. `Fund` requires that the spent input does not hold the NFT
and `Device` and `SpendWithGrant` require that it does, so each redeemer
is tied to one kind of UTxO. `Device` and `SpendWithGrant` require a
datum that decodes as `AccountState`. `SpendWithGrant` requires a control
output holding the NFT, which a burn makes impossible, so the agent path
can never accompany `DeleteAccount`. The mint handler matches the
redeemer against the minted quantity: `(CreateAccount, 1)` and
`(DeleteAccount, -1)` only.

Tests. `attack_other_redeemer_fund_on_the_control_utxo` (`!`),
`attack_other_redeemer_device_on_a_plain_deposit` (`fail`),
`attack_other_redeemer_grant_on_a_deposit_with_a_forged_state` (`!`),
`attack_other_redeemer_delete_account_with_the_control_spent_by_grant`
(`fail`), `attack_other_redeemer_mint_redeemers_swapped` (`!`).

## Missed input validation

Attack. The grantee pays exactly the per call cap and lets the account
pay the fee; drains lovelace from the control UTxO on top of the cap;
uses a grant scoped to one asset name to move a sibling asset name under
the same policy; pays part of a spend within the per call cap to the
bare script address to dodge the recipient list; and the owner path is
asked to store grants with a negative cap, no expiry, a lovelace cap on
a lovelace scope, or two grants in one slot.

Mitigation. `grant.leaving_value` is a net sum over the full account
address, so the fee and the control UTxO's own lovelace count as leaving
and the per call cap in `grant.stays_within_scope` is the rule that
refuses both the fee and the control drain attempts; the recreated state
in those tests carries the correct cap decrement, so nothing else
refuses them. The scoped asset is compared as a full asset class, policy
id and asset name, and `nothing_else_leaves` refuses any other class
with a positive outflow. The bare script address differs from the
account address, so an output there counts as leaving and must be a
listed recipient; the test keeps the outflow within the per call cap, so
`grant.pays_only_recipients` is the only rule that refuses it.
`state.is_well_formed` is applied to every state written on the owner
path and at creation.

Tests.
`attack_missed_input_validation_fee_paid_by_the_account_beyond_the_cap`
(`!`),
`attack_missed_input_validation_control_lovelace_drained_beyond_the_cap`
(`!`),
`attack_missed_input_validation_token_grant_leaks_a_sibling_asset_name`
(`!`), `attack_missed_input_validation_change_to_the_bare_script_address`
(`!`), `attack_missed_input_validation_ill_formed_grants_on_a_device_rewrite`
(`!` for each of the four states). Functional companions:
`spend_with_grant_rejects_one_lovelace_above_the_per_call_cap`,
`spend_with_grant_rejects_spending_above_the_remaining_cap`,
`spend_with_grant_rejects_lovelace_above_the_lovelace_cap_on_a_token_grant`,
`spend_with_grant_rejects_a_foreign_asset_leaving`,
`spend_with_grant_rejects_a_cap_raised_by_a_net_deposit`.

## Time handling

Attack. A grant spend with no upper bound; a lower bound past the expiry
and no upper bound; an exclusive upper bound one past the expiry, which
covers the same instants as an inclusive bound at the expiry; a
degenerate range whose upper bound is negative infinity.

Mitigation. `grant.ends_before_expiry` accepts only a `Finite` upper
bound whose value is at most `expires_at`, regardless of inclusiveness,
so an exclusive bound at `expires_at + 1` is refused although it is
equivalent; this is the conservative reading. The lower bound is not
consulted: it cannot extend the range past the upper bound, and the
ledger refuses any transaction whose range does not contain the current
slot. The bound is compared in POSIX milliseconds, the unit of
`expires_at`.

Tests. `attack_time_handling_no_upper_bound` (`!`),
`attack_time_handling_lower_bound_past_expiry_with_no_upper_bound` (`!`),
`attack_time_handling_exclusive_upper_bound_one_past_expiry` (`!`),
`attack_time_handling_negative_infinity_upper_bound` (`!`). Functional
companions: `spend_with_grant_rejects_a_validity_range_ending_after_the_expiry`,
`spend_with_grant_accepts_a_validity_range_ending_at_the_expiry`.

## Unbounded datum, inputs and value

Attack. A device rewrite or an account creation storing seventeen
grants, nine devices or a grant with nine recipients; a bundle of tokens
under twenty policies parked on the control output at creation; twenty
deposits spent at once without the control UTxO.

Mitigation. `state.is_well_formed` bounds the state to `max_devices`
(8), `max_grants` (16) and `max_recipients` (8) and is applied on every
write of the state. `assets.has_nft_strict` keeps every token but the
state NFT off the control output on every path. Deposits are not bounded
in number, but every one of them needs the control UTxO in the same
transaction and pays for its own handler execution; the cost of many
deposits is quantified under Resource exhaustion.

Tests. `attack_unbounded_datum_seventeen_grants_on_a_device_rewrite`,
`attack_unbounded_datum_nine_devices_on_a_device_rewrite`,
`attack_unbounded_datum_nine_recipients_on_a_device_rewrite`,
`attack_unbounded_datum_seventeen_grants_at_creation`,
`attack_unbounded_value_token_bundle_on_the_control_at_creation`,
`attack_unbounded_inputs_deposits_spent_without_a_control` (all `!`).
Functional companions: `device_rejects_extra_tokens_on_the_control_output`,
`spend_with_grant_rejects_extra_tokens_on_the_control_output`, and the
bound tests in `lib/cardano_account_custody_contract/state.test.ak`.

## UTxO contention

Reasoning, no rejection test is possible. Every owner and agent
operation spends the one control UTxO, so two operations on the same
account cannot be in flight at once: the second is rejected by the
ledger as a double spend and must be rebuilt. This is a liveness
property, not a safety one; nothing an attacker without a key can do
causes the control UTxO to be spent. A grantee, however, may submit a
grant spend with a net outflow of zero, which leaves the state byte for
byte identical and is accepted, and may do so repeatedly to keep the
control UTxO moving and race the owner's revoke. The loss is bounded by
the caps the owner granted and ends when the owner's rewrite lands. The
validator refuses to spend two control UTxOs of one account in a grant
spend (`grant.spends_one_control_utxo`, test
`spend_with_grant_rejects_two_control_utxos_of_the_account`), so the
accounting always runs over a single state. That rule is defence in
depth and no test isolates it: a second control UTxO among the inputs
brings a second state NFT that the single control output cannot take
back, so `nothing_else_leaves` already refuses the transaction.

## Locked value

Attack. A grant spend pays the whole balance back to the account address
under a datum hash, or under an inline datum; a grant spend sends the
balance to the bare script address; a device rewrite removes every
device; an account is created without devices.

Mitigation. The datum hash case was a live finding, fixed by
`grant.deposits_carry_no_datum`: on the agent path every output at the
account address that does not hold the state NFT must carry `NoDatum`.
A script output under a datum hash can only be spent by whoever supplies
the preimage, and none of it counts as leaving, so without the rule a
grantee with any cap at all could put the entire balance beyond reach.
Inline datums are refused by the same rule: a deposit has no use for one.
The Device path is deliberately exempt from `deposits_carry_no_datum`:
the owner has unrestricted authority over the account and may tag
deposits with a datum. The bare script address is not the account
address, so sending the whole balance there counts as leaving and the
per call cap is what refuses it; with a recipient list the destination
is refused as well, and through an open grant the loss stays bounded by
the caps. `state.is_well_formed` requires at least one device on every
write and at creation.

What remains possible and is accepted: a grant with an empty recipient
list may send up to its caps to any address, including unspendable ones;
a device may send anything anywhere; the owner may delete the account
while deposits remain, after which the deposits need a new control UTxO,
which the stake key holder can always create; a deposit made by a third
party under a datum hash without a known preimage is that party's own
loss. Deposits sent to the script address with no stake part or with a
stake part other than an inline verification key can never be spent, on
any path, because `account.stake_key_hash_of` aborts; that is an
off-chain obligation (see recommendations).

Tests. `attack_locked_value_grant_spend_deposits_under_a_datum_hash`
(`!`), `attack_locked_value_grant_spend_deposits_under_an_inline_datum`
(`!`),
`attack_locked_value_grant_spend_sends_the_balance_to_the_bare_script_address`
(`!`), `attack_locked_value_device_rewrite_removes_every_device` (`!`),
`attack_locked_value_account_created_without_devices` (`!`). Unit tests
of the new rule: `deposits_carry_no_datum_*` in
`lib/cardano_account_custody_contract/grant.test.ak`.

## Staking and certificates

Reasoning, no test is possible: the validator does not inspect
certificates or withdrawals, and its `else` handler fails for every
script purpose other than mint and spend, so the script hash can never
act as a stake credential, a DRep or a committee member. The account's
stake credential is the user's own verification key. Any reward
withdrawal or certificate for that credential needs the stake key
witness, which the ledger checks and which no device or grantee holds.
A withdrawal from an unrelated reward account added to an agent
transaction only adds value that must balance into the outputs or the
fee, both of which the grant accounting and the secp256k1 message cover;
for an Ed25519 grantee the whole transaction body is signed anyway. The
grantee message deliberately omits certificates and withdrawals for this
reason, as documented in the README.

## Evaluation order

Reasoning plus one test. Every check in both handlers is a conjunction
(`and { .. }`) preceded by `expect` bindings; `and` short circuits on the
first False and `expect` aborts, so no later check can rescue an earlier
failure and there is no path on which a check is skipped. The only
dependence between handlers is that `Fund` relies on the control UTxO's
own handler to do the accounting. The test
`attack_evaluation_order_fund_passes_only_together_with_the_control_spend`
shows `Fund` returning True while the control UTxO's `Device` handler
returns False for lack of a device signature; the ledger accepts a
transaction only when every script passes, so the order in which they
run is irrelevant. The mint handler likewise relies on the control
input's spend handler for the device signature on `DeleteAccount`.

## Signature replay across transactions, accounts and networks

Attack. The fixture secp256k1 signature, which authorises one specific
transaction, is presented for the control UTxO the account has after
that spend; for another account that grants the same key with its
control UTxO at the same output index; with an extra input, a different
fee, a different validity range, or a mint added; and in its high s
form. An Ed25519 key granted by one account signs a spend from another
account under the same slot number.

Mitigation. `grant.grantee_message` hashes the domain prefix, the spent
control output reference, every input's output reference, the outputs,
the fee, the validity range and the mint. The control output reference
is consumed by the spend, so a signature authorises exactly one
transaction; the outputs include the recreated control output at the
account's own address, so the same bytes cannot serve another account.
The secp256k1 builtin accepts low s signatures only, so a signature has
one valid form. An Ed25519 grantee signs the transaction itself, which
the ledger binds to its inputs, and is looked up in the state of the
control UTxO being spent.

Across networks: the message carries no network identifier and Plutus
addresses carry none either. The binding is transitive: the control
output reference is the hash of the transaction that created the control
UTxO, whose inputs chain back to a genesis UTxO that differs between
networks, so no output reference exists on two networks. A direct
network discriminator in the domain prefix would make this explicit and
is listed under recommendations.

Tests. `attack_signature_replay_same_signature_on_a_later_control_utxo`,
`attack_signature_replay_same_signature_for_another_accounts_grant`,
`attack_signature_replay_same_signature_with_an_extra_input`,
`attack_signature_replay_same_signature_with_a_different_fee`,
`attack_signature_replay_same_signature_with_a_different_validity_range`,
`attack_signature_replay_same_signature_with_a_mint_added`,
`attack_signature_replay_high_s_form_of_the_signature`,
`attack_signature_replay_ed25519_grantee_of_another_account` (all `!`).
`the_fixture_signature_still_authorises_its_own_transaction` confirms the
fixture is a valid signature, so the rejections are not artefacts.
Functional companion:
`spend_with_grant_rejects_a_secp256k1_signature_over_another_transaction`.

## Dust attacks

Attack. An attacker dusts the account with tokens under three policies.
A grant spend over the dusted deposit returns all but one unit of dust,
or pushes the dust onto the control output.

Mitigation. `grant.stays_within_scope` refuses a positive outflow of any
asset class but the scoped one and lovelace, down to a single unit, and
`assets.has_nft_strict` keeps dust off the control output. Dust can
therefore only be moved by a device, and a grantee that includes a
dusted deposit must return every unit of it. The owner's cost is the fee
of sweeping; the attacker's cost is the minimum lovelace of every dust
UTxO, which the owner recovers. Dust deposits carrying a state shaped
datum are the forged control case under Missing UTxO authentication.

Tests. `attack_dust_attack_grant_spend_keeps_one_unit_of_dust` (`!`),
`attack_dust_attack_dust_pushed_onto_the_control_output` (`!`).

## Resource exhaustion

The `budget_` tests build the largest well formed state (eight devices,
sixteen grants, eight recipients each, every key 28 bytes), which
serialises to 6669 bytes of CBOR
(`budget_largest_state_datum_stays_within_the_transaction_size_limit`),
and run the heaviest handlers over it. `aiken check` reports the
execution units below. Each figure includes the cost of building the
fixture, which the `budget_baseline_` tests measure on their own, and
excludes the on-chain cost of decoding the script context, which the
test harness does not charge. The net figures are therefore indicative
and must be confirmed on preprod with the real transaction builder.
The mainnet limit per transaction is 14,000,000 memory units and
10,000,000,000 CPU steps.

| Test | mem | cpu | baseline mem | net mem |
| --- | --- | --- | --- | --- |
| `budget_largest_state_grant_spend_ed25519` (9 inputs) | 6,879,111 | 2,235,675,352 | 1,075,060 | 5.8 M |
| `budget_largest_state_grant_spend_secp256k1` (2 inputs) | 6,260,482 | 2,939,080,448 | 953,768 | 5.3 M |
| `budget_largest_state_device_rewrite` | 10,844,889 | 3,279,811,158 | 754,965 | 10.1 M |
| `budget_largest_state_account_creation` | 6,071,349 | 1,845,743,437 | 387,226 | 5.7 M |
| `budget_largest_state_fund_spend_among_eight_deposits` | 1,181,480 | 355,342,806 | 1,075,060 | 0.1 M |
| `budget_grant_spend_over_forty_deposits` (small state) | 5,658,081 | 1,855,639,338 | 1,149,070 | 4.5 M |
| `budget_fund_spend_among_forty_deposits` | 1,368,334 | 436,824,171 | 1,149,070 | 0.2 M |

Observations.

- The device rewrite over the largest state is the heaviest single
  execution at about 10.1 M memory units net, 72 percent of the
  transaction limit, driven by decoding the largest state twice (the
  spent datum and the recreated one) and checking well formedness. It
  fits, so the owner can always rewrite or shrink such a state, but
  only a few `Fund` executions fit beside it. This is the one budget
  concern found; the parameters `max_grants` and `max_recipients` in
  `state.ak` are the levers if on-chain measurement shows it too tight.
- A grant spend with 40 deposits costs about 4.5 M memory units for the
  control UTxO's handler plus about 0.2 M for each of the 40 `Fund`
  executions, about 12.5 M in total, which is close to the limit. Around
  30 deposits per grant spend is a provisional batch size pending
  on-chain measurement; the off-chain builder must batch larger sweeps.
- Complexity. `grant.leaving_value` folds `assets.merge` over the
  inputs and outputs at the address; each merge is linear in the number
  of asset entries of both operands, so the whole fold is linear in the
  total number of entries, not quadratic. `account.own_input` and
  `account.has_control_input` are linear scans of the inputs run once
  per `Fund` execution, so the total work of a transaction with n
  deposits grows with n squared; the measured growth is from 0.1 M to
  0.2 M memory units per `Fund` execution between 9 and 41 inputs.
  `state.is_well_formed` uses `list.unique`, which is quadratic, over
  lists bounded at 8 and 16. `grant.pays_only_recipients` is linear in
  outputs times at most 8 recipients.
  `account.state_nfts_sit_at_their_own_addresses` is one dictionary
  lookup per input or output. No helper is unbounded in anything the
  attacker controls except the number of inputs and outputs, which the
  transaction size limit bounds and the submitter pays for.

Reference scripts. Every transaction that spends a UTxO pays a fee for
the size of the reference script the UTxO holds. A grantee could attach
a large reference script to the control output it recreates and so
raise the cost of the owner's next spend; the owner could only shed it
by paying that fee once. `grant.carries_no_reference_script`, called
from the `SpendWithGrant` branch of `validators/account.ak`, requires
the recreated control output to carry no reference script. Tests:
`attack_resource_exhaustion_reference_script_on_the_control_output`
(`!`), `spend_with_grant_rejects_a_reference_script_on_the_control_output`,
and the `carries_no_reference_script_*` unit tests in
`lib/cardano_account_custody_contract/grant.test.ak`. Deposits a grant
spend pays back to the account may still carry one, since the owner
chooses which deposits to spend, and the owner's own path is not
constrained.

## Findings that required a code change

1. A grantee could lock the whole balance. `SpendWithGrant` exempted
   every output at the account address from the recipient check and
   counted it as returned, whatever its datum. A grant spend could
   therefore pay every deposit back to the account address under a
   datum hash with no known preimage: nothing counted as leaving, the
   caps stayed untouched, and the funds became unspendable on every
   path, because the ledger refuses to run a script on an input whose
   datum hash has no preimage in the witness set. The exploit was
   reproduced against the committed validator before the fix. Fix:
   `grant.deposits_carry_no_datum`, called from the `SpendWithGrant`
   branch of `validators/account.ak`, requires every output at the
   account address that does not hold the state NFT to carry `NoDatum`.
   Tests: `attack_locked_value_grant_spend_deposits_under_a_datum_hash`,
   `attack_locked_value_grant_spend_deposits_under_an_inline_datum`, and
   the `deposits_carry_no_datum_*` unit tests. `plutus.json` was
   regenerated.
2. A grantee could raise the owner's fees. `SpendWithGrant` accepted a
   control output with a reference script attached, and every later
   spend of the control UTxO would have paid for that script's size.
   Fix: `grant.carries_no_reference_script`, called from the
   `SpendWithGrant` branch of `validators/account.ak`, requires the
   recreated control output to carry no reference script. Tests:
   `attack_resource_exhaustion_reference_script_on_the_control_output`,
   `spend_with_grant_rejects_a_reference_script_on_the_control_output`
   and the `carries_no_reference_script_*` unit tests. `plutus.json` was
   regenerated.

No other attack succeeded.

## Residual risks and recommendations

- Audit before mainnet. This review is internal and test driven; an
  independent audit should precede any mainnet deployment. The contract
  is testnet only at this stage.
- Stake key custody. Stake key compromise is account compromise
  (trust assumption). Keep the stake key under the same protection as
  the devices, and never delegate the ability to sign with it.
- Off-chain obligations. Check that no state NFT of the stake key exists
  before `CreateAccount`. Only ever pay to the account's full address,
  with the inline verification key stake part; funds at the bare script
  address or under any other stake part are unspendable. When building
  a secp256k1 grant spend, validate key, message and signature lengths
  before submission, since the builtin errors rather than returns False.
  Batch sweeps of many deposits to stay within the execution budget.
- Parameter choices. `max_grants` 16 and `max_recipients` 8 put the
  heaviest owner operation at about 72 percent of the memory budget in
  the test harness. Measure on preprod with real transactions; lower
  one of the two bounds if the on-chain figure, which includes context
  decoding, approaches the limit. Grant caps and expiries are the
  owner's choice; a grant with an empty recipient list lets the grantee
  send up to its caps anywhere, including unspendable addresses, and a
  recipient that is a script address makes the funds subject to that
  script's datum, so prefer key addresses as recipients.
- One control UTxO serialises every operation. Owner and agent
  operations on an account cannot run concurrently, a grantee can churn
  the control UTxO with zero outflow spends, and a revoke races the
  grantee's pending spends; caps bound the exposure. If concurrency
  matters, the design would need separate per grant UTxOs, which is a
  different contract.
- No rolling period caps. A grant has a per call cap, a cumulative cap
  and an expiry, nothing per day or per epoch. A grantee can exhaust the
  cumulative cap at once, in as many transactions as the per call cap
  requires. Issue grants with the cumulative cap sized to the tolerable
  loss, and short expiries, and re-issue rather than over-grant.
- Grantee key validation. The validator does not check that an Ed25519
  grantee hash is 28 bytes or a secp256k1 key 33 bytes; an ill sized key
  only makes the grant unusable. Validate off-chain when issuing.
- Signature message domain. The secp256k1 message is bound to the
  network only transitively, through the control output reference. A
  future revision of the message domain could add an explicit network or
  chain discriminator; doing so changes the message for every signer and
  would need a new domain string.
- Deposit fragmentation. A grantee may split the balance into many
  deposits at the account address, raising the owner's sweeping cost.
  Caps do not bound this since nothing leaves; the owner's remedy is to
  revoke the grant and sweep.
- Accepted and harmless. A grantee may mint its own account in the same
  transaction as a grant spend: the mint handler demands the grantee's
  own stake key signature and a control output at the grantee's own
  account address, and this account's accounting is unaffected. An
  output to the account script with a pointer stake credential is not
  the account address, so it counts as leaving and is refused by a
  recipient list; under an empty list it is bounded by the caps like
  any other destination. An inverted validity range, with a lower bound
  above a finite upper bound no later than the expiry, is accepted by
  the validator but can never apply on the ledger, since no slot lies
  within it.
