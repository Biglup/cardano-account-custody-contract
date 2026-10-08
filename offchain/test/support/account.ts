/**
 * Copyright 2026 IOG.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/* IMPORTS ********************************************************************/

import type { PlutusData, PlutusScript, UTxO, Value } from '@biglup/cometa';
import { accountAddress, grantAssetId, rewardAddress, stateNftAssetId } from '../../src/address.js';
import { accountScript, accountScriptHash, loadBlueprint, logicValidator } from '../../src/blueprint.js';
import { Cometa } from '../../src/cometa.js';
import { transactionBodyParts } from '../../src/body.js';
import { type AccountState, type Grant, type Scope, bytes, encodeAccountState, encodeGrant, encodeReserveDatum } from '../../src/data.js';
import { currentLogicScript, logicScriptHash } from '../../src/logic.js';
import { type NetworkScripts, type ReferenceScriptRecord } from '../../src/network.js';
import { applyParameters, stakeScript, stakeScriptHash } from '../../src/stake-script.js';
import { fixtureLogicScript } from '../../scripts/fixture-logic.js';
import { FakeProvider, FakeWallet, utxo } from './fake.js';

/* CONSTANTS ******************************************************************/

/** The keys and asset identifiers of the account scenario under test. */
export const OWNER_PAYMENT_KEY = 'aa'.repeat(28);
export const OWNER_STAKE_KEY = 'bb'.repeat(28);
export const AGENT_PAYMENT_KEY = 'cc'.repeat(28);
export const AGENT_STAKE_KEY = 'dd'.repeat(28);
export const OTHER_DEVICE_KEY = 'ee'.repeat(28);
export const STRANGER_KEY = 'ff'.repeat(28);
export const SPONSOR_PAYMENT_KEY = '77'.repeat(28);
export const SPONSOR_STAKE_KEY = '88'.repeat(28);
export const TOKEN_POLICY = '99'.repeat(28);
export const TOKEN_NAME = Cometa.utf8ToHex('token');
export const TOKEN_ASSET_ID = `${TOKEN_POLICY}${TOKEN_NAME}`;
export const EXPIRY = 1_800_000_000_000n;
export const VALID_UNTIL_SLOT = 100_000_000n;
export const CONTROL_LOVELACE = 2_000_000n;
export const GRANT_LOVELACE = 2_000_000n;

/**
 * The parameter the logic outside the blueprint is applied to. The fixture
 * is the current logic applied to this hash in place of the proxy hash: it
 * has its own script hash and its own credential, which is all the
 * builders and the fake evaluator read of a logic, so it stands for a
 * version this library does not carry, given alongside the blueprint or
 * refused. On chain such a script answers to another proxy, so it is a
 * fixture only.
 */
export const FOREIGN_LOGIC_PARAMETER = '02'.repeat(28);

/** The always fail script hash the tests park reference scripts under, and the lovelace each parked UTxO holds. */
export const PARKING_SCRIPT_HASH = 'ab'.repeat(28);
export const PARKED_LOVELACE = 30_000_000n;

/** The scripts and derived identifiers of the account under test, whose owner is the owner wallet's payment key. */
export const script = accountScript();
export const scriptHash = accountScriptHash(script);
export const ownerStakeScript = stakeScript(OWNER_PAYMENT_KEY, scriptHash);
export const ownerStakeScriptHash = stakeScriptHash(ownerStakeScript);
export const nftAssetId = stateNftAssetId(scriptHash, ownerStakeScriptHash);
export const address = accountAddress(scriptHash, ownerStakeScriptHash).toString();
export const ownerRewardAddress = rewardAddress(ownerStakeScriptHash).toBech32();

/** The logic of the blueprint applied to the proxy hash, which every fixture account runs, and the reward account its zero withdrawal draws from. */
export const logicV1: PlutusScript = currentLogicScript(scriptHash);
export const logicV1Hash = logicScriptHash(logicV1);
export const logicV1RewardAddress = rewardAddress(logicV1Hash).toBech32();

/**
 * The throwaway second logic of the upgrade fixture project applied to
 * the proxy hash, which the upgrade fixtures move accounts to, and the
 * reward account its zero withdrawal draws from. It is outside the
 * blueprint, so every builder that serves an account on it is given it
 * among the logics it may attach.
 */
export const secondLogic: PlutusScript = fixtureLogicScript(scriptHash);
export const secondLogicHash = logicScriptHash(secondLogic);
export const secondLogicRewardAddress = rewardAddress(secondLogicHash).toBech32();

/** A logic of another proxy, the blueprint's logic applied to `FOREIGN_LOGIC_PARAMETER`, and its hash. */
export const foreignLogic: PlutusScript = {
  type: Cometa.ScriptType.Plutus,
  bytes: applyParameters(logicValidator(loadBlueprint()).compiledCode, [bytes(FOREIGN_LOGIC_PARAMETER)]),
  version: Cometa.PlutusLanguageVersion.V3,
};
export const foreignLogicHash = logicScriptHash(foreignLogic);

/** The always fail script address the tests park reference scripts at. */
export const parkingAddress = Cometa.EnterpriseAddress.fromCredentials(Cometa.NetworkId.Testnet, { hash: PARKING_SCRIPT_HASH, type: Cometa.CredentialType.ScriptHash })
  .toAddress()
  .toString();

/** The state of a freshly created account under the blueprint's logic. */
export const initialState: AccountState = { logic: logicV1Hash, devices: [OWNER_PAYMENT_KEY], grantGeneration: 0n, nextSlot: 0n, revoked: [], outstanding: 0n };

/** The transaction ids of the UTxOs each wallet and the account hold in a scenario. */
export const CONTROL_UTXO_TX = '11'.repeat(32);
export const FUND_UTXO_TX = '22'.repeat(32);
export const OWNER_UTXO_TX = '33'.repeat(32);
export const AGENT_UTXO_TX = '44'.repeat(32);
export const SPONSOR_UTXO_TX = '55'.repeat(32);
export const GRANT_UTXO_TX = '66'.repeat(32);
export const RESERVE_UTXO_TX = '77'.repeat(32);
export const REFERENCE_UTXO_TX = '88'.repeat(32);

/* TYPES **********************************************************************/

/** A provider holding the owner, agent and sponsor wallets' funds and the account's UTxOs. */
export interface Scenario {
  provider: FakeProvider;
  owner: FakeWallet;
  agent: FakeWallet;
  sponsor: FakeWallet;
}

/* FUNCTIONS ******************************************************************/

/** A key address outside the account, usable as a destination. */
export const enterpriseAddress = (keyHash: string): string =>
  Cometa.EnterpriseAddress.fromCredentials(Cometa.NetworkId.Testnet, { hash: keyHash, type: Cometa.CredentialType.KeyHash })
    .toAddress()
    .toString();

/**
 * The destination the fixture grants allow. Declared here rather than in
 * CONSTANTS because its value calls `enterpriseAddress` above, which must
 * already be defined when this initialiser runs.
 */
export const recipientAddress = enterpriseAddress(STRANGER_KEY);

/** A lovelace scope allowing 10 tADA per call and 15 tADA in total. */
export const lovelaceScope = (recipients: string[] = []): Scope => ({
  asset: { policyId: '', assetName: '' },
  perCallCap: 10_000_000n,
  cap: 15_000_000n,
  lovelacePerCallCap: 0n,
  lovelaceCap: 0n,
  expiresAt: EXPIRY,
  recipients,
});

/** A token scope allowing 10 tokens per call, 50 in total, 2.5 tADA alongside per call and 3 tADA alongside in total. */
export const tokenScope = (recipients: string[] = []): Scope => ({
  asset: { policyId: TOKEN_POLICY, assetName: TOKEN_NAME },
  perCallCap: 10n,
  cap: 50n,
  lovelacePerCallCap: 2_500_000n,
  lovelaceCap: 3_000_000n,
  expiresAt: EXPIRY,
  recipients,
});

/**
 * A lovelace grant, a token grant and a restricted lovelace grant, all
 * held by the agent key and issued under generation zero in slots zero to
 * two. Declared here rather than in CONSTANTS because its value calls
 * `lovelaceScope` and `tokenScope` above, which must already be defined
 * when this initialiser runs.
 */
export const fixtureGrants: Grant[] = [
  { slot: 0n, grantee: AGENT_PAYMENT_KEY, generation: 0n, scope: lovelaceScope() },
  { slot: 1n, grantee: AGENT_PAYMENT_KEY, generation: 0n, scope: tokenScope([recipientAddress]) },
  { slot: 2n, grantee: AGENT_PAYMENT_KEY, generation: 0n, scope: lovelaceScope([recipientAddress]) },
];

/** The state of an account that issued the fixture grants and holds them all. */
export const grantedState: AccountState = { ...initialState, nextSlot: 3n, outstanding: 3n };

/** The asset id of the grant token of a slot of the account under test. */
export const grantAssetIdOf = (slot: bigint): string => grantAssetId(scriptHash, ownerStakeScriptHash, slot);

/** The control UTxO of the account under test, carrying a state inline. */
export const controlUtxo = (state: AccountState, index = 0): UTxO =>
  utxo(CONTROL_UTXO_TX, index, address, { coins: CONTROL_LOVELACE, assets: { [nftAssetId]: 1n } }, encodeAccountState(state));

/** A deposit UTxO at the account address. */
export const fundUtxo = (index: number, value: Value): UTxO => utxo(FUND_UTXO_TX, index, address, value);

/** A reserve UTxO at the account address: a deposit carrying the reserve datum. */
export const reserveUtxo = (index: number, value: Value): UTxO => utxo(RESERVE_UTXO_TX, index, address, value, encodeReserveDatum());

/** A UTxO at the account address carrying only a datum hash, as anyone can park there, which discovery lists as a reserve and no builder spends. */
export const datumHashUtxo = (index: number, value: Value): UTxO => ({
  input: { txId: RESERVE_UTXO_TX, index },
  output: { address, value, datumHash: 'ab'.repeat(32) },
});

/** The grant UTxO of a grant, holding its token and lovelace at the account address, indexed by its slot. */
export const grantUtxo = (grant: Grant, coins = GRANT_LOVELACE): UTxO =>
  utxo(GRANT_UTXO_TX, Number(grant.slot), address, { coins, assets: { [grantAssetIdOf(grant.slot)]: 1n } }, encodeGrant(grant));

/** The grant UTxOs of the fixture grants. */
export const grantedUtxos = (): UTxO[] => fixtureGrants.map((grant) => grantUtxo(grant));

/**
 * The scripts parked as reference scripts in every scenario: the proxy,
 * the blueprint's logic and the second logic the upgrade moves an
 * account to, each in its own UTxO at the parking address, indexed in
 * this order under the reference transaction.
 */
export const parkedScripts: PlutusScript[] = [script, logicV1, secondLogic];

/** The reference script UTxO of a parked script, as the network setup leaves it and the fake provider serves it. */
export const referenceUtxo = (parked: PlutusScript): UTxO => ({
  input: { txId: REFERENCE_UTXO_TX, index: parkedScripts.indexOf(parked) },
  output: { address: parkingAddress, value: { coins: PARKED_LOVELACE }, scriptReference: parked },
});

/** The record of a parked script as the network file carries it. */
export const referenceRecord = (parked: PlutusScript): ReferenceScriptRecord => ({
  scriptHash: Cometa.computeScriptHash(parked),
  txId: REFERENCE_UTXO_TX,
  index: parkedScripts.indexOf(parked),
  address: parkingAddress,
  lovelace: PARKED_LOVELACE.toString(),
});

/** The reference scripts of the test network: the given scripts, every parked one when none are named. */
export const networkScripts = (parked: PlutusScript[] = parkedScripts): NetworkScripts => ({
  network: 'fake',
  references: parked.map(referenceRecord),
});

/**
 * A funded owner, agent and sponsor wallet plus the account's UTxOs beyond
 * its control UTxO, served by one fake provider that also holds the
 * parked reference scripts, so that a builder given the network's records
 * finds the UTxOs it references.
 */
export const scenario = (state: AccountState | undefined, utxos: UTxO[]): Scenario => {
  const provider = new FakeProvider();
  const owner = new FakeWallet(provider, OWNER_PAYMENT_KEY, OWNER_STAKE_KEY);
  const agent = new FakeWallet(provider, AGENT_PAYMENT_KEY, AGENT_STAKE_KEY);
  const sponsor = new FakeWallet(provider, SPONSOR_PAYMENT_KEY, SPONSOR_STAKE_KEY);
  provider.addUtxo(utxo(OWNER_UTXO_TX, 0, owner.address.toString(), { coins: 50_000_000n }));
  provider.addUtxo(utxo(AGENT_UTXO_TX, 0, agent.address.toString(), { coins: 20_000_000n }));
  provider.addUtxo(utxo(SPONSOR_UTXO_TX, 0, sponsor.address.toString(), { coins: 60_000_000n }));
  for (const parked of parkedScripts) {
    provider.addUtxo(referenceUtxo(parked));
  }
  if (state) {
    provider.addUtxo(controlUtxo(state));
  }
  for (const each of utxos) {
    provider.addUtxo(each);
  }
  return { provider, owner, agent, sponsor };
};

/** The inputs of a transaction paired with the redeemer data spending them, when any. */
export const spentWithRedeemers = (tx: string): { input: UTxO['input']; redeemer?: PlutusData }[] => {
  const inputs = transactionBodyParts(tx).inputs;
  const redeemers = Cometa.readRedeemersFromTx(tx).filter((redeemer) => redeemer.purpose === Cometa.RedeemerPurpose.spend);
  return inputs.map((input, index) => {
    const redeemer = redeemers.find((candidate) => candidate.index === index);
    return redeemer ? { input, redeemer: redeemer.data } : { input };
  });
};

/** The CBOR of the redeemer spending an input, or undefined when the input needs none. */
export const redeemerOf = (tx: string, input: UTxO['input']): string | undefined => {
  const spent = spentWithRedeemers(tx).find((entry) => entry.input.txId === input.txId && entry.input.index === input.index);
  return spent?.redeemer === undefined ? undefined : Cometa.plutusDataToCbor(spent.redeemer);
};
