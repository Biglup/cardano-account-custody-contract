# Devnet evidence

Every flow of the account custody contract exercised on the local devnet
through its Blockfrost compatible API. The devnet runs Conway at the
protocol version of preprod, with the parameters the COPIED_PARAMETERS
list of offchain/scripts/devnet-parameters.ts names copied from preprod
into its genesis, the fee, size, deposit, pool, collateral and execution
unit limit parameters among them, and with the cost models of its own
Conway genesis, whose memory prices equal preprod and whose CPU prices
for integer division and byte string equality sit below it, so the memory
budgets below are what preprod charges for the same work and the step
budgets a little under it; see README, Running the devnet. Its chain has
one second blocks, so a run costs nothing and confirms in about a second.
Its transactions are listed by id, since no explorer serves the chain.
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
applied to the owner key and the proxy hash: creation registers
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
recorded in the network file. After the sweep the run proves the owner
upgrade, the mechanism that lets a later logic replace the one every
account runs. It needs a second logic script to move an account to, so
it sets up the throwaway one of fixtures/upgrade-logic on the network,
which no account of the contract runs and the blueprint does not
carry, upgrades the account from the contract's logic to it with the
generation bumped, shows a grant issued before the upgrade dead by
that bump, refused by the builder and by the second logic, and swept
under it, which judges it by the stable prefix of its datum, issues it
again under it from the request survivingGrantRequests lists, spends
under it, shows the grantee refused a move back by the builder and by
the second logic, and sweeps the account again, leaving the control
UTxO under the second logic.

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
- Logic hash: `2cd68e398bdf9fbc8d257614b54403451ee722520ec785fe14f8df5a`
- Second logic hash of the upgrade proof: `69baa8a8c877247028c56c8130449e186e3658d541536d168f92db3d`

## Setup

The one time setup of the network for the contract's logic: the credential
registered, the proxy and the logic parked as reference scripts, a bare
zero withdrawal from the registered credential refused by the logic in
phase two, since with no control UTxO spent or referenced it takes its
arrival path and finds no control output, and a zero withdrawal from an
unregistered credential refused by the node in phase one. Recorded in
the network file and reused by later runs.

| Step | Flow | Transactions | Outcome |
| ---- | ---- | ------------ | ------- |
| 1 | register the contract's logic credential with the Conway deposit through the logic publish handler, paid by the funding wallet | `8e4b74c0981c` | confirmed |
| 2 | park the proxy as a reference script in its own UTxO at the always fail script address, holding its minimum lovelace | `e2d752639dca` | confirmed |
| 3 | park the contract's logic as a reference script in its own UTxO at the always fail script address, holding its minimum lovelace | `0c6421f3e628` | confirmed |
| 4 | a bare zero withdrawal from the registered logic credential in a plain transaction of the funding wallet, with no control UTxO spent or referenced, built unchecked, signed and submitted: the logic takes its arrival path, which expects exactly one control output, and finds none | none | refused by the node: "ConwayUtxowFailure (UtxoFailure (UtxosFailure (ValidationTagMismatch (IsValid True) (FailedUnexpectedly (PlutusFailure "The PlutusV3 script failed: The script hash is:ScriptHash "2cd68e398bdf9fbc8d257614b54403451ee722520ec785fe14f8df5a" The plutus evaluation error is: CekError An error has occurred: The machine terminated because of an error, either from a built-in function or from an explicit use of 'error'. Caused by: force tailList []..." |
| 5 | a zero withdrawal from an unregistered logic credential, the contract's logic applied to another parameter, in a plain transaction of the funding wallet | none | refused by the node in phase one: "ConwayWithdrawalsMissingAccounts (Withdrawals {unWithdrawals = fromList [(AccountAddress {aaNetworkId = Testnet, aaId = AccountId {unAccountId = ScriptHashObj (ScriptHash "fcdc5f899e4e7ed937bc2b07c1005931f7d400f46185443c3542becd")}},Coin 0)]})" |

## Flows

| Step | Flow | Transactions | Outcome |
| ---- | ---- | ------------ | ------- |
| 1 | createAccount, sponsored by the funding wallet and signed by the owner key, registers the stake credential with its deposit, mints the state NFT with the owner key as the only device and zero counters, names the contract's logic in the control datum and runs it through its zero withdrawal | `9b7bf5dd053a` | confirmed |
| 2 | deposit 120 tADA into the account with a plain transfer from the funding wallet | `daf192d70885` | confirmed |
| 3 | deposit 60 tADA into the account as a reserve from the funding wallet, under the reserve datum the owner alone can spend | `9930da8e1ce5` | confirmed |
| 4 | spendWithDevice 5 tADA to the owner address, fee drawn from the reserve and the reserve recreated | `9db891b85642` | confirmed |
| 5 | withdrawRewards of zero from the reward account signed by the owner device | `07de3216cb60` | confirmed |
| 6 | delegateStake to an active pool of the network signed by the owner device | `5b11d4838e56` | confirmed |
| 7 | issueGrant slot 0 to the agent key: 10 tADA per call, 15 tADA in total, owner as the only recipient, minted into its own grant UTxO paid by the account | `0af9d00f56f7` | confirmed |
| 8 | spendWithGrant 8 tADA to the owner address signed by the agent, spending the grant UTxO, referencing the control UTxO and running the contract's logic through its zero withdrawal | `b94f14792835` | confirmed |
| 9 | spendWithGrant 8 tADA again, beyond the remaining cap | none | refused by the builder: "Grant 0 refuses the spend: 9500000 of the scoped asset exceeds the remaining cap of 5500000" |
| 10 | spendWithGrant 8 tADA again, beyond the remaining cap, built unchecked, signed and submitted | none | refused by the node: "ConwayUtxowFailure (UtxoFailure (UtxosFailure (ValidationTagMismatch (IsValid True) (FailedUnexpectedly (PlutusFailure "The PlutusV3 script failed: The script hash is:ScriptHash "2cd68e398bdf9fbc8d257614b54403451ee722520ec785fe14f8df5a" The plutus evaluation error is: CekError An error has occurred: The machine terminated because of an error, either from a built-in function or from an explicit use of 'error'. Caused by: error..." |
| 11 | spendWithGrant 3 tADA to an address outside the recipients | none | refused by the builder: "addr_test1qq0hh0346ykhvwk38434e3tyz8vqv988m83hyh5a0c86jmlnrf9hlv55p94jw7pm060q92lwzcy483x3cdy73lyquw4sxp9qvw is not a recipient of grant 0" |
| 12 | spendWithGrant 3 tADA to an address outside the recipients, built unchecked, signed and submitted | none | refused by the node: "ConwayUtxowFailure (UtxoFailure (UtxosFailure (ValidationTagMismatch (IsValid True) (FailedUnexpectedly (PlutusFailure "The PlutusV3 script failed: The script hash is:ScriptHash "2cd68e398bdf9fbc8d257614b54403451ee722520ec785fe14f8df5a" The plutus evaluation error is: CekError An error has occurred: The machine terminated because of an error, either from a built-in function or from an explicit use of 'error'. Caused by: error..." |
| 13 | mint 20 test tokens under a native policy of the funding wallet key and deposit them into the account as plain funds | `d24a42935891` | confirmed |
| 14 | issueGrant slot 1 to the agent key over the test token: 10 tokens per call, 20 in total, 3 tADA alongside per call, 7 tADA alongside in total, the recipient wallet as the only recipient | `6c55f8d09871` | confirmed |
| 15 | spendWithGrant 11 tokens to the recipient, beyond the per call cap | none | refused by the builder: "Grant 1 refuses the spend: 11 of the scoped asset exceeds the per call cap of 10" |
| 16 | spendWithGrant 11 tokens to the recipient, beyond the per call cap, built unchecked, signed and submitted | none | refused by the node: "ConwayUtxowFailure (UtxoFailure (UtxosFailure (ValidationTagMismatch (IsValid True) (FailedUnexpectedly (PlutusFailure "The PlutusV3 script failed: The script hash is:ScriptHash "2cd68e398bdf9fbc8d257614b54403451ee722520ec785fe14f8df5a" The plutus evaluation error is: CekError An error has occurred: The machine terminated because of an error, either from a built-in function or from an explicit use of 'error'. Caused by: error..." |
| 17 | spendWithGrant 10 tokens with 1.5 tADA to the recipient twice, which exhausts the token cap and leaves no token in the account | `538730fa8514`, `1b3b99a21d35` | confirmed |
| 18 | the agent builds and signs spendWithGrant 1 tADA against slot 0 and holds it; revokeGrant slot 0 spends the control UTxO it references and lands; the agent then submits the held transaction and the node refuses it in phase one, its reference input spent | `cc866d8aa6f6` | refused by the node in phase one: "ConwayUtxowFailure (UtxoFailure (BadInputsUTxO (NonEmptySet (fromList [TxIn (TxId {unTxId = SafeHash "6c55f8d098719b2b573619d49b2512c3769f52c9d4d1b0ff7a105ad57681335e"}) (TxIx {unTxIx = 1})]))))" |
| 19 | spendWithGrant 1 tADA with the revoked grant | none | refused by the builder: "Grant 0 is dead: slot 0 is revoked" |
| 20 | spendWithGrant 1 tADA with the revoked grant, built unchecked against the revoked control state, signed and submitted | none | refused by the node: "ConwayUtxowFailure (UtxoFailure (UtxosFailure (ValidationTagMismatch (IsValid True) (FailedUnexpectedly (PlutusFailure "The PlutusV3 script failed: The script hash is:ScriptHash "2cd68e398bdf9fbc8d257614b54403451ee722520ec785fe14f8df5a" The plutus evaluation error is: CekError An error has occurred: The machine terminated because of an error, either from a built-in function or from an explicit use of 'error'. Caused by: error..." |
| 21 | revokeAllGrants, bumping the grant generation to one and clearing the revoked list, which kills the exhausted token grant too | `62c4da7e916c` | confirmed |
| 22 | sweepGrant slots 0 and 1, dead by generation, burning both grant tokens and freeing their lovelace to the account | `38dc277867b4` | confirmed |
| 23 | issueGrant slot 2 expiring in 90 seconds, then spendWithGrant after the expiry | `bee0015cf802` | refused by the builder: "Slot 167 starts after grant 2 expires" |
| 24 | spendWithGrant 1 tADA with the expired grant, built unchecked with a validity range ending after the expiry, signed and submitted | none | refused by the node: "ConwayUtxowFailure (UtxoFailure (UtxosFailure (ValidationTagMismatch (IsValid True) (FailedUnexpectedly (PlutusFailure "The PlutusV3 script failed: The script hash is:ScriptHash "2cd68e398bdf9fbc8d257614b54403451ee722520ec785fe14f8df5a" The plutus evaluation error is: CekError An error has occurred: The machine terminated because of an error, either from a built-in function or from an explicit use of 'error'. Caused by: error..." |
| 25 | sweepGrant slot 2 with a validity range starting after its expiry, burning its grant token | `491fc6fd6e4c` | confirmed |
| 26 | addDevice seven times: the agent wallet key and six rotation keys, one transaction each, until the account holds eight devices | `19a0de1d6bd9`, `dc1df8bfff1b`, `441aaf7ae2d4`, `57fc316c42e6`, `f14d67193656`, `157e6a7a8c80`, `294a018bf9d2` | confirmed |
| 27 | issueGrant eight grants with eight recipients each to the agent key, twice, slots 3 to 18, until sixteen grants are outstanding | `a8bf95232ba0`, `63a957edde93` | confirmed |
| 28 | revokeGrant slots 3 to 18 one by one, sixteen transactions, each appending its slot to the revoked list | `00b5e0a88983`, `3235c8aeae62`, `7d60ba05ddbb`, `193eda86d4ff`, `ad9d36c6c0f0`, `b4bbdaa89e8b`, `9ad456878631`, `7d1c7028bc93`, `57114bf420c5`, `4e382ad7407c`, `afdea9f028ae`, `c4c1f03810d6`, `2e0d53498c4b`, `2cbbaac3c3b4`, `ee84439be1d5`, `3438c8839821` | confirmed |
| 29 | sweepGrant slots 3 to 10 and 11 to 18, eight dead grants per transaction, burning their tokens | `85f2d250a32f`, `2c5897142b5a` | confirmed |
| 30 | issueGrant eight grants with eight recipients each, twice, slots 19 to 34, until sixteen grants are outstanding again | `403fde788bf0`, `2daee7695815` | confirmed |
| 31 | revokeGrant slots 19 to 34 one by one, sixteen transactions, until the revoked list holds its thirty two slots | `60fd18c637d0`, `e5aab044f711`, `f8c1bbdbdcfe`, `6a932116a878`, `054bbedb3bbc`, `942383e96f31`, `464da508b3a2`, `314c3936c6f2`, `f5270b85c86f`, `12ebde918c80`, `143ffc021e51`, `cc41cabc4016`, `1f332bd41bab`, `5f01e48dbef1`, `c0dacfa24968`, `60708e12a8ce` | confirmed |
| 32 | rewriteState over the largest state, eight devices, thirty two revoked slots and sixteen outstanding grants, replacing the sixth rotation key with a seventh | `1b9e0939776e` | confirmed |
| 33 | sweepGrant slots 19 to 26 and 27 to 34 over the largest state, eight dead grants per transaction, burning their tokens | `dbe70ac967d2`, `d6015ea7fc8b` | confirmed |
| 34 | spendWithDevice 1 tADA to the owner address signed by the agent device, which finds the account by its persisted record and its own wallet alone | `4f2aec132d3a` | confirmed |
| 35 | withdrawRewards of zero from the reward account signed by the agent device, again from the account record and its own wallet alone | `6a8356c35592` | confirmed |
| 36 | deposit twenty UTxOs of 1.5 tADA into the account in one transaction from the funding wallet | `b3ec0f7edf39` | confirmed |
| 37 | issueGrant slot 35 to the agent key: 1,000 tADA per call and in total, the funding wallet as the only recipient | `241e571f356e` | confirmed |
| 38 | spendWithGrant over the 13 largest fund UTxOs of the account, one more than the 12 a checked grant spend may take, refused by the builder before anything is evaluated or submitted | none | refused by the builder: "The spend needs 13 fund UTxOs, more than the 12 one grant spend may take; sweep the funds in batches of fundBatches first" |
| 39 | spendWithGrant sweeping every fund UTxO of the account to the funding wallet in batches of at most 12 fund UTxOs per transaction, the first over exactly 12, each referencing the largest control state, with the execution units of the heaviest batch read back and set against the limit of the chain | `7244965dd72a`, `aad9ddf4a7c2`, `afcba2ff4c0b` | confirmed |
| 40 | removeDevice the agent wallet key | `7776fcecc440` | confirmed |
| 41 | removeDevice the six rotation keys, one transaction each, until the owner key is the only device | `e259d6d748fc`, `2fea03dfb061`, `ac6ca2ac9fc5`, `09cf2f7c24f4`, `50eb84a24ee1`, `04565be1b68c` | confirmed |
| 42 | spendWithDevice, sponsored by the funding wallet, sweeps every fund and reserve UTxO back to it, leaving only the control UTxO at the account address | `5c5a39027079` | confirmed |
| 43 | setup of the second logic on the network: register its credential with the Conway deposit through the logic publish handler and park it as a reference script at the always fail script address, both paid by the funding wallet and recorded in the network file, which the builders reference it from; a network that records it already has the parked UTxO checked through the provider and reused | `cf4d6dad2f0a`, `2abfc74ba77c` | confirmed |
| 44 | deposit 30 tADA into the account as plain funds from the funding wallet, from which the upgrade flows pay their owner steps, the reserve having been swept | `f58b425e47e6` | confirmed |
| 45 | issueGrant slot 36 to the agent key under the contract's logic: 10 tADA per call, 15 tADA in total, owner as the only recipient, issued under generation 2, which the runner checks the account is at | `24f9f7adf322` | confirmed |
| 46 | upgradeLogic to the second logic, rewriting the first field of the control datum with the generation bumped to 3, running the contract's logic, which approves the leave, and the second logic, which validates the arrival, both referenced from their parked UTxOs, over an account holding one device, no revoked slot and one outstanding grant | `4daf67713e60` | confirmed |
| 47 | spendWithGrant 1 tADA with the slot 36 grant, dead since the upgrade bumped the generation past it | none | refused by the builder: "Grant 36 is dead: grant 36 was issued under generation 2 and the account is at 3" |
| 48 | spendWithGrant 1 tADA with the slot 36 grant, built unchecked against the upgraded control state, signed and submitted; the second logic refuses the dead grant | none | refused by the node: "ConwayUtxowFailure (UtxoFailure (UtxosFailure (ValidationTagMismatch (IsValid True) (FailedUnexpectedly (PlutusFailure "The PlutusV3 script failed: The script hash is:ScriptHash "69baa8a8c877247028c56c8130449e186e3658d541536d168f92db3d" The plutus evaluation error is: CekError An error has occurred: The machine terminated because of an error, either from a built-in function or from an explicit use of 'error'. Caused by: error..." |
| 49 | sweepGrant slot 36 under the second logic, dead by generation, which the sweep rule reads from the stable prefix of its datum, burning its grant token | `85e8cb9e2dda` | confirmed |
| 50 | issueGrant slot 37 to the agent key under the second logic, the one request survivingGrantRequests lists from the grants and the state before the upgrade, issued under generation 3 | `14425402090c` | confirmed |
| 51 | spendWithGrant 8 tADA to the owner address with the slot 37 grant, referencing the control UTxO that names the second logic and running it | `b0d2c5f184b4` | confirmed |
| 52 | upgradeLogic back to the contract's logic attempted from the agent wallet, which holds no device key of the account | none | refused by the builder: "The wallet payment key is not a device of the account" |
| 53 | upgradeLogic back to the contract's logic assembled on the agent wallet with the grantee key as the only signer, built unchecked, signed and submitted; the second logic, which the account would leave, refuses the device spend without a device signature, while the contract's logic reads no signature of the arrival | none | refused by the node: "ConwayUtxowFailure (UtxoFailure (UtxosFailure (ValidationTagMismatch (IsValid True) (FailedUnexpectedly (PlutusFailure "The PlutusV3 script failed: The script hash is:ScriptHash "69baa8a8c877247028c56c8130449e186e3658d541536d168f92db3d" The plutus evaluation error is: CekError An error has occurred: The machine terminated because of an error, either from a built-in function or from an explicit use of 'error'. Caused by: error..." |
| 54 | spendWithDevice, sponsored by the funding wallet, sweeps every fund UTxO back to it once the slot 37 grant is revoked and swept, leaving only the control UTxO under the second logic at the account address | `f38a1ad1f116` | confirmed |

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
| 7 | 1 | `0af9d00f56f7` | 3 spend, mint, reward | 2,040,161 (11.6%) | 689,552,534 (6.8%) | reward 0: 1,139,689 / 387,572,146; spend 1: 410,345 / 137,790,944; mint 0: 246,295 / 79,237,047; spend 0: 126,684 / 42,570,729; spend 2: 117,148 / 42,381,668 |
| 8 | 1 | `b94f14792835` | 2 spend, reward | 1,550,840 (8.8%) | 546,705,903 (5.4%) | reward 0: 1,188,189 / 424,328,004; spend 0: 264,609 / 86,877,976; spend 1: 98,042 / 35,499,923 |
| 14 | 1 | `6c55f8d09871` | 3 spend, mint, reward | 2,033,317 (11.6%) | 686,881,171 (6.8%) | reward 0: 1,132,845 / 384,900,783; spend 1: 410,345 / 137,790,944; mint 0: 246,295 / 79,237,047; spend 0: 126,684 / 42,570,729; spend 2: 117,148 / 42,381,668 |
| 17 | 2 | `538730fa8514` | 3 spend, reward | 1,897,932 (10.8%) | 663,552,276 (6.6%) | reward 0: 1,413,108 / 496,900,243; spend 0: 280,884 / 91,901,522; spend 2: 105,898 / 39,250,588; spend 1: 98,042 / 35,499,923 |
| 18 | 1 | `cc866d8aa6f6` | 2 spend, reward | 1,054,737 (6.0%) | 359,691,826 (3.5%) | reward 0: 605,157 / 206,146,515; spend 1: 322,896 / 110,974,582; spend 0: 126,684 / 42,570,729 |
| 21 | 1 | `62c4da7e916c` | 2 spend, reward | 1,052,971 (6.0%) | 359,103,961 (3.5%) | reward 0: 603,391 / 205,558,650; spend 1: 322,896 / 110,974,582; spend 0: 126,684 / 42,570,729 |
| 22 | 1 | `38dc277867b4` | 4 spend, mint, reward | 2,526,520 (14.4%) | 864,758,460 (8.6%) | reward 0: 1,118,743 / 402,719,039; spend 2: 409,763 / 137,109,238; spend 3: 316,784 / 106,101,738; spend 0: 305,102 / 98,369,307; mint 0: 211,739 / 65,383,437; spend 1: 164,389 / 55,075,701 |
| 23 | 1 | `bee0015cf802` | 3 spend, mint, reward | 2,077,456 (11.8%) | 703,538,105 (7.0%) | reward 0: 1,147,313 / 392,712,381; spend 2: 414,239 / 140,368,421; mint 0: 246,295 / 79,237,047; spend 1: 145,037 / 49,689,274; spend 0: 124,572 / 41,530,982 |
| 25 | 1 | `491fc6fd6e4c` | 3 spend, mint, reward | 1,970,933 (11.2%) | 669,633,688 (6.6%) | reward 0: 1,003,904 / 349,929,905; spend 1: 378,166 / 126,468,164; spend 2: 285,187 / 95,460,664; mint 0: 176,992 / 55,204,226; spend 0: 126,684 / 42,570,729 |
| 26 | 7 | `294a018bf9d2` | 3 spend, reward | 1,492,741 (8.5%) | 495,037,511 (4.9%) | reward 0: 890,095 / 289,003,377; spend 1: 358,814 / 121,081,737; spend 0: 126,684 / 42,570,729; spend 2: 117,148 / 42,381,668 |
| 27 | 2 | `a8bf95232ba0` | 3 spend, mint, reward | 7,925,936 (45.2%) | 2,563,669,709 (25.6%) | reward 0: 6,409,058 / 2,055,652,763; spend 1: 771,062 / 254,755,393; mint 0: 501,984 / 168,309,156; spend 0: 126,684 / 42,570,729; spend 2: 117,148 / 42,381,668 |
| 28 | 16 | `3438c8839821` | 3 spend, reward | 1,614,693 (9.2%) | 528,972,381 (5.2%) | reward 0: 1,012,047 / 322,938,247; spend 1: 358,814 / 121,081,737; spend 0: 126,684 / 42,570,729; spend 2: 117,148 / 42,381,668 |
| 29 | 2 | `2c5897142b5a` | 10 spend, mint, reward | 8,679,753 (49.5%) | 2,923,194,406 (29.2%) | reward 0: 3,348,377 / 1,204,415,571; spend 9: 603,239 / 203,533,159; spend 7: 498,578 / 164,793,228; spend 6: 494,684 / 162,215,751; spend 5: 490,790 / 159,638,274; spend 4: 486,896 / 157,060,797; spend 3: 483,002 / 154,483,320; spend 2: 479,108 / 151,905,843; spend 1: 475,214 / 149,328,366; spend 0: 471,320 / 146,750,889; spend 8: 428,324 / 142,610,505; mint 0: 420,221 / 126,458,703 |
| 30 | 2 | `2daee7695815` | 4 spend, mint, reward | 8,321,032 (47.5%) | 2,691,679,777 (26.9%) | reward 0: 6,621,527 / 2,120,199,742; spend 2: 783,307 / 260,010,040; mint 0: 510,335 / 170,986,326; spend 1: 145,037 / 49,689,274; spend 3: 136,254 / 49,263,413; spend 0: 124,572 / 41,530,982 |
| 31 | 16 | `60708e12a8ce` | 3 spend, reward | 1,736,645 (9.9%) | 562,907,853 (5.6%) | reward 0: 1,133,999 / 356,873,719; spend 1: 358,814 / 121,081,737; spend 0: 126,684 / 42,570,729; spend 2: 117,148 / 42,381,668 |
| 32 | 1 | `1b9e0939776e` | 2 spend, reward | 1,529,091 (8.7%) | 491,217,942 (4.9%) | reward 0: 1,079,511 / 337,672,631; spend 1: 322,896 / 110,974,582; spend 0: 126,684 / 42,570,729 |
| 33 | 2 | `d6015ea7fc8b` | 10 spend, mint, reward | 9,202,345 (52.5%) | 3,075,777,302 (30.7%) | reward 0: 3,870,969 / 1,356,998,467; spend 9: 603,239 / 203,533,159; spend 7: 498,578 / 164,793,228; spend 6: 494,684 / 162,215,751; spend 5: 490,790 / 159,638,274; spend 4: 486,896 / 157,060,797; spend 3: 483,002 / 154,483,320; spend 2: 479,108 / 151,905,843; spend 1: 475,214 / 149,328,366; spend 0: 471,320 / 146,750,889; spend 8: 428,324 / 142,610,505; mint 0: 420,221 / 126,458,703 |
| 34 | 1 | `4f2aec132d3a` | 3 spend, reward | 1,804,459 (10.3%) | 583,789,429 (5.8%) | reward 0: 1,174,246 / 370,325,310; spend 1: 386,381 / 128,511,722; spend 0: 126,684 / 42,570,729; spend 2: 117,148 / 42,381,668 |
| 35 | 1 | `6a8356c35592` | 2 spend, 2 reward | 1,713,291 (9.7%) | 548,005,102 (5.4%) | reward 0: 1,092,829 / 341,623,879; spend 1: 322,896 / 110,974,582; reward 1: 170,882 / 52,835,912; spend 0: 126,684 / 42,570,729 |
| 37 | 1 | `241e571f356e` | 3 spend, mint, reward | 2,633,401 (15.0%) | 852,324,341 (8.5%) | reward 0: 1,732,929 / 550,343,953; spend 1: 410,345 / 137,790,944; mint 0: 246,295 / 79,237,047; spend 0: 126,684 / 42,570,729; spend 2: 117,148 / 42,381,668 |
| 39 | 3 | `7244965dd72a` | 13 spend, reward | 4,275,788 (24.4%) | 1,559,075,668 (15.5%) | reward 0: 2,485,810 / 846,636,264; spend 0: 356,470 / 116,326,846; spend 12: 140,876 / 63,852,170; spend 11: 136,982 / 61,274,693; spend 10: 133,088 / 58,697,216; spend 9: 129,194 / 56,119,739; spend 8: 125,300 / 53,542,262; spend 7: 121,406 / 50,964,785; spend 6: 117,512 / 48,387,308; spend 5: 113,618 / 45,809,831; spend 4: 109,724 / 43,232,354; spend 3: 105,830 / 40,654,877; spend 2: 101,936 / 38,077,400; spend 1: 98,042 / 35,499,923 |
| 40 | 1 | `7776fcecc440` | 2 spend, reward | 1,483,742 (8.4%) | 478,691,081 (4.7%) | reward 0: 1,034,162 / 325,145,770; spend 1: 322,896 / 110,974,582; spend 0: 126,684 / 42,570,729 |
| 41 | 6 | `e259d6d748fc` | 2 spend, reward | 1,440,360 (8.2%) | 466,733,513 (4.6%) | reward 0: 990,780 / 313,188,202; spend 1: 322,896 / 110,974,582; spend 0: 126,684 / 42,570,729 |
| 42 | 1 | `5c5a39027079` | 4 spend, reward | 1,452,340 (8.2%) | 499,204,712 (4.9%) | reward 0: 711,950 / 242,857,093; spend 1: 375,516 / 126,436,077; spend 0: 126,684 / 42,570,729; spend 3: 121,042 / 44,959,145; spend 2: 117,148 / 42,381,668 |
| 43 | 1 | `cf4d6dad2f0a` | cert | 21,507 (0.1%) | 6,248,080 (<0.1%) | cert 0: 21,507 / 6,248,080 |
| 45 | 1 | `24f9f7adf322` | 2 spend, mint, reward | 1,663,722 (9.5%) | 564,977,252 (5.6%) | reward 0: 993,962 / 337,682,670; spend 0: 358,645 / 121,950,960; mint 0: 213,073 / 69,843,699; spend 1: 98,042 / 35,499,923 |
| 46 | 1 | `4daf67713e60` | 2 spend, 2 reward | 1,266,645 (7.2%) | 429,718,250 (4.2%) | reward 0: 477,101 / 164,153,389; reward 1: 376,037 / 122,146,015; spend 0: 315,465 / 107,918,923; spend 1: 98,042 / 35,499,923 |
| 49 | 1 | `85e8cb9e2dda` | 3 spend, mint, reward | 1,692,032 (9.6%) | 583,145,881 (5.8%) | reward 0: 833,753 / 293,547,248; spend 1: 338,711 / 115,882,827; spend 0: 252,528 / 83,589,532; mint 0: 165,104 / 52,048,874; spend 2: 101,936 / 38,077,400 |
| 50 | 1 | `14425402090c` | 2 spend, mint, reward | 1,678,074 (9.5%) | 569,110,841 (5.6%) | reward 0: 1,008,314 / 341,816,259; spend 0: 358,645 / 121,950,960; mint 0: 213,073 / 69,843,699; spend 1: 98,042 / 35,499,923 |
| 51 | 1 | `b0d2c5f184b4` | 2 spend, reward | 1,560,162 (8.9%) | 549,132,782 (5.4%) | reward 0: 1,197,511 / 426,754,883; spend 0: 264,609 / 86,877,976; spend 1: 98,042 / 35,499,923 |
| 54 | 1 | `f38a1ad1f116` | 2 spend, reward | 1,066,340 (6.0%) | 361,236,402 (3.6%) | reward 0: 625,266 / 210,387,571; spend 0: 343,032 / 115,348,908; spend 1: 98,042 / 35,499,923 |

## Budget comparison

The heaviest transaction of each measured step against the rows of the
budget table in `docs/security-review.md`, which gives the net memory
units and steps of each handler as the test runner charged them over the
largest state, summed here over the handlers the transaction runs. The
on-chain figures are what the ledger charged for the same handlers over
the real transaction, so they are the ones the limits apply to. The
heaviest agent sweep batch is set against the eight and forty deposit
rows of the review; its input count is in the Redeemers column, one Fund
execution per deposit beside the SpendWithGrant execution. Those two rows
are the one batch measured once, so their transaction and their on-chain
columns repeat and only the review columns differ. The forty
deposit row is not reachable on chain: the builder takes at most twelve
fund UTxOs in one checked grant spend, as the refusal in the flows table
above shows, so the batch over exactly twelve is the heaviest agent
spend the library submits, and its share of the limit is the margin
that bound leaves. The upgrade is set against the upgrade row of the
review, which was measured over the largest state; the run upgrades
after the teardown, over an account holding one device, no revoked
slot and one outstanding grant, so its on-chain figure sits below
what the largest state would cost and the context decoding is the
only addition.

| Step | Path | Handlers | Transaction | Redeemers | On-chain memory | On-chain steps | Review net memory | Review net steps | Share of the limits |
| ---- | ---- | -------- | ----------- | --------- | --------------- | -------------- | ----------------- | ---------------- | ------------------- |
| 27 | issue of eight grants with eight recipients each | Device and IssueGrants | `a8bf95232ba0` | 5 | 7,925,936 | 2,563,669,709 | 6,910,000 | 2,130,000,000 | 45.2% / 25.6% |
| 28 | revoke of one slot | Device | `3438c8839821` | 4 | 1,614,693 | 528,972,381 | 1,100,000 | 320,000,000 | 9.2% / 5.2% |
| 29 | sweep of eight dead grants | Device, eight SweepGrant and BurnGrants | `2c5897142b5a` | 12 | 8,679,753 | 2,923,194,406 | 8,260,000 | 2,550,000,000 | 49.5% / 29.2% |
| 30 | issue of eight grants with eight recipients each | Device and IssueGrants | `2daee7695815` | 6 | 8,321,032 | 2,691,679,777 | 6,910,000 | 2,130,000,000 | 47.5% / 26.9% |
| 31 | revoke of one slot over the largest state | Device | `60708e12a8ce` | 4 | 1,736,645 | 562,907,853 | 1,100,000 | 320,000,000 | 9.9% / 5.6% |
| 32 | device rewrite over the largest state | Device | `1b9e0939776e` | 3 | 1,529,091 | 491,217,942 | 1,100,000 | 320,000,000 | 8.7% / 4.9% |
| 33 | sweep of eight dead grants over the largest state | Device, eight SweepGrant and BurnGrants | `d6015ea7fc8b` | 12 | 9,202,345 | 3,075,777,302 | 8,260,000 | 2,550,000,000 | 52.5% / 30.7% |
| 39 | agent spend over eight deposits | SpendWithGrant and eight Fund | `7244965dd72a` | 14 | 4,275,788 | 1,559,075,668 | 3,200,000 | 1,130,000,000 | 24.4% / 15.5% |
| 39 | agent spend over forty deposits | SpendWithGrant and forty Fund | `7244965dd72a` | 14 | 4,275,788 | 1,559,075,668 | 13,400,000 | 6,180,000,000 | 24.4% / 15.5% |
| 46 | upgrade | Device, the leaving logic and the arriving logic | `4daf67713e60` | 4 | 1,266,645 | 429,718,250 | 1,620,000 | 500,000,000 | 7.2% / 4.2% |

## Supporting transactions

| Purpose | Transaction |
| ------- | ----------- |
| fund the owner wallet with 5000000 lovelace | `2ad549c5a2f8` |
| fund the agent wallet with 10000000 lovelace | `2e369a8c5bf6` |
| revokeAllGrants, which kills the sweep grant | `1227987a6872` |
| sweepGrant slot 35, the last outstanding grant, so that only the control UTxO is left to sweep | `994321398034` |
| revokeGrant slot 37, which kills the grant issued again under the second logic | `033e03a14abf` |
| sweepGrant slot 37, the last outstanding grant, so that only the control UTxO is left to sweep | `579225441973` |
| return the agent wallet balance to the funding wallet | `a952378f0360` |
| return the owner wallet balance to the funding wallet | `354bf5966d93` |
| return the recipient wallet balance to the funding wallet | `9db5bba96ba6` |
