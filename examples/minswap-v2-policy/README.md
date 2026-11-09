# Minswap v2 grant policy example

An example policy script for the Cardano account custody contract. It lets
a grant pay Minswap v2 order outputs only on terms the account owner fixed
at issuance. It is an example. It is unaudited and it is not part of the
contract or its blueprint.

Build and test it on its own with `aiken check` and `aiken build` in this
directory.

## How it plugs in

A grant recipient may name a policy script:

```text
Recipient { address, policy: Option<GrantPolicy { script, settings }> }
```

When a grant spend pays that address, the logic requires a zero withdrawal
from the policy script. The ledger runs the script once over the whole
transaction. The script finds the grant input by its grant token, selects
the recipient entries that name its own hash, and validates every output at
each such address against that entry's settings. Outputs at other
recipients are not its concern. The script is parameterised by the account
proxy hash.

The recipient address carries the order address. Pair the entry with a
recipient list that does not leave other paths open: an empty recipient
list means any destination, so no policy runs.

The credential must be registered once. The script's `publish` handler
accepts only the registration of a script credential, as the logic's does.

## Settings

The `settings` a recipient entry carries, in order:

| Field | Meaning |
| --- | --- |
| `canceller` | The only order canceller allowed, compared whole |
| `receiver` | The address both the refund and the success receiver must be, normally the account address |
| `lp_asset` | The LP asset of the only pool an order may target |
| `direction_a_to_b` | The only swap direction allowed |
| `price_numerator`, `price_denominator` | The bound `minimum_receive * price_denominator >= sold * price_numerator` |
| `max_batcher_fee` | The largest `max_batcher_fee` an order may name |
| `max_tip` | The largest cancelling tip an order may name |

## What it enforces

Every output at the recipient address must carry an inline Minswap order
datum, and:

- The step is constructor 0, `SwapExactIn`, with `SAOSpecificAmount`. Any
  other step, or `SAOAll`, does not decode and is refused.
- `canceller`, both receivers and `lp_asset` are exactly as set.
- Both receiver datums are the empty receiver datum, since the account
  refuses returned value under a datum (INV-37).
- The direction is as set, the sold amount and `minimum_receive` are
  positive, and `minimum_receive` is at least the sold amount at the price.
- `max_batcher_fee` is at most the cap, and the expiry option's tip, when
  set, is at most the cap. A tip and a fee are the ways an order can spend
  its own value with everything else pinned: anyone can cancel an expired
  order and claim up to the tip.

## What it does not enforce

- The price bound is fixed at issuance. The owner reissues the grant to move
  it.
- One pool and one direction per recipient entry.
- It cannot see the live pool price. `minimum_receive` is the only price
  bound, and the sold amount is the order's own declaration.
- The caps of the grant stay the backstop. A grantee can place many orders,
  each costing up to the batcher fee cap, and pay expired tips, up to the
  caps.
- It does not restrict other outputs of the transaction: the recipient list
  does that.
- Order expiry times are not bounded, only the tip they could cost.

## The data layout

The types in `lib/minswap_v2_policy/types.ak` are this example's own and
match only the on-chain constructor and field order of
[`lib/amm_dex_v2/types.ak`](https://github.com/minswap/minswap-dex-v2/blob/c3293ad435792ba502f5a2b1691c6736e5f167e6/lib/amm_dex_v2/types.ak)
at commit `c3293ad435792ba502f5a2b1691c6736e5f167e6`. Minswap's repository is
GPL-3.0; none of its source or comments are copied here.

Verified against that commit: the `OrderDatum` field order; the canceller,
receiver datum and swap amount constructors; and that `SwapExactIn` is the
first `OrderStep` constructor. `Option<(Int, Int)>` was verified by running
Minswap's compiled expired-order cancellation validator from its committed
`plutus.json` on `Some` holding a list of the time and the tip, and by the
test `tuple_option_encoding_matches_minswap` for this compiler. At that
commit, the off-chain encoder in `src/types/order.ts` writes the time and
the tip as the two fields of `Some`, which that compiled validator refuses
to decode; use the list form.

## Networks

Minswap's preprod order script is
`addr_test1wrdf2f2x8pq3wwk3yv936ksmt59rz94mm66yzge8zj9pk7s0kjph3`, per
`deployed/preprod/script.json` in their repository at that commit. Minswap's
scripts are Plutus V2, and placing an order runs none of them.

This example has been run on a local devnet only, with a dummy script hash
standing in for the order address. It has not been run on preprod or
against a real batcher.
