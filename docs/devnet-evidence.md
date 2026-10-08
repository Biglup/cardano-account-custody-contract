# Devnet evidence

Every flow of the account custody contract exercised on the local devnet
through its Blockfrost compatible API. The devnet runs Conway at the
protocol version of preprod, with the parameters the COPIED_PARAMETERS
list of scripts/devnet-parameters.ts names copied from preprod into its
genesis, the fee, size, deposit, pool, collateral and execution unit
limit parameters among them, and with the cost models of its own Conway
genesis, whose memory prices equal preprod and whose CPU prices for
integer division and byte string equality sit below it, so the memory
budgets below are what preprod charges for the same work and the step
budgets a little under it; see README, Running the devnet. Its
chain has one second blocks, so a run costs nothing and confirms in
about a second. Its transactions are listed by id, since no explorer
serves the chain.
Flows refused by the builder quote the check that
stopped them before anything reached the chain. Flows refused by the node
were built without those checks, signed and submitted, and quote the
ledger error Blockfrost returned when the validator failed in phase two;
the node rejects such a transaction before it enters a block, so no
collateral is consumed. The flow refused in phase one was built, signed
and held while the owner revoked the grant it spends; the revoke spent
the control UTxO the held transaction references, so the node refused
it as a transaction over a spent input before running any script. The
account stake credential is the hash of the account's own stake script,
applied to the owner key and the account script hash: creation registers
it with the deposit, and the owner device and later the agent device
operate its reward account. Each grant lives in its own grant UTxO under
its grant token; an agent spend consumes the grant UTxO and plain funds
and references the control UTxO, which only the owner spends. The owner
wallet holds no ADA beyond one collateral UTxO: the funding wallet
sponsors the creation and the final sweep, and every other owner
operation is paid from the account, its fee drawn from a reserve UTxO
the owner alone can spend for as long as the reserve can cover the most
a transaction can cost. The run builds the largest state the validators
admit, eight devices, thirty two revoked slots and sixteen outstanding
grants with eight recipients each, and records the execution units the
chain charged for every script transaction, with the heaviest paths set
against the budget table of the security review. An account is never
deleted and its credential stays registered, so the run ends by sweeping
the funds and the reserve back and leaving the control UTxO in place;
every run therefore creates its account for a fresh owner key of the
mnemonic. The account proxy is the payment credential and the token
policy; the rules live in a logic script the control datum names in
its first field, which every account transaction runs through a zero
withdrawal from the logic credential, with the proxy and the logic
referenced from UTxOs parked at an always fail script address and
recorded in the network file. After the sweep the run sets up a second
logic version, upgrades the account to it with the generation bumped,
shows a grant of the first version dead and swept through its stable
prefix, reissues it under the second version, spends under it, and
shows the grantee refused an upgrade.

- Date: 2026-10-08
- Funding address: `addr_test1qzl2jwckw20u69f0cq0vkrnuztx93hcmpwswja60txpnxrunu8tugxe0030m7uyvnz3hlppj4e28jyl9c94cque0gavqlw2xsv`
- Owner address: `addr_test1qzq4ccglz6zq4tk3qvrmckr0vdrfkyf89c0atgmsfl5q3e4jdsq74sswplkkqal7vklez5f9cp0ffx9lm84kerwl03ns9g70rl`
- Agent address: `addr_test1qq0hh0346ykhvwk38434e3tyz8vqv988m83hyh5a0c86jmlnrf9hlv55p94jw7pm060q92lwzcy483x3cdy73lyquw4sxp9qvw`
- Recipient address: `addr_test1qrdpc8zqwmyqwnswz6324dr2vu4sc58llstplxr6fkd3zafjcy7cl6s573dawhwmlne5a6lj5pkah780zy8mpefy9jaq975qc2`
- Account address: `addr_test1xrkkr936e9x39s9nyzl95vmvx6hkd0qzcwqwp23sqxyey5ux740yev3655x985l6n00kq5s56n35396kvhklzrg30nds5dkjsr`
- Account proxy hash: `ed61963ac94d12c0b320be5a336c36af66bc02c380e0aa3001899253`
- State NFT policy id: `ed61963ac94d12c0b320be5a336c36af66bc02c380e0aa3001899253`
- Account stake credential: `86f55e4cb23aa50c53d3fa9bdf605214d4e348975665edf10d117cdb`
- Reward address: `stake_test17zr02hjvkga22rzn60afhhmq2g2dfc6gjatxtm03p5ghekcamjrgq`
- Delegated pool: `pool1wvqhvyrgwch4jq9aa84hc8q4kzvyq2z3xr6mpafkqmx9wce39zy`
- Test token policy id: `d5ed90d9a348717b896694b642dd138280640a36ee4bcd9943af8bfc`
- Logic v1 hash: `2cd68e398bdf9fbc8d257614b54403451ee722520ec785fe14f8df5a`

## Setup

The one time setup of the network for logic v1: the logic credential
registered, the proxy and the logic parked as reference scripts, a bare
zero withdrawal from the registered credential refused by the logic in
phase two, since with no control UTxO spent or referenced it takes its
arrival path and finds no control output, and a zero withdrawal from an
unregistered credential refused by the node in phase one. Recorded in
the network file and reused by later runs.

| Step | Flow | Transactions | Outcome |
| ---- | ---- | ------------ | ------- |
| 1 | register the logic v1 credential with the Conway deposit through the logic publish handler, paid by the funding wallet | `8e4b74c0981c` | confirmed |
| 2 | park the proxy as a reference script in its own UTxO at the always fail script address, holding its minimum lovelace | `e2d752639dca` | confirmed |
| 3 | park logic v1 as a reference script in its own UTxO at the always fail script address, holding its minimum lovelace | `0c6421f3e628` | confirmed |
| 4 | a bare zero withdrawal from the registered logic v1 credential in a plain transaction of the funding wallet, with no control UTxO spent or referenced, built unchecked, signed and submitted: the logic takes its arrival path, which expects exactly one control output, and finds none | none | refused by the node: "ConwayUtxowFailure (UtxoFailure (UtxosFailure (ValidationTagMismatch (IsValid True) (FailedUnexpectedly (PlutusFailure "The PlutusV3 script failed: The script hash is:ScriptHash "2cd68e398bdf9fbc8d257614b54403451ee722520ec785fe14f8df5a" The plutus evaluation error is: CekError An error has occurred: The machine terminated because of an error, either from a built-in function or from an explicit use of 'error'. Caused by: force tailList []..." |
| 5 | a zero withdrawal from an unregistered logic credential, logic v1 applied to another parameter, in a plain transaction of the funding wallet | none | refused by the node in phase one: "ConwayWithdrawalsMissingAccounts (Withdrawals {unWithdrawals = fromList [(AccountAddress {aaNetworkId = Testnet, aaId = AccountId {unAccountId = ScriptHashObj (ScriptHash "fcdc5f899e4e7ed937bc2b07c1005931f7d400f46185443c3542becd")}},Coin 0)]})" |

## Flows

| Step | Flow | Transactions | Outcome |
| ---- | ---- | ------------ | ------- |
| 1 | createAccount, sponsored by the funding wallet and signed by the owner key, registers the stake credential with its deposit, mints the state NFT with the owner key as the only device and zero counters, names logic v1 in the control datum and runs it through its zero withdrawal | `9b7bf5dd053a` | confirmed |
| 2 | deposit 120 tADA into the account with a plain transfer from the funding wallet | `daf192d70885` | confirmed |
| 3 | deposit 60 tADA into the account as a reserve from the funding wallet, under the reserve datum the owner alone can spend | `9930da8e1ce5` | confirmed |
| 4 | spendWithDevice 5 tADA to the owner address, fee drawn from the reserve and the reserve recreated | `9db891b85642` | confirmed |
| 5 | withdrawRewards of zero from the reward account signed by the owner device | `07de3216cb60` | confirmed |
| 6 | delegateStake to an active preprod pool signed by the owner device | `5b11d4838e56` | confirmed |
| 7 | issueGrant slot 0 to the agent key: 10 tADA per call, 15 tADA in total, owner as the only recipient, minted into its own grant UTxO paid by the account | `4e4d3541af6d` | confirmed |
| 8 | spendWithGrant 8 tADA to the owner address signed by the agent, spending the grant UTxO, referencing the control UTxO and running logic v1 through its zero withdrawal | `a33f2fd2ccf1` | confirmed |
| 9 | spendWithGrant 8 tADA again, beyond the remaining cap | none | refused by the builder: "Grant 0 refuses the spend: 9500000 of the scoped asset exceeds the remaining cap of 5500000" |
| 10 | spendWithGrant 8 tADA again, beyond the remaining cap, built unchecked, signed and submitted | none | refused by the node: "ConwayUtxowFailure (UtxoFailure (UtxosFailure (ValidationTagMismatch (IsValid True) (FailedUnexpectedly (PlutusFailure "The PlutusV3 script failed: The script hash is:ScriptHash "2cd68e398bdf9fbc8d257614b54403451ee722520ec785fe14f8df5a" The plutus evaluation error is: CekError An error has occurred: The machine terminated because of an error, either from a built-in function or from an explicit use of 'error'. Caused by: error..." |
| 11 | spendWithGrant 3 tADA to an address outside the recipients | none | refused by the builder: "addr_test1qq0hh0346ykhvwk38434e3tyz8vqv988m83hyh5a0c86jmlnrf9hlv55p94jw7pm060q92lwzcy483x3cdy73lyquw4sxp9qvw is not a recipient of grant 0" |
| 12 | spendWithGrant 3 tADA to an address outside the recipients, built unchecked, signed and submitted | none | refused by the node: "ConwayUtxowFailure (UtxoFailure (UtxosFailure (ValidationTagMismatch (IsValid True) (FailedUnexpectedly (PlutusFailure "The PlutusV3 script failed: The script hash is:ScriptHash "2cd68e398bdf9fbc8d257614b54403451ee722520ec785fe14f8df5a" The plutus evaluation error is: CekError An error has occurred: The machine terminated because of an error, either from a built-in function or from an explicit use of 'error'. Caused by: error..." |
| 13 | mint 20 test tokens under a native policy of the funding wallet key and deposit them into the account as plain funds | `d24a42935891` | confirmed |
| 14 | issueGrant slot 1 to the agent key over the test token: 10 tokens per call, 20 in total, 3 tADA alongside per call, 7 tADA alongside in total, the recipient wallet as the only recipient | `a04779d344ea` | confirmed |
| 15 | spendWithGrant 11 tokens to the recipient, beyond the per call cap | none | refused by the builder: "Grant 1 refuses the spend: 11 of the scoped asset exceeds the per call cap of 10" |
| 16 | spendWithGrant 11 tokens to the recipient, beyond the per call cap, built unchecked, signed and submitted | none | refused by the node: "ConwayUtxowFailure (UtxoFailure (UtxosFailure (ValidationTagMismatch (IsValid True) (FailedUnexpectedly (PlutusFailure "The PlutusV3 script failed: The script hash is:ScriptHash "2cd68e398bdf9fbc8d257614b54403451ee722520ec785fe14f8df5a" The plutus evaluation error is: CekError An error has occurred: The machine terminated because of an error, either from a built-in function or from an explicit use of 'error'. Caused by: error..." |
| 17 | spendWithGrant 10 tokens with 1.5 tADA to the recipient twice, which exhausts the token cap and leaves no token in the account | `a04f6f8f3fbf`, `42ed44a3a554` | confirmed |
| 18 | the agent builds and signs spendWithGrant 1 tADA against slot 0 and holds it; revokeGrant slot 0 spends the control UTxO it references and lands; the agent then submits the held transaction and the node refuses it in phase one, its reference input spent | `091223ae532a` | refused by the node in phase one: "ConwayUtxowFailure (UtxoFailure (BadInputsUTxO (NonEmptySet (fromList [TxIn (TxId {unTxId = SafeHash "a04779d344ea3632d47e1daf7920887f4afc9398843a2919ca8737080fd3b6df"}) (TxIx {unTxIx = 1})]))))" |
| 19 | spendWithGrant 1 tADA with the revoked grant | none | refused by the builder: "Grant 0 is dead: slot 0 is revoked" |
| 20 | spendWithGrant 1 tADA with the revoked grant, built unchecked against the revoked control state, signed and submitted | none | refused by the node: "ConwayUtxowFailure (UtxoFailure (UtxosFailure (ValidationTagMismatch (IsValid True) (FailedUnexpectedly (PlutusFailure "The PlutusV3 script failed: The script hash is:ScriptHash "2cd68e398bdf9fbc8d257614b54403451ee722520ec785fe14f8df5a" The plutus evaluation error is: CekError An error has occurred: The machine terminated because of an error, either from a built-in function or from an explicit use of 'error'. Caused by: error..." |
| 21 | revokeAllGrants, bumping the grant generation to one and clearing the revoked list, which kills the exhausted token grant too | `faf18a6e4c5c` | confirmed |
| 22 | sweepGrant slots 0 and 1, dead by generation, burning both grant tokens and freeing their lovelace to the account | `4ebd7381d252` | confirmed |
| 23 | issueGrant slot 2 expiring in 90 seconds, then spendWithGrant after the expiry | `9a9afb231d64` | refused by the builder: "Slot 167 starts after grant 2 expires" |
| 24 | spendWithGrant 1 tADA with the expired grant, built unchecked with a validity range ending after the expiry, signed and submitted | none | refused by the node: "ConwayUtxowFailure (UtxoFailure (UtxosFailure (ValidationTagMismatch (IsValid True) (FailedUnexpectedly (PlutusFailure "The PlutusV3 script failed: The script hash is:ScriptHash "2cd68e398bdf9fbc8d257614b54403451ee722520ec785fe14f8df5a" The plutus evaluation error is: CekError An error has occurred: The machine terminated because of an error, either from a built-in function or from an explicit use of 'error'. Caused by: error..." |
| 25 | sweepGrant slot 2 with a validity range starting after its expiry, burning its grant token | `f0b1ef95b66f` | confirmed |
| 26 | addDevice seven times: the agent wallet key and six rotation keys, one transaction each, until the account holds eight devices | `ec62b72de0ff`, `3c55fdaeb204`, `0c55bc9600f2`, `dc38a93e9e01`, `c8bf6073966b`, `30ec87c202c3`, `cea9d032b5dd` | confirmed |
| 27 | issueGrant eight grants with eight recipients each to the agent key, twice, slots 3 to 18, until sixteen grants are outstanding | `700501c3c8f5`, `fe308b965586` | confirmed |
| 28 | revokeGrant slots 3 to 18 one by one, sixteen transactions, each appending its slot to the revoked list | `952a9f9287d0`, `41d39e996d7e`, `d0a5181a706b`, `1e06f1277088`, `d36ccda34456`, `a580dc3773b8`, `52e8d1e3802d`, `f43c4108023e`, `4260c77aa958`, `304b84dd3fa8`, `b793cb2e13eb`, `1e9d2fa8cd37`, `de42bf030b69`, `c92ffd132669`, `c3b348899935`, `3d834be78734` | confirmed |
| 29 | sweepGrant slots 3 to 10 and 11 to 18, eight dead grants per transaction, burning their tokens | `d75b26cf424c`, `7c34ec7d06c6` | confirmed |
| 30 | issueGrant eight grants with eight recipients each, twice, slots 19 to 34, until sixteen grants are outstanding again | `7ea6795f840e`, `aa0cc9e396c1` | confirmed |
| 31 | revokeGrant slots 19 to 34 one by one, sixteen transactions, until the revoked list holds its thirty two slots | `30ddfdc9ac7f`, `6c9b926bf37e`, `41b8a6957632`, `2b2f62d678ef`, `5e26b7dc82e0`, `6f3b2ee4708b`, `c5a4120f59c7`, `b86f836bead6`, `bba2010e32f0`, `e7e19486c209`, `47c689315995`, `a47291883652`, `f810799d6176`, `feb9793f61a6`, `32d503c0b2c2`, `0cc48b188334` | confirmed |
| 32 | rewriteState over the largest state, eight devices, thirty two revoked slots and sixteen outstanding grants, replacing the sixth rotation key with a seventh | `1054d1efa90b` | confirmed |
| 33 | sweepGrant slots 19 to 26 and 27 to 34 over the largest state, eight dead grants per transaction, burning their tokens | `b54454f9b7c3`, `0df2511191a7` | confirmed |
| 34 | spendWithDevice 1 tADA to the owner address signed by the agent device, which finds the account by its persisted record and its own wallet alone | `d73661bbfda8` | confirmed |
| 35 | withdrawRewards of zero from the reward account signed by the agent device, again from the account record and its own wallet alone | `a02f6da9c557` | confirmed |
| 36 | deposit twenty UTxOs of 1.5 tADA into the account in one transaction from the funding wallet | `b3ec0f7edf39` | confirmed |
| 37 | issueGrant slot 35 to the agent key: 1,000 tADA per call and in total, the funding wallet as the only recipient | `536821c1e694` | confirmed |
| 38 | spendWithGrant over the 13 largest fund UTxOs of the account, one more than the 12 a checked grant spend may take, refused by the builder before anything is evaluated or submitted | none | refused by the builder: "The spend needs 13 fund UTxOs, more than the 12 one grant spend may take; sweep the funds in batches of fundBatches first" |
| 39 | spendWithGrant sweeping every fund UTxO of the account to the funding wallet in batches of at most 12 fund UTxOs per transaction, the first over exactly 12, each referencing the largest control state, with the execution units of the heaviest batch read back and set against the limit of the chain | `d2e90ea19ac3`, `2685a945dc62`, `00a6b9c4e2a0` | confirmed |
| 40 | removeDevice the agent wallet key | `101fc3f5bb6e` | confirmed |
| 41 | removeDevice the six rotation keys, one transaction each, until the owner key is the only device | `52073d13fb6f`, `5282e86f2970`, `d79777d8f08d`, `5384ec4008f9`, `1b84037f90e0`, `853e6f382080` | confirmed |
| 42 | spendWithDevice, sponsored by the funding wallet, sweeps every fund and reserve UTxO back to it, leaving only the control UTxO at the account address | `321846ed6ce3` | confirmed |

## Execution units

The execution units the chain recorded for the heaviest script
transaction of every step that ran one, read back from the redeemers of
the confirmed transaction. Memory is in memory units and steps in CPU
steps, each followed by its share of the per transaction limit of
17,500,000 memory units and 10,000,000,000 steps, as the protocol
parameters of devnet report it at the time of the run. The breakdown
lists every redeemer of the transaction by purpose and index, heaviest
first, as memory / steps.

| Step | Transactions | Heaviest | Redeemers | Memory | Steps | Breakdown |
| ---- | ------------ | -------- | --------- | ------ | ----- | --------- |
| 1 | 1 | `9b7bf5dd053a` | mint, cert, reward | 580,691 (3.3%) | 191,555,977 (1.9%) | reward 0: 266,218 / 85,999,047; mint 0: 198,824 / 69,340,959; cert 0: 115,649 / 36,215,971 |
| 4 | 1 | `9db891b85642` | 3 spend, reward | 1,317,320 (7.5%) | 448,710,257 (4.4%) | reward 0: 687,107 / 235,246,138; spend 1: 386,381 / 128,511,722; spend 0: 126,684 / 42,570,729; spend 2: 117,148 / 42,381,668 |
| 5 | 1 | `07de3216cb60` | 2 spend, 2 reward | 1,201,765 (6.8%) | 406,037,647 (4.0%) | reward 0: 605,690 / 206,544,707; spend 1: 322,896 / 110,974,582; reward 1: 146,495 / 45,947,629; spend 0: 126,684 / 42,570,729 |
| 6 | 1 | `5b11d4838e56` | 2 spend, cert, reward | 1,209,329 (6.9%) | 408,320,945 (4.0%) | reward 0: 605,690 / 206,544,707; spend 1: 322,896 / 110,974,582; cert 0: 154,059 / 48,230,927; spend 0: 126,684 / 42,570,729 |
| 7 | 1 | `4e4d3541af6d` | 3 spend, mint, reward | 2,040,161 (11.6%) | 689,552,534 (6.8%) | reward 0: 1,139,689 / 387,572,146; spend 1: 410,345 / 137,790,944; mint 0: 246,295 / 79,237,047; spend 0: 126,684 / 42,570,729; spend 2: 117,148 / 42,381,668 |
| 8 | 1 | `a33f2fd2ccf1` | 2 spend, reward | 1,550,840 (8.8%) | 546,705,903 (5.4%) | reward 0: 1,188,189 / 424,328,004; spend 0: 264,609 / 86,877,976; spend 1: 98,042 / 35,499,923 |
| 14 | 1 | `a04779d344ea` | 3 spend, mint, reward | 2,033,317 (11.6%) | 686,881,171 (6.8%) | reward 0: 1,132,845 / 384,900,783; spend 1: 410,345 / 137,790,944; mint 0: 246,295 / 79,237,047; spend 0: 126,684 / 42,570,729; spend 2: 117,148 / 42,381,668 |
| 17 | 2 | `a04f6f8f3fbf` | 3 spend, reward | 1,897,932 (10.8%) | 663,552,276 (6.6%) | reward 0: 1,413,108 / 496,900,243; spend 0: 280,884 / 91,901,522; spend 2: 105,898 / 39,250,588; spend 1: 98,042 / 35,499,923 |
| 18 | 1 | `091223ae532a` | 2 spend, reward | 1,054,737 (6.0%) | 359,691,826 (3.5%) | reward 0: 605,157 / 206,146,515; spend 1: 322,896 / 110,974,582; spend 0: 126,684 / 42,570,729 |
| 21 | 1 | `faf18a6e4c5c` | 2 spend, reward | 1,052,971 (6.0%) | 359,103,961 (3.5%) | reward 0: 603,391 / 205,558,650; spend 1: 322,896 / 110,974,582; spend 0: 126,684 / 42,570,729 |
| 22 | 1 | `4ebd7381d252` | 4 spend, mint, reward | 2,559,567 (14.6%) | 874,575,236 (8.7%) | reward 0: 1,117,979 / 402,608,320; spend 3: 413,657 / 139,686,715; spend 1: 308,996 / 100,946,784; spend 0: 305,102 / 98,369,307; mint 0: 211,739 / 65,383,437; spend 2: 202,094 / 67,580,673 |
| 23 | 1 | `9a9afb231d64` | 3 spend, mint, reward | 2,077,456 (11.8%) | 703,538,105 (7.0%) | reward 0: 1,147,313 / 392,712,381; spend 2: 414,239 / 140,368,421; mint 0: 246,295 / 79,237,047; spend 1: 145,037 / 49,689,274; spend 0: 124,572 / 41,530,982 |
| 25 | 1 | `f0b1ef95b66f` | 3 spend, mint, reward | 1,970,933 (11.2%) | 669,633,688 (6.6%) | reward 0: 1,003,904 / 349,929,905; spend 1: 378,166 / 126,468,164; spend 2: 285,187 / 95,460,664; mint 0: 176,992 / 55,204,226; spend 0: 126,684 / 42,570,729 |
| 26 | 7 | `cea9d032b5dd` | 3 spend, reward | 1,492,741 (8.5%) | 495,037,511 (4.9%) | reward 0: 890,095 / 289,003,377; spend 1: 358,814 / 121,081,737; spend 0: 126,684 / 42,570,729; spend 2: 117,148 / 42,381,668 |
| 27 | 2 | `700501c3c8f5` | 3 spend, mint, reward | 7,925,936 (45.2%) | 2,563,669,709 (25.6%) | reward 0: 6,409,058 / 2,055,652,763; spend 1: 771,062 / 254,755,393; mint 0: 501,984 / 168,309,156; spend 0: 126,684 / 42,570,729; spend 2: 117,148 / 42,381,668 |
| 28 | 16 | `3d834be78734` | 3 spend, reward | 1,614,693 (9.2%) | 528,972,381 (5.2%) | reward 0: 1,012,047 / 322,938,247; spend 1: 358,814 / 121,081,737; spend 0: 126,684 / 42,570,729; spend 2: 117,148 / 42,381,668 |
| 29 | 2 | `7c34ec7d06c6` | 10 spend, mint, reward | 8,415,377 (48.0%) | 2,844,660,198 (28.4%) | reward 0: 3,354,489 / 1,205,301,323; spend 1: 572,087 / 182,913,343; spend 9: 506,366 / 169,948,182; spend 8: 502,472 / 167,370,705; spend 7: 498,578 / 164,793,228; spend 6: 494,684 / 162,215,751; spend 5: 490,790 / 159,638,274; spend 4: 486,896 / 157,060,797; spend 3: 483,002 / 154,483,320; spend 2: 479,108 / 151,905,843; mint 0: 420,221 / 126,458,703; spend 0: 126,684 / 42,570,729 |
| 30 | 2 | `aa0cc9e396c1` | 4 spend, mint, reward | 8,321,032 (47.5%) | 2,691,679,777 (26.9%) | reward 0: 6,621,527 / 2,120,199,742; spend 2: 783,307 / 260,010,040; mint 0: 510,335 / 170,986,326; spend 1: 145,037 / 49,689,274; spend 3: 136,254 / 49,263,413; spend 0: 124,572 / 41,530,982 |
| 31 | 16 | `0cc48b188334` | 3 spend, reward | 1,736,645 (9.9%) | 562,907,853 (5.6%) | reward 0: 1,133,999 / 356,873,719; spend 1: 358,814 / 121,081,737; spend 0: 126,684 / 42,570,729; spend 2: 117,148 / 42,381,668 |
| 32 | 1 | `1054d1efa90b` | 2 spend, reward | 1,529,091 (8.7%) | 491,217,942 (4.9%) | reward 0: 1,079,511 / 337,672,631; spend 1: 322,896 / 110,974,582; spend 0: 126,684 / 42,570,729 |
| 33 | 2 | `0df2511191a7` | 10 spend, mint, reward | 9,202,345 (52.5%) | 3,075,777,302 (30.7%) | reward 0: 3,870,969 / 1,356,998,467; spend 9: 603,239 / 203,533,159; spend 7: 498,578 / 164,793,228; spend 6: 494,684 / 162,215,751; spend 5: 490,790 / 159,638,274; spend 4: 486,896 / 157,060,797; spend 3: 483,002 / 154,483,320; spend 2: 479,108 / 151,905,843; spend 1: 475,214 / 149,328,366; spend 0: 471,320 / 146,750,889; spend 8: 428,324 / 142,610,505; mint 0: 420,221 / 126,458,703 |
| 34 | 1 | `d73661bbfda8` | 3 spend, reward | 1,804,459 (10.3%) | 583,789,429 (5.8%) | reward 0: 1,174,246 / 370,325,310; spend 1: 386,381 / 128,511,722; spend 0: 126,684 / 42,570,729; spend 2: 117,148 / 42,381,668 |
| 35 | 1 | `a02f6da9c557` | 2 spend, 2 reward | 1,713,291 (9.7%) | 548,005,102 (5.4%) | reward 0: 1,092,829 / 341,623,879; spend 1: 322,896 / 110,974,582; reward 1: 170,882 / 52,835,912; spend 0: 126,684 / 42,570,729 |
| 37 | 1 | `536821c1e694` | 3 spend, mint, reward | 2,633,401 (15.0%) | 852,324,341 (8.5%) | reward 0: 1,732,929 / 550,343,953; spend 1: 410,345 / 137,790,944; mint 0: 246,295 / 79,237,047; spend 0: 126,684 / 42,570,729; spend 2: 117,148 / 42,381,668 |
| 39 | 3 | `2685a945dc62` | 13 spend, reward | 6,203,648 (35.4%) | 2,119,773,993 (21.1%) | reward 0: 2,405,686 / 839,171,213; spend 11: 399,304 / 144,679,093; spend 12: 308,208 / 111,199,118; spend 10: 300,420 / 106,044,164; spend 9: 296,526 / 103,466,687; spend 8: 292,632 / 100,889,210; spend 7: 288,738 / 98,311,733; spend 6: 284,844 / 95,734,256; spend 5: 280,950 / 93,156,779; spend 4: 277,056 / 90,579,302; spend 3: 273,162 / 88,001,825; spend 2: 269,268 / 85,424,348; spend 1: 265,374 / 82,846,871; spend 0: 261,480 / 80,269,394 |
| 40 | 1 | `101fc3f5bb6e` | 2 spend, reward | 1,483,742 (8.4%) | 478,691,081 (4.7%) | reward 0: 1,034,162 / 325,145,770; spend 1: 322,896 / 110,974,582; spend 0: 126,684 / 42,570,729 |
| 41 | 6 | `52073d13fb6f` | 2 spend, reward | 1,440,360 (8.2%) | 466,733,513 (4.6%) | reward 0: 990,780 / 313,188,202; spend 1: 322,896 / 110,974,582; spend 0: 126,684 / 42,570,729 |
| 42 | 1 | `321846ed6ce3` | 4 spend, reward | 1,504,847 (8.5%) | 517,494,551 (5.1%) | reward 0: 719,574 / 247,997,328; spend 2: 379,410 / 129,013,554; spend 1: 145,037 / 49,689,274; spend 3: 136,254 / 49,263,413; spend 0: 124,572 / 41,530,982 |

## Budget comparison

The heaviest transaction of each measured step against the rows of the
budget table in `docs/security-review.md`, which gives the net memory
units and steps of each handler as the test runner charged them over the
largest state, summed here over the handlers the transaction runs. The
on-chain figures are what the ledger charged for the same handlers over
the real transaction, so they are the ones the limits apply to. The
heaviest agent sweep batch is set against the eight and forty deposit
rows of the review; its input count is in the Redeemers column, one Fund
execution per deposit beside the SpendWithGrant execution. The forty
deposit row is not reachable on chain: the builder takes at most twelve
fund UTxOs in one checked grant spend, as the refusal in the flows table
above shows, so the batch over exactly twelve is the heaviest agent
spend the library submits, and its share of the limit is the margin
that bound leaves.

| Step | Path | Handlers | Transaction | Redeemers | On-chain memory | On-chain steps | Review net memory | Review net steps | Share of the limits |
| ---- | ---- | -------- | ----------- | --------- | --------------- | -------------- | ----------------- | ---------------- | ------------------- |
| 27 | issue of eight grants with eight recipients each | Device and IssueGrants | `700501c3c8f5` | 5 | 7,925,936 | 2,563,669,709 | 6,910,000 | 2,130,000,000 | 45.2% / 25.6% |
| 28 | revoke of one slot | Device | `3d834be78734` | 4 | 1,614,693 | 528,972,381 | 1,100,000 | 320,000,000 | 9.2% / 5.2% |
| 29 | sweep of eight dead grants | Device, eight SweepGrant and BurnGrants | `7c34ec7d06c6` | 12 | 8,415,377 | 2,844,660,198 | 8,260,000 | 2,550,000,000 | 48.0% / 28.4% |
| 30 | issue of eight grants with eight recipients each | Device and IssueGrants | `aa0cc9e396c1` | 6 | 8,321,032 | 2,691,679,777 | 6,910,000 | 2,130,000,000 | 47.5% / 26.9% |
| 31 | revoke of one slot over the largest state | Device | `0cc48b188334` | 4 | 1,736,645 | 562,907,853 | 1,100,000 | 320,000,000 | 9.9% / 5.6% |
| 32 | device rewrite over the largest state | Device | `1054d1efa90b` | 3 | 1,529,091 | 491,217,942 | 1,100,000 | 320,000,000 | 8.7% / 4.9% |
| 33 | sweep of eight dead grants over the largest state | Device, eight SweepGrant and BurnGrants | `0df2511191a7` | 12 | 9,202,345 | 3,075,777,302 | 8,260,000 | 2,550,000,000 | 52.5% / 30.7% |
| 39 | agent spend over eight deposits | SpendWithGrant and eight Fund | `2685a945dc62` | 14 | 6,203,648 | 2,119,773,993 | 3,200,000 | 1,130,000,000 | 35.4% / 21.1% |
| 39 | agent spend over forty deposits | SpendWithGrant and forty Fund | `2685a945dc62` | 14 | 6,203,648 | 2,119,773,993 | 13,400,000 | 6,180,000,000 | 35.4% / 21.1% |

## Supporting transactions

| Purpose | Transaction |
| ------- | ----------- |
| fund the owner wallet with 5000000 lovelace | `2ad549c5a2f8` |
| fund the agent wallet with 10000000 lovelace | `2e369a8c5bf6` |
| revokeAllGrants, which kills the sweep grant | `f86e6be779fc` |
| sweepGrant slot 35, the last outstanding grant, so that only the control UTxO is left to sweep | `5cd4121b2d8c` |
| return the agent wallet balance to the funding wallet | `a952378f0360` |
| return the owner wallet balance to the funding wallet | `63ad28b94868` |
| return the recipient wallet balance to the funding wallet | `c67990ca7f62` |
