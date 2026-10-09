# Grants

A [grant](../glossary.md#grant) lets one grantee key move bounded value
out of an account without the owner. This guide covers issuing, spending,
revoking and sweeping grants, and the bounds that apply to each. It
assumes the setup of the [quickstart](quickstart.md). The snippets extend
the quickstart script, use its `submit` helper and its `device`
parameters, and import what they use from `./src/index.js`.

## Bounds

The bounds of `logic_v1` and of the library are listed in
[bounds](../protocol/datums-and-redeemers.md#bounds). The library
refuses an operation that breaks a bound. It checks the
[fee bound](#fee-bound) after it builds the transaction, and every other
bound before. The rationale for one UTxO per grant is in
[ADR 0003](../adr/0003-one-utxo-per-grant.md).

## Choose a scope

A `Scope` bounds one asset:

| Field | Meaning |
| --- | --- |
| `asset` | `{ policyId, assetName }` in hex. `LOVELACE` is the empty pair. |
| `perCallCap` | The most of the asset one transaction may move out. |
| `cap` | The most of the asset that may still move out. Each spend lowers it. |
| `lovelacePerCallCap` | For a token scope, the most lovelace one transaction may move out. |
| `lovelaceCap` | For a token scope, the lovelace that may still move out. |
| `expiresAt` | POSIX time in milliseconds. Must be positive. |
| `recipients` | Bech32 addresses the grantee may pay. Empty allows any address. |

A lovelace scope has both lovelace caps at zero:

```ts
const lovelaceScope: Scope = {
  asset: LOVELACE,
  perCallCap: 10_000_000n,
  cap: 20_000_000n,
  lovelacePerCallCap: 0n,
  lovelaceCap: 0n,
  expiresAt: BigInt(Date.now()) + 3_600_000n,
  recipients: [payeeAddress],
};
```

A token scope bounds the token with `perCallCap` and `cap`. Its lovelace
caps bound the lovelace that leaves beside the token: the minimum UTxO
lovelace of the outputs and the fee.

```ts
const tokenScope: Scope = {
  asset: { policyId, assetName },
  perCallCap: 10n,
  cap: 20n,
  lovelacePerCallCap: 3_000_000n,
  lovelaceCap: 7_000_000n,
  expiresAt: BigInt(Date.now()) + 3_600_000n,
  recipients: [payeeAddress],
};
```

A grant has no rolling period cap. A grantee can spend its whole `cap`
at once, in as many transactions as `perCallCap` requires. Size `cap` to
the loss you can tolerate, keep expiries short, and issue a new grant
rather than a large one. An empty recipient list lets the grantee pay any
address, unspendable ones included. A script address as a recipient
makes the funds subject to that script. Prefer key addresses.

## Issue grants

Issuance is an owner transaction. Each grant takes the account's next
[slot](../glossary.md#slot), in order, and the current
[generation](../glossary.md#generation). Its token is minted into a new
[grant UTxO](../glossary.md#grant-utxo) holding the token and its
minimum lovelace, which the account pays.

```ts
const tx = await issueGrant({
  ...device,
  grants: [
    { grantee: agentKey, scope: lovelaceScope },
    { grantee: otherAgentKey, scope: tokenScope },
  ],
});
```

- One transaction issues one to eight grants.
- The account holds at most 16 outstanding grants. A dead grant counts
  until it is swept.
- The grantee is a 56 character hex key hash. The library does not check
  its length. A grantee hash of the wrong length makes a grant nobody can
  spend.
- `grantsOf(provider, record)` lists the account's grant UTxOs in slot
  order. Each entry carries the decoded `grant` and its `prefix`.

## Spend under a grant

A [grant spend](../glossary.md#grant-spend) is built by the agent. The
control UTxO is a reference input, so the agent never competes with the
owner for it.

```ts
const tx = await spendWithGrant({
  record,
  wallet: agentWallet,
  provider,
  network,
  slot: 0n,
  grantee: agentKey,
  outputs: [{ address: payeeAddress, value: { coins: 5_000_000n } }],
  validUntilSlot: posixTimeToSlot(BigInt(Date.now())) + 600n,
});
```

- `grantee` must sign. `spendWithGrant` declares it as a required signer.
  The witness can come from the agent wallet or from an
  [agent key signer](../glossary.md#agent-key-signer).
- The collateral comes from `wallet`, or from a `collateral` wallet when
  one is given. A `sponsor` is refused: the account always pays a grant
  spend.
- The account's fund UTxOs pay the outputs and the fee. Reserves are never
  spent on this path. The change returns to the account as a plain
  deposit.
- Outputs go only to the grant's recipients, when it lists any. No asset
  other than the scoped one and lovelace may leave.
- Token outputs need their own minimum UTxO lovelace. That lovelace
  counts against the lovelace caps.
- The library refuses a dead grant, an output to a non recipient and an
  amount beyond the caps, naming the rule.

### Fee bound

The fee is known only after the scripts are evaluated, and the recreated
grant must carry its reduced caps before that. The library therefore
lowers the remaining caps by the outputs plus a
[fee bound](../glossary.md#fee-bound). The checks use the same sum:

- For a lovelace grant, the outputs plus the fee bound must fit
  `perCallCap` and `cap`.
- For a token grant, the token amount must fit `perCallCap` and `cap`,
  and the output lovelace plus the fee bound must fit
  `lovelacePerCallCap` and `lovelaceCap`.

The fee bound is 1.5 ADA unless `feeBound` sets another. The caps lose
the bound, not the fee. The difference returns to the account as change.
A spend whose fee ends above the bound is refused before submission;
raise `feeBound` for spends over many inputs. Size caps with this margin.

### Many fund UTxOs

A grant spend takes at most 12 fund UTxOs. A spend that needs more is
refused with the bound named.

`spendWithGrant` takes no list of inputs. It selects the fund UTxOs
itself: those holding the scoped token first, then the largest first,
until they cover the outputs, the fee bound and the minimum change.
`fundBatches(funds)` splits fund UTxOs into batches of at most 12,
largest first. To draw on many small fund UTxOs, size each spend's
outputs so that the selection takes the next batch: the batch's lovelace
less the fee bound and the minimum change. The change of a spend is a
new fund UTxO, so split the funds again before the next spend.

Agents of one account draw on the same fund UTxOs. Two spends that pick
the same UTxO collide, the ledger accepts one, and the other must be
rebuilt.

## Expiry

A grant spend's validity range must end no later than `expiresAt`.
`spendWithGrant` refuses a `validUntilSlot` that starts after the expiry.
After the expiry no spend can confirm. Expiry needs no transaction.

## Revoke

A [revoke](../glossary.md#revoke) is an owner transaction that touches
only the control UTxO.

```ts
await submit(await revokeGrant({ ...device, slot: 0n }), [owner, sponsor]);
await submit(await revokeAllGrants(device), [owner, sponsor]);
```

- `revokeGrant` adds the slot to the revoked list. The slot must have
  been issued and must not be revoked already.
- When the revoked list holds 32 slots, `revokeGrant` raises the
  generation instead. That revokes every grant of the account and clears
  the list.
- `revokeAllGrants` raises the generation and clears the list.
- Once the revoke confirms, no spend under the revoked grant can confirm.
  A spend built against the old control UTxO fails because its reference
  input is gone.
- A device can make a revoked grant current again by rewriting the state
  without its slot, while the generation is unchanged. A generation raise
  is final.

Pay owner transactions from a reserve, or through a fee sponsor, so that
a revoke never depends on a fund UTxO an agent may be spending. See
[reserves and fee payment](../architecture.md#reserves-and-fee-payment).

## Sweep

A [dead grant](../glossary.md#dead-grant) stays at the account address
until a device sweeps it. The sweep burns its token, returns its lovelace
to the account and lowers the outstanding count.

```ts
const dead = await deadGrantsOf(provider, record);
const slots = dead.slice(0, 8).map(({ prefix }) => prefix.slot);
await submit(await sweepGrant({ ...device, slots }), [owner, sponsor]);
```

`deadGrantsOf` lists grants dead by generation, by revocation or by
expiry at the current time.

- One transaction sweeps one to eight grants.
- A grant dead by generation or by revocation sweeps with no validity
  range.
- A grant dead only by expiry needs `validFromSlot` past its expiry:
  `posixTimeToSlot(expiresAt) + 1n`. The transaction is valid only from
  that slot.
- A sweep is judged against the state before the transaction. The revoke
  that kills a grant and the sweep of that grant are two transactions.
- An issuance and a sweep cannot share a transaction.

## Issue again after a generation raise

A generation raise kills every grant. To keep some, read the grants and
the state before the raise, then issue the survivors again:

```ts
const before = await findAccountUtxos(provider, device);
await submit(await revokeAllGrants(device), [owner, sponsor]);
const requests = survivingGrantRequests(before.grants, before.state);
```

Sweep the dead grants, then issue the requests in batches of up to
eight:

```ts
await submit(await issueGrant({ ...device, grants: requests.slice(0, 8) }), [owner, sponsor]);
```

`survivingGrantRequests` returns every grant current under the given
state, with the caps it has left and its expiry. It leaves out expired
grants and, when given one, a revoked slot. Each step is its own
transaction. Sweep first when the dead grants hold the account at 16
outstanding.

## Related

- [Signers](signers.md): what a wallet shows before it signs a grant.
- [Transactions](../protocol/transactions.md): the shape of issuance,
  grant spends, revokes and sweeps.
- [Lifecycle](../protocol/lifecycle.md): the states of a grant.
