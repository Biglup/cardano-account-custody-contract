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

## Build and test

Requires [Aiken](https://aiken-lang.org) v1.1.24.

```sh
aiken fmt --check
aiken check
aiken build
```

`aiken build` writes the contract's blueprint to `plutus.json`, which is
committed so off-chain code can load it directly.
