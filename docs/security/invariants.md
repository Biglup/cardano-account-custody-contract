# Invariants

The properties the validators enforce. Each is one sentence, followed by
the validator and the functions that enforce it. Terms are defined in the
[glossary](../glossary.md).

The first two sections hold whatever logic an account names. The third
holds only while an account names `logic_v1`. The last section lists what
any logic must enforce, since the proxy leaves it every other rule.

Paths used below:

- Proxy: [validators/account.ak](../../validators/account.ak)
- Stake script: [validators/account_stake.ak](../../validators/account_stake.ak)
- Logic: [validators/logic_v1.ak](../../validators/logic_v1.ak)
- Library: [account.ak](../../lib/cardano_account_custody_contract/account.ak),
  [logic.ak](../../lib/cardano_account_custody_contract/logic.ak),
  [rules.ak](../../lib/cardano_account_custody_contract/rules.ak),
  [grant.ak](../../lib/cardano_account_custody_contract/grant.ak),
  [state.ak](../../lib/cardano_account_custody_contract/state.ak)

## The proxy

**INV-1.** A state NFT name is 28 bytes, the account's stake script
hash, and a grant token name is 32 bytes, that hash followed by the slot
as 4 big endian bytes.
Proxy `mint`;
[`account.is_state_nft_name`, `account.is_grant_name`, `account.grant_token_name`, `account.account_of_name`](../../lib/cardano_account_custody_contract/account.ak).

**INV-2.** `CreateAccount` mints exactly one token under the policy, a 28
byte name in quantity one.
[Proxy `mint`, `CreateAccount` arm](../../validators/account.ak).

**INV-3.** `IssueGrants` mints only 32 byte grant names of one account in
quantity one each, and `BurnGrants` burns only such names in quantity
minus one each.
[Proxy `mints_grants_of_one_account`](../../validators/account.ak);
[`account.mints_grants_of`](../../lib/cardano_account_custody_contract/account.ak).

**INV-4.** No transaction burns a state NFT, so a minted state NFT exists
for good.
[Proxy `mint`](../../validators/account.ak), from INV-2 and INV-3.

**INV-5.** A state NFT is minted only beside a publish redeemer for a
certificate registering the stake credential of the same name, which
exists only when the stake script ran on that certificate.
[Proxy `mint`](../../validators/account.ak);
[`account.registers_stake_credential`, `account.registers_credential`](../../lib/cardano_account_custody_contract/account.ak).

**INV-6.** At creation, the state NFT lands in exactly one control output
at its own account address, holding only lovelace and the NFT, under an
inline datum, with no reference script.
[Proxy `mint`](../../validators/account.ak);
[`account.find_control_output`, `account.holds_only_lovelace_and_state_nft`](../../lib/cardano_account_custody_contract/account.ak).

**INV-7.** At creation, field 0 of the control datum is a 28 byte hash and
the transaction withdraws from that credential.
[Proxy `mint`](../../validators/account.ak);
[`account.logic_of`, `account.is_script_hash`, `account.withdraws_from`](../../lib/cardano_account_custody_contract/account.ak).

**INV-8.** In every creation, every issuance and every spend of a UTxO
holding a token of the policy, each account token among the outputs sits
in quantity one at the account address its name denotes.
[Proxy `mint` and `spend`](../../validators/account.ak);
[`account.tokens_sit_at_their_own_addresses`](../../lib/cardano_account_custody_contract/account.ak).

**INV-9.** When a UTxO holding a state NFT is spent, exactly one output
holds that NFT, at the same account address, with only lovelace beside
it, under an inline datum, with no reference script.
[Proxy `spend`](../../validators/account.ak);
[`account.keeps_control_output`](../../lib/cardano_account_custody_contract/account.ak).

**INV-10.** Every spend except `Fund`, and every `IssueGrants` or
`BurnGrants` mint, requires the account's control UTxO exactly once among
the inputs and reference inputs and a withdrawal from the logic named in
field 0 of its datum.
[Proxy `runs_the_logic`](../../validators/account.ak);
[`account.find_present_control`, `account.logic_of`, `account.withdraws_from`](../../lib/cardano_account_custody_contract/account.ak).

**INV-11.** A `Fund` spend is accepted only for a UTxO holding no token of
the policy, beside an input holding a token of the same account at the
same full address when the UTxO has no datum, and beside the spent
control UTxO of the same account when it has one.
[Proxy `spend`, `Fund` arm](../../validators/account.ak);
[`account.holds_no_account_token`, `account.has_account_token_input`, `account.has_control_input`](../../lib/cardano_account_custody_contract/account.ak).

**INV-12.** A UTxO at a proxy address whose stake part is not an inline
script credential cannot be spent under any redeemer.
[Proxy `spend`](../../validators/account.ak);
[`account.stake_script_hash_of`](../../lib/cardano_account_custody_contract/account.ak).

**INV-13.** The proxy fails for every purpose other than `mint` and
`spend`.
[Proxy `else`](../../validators/account.ak).

## The stake script

**INV-14.** A registration of the account's stake credential, alone or
with a delegation, needs the owner's signature, exactly one state NFT of
that credential minted, and the owner among the devices of the single
control output holding it.
[Stake script `publish`, `creates_the_account`, `lists_the_owner_as_a_device`](../../validators/account_stake.ak).

**INV-15.** A withdrawal of any amount from the account's reward account,
and a delegation of its stake credential to a pool, a DRep or both, needs
the signature of a device listed in field 1 of the account's control
datum, spent or referenced.
[Stake script `withdraw` and `publish`](../../validators/account_stake.ak);
[`account.is_authorised_by_a_device`, `account.find_control_input`, `account.devices_of`](../../lib/cardano_account_custody_contract/account.ak).

**INV-16.** The stake script refuses every other certificate,
deregistration included, and fails for every purpose other than
`withdraw` and `publish`.
[Stake script `publish` and `else`](../../validators/account_stake.ak).

**INV-17.** Each account is created at most once: its state NFT needs a
registration of its stake credential, the ledger refuses a second
registration, and the stake script refuses the deregistration that would
allow one.
[Proxy `mint`](../../validators/account.ak);
[stake script `publish`](../../validators/account_stake.ak).

## `logic_v1`

These hold while an account names `logic_v1`. They are rules of that
version, not of the contract as a whole.

### Dispatch

**INV-18.** `logic_v1` accepts a transaction only when it finds exactly
one control UTxO naming it, spent or referenced, or none at all, so it
serves one account per transaction.
[Logic `withdraw`](../../validators/logic_v1.ak);
[`logic.is_own_control`](../../lib/cardano_account_custody_contract/logic.ak).

**INV-19.** `logic_v1`'s `publish` accepts only the registration of a
script credential, so its credential, once registered, stays registered.
[Logic `publish`](../../validators/logic_v1.ak);
[`logic.publish`](../../lib/cardano_account_custody_contract/logic.ak).

### Owner path

**INV-20.** On the owner path, the control UTxO carries `Device`, holds
the state NFT, and a device listed in the spent state signs.
[`logic.validates_owner_transaction`](../../lib/cardano_account_custody_contract/logic.ak);
[`rules.device_rule`](../../lib/cardano_account_custody_contract/rules.ak).

**INV-21.** On the owner path, every input at the account address carries
`Device`, `Fund` or `SweepGrant`, and `SpendWithGrant` is refused.
[`logic.validates_owner_transaction`, `logic.validates_spends`](../../lib/cardano_account_custody_contract/logic.ak).

**INV-22.** On the owner path, every control output naming `logic_v1` sits
at the spent account's address.
[`logic.validates_owner_transaction`](../../lib/cardano_account_custody_contract/logic.ak).

**INV-23.** On the owner path, every account token among the inputs and
the outputs sits at its own account address.
[`rules.device_rule`](../../lib/cardano_account_custody_contract/rules.ak).

**INV-24.** A control output that stays under `logic_v1` holds only
lovelace and the state NFT, carries a well formed state, keeps or raises
the generation, and moves the next slot by the grant tokens minted and
the outstanding count by those minted less those burned.
[`rules.recreates_control_output`](../../lib/cardano_account_custody_contract/rules.ak);
[`account.grant_mint_delta`](../../lib/cardano_account_custody_contract/account.ak);
[`state.is_well_formed`](../../lib/cardano_account_custody_contract/state.ak).

**INV-25.** A control output naming another logic needs a withdrawal from
that logic and nothing minted or burned under the policy.
[`rules.recreates_control_output`](../../lib/cardano_account_custody_contract/rules.ak).

**INV-26.** An issuance is signed by a device and mints the grant tokens
of the next slots in order, each into exactly one output at the account
address that holds only lovelace and that token, carries no reference
script, and carries an inline grant of that slot, of the recreated
generation, with a well formed scope.
[`rules.issue_grants_rule`, `rules.issues_grant`](../../lib/cardano_account_custody_contract/rules.ak);
[`state.is_grant_well_formed`](../../lib/cardano_account_custody_contract/state.ak).

**INV-27.** A burn is signed by a device and burns only grant tokens of
the account, in quantity minus one.
[`rules.burn_grants_rule`](../../lib/cardano_account_custody_contract/rules.ak).

**INV-28.** A sweep spends a grant UTxO holding only lovelace and its
token, signed by a device, burns that token, and is accepted only when
the grant is dead against the spent state.
[`rules.sweep_rule`](../../lib/cardano_account_custody_contract/rules.ak);
[`grant.is_dead`](../../lib/cardano_account_custody_contract/grant.ak).

**INV-29.** A grant is dead when its generation is older than the
account's or its slot is revoked, read from the stable prefix of its
datum, or, only when the datum decodes as a full grant, when the
validity range starts at a finite time strictly after its expiry.
[`grant.is_dead`, `grant.starts_after_expiry`](../../lib/cardano_account_custody_contract/grant.ak);
[`account.grant_slot_of`, `account.grant_generation_of`](../../lib/cardano_account_custody_contract/account.ak).

### Agent path

**INV-30.** On the agent path, nothing is minted or burned under the
policy, no control output names `logic_v1`, and every input at the
account address carries `Fund` or `SpendWithGrant`.
[`logic.validates_agent_transaction`, `logic.validates_spends`](../../lib/cardano_account_custody_contract/logic.ak);
[`rules.grant_spend_rule`](../../lib/cardano_account_custody_contract/rules.ak).

**INV-31.** A grant spend's grant UTxO holds only lovelace and its grant
token and is the only input holding a token of the account.
[`rules.grant_spend_rule`](../../lib/cardano_account_custody_contract/rules.ak);
[`grant.spends_one_account_token`](../../lib/cardano_account_custody_contract/grant.ak).

**INV-32.** A grant is spent only while current against the referenced
control state: its generation equals the account's and its slot is not
revoked.
[`grant.is_current`](../../lib/cardano_account_custody_contract/grant.ak).

**INV-33.** A grant spend is signed by the grantee as a required signer.
[`grant.is_authorised_by_grantee`](../../lib/cardano_account_custody_contract/grant.ak).

**INV-34.** A grant spend's validity range has a finite upper bound no
later than the grant's expiry.
[`grant.ends_before_expiry`](../../lib/cardano_account_custody_contract/grant.ak).

**INV-35.** The net outflow from the account's full address keeps the
scoped asset within the per call cap and the remaining cap, keeps
lovelace within both lovelace caps for a token scope, and lets no other
asset class leave.
[`grant.leaving_value`, `grant.stays_within_scope`](../../lib/cardano_account_custody_contract/grant.ak).

**INV-36.** When a grant lists recipients, every output away from the
account address pays a listed recipient.
[`grant.pays_only_recipients`](../../lib/cardano_account_custody_contract/grant.ak).

**INV-37.** Every output at the account address that holds no account
token carries no datum and no reference script.
[`grant.deposits_are_plain`](../../lib/cardano_account_custody_contract/grant.ak).

**INV-38.** Exactly one output holds the grant token, at the spent
grant UTxO's address, with the same value and no reference script.
[`rules.grant_spend_rule`](../../lib/cardano_account_custody_contract/rules.ak);
[`account.find_grant_output`](../../lib/cardano_account_custody_contract/account.ak);
[`grant.carries_no_reference_script`](../../lib/cardano_account_custody_contract/grant.ak).

**INV-39.** The recreated grant is an inline grant equal to the spent one
except its remaining caps, each between zero and the spent cap less the
net outflow of its asset, so a net deposit leaves a cap unchanged and
remaining caps never increase.
[`grant.carries_grant_within`, `grant.grant_after_spend`](../../lib/cardano_account_custody_contract/grant.ak).

**INV-40.** On the agent path, every account token among the inputs and
the outputs sits at its own account address.
[`rules.grant_spend_rule`](../../lib/cardano_account_custody_contract/rules.ak).

### Arrival

**INV-41.** On arrival, exactly one control output names `logic_v1`, and
it holds only lovelace and the state NFT and carries a well formed state.
[`logic.validates_arrival`](../../lib/cardano_account_custody_contract/logic.ak).

**INV-42.** At creation under `logic_v1`, the state NFT is the only token
minted under the policy, and the next slot, the revoked list and the
outstanding count are zero or empty.
[`logic.validates_arrival`](../../lib/cardano_account_custody_contract/logic.ak);
[`state.has_zero_counters`](../../lib/cardano_account_custody_contract/state.ak).

**INV-43.** On an upgrade to `logic_v1`, the leaving logic withdraws, the
generation is strictly greater than field 2 of the leaving state, the
device list equals field 1 of the leaving state, and nothing is minted or
burned under the policy.
[`logic.validates_arrival`](../../lib/cardano_account_custody_contract/logic.ak);
[`account.generation_of`, `account.devices_of`](../../lib/cardano_account_custody_contract/account.ak).

### State

**INV-44.** Every state `logic_v1` accepts as written lists one to 8
distinct devices, has a non-negative generation, next slot and
outstanding count, at most 16 outstanding grants and at most 32 revoked
slots.
[`state.is_well_formed`](../../lib/cardano_account_custody_contract/state.ak).

**INV-45.** Every grant `logic_v1` issues has non-negative caps, a
positive expiry, at most 8 recipients, and zero lovelace caps when its
asset is lovelace.
[`state.is_scope_well_formed`](../../lib/cardano_account_custody_contract/state.ak).

**INV-46.** `logic_v1` decodes the control state and every grant it spends
or issues strictly, so a datum with an extra field is refused, while a
sweep reads only the stable prefix of a grant.
[`account.state_datum`, `account.grant_datum`](../../lib/cardano_account_custody_contract/account.ak);
[`rules.issues_grant`, `rules.sweep_rule`](../../lib/cardano_account_custody_contract/rules.ak).

## Obligations of every logic

The proxy runs the logic the control datum names on every spend except
`Fund` and on every grant mint. It enforces nothing else. A logic an
account arrives at must therefore enforce these itself, or the account
has no such rule. `logic_v1` meets each one through the invariants
cited.

1. Authorise every spend of the control UTxO, every grant UTxO spend
   under `SpendWithGrant` or `SweepGrant`, and every grant mint. The
   deposits ride on these under the proxy's `Fund` rule: a reserve needs
   only the spent control UTxO, and a fund UTxO only an input holding an
   account token, a grant UTxO included (INV-11). A logic that accepts a
   grant UTxO spend on weaker terms lets it drain every fund UTxO of the
   account. `logic_v1`: INV-20, INV-26 and INV-27 for the control UTxO
   and the mints, INV-28 for a sweep, INV-30 to INV-39 for a grant spend
   and the fund UTxOs beside it.
2. Authenticate the control UTxO and grant UTxOs by their tokens, never
   by their datums. `logic_v1`: INV-20, INV-28, INV-31.
3. Validate the whole state on its arrival path, since the leaving logic
   need not read it. `logic_v1`: INV-41 to INV-44.
4. Kill every grant issued before its arrival. The proxy routes every
   `SpendWithGrant` to the logic the control datum names, so the leaving
   logic has no say over old grants. `logic_v1`: INV-43.
5. Keep the stable prefixes: `logic`, `devices` and `grant_generation`
   of the account state, and `slot`, `grantee` and `generation` of a
   grant, first and in that order. The proxy, the stake script, an
   arriving logic and a sweep read them by position.
6. On its leaving path, require the arriving logic to run. `logic_v1`:
   INV-25.
7. Admit no control output naming it for another account outside its
   arrival path. `logic_v1`: INV-22, INV-30.
8. Accept the registration of its own credential and refuse its
   deregistration, so the withdrawal every spend needs stays available.
   `logic_v1`: INV-19.

What `logic_v1` checks of an arriving state, and what it leaves open, is
in [known issues](known-issues.md#counters-written-on-arrival).
