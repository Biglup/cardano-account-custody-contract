# cardano-account-custody-contract

Cardano account custody contract in Aiken: a stable per-user address with owner keys and on-chain bounded, revocable agent grants (cap, expiry, destinations).

Each user gets one address whose payment credential is this contract's script
hash and whose stake credential is the user's own stake key. Funds sit there
as ordinary UTxOs that anyone can deposit to with a plain transfer. A single
control UTxO at that address, marked by an account state NFT that this same
script mints, carries the account's state: its device keys, any one of which
has full authority over the account, and its grants, bounded and revocable
permissions held by other parties. A device signature lets the owner rewrite
the state freely, as long as the result stays well formed. A grantee's
signature lets an agent spend from the account, but only within that grant's
remaining caps, before its expiry, and only to its allowed recipients; the
control UTxO is recreated with the caps reduced by what left. This is the
Cardano counterpart of the Midnight Passport Account Custody Contract (ACC),
and keeps its vocabulary where Cardano has no established term of its own.

## Vocabulary

Terms with no established Cardano equivalent keep their Midnight ACC name.
Where Cardano already has an established term, that term is used.

| Midnight ACC term    | This contract's term  | Meaning                                                   |
| --------------------- | ---------------------- | ---------------------------------------------------------- |
| devices                | devices                | The owner's keys; any one authorises the owner path       |
| grants                 | grants                 | The account's bounded, revocable permissions                |
| slot                   | slot                   | A grant's identifier, distinct within `grants` but not its list index |
| scope                  | scope                  | A grant's bounds: asset, caps, expiry, recipients           |
| issue_grant            | issue_grant            | Owner action that adds a grant to the state                 |
| revoke_grant           | revoke_grant           | Owner action that removes one grant from the state          |
| revoke_all_grants      | revoke_all_grants      | Owner action that clears every grant from the state         |
| grant_generation       | grant_generation       | Counter bumped by `revoke_all_grants` only                  |
| withdraw                | spend                   | Taking funds out of the account (`spend_with_device`, `spend_with_grant`) |
| fund                   | deposit                | Adding funds to the account, a plain transfer with no datum |
| account token          | state NFT               | The NFT marking the account's control UTxO                  |
| account identity       | stake key hash          | The key hash that makes the account's address its owner's own |

## Grant accounting

A grant spend is checked once, over the whole transaction, on the control
UTxO. The value leaving the account is the sum of every input at the
account address minus the sum of every output paid back to it, per asset
class, so deposits made in the same transaction count against what left.
The caps are checked against that net outflow, and the recreated state
reduces the grant's remaining cap by the net outflow of its asset and, for
a grant whose asset is not lovelace, the remaining lovelace cap by the net
outflow of lovelace, each clamped at zero. A net inflow of an asset leaves
its cap exactly as it was: a cap never increases through an agent spend,
whatever the agent deposits alongside.

## Grantee signatures

A grant names its grantee either as an Ed25519 verification key hash or as
a 33 byte compressed secp256k1 public key. An Ed25519 grantee authorises a
`SpendWithGrant` spend by signing the transaction itself and appearing in
its required signers; the redeemer's `signature` is `None`. A secp256k1
grantee cannot sign a Cardano transaction, so the redeemer carries its
signature over a message that the validator rebuilds from the transaction
it is validating. Off-chain code must build the same message byte for byte:

1. Build the tuple, in this order:
   1. the domain prefix, the 32 UTF-8 bytes of
      `cardano_account_custody:grant:v1`, as a byte string;
   2. the output reference of the control UTxO being spent;
   3. the output references of every input of the transaction, in the
      transaction's input order;
   4. the outputs of the transaction, in order;
   5. the fee, in lovelace;
   6. the validity range;
   7. the mint.
   Each element is encoded as Plutus data exactly as the Plutus V3 script
   context presents it, and the tuple itself is a plain data list of seven
   elements.
2. Serialise the tuple to CBOR with the ledger's `serialiseData` encoding
   of Plutus data, which is what `aiken/cbor.serialise` produces:
   - a constructor with index `i` is a tagged array, with tag `121 + i`
     for `i < 7` and tag `1280 + (i - 7)` for `7 <= i < 128`, whose content
     is the list of its fields;
   - a non empty list, including a non empty list of constructor fields,
     is an indefinite length array, `0x9f` followed by the elements and
     closed by `0xff`; an empty list is the definite `0x80`;
   - a map is a definite length map;
   - a byte string of at most 64 bytes is a definite length byte string; a
     longer one is an indefinite length byte string made of 64 byte chunks;
   - an integer in the range a plain CBOR integer covers is encoded as one;
     a larger one is a bignum.
   The whole tuple therefore starts with `0x9f 0x58 0x20` and the domain
   prefix. A transaction with no mint serialises the mint as the empty map
   `0xa0`, and the fee is a plain integer. CBOR libraries that default to
   definite length arrays produce different bytes for the lists and
   constructor fields, and therefore a different digest; use the Plutus
   data encoding of the library, or encode the arrays as indefinite.
3. Hash the serialisation with blake2b-256. The 32 byte digest is the message.
4. Sign the digest with ECDSA over secp256k1, signing the digest as is and
   without hashing it again, and encode the signature as the 64 byte
   concatenation `r || s`, each as a 32 byte big-endian integer. The
   signature must be in low s form: the verification builtin follows
   libsecp256k1 and rejects a signature whose `s` is above half the curve
   order, so normalise `s` to `n - s` when a signer produces the high form.
   Validate lengths before submitting: a public key that is not 33 bytes,
   a message that is not 32 bytes or a signature that is not 64 bytes makes
   the builtin error instead of returning false, which fails the
   transaction in phase two and costs the collateral.

The redeemer then carries `Some(signature)`. Because the control UTxO's
output reference is part of the message and is consumed by the spend, a
signature authorises exactly one transaction and can never be replayed.

The message leaves out the rest of the transaction body on purpose:
withdrawals, certificates, reference inputs, redeemers, required signers,
witness datums, votes, proposals, the treasury donation and the collateral.
Everything the grant bounds, the value leaving the account, the recipients
and the recreated state, is a function of the inputs and outputs alone, and
those are signed. Any withdrawal or certificate touching the user's stake
credential needs the user's own stake key witness, which no agent holds.
Any extra inflow, such as a withdrawal from a different reward account,
can only balance into the signed outputs, the fee or a deposit, so it
cannot move value the agent did not sign for. The transaction id itself
cannot be part of the message, because the redeemer carrying the signature
is covered by the script data hash in the body, which the id hashes.

The validity range doubles as the grant's time check. Its upper bound must
be finite and its value must be at most the grant's `expires_at`, whether
the bound is inclusive or exclusive; a transaction with no upper bound is
refused, since it could be applied after the grant expired. The bound is
compared as POSIX milliseconds, the unit of `expires_at`.

## Trust assumption

The mint handler cannot prove that an account's state NFT does not already
exist, so whoever holds a stake key can always mint a second control UTxO
at that account's address, with devices of their choosing, and spend every
deposit through it. A stake key compromise therefore equals a full account
compromise, independently of the device keys. In the intended deployment
the stake key and the device keys derive from the same credential, so this
adds no trust beyond what the devices already carry, but off-chain code
must check that no state NFT of the stake key exists before creating an
account.

## Build and test

Requires [Aiken](https://aiken-lang.org) v1.1.24.

```sh
aiken fmt --check
aiken check
aiken build
```

`aiken build` writes the contract's blueprint to `plutus.json`, which is
committed so off-chain code can load it directly.
