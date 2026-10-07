# Preprod evidence

Every flow of the account custody contract exercised on the Cardano preprod
network through Blockfrost. Confirmed flows link to their transactions on
the preprod explorer. Flows refused by the builder quote the check that
stopped them before anything reached the chain. Flows refused by the node
were built without those checks, signed and submitted, and quote the
ledger error Blockfrost returned when the validator failed in phase two;
the node rejects such a transaction before it enters a block, so no
collateral is consumed.

- Date: 2026-10-07
- Funding address: `addr_test1qqalup9s2kpfrcf60zqxusar6fhgkcsd6z94a65ucmdaavxy456rp43g7mn75fnrw8tajhvtdc920z5d8z0npnjm52asxk8ews`
- Account address: `addr_test1zqwkuyvg3u0kwdxpurxy08efse8rajfj6vadsmdrcep3lgxy456rp43g7mn75fnrw8tajhvtdc920z5d8z0npnjm52aslfavah`
- Account script hash: `1d6e11888f1f6734c1e0cc479f29864e3ec932d33ad86da3c6431fa0`
- State NFT policy id: `1d6e11888f1f6734c1e0cc479f29864e3ec932d33ad86da3c6431fa0`

| Step | Flow | Transactions | Outcome |
| ---- | ---- | ------------ | ------- |
| 1 | createAccount mints the state NFT with the owner key as the only device | [715883d5b15f](https://preprod.cardanoscan.io/transaction/715883d5b15f02a944b30a4c687c70430e4efb62937cfb1a921f189dc78decca) | confirmed |
| 2 | deposit 50 tADA into the account with a plain transfer | [3df68257e87e](https://preprod.cardanoscan.io/transaction/3df68257e87ed50b19146e79c013af7c795023ed73896233e6fe031c86e2a156) | confirmed |
| 3 | spendWithDevice 5 tADA to the owner address | [84dd9961048e](https://preprod.cardanoscan.io/transaction/84dd9961048e81eaa951af212212d71cea2c44d784339cdc9ac394ff0393a4e3) | confirmed |
| 4 | issueGrant slot 0 to the Ed25519 agent: 10 tADA per call, 15 tADA in total, owner as the only recipient | [70edf988fc90](https://preprod.cardanoscan.io/transaction/70edf988fc907489625ddbd8a5ed29410d178e96c9ab5ee2db69a952452a7b91) | confirmed |
| 5 | spendWithGrant 8 tADA to the owner address signed by the Ed25519 agent | [6c6c4f5466bf](https://preprod.cardanoscan.io/transaction/6c6c4f5466bf55ff9c0846224e2a86e058259f6b62830c7180dc2eea3cf6af13) | confirmed |
| 6 | spendWithGrant 8 tADA again, beyond the remaining cap | none | refused by the builder: "Grant 0 refuses the spend: 8000000 of the scoped asset exceeds the remaining cap of 6145453" |
| 7 | spendWithGrant 8 tADA again, beyond the remaining cap, built unchecked, signed and submitted | none | refused by the node: "ConwayUtxowFailure (UtxoFailure (UtxosFailure (ValidationTagMismatch Phase2Valid (FailedUnexpectedly (PlutusFailure \"The PlutusV3 script failed: ...\"" |
| 8 | spendWithGrant 3 tADA to an address outside the recipients | none | refused by the builder: "addr_test1qpq5gz7gyn39a0jh7sln54yrx7a72mgtmsm0zckkhve03zgkyqa8k48398gsyllkypnjqhavl6ghmejkwudrka28g8cqkygz08 is not a recipient of grant 0" |
| 9 | spendWithGrant 3 tADA to an address outside the recipients, built unchecked, signed and submitted | none | refused by the node: "ConwayUtxowFailure (UtxoFailure (UtxosFailure (ValidationTagMismatch Phase2Valid (FailedUnexpectedly (PlutusFailure \"The PlutusV3 script failed: ...\"" |
| 10 | revokeGrant slot 0 | [6fa03de5c77c](https://preprod.cardanoscan.io/transaction/6fa03de5c77c680ff29877f6c69a7551a0b339b1ef201ef3bba37d5543199e04) | confirmed |
| 11 | spendWithGrant 1 tADA with the revoked grant | none | refused by the builder: "The account has no grant in slot 0" |
| 12 | issueGrant slot 1 to the secp256k1 agent and spendWithGrant 2 tADA with its signature | [50c24f2c0cf9](https://preprod.cardanoscan.io/transaction/50c24f2c0cf9a23217385b6739f6321cf78f51ed0e36a6fc81d6ee67c544333b), [535aca707b57](https://preprod.cardanoscan.io/transaction/535aca707b57de1108aed177e2d4be9d7111835cfb03ce5de9d8c05cf0a1fcac) | confirmed |
| 13 | issueGrant slot 2 expiring in 90 seconds, then spendWithGrant after the expiry | [972019bce27a](https://preprod.cardanoscan.io/transaction/972019bce27a75d569ac4e40dc0ff3c219aab28b54a322f6faa870fbf7dea777) | refused by the builder: "Slot 135663435 starts after grant 2 expires" |
| 14 | spendWithGrant 1 tADA with the expired grant, built unchecked with a validity range ending after the expiry, signed and submitted | none | refused by the node: "ConwayUtxowFailure (UtxoFailure (UtxosFailure (ValidationTagMismatch Phase2Valid (FailedUnexpectedly (PlutusFailure \"The PlutusV3 script failed: ...\"" |
| 15 | addDevice the agent wallet key, then spendWithDevice 1 tADA signed by the new device | [f5f1b02f9114](https://preprod.cardanoscan.io/transaction/f5f1b02f91147bd04b0a4cfabf0be82817ad372d492fe1fce1459fb75bc53990), [e2ca701abc06](https://preprod.cardanoscan.io/transaction/e2ca701abc06730f5f99f4dccf1011835baa5072b05d2c0cee42d594805f8731) | confirmed |
| 16 | removeDevice the agent wallet key | [aab477f37e04](https://preprod.cardanoscan.io/transaction/aab477f37e04e927767079e54479da7a889a112728bd350b1e8f36a67659768a) | confirmed |
| 17 | revokeAllGrants | [b40fa6b58b6b](https://preprod.cardanoscan.io/transaction/b40fa6b58b6b5965f1341f16ab36fa31b302f8da56af4988c1fbfe911234d22f) | confirmed |
| 18 | deleteAccount burns the state NFT and returns the funds to the funding wallet | [59705720d061](https://preprod.cardanoscan.io/transaction/59705720d061360b4cd2848e5a59aebea1c7ad187c062e21d418878b66858dde) | confirmed |

## Supporting transactions

| Purpose | Transaction |
| ------- | ----------- |
| fund the agent wallet with 10000000 lovelace | [1512be585045](https://preprod.cardanoscan.io/transaction/1512be585045df69965835a32b2d88f5a5a63e0be7d4af40e5b7b7172586c6a4) |
| return the agent wallet balance to the funding wallet | [6cea1f1c6cf7](https://preprod.cardanoscan.io/transaction/6cea1f1c6cf7350466c03b1f42357906baa56256b2cb40351199209a264fea53) |
