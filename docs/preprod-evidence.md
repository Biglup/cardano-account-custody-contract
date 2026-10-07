# Preprod evidence

Every flow of the account custody contract exercised on the Cardano preprod
network through Blockfrost. Confirmed flows link to their transactions on
the preprod explorer. Flows refused by the builder quote the check that
stopped them before anything reached the chain. Flows refused by the node
were built without those checks, signed and submitted, and quote the
ledger error Blockfrost returned when the validator failed in phase two;
the node rejects such a transaction before it enters a block, so no
collateral is consumed. The account stake credential is the hash of the
account's own stake script, applied to the owner key and the account
script hash: creation registers it with the deposit, and the owner device
and later the second device operate its reward account. The owner wallet
holds no ADA beyond one collateral UTxO: the funding wallet sponsors the
creation and every later owner operation is paid from the account. An
account is never deleted and its credential stays registered, so the run
ends by sweeping the funds back and leaving the control UTxO in place;
every run therefore creates its account for a fresh owner key of the
mnemonic.

- Date: 2026-10-07
- Funding address: `addr_test1qqalup9s2kpfrcf60zqxusar6fhgkcsd6z94a65ucmdaavxy456rp43g7mn75fnrw8tajhvtdc920z5d8z0npnjm52asxk8ews`
- Owner address: `addr_test1qq8zaw9ststc28lpx2lnpr5mcufw7ycer5ufnsrtjfncpcvke0k47jualx42ygnw43ln87x6pa0x02wwtt8kd6c4wvpqjmen74`
- Account address: `addr_test1xqzjfatm0pw08fzm0mtq9xec0hpel7eyzx73edpsp3vv9se9kk6w6ysn4vg4wkndvea98s40zpamq5n3dwpmzu46lces43snzv`
- Account script hash: `0524f57b785cf3a45b7ed6029b387dc39ffb2411bd1cb4300c58c2c3`
- State NFT policy id: `0524f57b785cf3a45b7ed6029b387dc39ffb2411bd1cb4300c58c2c3`
- Account stake credential: `25b5b4ed1213ab11575a6d667a53c2af107bb052716b83b172bafe33`
- Reward address: `stake_test17qjmtd8dzgf6ky2htfkkv7jnc2h3q7as2fckhqa3w2a0uvcdt7rc2`
- Delegated pool: `pool1wn6a6f23ctq06udwhw27ravdpd6zcr7jlut3yez0wzdackz3222`

| Step | Flow | Transactions | Outcome |
| ---- | ---- | ------------ | ------- |
| 1 | createAccount, sponsored by the funding wallet and signed by the owner key, registers the stake credential with its deposit and mints the state NFT with the owner key as the only device | [219d83c5833e](https://preprod.cardanoscan.io/transaction/219d83c5833ed94f2ff5a484a1812c9597c879e94479cf64784ea801959a3830) | confirmed |
| 2 | deposit 50 tADA into the account with a plain transfer from the funding wallet | [8ddb846c64dc](https://preprod.cardanoscan.io/transaction/8ddb846c64dc3b5686818c2c414d57b22f2612598b9f1e4f8debb1169938b1e4) | confirmed |
| 3 | spendWithDevice 5 tADA to the owner address, fee paid from the account | [0836f003214b](https://preprod.cardanoscan.io/transaction/0836f003214bbbfcc9f65b82c794227bc388a5e7b5e3e6ece1479cb9bb02ea45) | confirmed |
| 4 | withdrawRewards of zero from the reward account signed by the owner device | [5a1c1190dd1f](https://preprod.cardanoscan.io/transaction/5a1c1190dd1fa90b6319d4fc0ee3208093585f8499c639870ccc1ebf88b8b1a9) | confirmed |
| 5 | delegateStake to an active preprod pool signed by the owner device | [c280b9c34244](https://preprod.cardanoscan.io/transaction/c280b9c3424477314ca0af82008772dc126fc3bd6b99a62b623bfc6082625fe8) | confirmed |
| 6 | issueGrant slot 0 to the agent key: 10 tADA per call, 15 tADA in total, owner as the only recipient | [589cfe875498](https://preprod.cardanoscan.io/transaction/589cfe8754981e2786aa30b8f1ee77a5f23e2ee55950237bc0b67fb14324a3f2) | confirmed |
| 7 | spendWithGrant 8 tADA to the owner address signed by the agent | [9fe97bb7e8f8](https://preprod.cardanoscan.io/transaction/9fe97bb7e8f8b76beef36e40b5514cec89c6d802a72a9b6fa9b460e3675547ee) | confirmed |
| 8 | spendWithGrant 8 tADA again, beyond the remaining cap | none | refused by the builder: "Grant 0 refuses the spend: 8000000 of the scoped asset exceeds the remaining cap of 6156805" |
| 9 | spendWithGrant 8 tADA again, beyond the remaining cap, built unchecked, signed and submitted | none | refused by the node: "ConwayUtxowFailure (UtxoFailure (UtxosFailure (ValidationTagMismatch Phase2Valid (FailedUnexpectedly (PlutusFailure "The PlutusV3 script failed: The script hash is:ScriptHash "0524f57b785cf3a45b7ed6029b387dc39ffb2411bd1cb4300c58c2c3" The plutus evaluation error is: CekError An error has occurred: The machine terminated because of an error, either from a built-in function or from an explicit use of 'error'. Caused by: error..." |
| 10 | spendWithGrant 3 tADA to an address outside the recipients | none | refused by the builder: "addr_test1qpq5gz7gyn39a0jh7sln54yrx7a72mgtmsm0zckkhve03zgkyqa8k48398gsyllkypnjqhavl6ghmejkwudrka28g8cqkygz08 is not a recipient of grant 0" |
| 11 | spendWithGrant 3 tADA to an address outside the recipients, built unchecked, signed and submitted | none | refused by the node: "ConwayUtxowFailure (UtxoFailure (UtxosFailure (ValidationTagMismatch Phase2Valid (FailedUnexpectedly (PlutusFailure "The PlutusV3 script failed: The script hash is:ScriptHash "0524f57b785cf3a45b7ed6029b387dc39ffb2411bd1cb4300c58c2c3" The plutus evaluation error is: CekError An error has occurred: The machine terminated because of an error, either from a built-in function or from an explicit use of 'error'. Caused by: error..." |
| 12 | revokeGrant slot 0 | [32c9262ff875](https://preprod.cardanoscan.io/transaction/32c9262ff875305840d89748514982c2ea63342ea2a44190c8245ce521c23959) | confirmed |
| 13 | spendWithGrant 1 tADA with the revoked grant | none | refused by the builder: "The account has no grant in slot 0" |
| 14 | issueGrant slot 1 expiring in 90 seconds, then spendWithGrant after the expiry | [770cd434399b](https://preprod.cardanoscan.io/transaction/770cd434399b71801eda679f7b8dcbc44ab0911bef7d0b0b17db82404e331d4f) | refused by the builder: "Slot 135678122 starts after grant 1 expires" |
| 15 | spendWithGrant 1 tADA with the expired grant, built unchecked with a validity range ending after the expiry, signed and submitted | none | refused by the node: "ConwayUtxowFailure (UtxoFailure (UtxosFailure (ValidationTagMismatch Phase2Valid (FailedUnexpectedly (PlutusFailure "The PlutusV3 script failed: The script hash is:ScriptHash "0524f57b785cf3a45b7ed6029b387dc39ffb2411bd1cb4300c58c2c3" The plutus evaluation error is: CekError An error has occurred: The machine terminated because of an error, either from a built-in function or from an explicit use of 'error'. Caused by: error..." |
| 16 | addDevice the agent wallet key, then spendWithDevice 1 tADA signed by the new device, which finds the account by its persisted record and its own wallet alone | [b31f216057e6](https://preprod.cardanoscan.io/transaction/b31f216057e628be5f4597966ac3e00b593004a87b46a0796911eb5e30daea40), [22333f3ccee3](https://preprod.cardanoscan.io/transaction/22333f3ccee3db55d0794599ed2743d98d575a64d68bf35eed0c3f584d9482b2) | confirmed |
| 17 | withdrawRewards of zero from the reward account signed by the new device, again from the account record and its own wallet alone | [f2286513eede](https://preprod.cardanoscan.io/transaction/f2286513eede47bdaa9199f89603492cea1dc41a496b1acc29cd3d91b4a620ff) | confirmed |
| 18 | removeDevice the agent wallet key | [30ad9e873f03](https://preprod.cardanoscan.io/transaction/30ad9e873f038c32868d602bd5f73dd79ccb97e2df7829e28a65205492730a43) | confirmed |
| 19 | revokeAllGrants | [c6766c390aba](https://preprod.cardanoscan.io/transaction/c6766c390aba092b0d20ea291711bbea4d68cc40b8382c923d68001f1cbd95e0) | confirmed |
| 20 | spendWithDevice, sponsored by the funding wallet, sweeps every fund UTxO back to it, leaving only the control UTxO at the account address | [2ce6747e9827](https://preprod.cardanoscan.io/transaction/2ce6747e9827f46f3c3398de884cf3faeb12d8bcfa0bbcb722742425811efe93) | confirmed |

## Supporting transactions

| Purpose | Transaction |
| ------- | ----------- |
| return the agent wallet balance to the funding wallet | [b5aa97d8eacb](https://preprod.cardanoscan.io/transaction/b5aa97d8eacb06f3ef655f1099b303a5bdd57bab4ff3d10bb5a7ceda04fbe187) |
| return the owner wallet balance to the funding wallet | [5a8dea4544d5](https://preprod.cardanoscan.io/transaction/5a8dea4544d5e4b6f665e926367da129c73f24a75a0c0a2913b4b461f23d5c77) |
