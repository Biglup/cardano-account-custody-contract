# SundaeSwap v3 grant policy example

An example policy script for the Cardano account custody contract. It lets
a grant pay SundaeSwap v3 order outputs only on terms the account owner
fixed at issuance. It is an example. It is unaudited and it is not part of
the contract or its blueprint.

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
| `pool_ident` | The only pool an order may target |
| `owner` | The only owner allowed, compared whole, so a nested `AnyOf` or `AtLeast` cannot add a signer |
| `offer_asset`, `receive_asset` | The asset classes of the swap |
| `price_numerator`, `price_denominator` | The bound `min_received * price_denominator >= offer * price_numerator` |
| `max_protocol_fee` | The largest `max_protocol_fee` an order may name |
| `extension` | The only extension an order may carry |

## What it enforces

Every output at the recipient address must carry an inline SundaeSwap order
datum, and:

- `pool_ident` is `Some` of exactly the pinned pool. `None` means any pool
  with the right assets.
- `destination` is `Fixed`, at the address of the grant input the script
  read, the account the grant belongs to, with no datum. `Self` is refused.
  A mistaken settings value cannot send proceeds elsewhere.
- `details` is `Swap`. `Strategy` is late-bound: its authorised signer picks
  the real order details off-chain after placement, which defeats every
  check here. The other order kinds do not decode and are refused.
- `owner` equals the configured value, compared as a whole
  `MultisigScript`.
- `max_protocol_fee` is at most the cap.
- `offer` and `min_received` name the pinned asset classes, the offer is
  positive, the price terms in the settings are positive, and
  `min_received` is at least the offer at the price. A settings value with
  a zero or negative term could otherwise make the price bound vacuous.
- The order output carries no reference script.
- `extension` equals the pinned value. At the commit below, neither the
  order validator nor the pool reads `extension`, so a pinned value costs
  nothing today and closes the field against any later order script that
  does read it. `Void` is the value their tests use.

## What it does not enforce

- The price bound is fixed at issuance. The owner reissues the grant to move
  it.
- One pool, one pair and one direction per recipient entry.
- It cannot see the live pool price. `min_received` is the only price bound,
  and the offer is the order's own declaration: the value locked in the
  order is not tied to it, since any surplus returns to the destination.
- The caps of the grant stay the backstop. A grantee can place many orders,
  each costing up to the protocol fee cap, up to the caps.
- It does not restrict other outputs of the transaction: the recipient list
  does that.

## The data layout

The types in `lib/sundaeswap_v3_policy/types.ak` are this example's own and
match only the on-chain constructor and field order of
[`lib/types/order.ak`](https://github.com/SundaeSwap-finance/sundae-contracts/blob/be33466b7dbe0f8e6c0e0f46ff23737897f45835/lib/types/order.ak),
[`lib/shared.ak`](https://github.com/SundaeSwap-finance/sundae-contracts/blob/be33466b7dbe0f8e6c0e0f46ff23737897f45835/lib/shared.ak)
at commit `be33466b7dbe0f8e6c0e0f46ff23737897f45835` and
[`lib/sundae/multisig.ak`](https://github.com/KtorZ/aicone/blob/a9ae9ef8b6bdb183ea020ea97f6b648f9343924e/lib/sundae/multisig.ak)
at commit `a9ae9ef8b6bdb183ea020ea97f6b648f9343924e`. The licensing of that
repository is unclear: its `aiken.toml` says Apache-2.0 and it has no
LICENSE file. None of its source or comments are copied here.

Verified against that commit: the `OrderDatum` field order and the
`Destination`, `Order` and `MultisigScript` constructor order. The
3-tuple `SingletonValue` and the `(ByteArray, ByteArray)` pair encode as
lists, per `plutus.json` at that commit and per the test
`asset_amount_is_encoded_as_a_list` for this compiler. That committed
blueprint names Aiken v1.0.26 and Plutus V2, while the sources at the same
commit use the current Plutus V3 `cardano/` modules, so it may be older than
the sources.

## Networks

This example has been run on a local devnet only, with a dummy script hash
standing in for the order address. It has not been run on preprod or against
a real scooper. No deployed SundaeSwap v3 order address is recorded here,
because none could be verified from published deployment data. Fill it in
before a preprod run.
