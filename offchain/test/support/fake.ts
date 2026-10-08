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

import type {
  Address,
  AssetAmounts,
  NetworkId,
  NetworkMagic,
  PlutusData,
  ProtocolParameters,
  Provider,
  Redeemer,
  RewardAddress,
  TransactionBuilder,
  TxIn,
  TxOut,
  UTxO,
  Value,
  VkeyWitnessSet,
  Wallet,
} from '@biglup/cometa';
import {
  accountAddress,
  accountOfTokenName,
  grantAssetId,
  grantTokenName,
  grantTokenNamesOf,
  isGrantTokenName,
  stateNftAssetId,
  toAddress,
} from '../../src/address.js';
import { Cometa } from '../../src/cometa.js';
import { type ValidityRange, type Withdrawal, transactionBodyParts, upperBoundTime } from '../../src/body.js';
import {
  type AccountRedeemer,
  type AccountState,
  type Grant,
  decodeAccountRedeemer,
  decodeAccountState,
  decodeGrant,
  decodeLogicHash,
  decodeMintRedeemer,
  expectBytes,
  expectList,
} from '../../src/data.js';
import { stakeScript, stakeScriptHash } from '../../src/stake-script.js';
import {
  grantAfterSpend,
  grantDeathReason,
  grantOutputViolation,
  hasZeroCounters,
  isGrantCurrent,
  scopeDefect,
  scopeViolation,
  stateDefect,
} from '../../src/state.js';
import { type Balance, addBalances, subtractBalances, toBalance } from '../../src/value.js';

/* CONSTANTS ******************************************************************/

/** The Plutus V3 cost model of the preprod Conway genesis. */
const PLUTUS_V3_COSTS = [
  100788, 420, 1, 1, 1000, 173, 0, 1, 1000, 59957, 4, 1, 11183, 32, 201305, 8356, 4, 16000, 100, 16000, 100, 16000, 100, 16000,
  100, 16000, 100, 16000, 100, 100, 100, 16000, 100, 94375, 32, 132994, 32, 61462, 4, 72010, 178, 0, 1, 22151, 32, 91189, 769,
  4, 2, 85848, 123203, 7305, -900, 1716, 549, 57, 85848, 0, 1, 1, 1000, 42921, 4, 2, 24548, 29498, 38, 1, 898148, 27279, 1,
  51775, 558, 1, 39184, 1000, 60594, 1, 141895, 32, 83150, 32, 15299, 32, 76049, 1, 13169, 4, 22100, 10, 28999, 74, 1, 28999,
  74, 1, 43285, 552, 1, 44749, 541, 1, 33852, 32, 68246, 32, 72362, 32, 7243, 32, 7391, 32, 11546, 32, 85848, 123203, 7305,
  -900, 1716, 549, 57, 85848, 0, 1, 90434, 519, 0, 1, 74433, 32, 85848, 123203, 7305, -900, 1716, 549, 57, 85848, 0, 1, 1,
  85848, 123203, 7305, -900, 1716, 549, 57, 85848, 0, 1, 955506, 213312, 0, 2, 270652, 22588, 4, 1457325, 64566, 4, 20467, 1,
  4, 0, 141992, 32, 100788, 420, 1, 1, 81663, 32, 59498, 32, 20142, 32, 24588, 32, 20744, 32, 25933, 32, 24623, 32, 43053543,
  10, 53384111, 14333, 10, 43574283, 26308, 10, 16000, 100, 16000, 100, 962335, 18, 2780678, 6, 442008, 1, 52538055, 3756,
  18, 267929, 18, 76433006, 8868, 18, 52948122, 18, 1995836, 36, 3227919, 12, 901022, 1, 166917843, 4307, 36, 284546, 36,
  158221314, 26549, 36, 74698472, 36, 333849714, 1, 254006273, 72, 2174038, 72, 2261318, 64571, 4, 207616, 8310, 4, 1293828,
  28716, 63, 0, 1, 1006041, 43623, 251, 0, 1,
];

/** A one half threshold, used wherever a governance threshold is needed. */
const half = { numerator: 1, denominator: 2 };

/** Protocol parameters close to preprod's, enough for fee and script data hash computation. */
export const PROTOCOL_PARAMETERS: ProtocolParameters = {
  minFeeA: 44,
  minFeeB: 155381,
  maxBlockBodySize: 90112,
  maxTxSize: 16384,
  maxBlockHeaderSize: 1100,
  keyDeposit: 2_000_000,
  poolDeposit: 500_000_000,
  maxEpoch: 18,
  nOpt: 500,
  poolPledgeInfluence: { numerator: 3, denominator: 10 },
  treasuryGrowthRate: { numerator: 1, denominator: 5 },
  expansionRate: { numerator: 3, denominator: 1000 },
  decentralisationParam: { numerator: 0, denominator: 1 },
  extraEntropy: null,
  protocolVersion: { major: 10, minor: 0 },
  minPoolCost: 170_000_000,
  adaPerUtxoByte: 4310,
  costModels: [{ language: 'PlutusV3', costs: PLUTUS_V3_COSTS }],
  executionCosts: {
    memory: { numerator: 577, denominator: 10_000 },
    steps: { numerator: 721, denominator: 10_000_000 },
  },
  maxTxExUnits: { memory: 14_000_000, steps: 10_000_000_000 },
  maxBlockExUnits: { memory: 62_000_000, steps: 20_000_000_000 },
  maxValueSize: 5000,
  collateralPercent: 150,
  maxCollateralInputs: 3,
  poolVotingThresholds: {
    motionNoConfidence: half,
    committeeNormal: half,
    committeeNoConfidence: half,
    hardForkInitiation: half,
    securityRelevantParamVotingThreshold: half,
  },
  drepVotingThresholds: {
    motionNoConfidence: half,
    committeeNormal: half,
    committeeNoConfidence: half,
    hardForkInitiation: half,
    updateConstitution: half,
    ppNetworkGroup: half,
    ppEconomicGroup: half,
    ppTechnicalGroup: half,
    ppGovernanceGroup: half,
    treasuryWithdrawal: half,
  },
  minCommitteeSize: 0,
  committeeTermLimit: 146,
  governanceActionValidityPeriod: 6,
  governanceActionDeposit: 100_000_000_000,
  drepDeposit: 500_000_000,
  drepInactivityPeriod: 20,
  refScriptCostPerByte: { numerator: 15, denominator: 1 },
};

/** The execution units the fake provider reports for every redeemer. */
export const FAKE_EXECUTION_UNITS = { memory: 1_500_000, steps: 700_000_000 };

/** The hex length of a script hash, which the logic field of a control datum must have. */
const SCRIPT_HASH_HEX_LENGTH = 56;

/** The certificate tags the inspection reports for a registration of a stake credential, alone or with a delegation, both of which create an account. */
const REGISTRATION_TAGS = ['registration', 'stake_registration_delegation'];

/* TYPES **********************************************************************/

/** The identifiers of the account an address belongs to. */
interface AccountKeys {
  scriptHash: string;
  stakeScriptHash: string;
  address: string;
  nftAssetId: string;
}

/** A certificate as the transaction inspection reports it: its kind and, for a stake certificate, its credential. */
interface InspectedCertificate {
  tag: string;
  credential?: { tag: string; value: string };
}

/** What the fake evaluator sees of a transaction: the script context the validators read. */
interface Context {
  spent: UTxO[];
  referenced: UTxO[];
  outputs: TxOut[];
  mint: AssetAmounts;
  validityRange: ValidityRange;
  requiredSigners: string[];
  certificates: InspectedCertificate[];
  withdrawals: Withdrawal[];
  /** The proxy redeemer of each spent input at an account address, keyed by output reference. */
  spendRedeemers: Map<string, AccountRedeemer>;
  /** The mint redeemer of each policy run, keyed by policy id. */
  mintRedeemers: Map<string, PlutusData>;
}

/* FUNCTIONS ******************************************************************/

/** The bech32 form of an address, used to key the canned UTxOs. */
const addressKey = (address: Address | string): string => (typeof address === 'string' ? address : address.toString());

/** The key of an output reference. */
const referenceKey = (input: TxIn): string => `${input.txId}#${input.index}`;

/** The account an address belongs to, when it is a script base address with a script stake part. */
const accountOf = (address: string): AccountKeys | undefined => {
  const base = toAddress(address).asBase();
  const payment = base?.getPaymentCredential();
  const stake = base?.getStakeCredential();
  return payment?.type === Cometa.CredentialType.ScriptHash && stake?.type === Cometa.CredentialType.ScriptHash
    ? { scriptHash: payment.hash, stakeScriptHash: stake.hash, address, nftAssetId: stateNftAssetId(payment.hash, stake.hash) }
    : undefined;
};

/** The names of the account's tokens a value holds: its state NFT and its grant tokens. */
const accountTokenNames = (value: Value, keys: AccountKeys): string[] => [
  ...((value.assets?.[keys.nftAssetId] ?? 0n) > 0n ? [keys.stakeScriptHash] : []),
  ...grantTokenNamesOf(value, keys.scriptHash, keys.stakeScriptHash),
];

/** Whether an output sits at the account address, holds its state NFT and carries an inline datum, as every control UTxO does. */
const isControlOutput = (output: TxOut, keys: AccountKeys): boolean =>
  output.address === keys.address && output.value.assets?.[keys.nftAssetId] === 1n && output.datum !== undefined;

/** Whether a value holds nothing but lovelace and one unit of an asset. */
const holdsOnlyLovelaceAnd = (value: Value, assetId: string): boolean => {
  const assets = Object.entries(value.assets ?? {}).filter(([, quantity]) => quantity !== 0n);
  return assets.length === 1 && assets[0]?.[0] === assetId && assets[0]?.[1] === 1n;
};

/** The state an output carries as its inline datum in the shape the logic keeps, or undefined without one. */
const stateOf = (output: TxOut): AccountState | undefined => {
  if (output.datum === undefined) {
    return undefined;
  }
  try {
    return decodeAccountState(output.datum);
  } catch {
    return undefined;
  }
};

/** The logic hash an output's datum names in its first field, as the proxy reads it, or undefined when it names none. */
const logicOf = (output: TxOut): string | undefined => {
  if (output.datum === undefined) {
    return undefined;
  }
  try {
    const logic = decodeLogicHash(output.datum);
    return logic.length === SCRIPT_HASH_HEX_LENGTH ? logic : undefined;
  } catch {
    return undefined;
  }
};

/** The devices an output's datum lists in its second field, as the stake script reads them, or undefined when it lists none. */
const devicesOf = (output: TxOut): string[] | undefined => {
  if (output.datum === undefined || !Cometa.isPlutusDataConstr(output.datum) || output.datum.fields.items.length < 2) {
    return undefined;
  }
  try {
    return expectList(output.datum.fields.items[1] as PlutusData, 'devices').map((device) => expectBytes(device, 'a device'));
  } catch {
    return undefined;
  }
};

/** The generation an output's datum carries in its third field, as an arriving logic reads it, or undefined when it carries none. */
const generationOf = (output: TxOut): bigint | undefined => {
  if (output.datum === undefined || !Cometa.isPlutusDataConstr(output.datum) || output.datum.fields.items.length < 3) {
    return undefined;
  }
  const generation = output.datum.fields.items[2] as PlutusData;
  return Cometa.isPlutusDataBigInt(generation) ? generation : undefined;
};

/** The grant an output carries as its inline datum, or undefined without one of the current shape. */
const grantOf = (output: TxOut): Grant | undefined => {
  if (output.datum === undefined) {
    return undefined;
  }
  try {
    return decodeGrant(output.datum);
  } catch {
    return undefined;
  }
};

/**
 * The slot and the generation a grant datum carries at fields 0 and 2,
 * which is all the sweep rule reads of a datum of any shape, or
 * undefined when the datum is not a constructor with integers there.
 */
const sweepPrefixOf = (output: TxOut): { slot: bigint; generation: bigint } | undefined => {
  if (output.datum === undefined || !Cometa.isPlutusDataConstr(output.datum) || output.datum.fields.items.length < 3) {
    return undefined;
  }
  const slot = output.datum.fields.items[0] as PlutusData;
  const generation = output.datum.fields.items[2] as PlutusData;
  return Cometa.isPlutusDataBigInt(slot) && Cometa.isPlutusDataBigInt(generation) ? { slot, generation } : undefined;
};

/** Whether one of the given devices is among the required signers. */
const signedByOneOf = (devices: string[], signers: string[]): boolean => devices.some((device) => signers.includes(device));

/** Whether one of the state's devices is among the required signers. */
const signedByDevice = (state: AccountState, signers: string[]): boolean => signedByOneOf(state.devices, signers);

/** The balance of the outputs at an address. */
const balanceAt = (outputs: TxOut[], address: string): Balance =>
  addBalances(...outputs.filter((output) => output.address === address).map((output) => toBalance(output.value)));

/** The single control output of the account, or undefined when there is none or several. */
const controlOutputOf = (outputs: TxOut[], keys: AccountKeys): TxOut | undefined => {
  const controls = outputs.filter((output) => isControlOutput(output, keys));
  return controls.length === 1 ? controls[0] : undefined;
};

/** The single output holding one unit of an asset, or undefined when there is none or several. */
const tokenOutputOf = (outputs: TxOut[], assetId: string): TxOut | undefined => {
  const holders = outputs.filter((output) => output.value.assets?.[assetId] === 1n);
  return holders.length === 1 ? holders[0] : undefined;
};

/** The entries of the mint under a policy as names and quantities, in name order. */
const mintedUnder = (mint: AssetAmounts, policyId: string): [string, bigint][] =>
  Object.entries(mint)
    .filter(([assetId]) => assetId.startsWith(policyId))
    .map(([assetId, quantity]): [string, bigint] => [assetId.slice(policyId.length), quantity])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/** Whether a value holds any token of the account policy, of this account or another. */
const holdsPolicyToken = (value: Value, scriptHash: string): boolean =>
  Object.entries(value.assets ?? {}).some(([assetId, quantity]) => assetId.startsWith(scriptHash) && quantity !== 0n);

/** Whether every account token among the outputs sits in quantity one at the address its name denotes. */
const tokensSitAtTheirOwnAddresses = (outputs: TxOut[], scriptHash: string): boolean =>
  outputs.every((output) =>
    Object.entries(output.value.assets ?? {})
      .filter(([assetId]) => assetId.startsWith(scriptHash))
      .every(([assetId, quantity]) => quantity === 1n && output.address === accountAddress(scriptHash, accountOfTokenName(assetId.slice(scriptHash.length))).toString()),
  );

/** Whether the transaction withdraws from a script credential, which is what makes the ledger run a logic. */
const withdrawsFrom = (context: Context, credential: string): boolean =>
  context.withdrawals.some((withdrawal) => withdrawal.script && withdrawal.credential === credential);

/** The number of grant tokens of the account minted and burned, or a failure when the mint holds anything else of its policy. */
const grantMintDelta = (mint: AssetAmounts, keys: AccountKeys): { minted: number; burned: number } | string => {
  let minted = 0;
  let burned = 0;
  for (const [name, quantity] of mintedUnder(mint, keys.scriptHash)) {
    if (!isGrantTokenName(name) || accountOfTokenName(name) !== keys.stakeScriptHash || (quantity !== 1n && quantity !== -1n)) {
      return `The mint holds ${name} of the account policy, which is not one grant token of the account`;
    }
    minted += quantity === 1n ? 1 : 0;
    burned += quantity === -1n ? 1 : 0;
  }
  return { minted, burned };
};

/** The control UTxOs of the account among a list, whatever logic they name. */
const controlsOf = (utxos: UTxO[], keys: AccountKeys): UTxO[] => utxos.filter((utxo) => isControlOutput(utxo.output, keys));

/** The control UTxOs under the proxy naming a logic among a list, of any account. */
const controlsNaming = (utxos: UTxO[], logic: string): UTxO[] =>
  utxos.filter((utxo) => {
    const keys = accountOf(utxo.output.address);
    return keys !== undefined && isControlOutput(utxo.output, keys) && logicOf(utxo.output) === logic;
  });

/**
 * Why the proxy refuses the control output of a spent control UTxO, or
 * undefined when it keeps it in place whatever logic runs: exactly one
 * output holds the state NFT, at the account address, under an inline
 * datum, with only lovelace beside it and no reference script.
 */
const pinnedControlFailure = (keys: AccountKeys, context: Context): string | undefined => {
  const holders = context.outputs.filter((output) => (output.value.assets?.[keys.nftAssetId] ?? 0n) === 1n);
  if (holders.length !== 1) {
    return `The state NFT must land in exactly one output, not ${holders.length}`;
  }
  const control = holders[0]!;
  if (control.address !== keys.address) {
    return 'The control output must sit at the account address';
  }
  if (!holdsOnlyLovelaceAnd(control.value, keys.nftAssetId)) {
    return 'The control output must hold only lovelace and the state NFT';
  }
  if (control.datum === undefined) {
    return 'The control output must carry an inline datum';
  }
  return control.scriptReference === undefined ? undefined : 'The control output carries a reference script';
};

/**
 * Why the proxy refuses to defer a spend or a mint to the logic, or
 * undefined when it does: the account's control UTxO is present exactly
 * once, spent or referenced, and the transaction withdraws from the logic
 * its datum names.
 */
const runsTheLogicFailure = (keys: AccountKeys, context: Context): string | undefined => {
  const present = [...controlsOf(context.spent, keys), ...controlsOf(context.referenced, keys)];
  if (present.length !== 1) {
    return `The control UTxO of ${keys.stakeScriptHash} must be present exactly once, spent or referenced, not ${present.length} times`;
  }
  const logic = logicOf(present[0]!.output);
  if (logic === undefined) {
    return 'The control datum names no logic in its first field';
  }
  return withdrawsFrom(context, logic) ? undefined : `The transaction does not withdraw from the logic ${logic} the control UTxO names`;
};

/**
 * Why the control output does not recreate the state as the logic's device
 * rule demands, or undefined when it does: under the same logic, only
 * lovelace and the NFT, a well formed state with a non decreasing
 * generation and counters following the mint; under another logic, a
 * withdrawal from that logic and nothing minted under the policy.
 */
const controlRecreationFailure = (old: AccountState, ownHash: string, keys: AccountKeys, context: Context): string | undefined => {
  const control = controlOutputOf(context.outputs, keys);
  if (!control) {
    return 'The control UTxO is not recreated in a single control output';
  }
  const nextLogic = logicOf(control);
  if (nextLogic === undefined) {
    return 'The recreated control datum names no logic';
  }
  if (nextLogic !== ownHash) {
    if (!withdrawsFrom(context, nextLogic)) {
      return `The account leaves for logic ${nextLogic}, which does not run`;
    }
    return mintedUnder(context.mint, keys.scriptHash).length === 0 ? undefined : 'An upgrade mints or burns under the account policy';
  }
  if (!holdsOnlyLovelaceAnd(control.value, keys.nftAssetId)) {
    return 'The control UTxO is not recreated holding only lovelace and the state NFT';
  }
  const next = stateOf(control);
  if (!next) {
    return 'The control UTxO is not recreated with a state of the shape the logic keeps';
  }
  const defect = stateDefect(next);
  if (defect) {
    return `The recreated state is not well formed: ${defect}`;
  }
  if (next.grantGeneration < old.grantGeneration) {
    return 'The recreated state lowers the grant generation';
  }
  const delta = grantMintDelta(context.mint, keys);
  if (typeof delta === 'string') {
    return delta;
  }
  if (next.nextSlot !== old.nextSlot + BigInt(delta.minted) || next.outstanding !== old.outstanding + BigInt(delta.minted) - BigInt(delta.burned)) {
    return 'The recreated counters do not follow the grant tokens minted and burned';
  }
  return undefined;
};

/** Why a device spend of the control UTxO breaks the owner path, or undefined when it passes. */
const deviceFailure = (own: UTxO, old: AccountState, ownHash: string, keys: AccountKeys, context: Context): string | undefined => {
  if (own.output.value.assets?.[keys.nftAssetId] !== 1n) {
    return 'The device redeemer spends a UTxO that is not the control UTxO';
  }
  if (!signedByDevice(old, context.requiredSigners)) {
    return 'No device of the account signs the device spend';
  }
  if (!tokensSitAtTheirOwnAddresses(context.spent.map((utxo) => utxo.output), keys.scriptHash) || !tokensSitAtTheirOwnAddresses(context.outputs, keys.scriptHash)) {
    return 'An account token sits away from its own account address';
  }
  return controlRecreationFailure(old, ownHash, keys, context);
};

/** A value as Plutus data, so that two values compare by content. */
const toValueData = (value: Value): PlutusData => ({
  items: [value.coins, ...Object.entries(value.assets ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)).map(([assetId, quantity]) => ({ items: [Cometa.hexToUint8Array(assetId), quantity] }))],
});

/** Why a grant spend breaks the agent path as the logic checks it, or undefined when it passes. */
const grantSpendFailure = (grantUtxo: UTxO, state: AccountState, keys: AccountKeys, context: Context): string | undefined => {
  const grant = grantOf(grantUtxo.output);
  if (!grant) {
    return 'The grant UTxO carries no grant of the shape the logic reads';
  }
  const assetId = grantAssetId(keys.scriptHash, keys.stakeScriptHash, grant.slot);
  if (!holdsOnlyLovelaceAnd(grantUtxo.output.value, assetId)) {
    return `The grant UTxO does not hold only lovelace and the grant token of slot ${grant.slot}`;
  }
  if (context.spent.filter((utxo) => accountTokenNames(utxo.output.value, keys).length > 0).length !== 1) {
    return 'A grant spend must spend exactly one account token';
  }
  if (!isGrantCurrent(grant, state)) {
    return `Grant ${grant.slot} is not current: ${grantDeathReason(grant, state)}`;
  }
  if (!context.requiredSigners.includes(grant.grantee)) {
    return `The grantee of grant ${grant.slot} does not sign`;
  }
  const ends = upperBoundTime(context.validityRange);
  if (ends === undefined || ends > grant.scope.expiresAt) {
    return `The validity range ends after grant ${grant.slot} expires`;
  }
  const leaving = subtractBalances(balanceAt(context.spent.map((utxo) => utxo.output), keys.address), balanceAt(context.outputs, keys.address));
  const violation = scopeViolation(grant.scope, leaving);
  if (violation) {
    return `Grant ${grant.slot} refuses the spend: ${violation}`;
  }
  const stranger = context.outputs.find(
    (output) => output.address !== keys.address && grant.scope.recipients.length > 0 && !grant.scope.recipients.includes(output.address),
  );
  if (stranger) {
    return `${stranger.address} is not a recipient of grant ${grant.slot}`;
  }
  const deposits = context.outputs.filter((output) => output.address === keys.address && accountTokenNames(output.value, keys).length === 0);
  if (deposits.some((output) => output.datum !== undefined || output.datumHash !== undefined || output.scriptReference !== undefined)) {
    return 'A deposit paid back by a grant spend carries a datum or a reference script';
  }
  if (!tokensSitAtTheirOwnAddresses(context.spent.map((utxo) => utxo.output), keys.scriptHash) || !tokensSitAtTheirOwnAddresses(context.outputs, keys.scriptHash)) {
    return 'An account token sits away from its own account address';
  }
  const output = tokenOutputOf(context.outputs, assetId);
  if (!output || output.address !== keys.address || !Cometa.deepEqualsPlutusData(toValueData(output.value), toValueData(grantUtxo.output.value))) {
    return `The grant token of slot ${grant.slot} is not returned to the account address with the value it came with`;
  }
  const recreated = grantOf(output);
  const outputViolation = recreated ? grantOutputViolation(grantAfterSpend(grant, leaving), recreated) : 'the output carries no grant';
  if (outputViolation) {
    return `The grant output of slot ${grant.slot} is refused: ${outputViolation}`;
  }
  if (output.scriptReference !== undefined) {
    return 'The grant output carries a reference script';
  }
  return undefined;
};

/**
 * Why a sweep of a grant UTxO breaks the owner path, or undefined when it
 * passes. The sweep reads the slot at field 0 and the generation at field
 * 2 of the datum, whatever its shape: the grant is dead when that
 * generation is older than the control's or that slot is revoked. Expiry
 * counts only when the datum decodes as the full four field grant, since
 * the expiry lives in the scope; a datum of another shape that is only
 * expired is refused.
 */
const sweepFailure = (grantUtxo: UTxO, state: AccountState, keys: AccountKeys, context: Context): string | undefined => {
  const prefix = sweepPrefixOf(grantUtxo.output);
  if (!prefix) {
    return 'The grant UTxO carries no datum with a slot at field 0 and a generation at field 2';
  }
  const assetId = grantAssetId(keys.scriptHash, keys.stakeScriptHash, prefix.slot);
  if (!holdsOnlyLovelaceAnd(grantUtxo.output.value, assetId)) {
    return `The grant UTxO does not hold only lovelace and the grant token of slot ${prefix.slot}`;
  }
  if (!signedByDevice(state, context.requiredSigners)) {
    return 'No device of the account signs the sweep';
  }
  const grant = grantOf(grantUtxo.output);
  const start = context.validityRange.lowerBound.bound;
  const expired = grant !== undefined && start.kind === 'finite' && start.time > grant.scope.expiresAt;
  if (prefix.generation >= state.grantGeneration && !state.revoked.includes(prefix.slot) && !expired) {
    return `Grant ${prefix.slot} is live and cannot be swept: issued under the current generation, its slot not revoked${
      grant === undefined ? ', and known by its prefix alone, which no expiry kills' : ', and not expired before the validity range starts'
    }`;
  }
  if (context.mint[assetId] !== -1n) {
    return `The grant token of slot ${prefix.slot} is not burned`;
  }
  return undefined;
};

/** Why a fund spend breaks the proxy's fund path, or undefined when it passes: the UTxO holds no token of the policy, of any account. */
const fundFailure = (utxo: UTxO, keys: AccountKeys, context: Context): string | undefined => {
  if (holdsPolicyToken(utxo.output.value, keys.scriptHash)) {
    return 'The fund redeemer spends a UTxO holding a token of the account policy';
  }
  if (utxo.output.datum === undefined && utxo.output.datumHash === undefined) {
    return context.spent.some((spent) => spent.output.address === keys.address && accountTokenNames(spent.output.value, keys).length > 0)
      ? undefined
      : 'A plain deposit is only spendable alongside an account token';
  }
  return controlsOf(context.spent, keys).length > 0 ? undefined : 'A reserve is only spendable with the control UTxO';
};

/** Why an issuance breaks the logic's issue rule over the minted entries, or undefined when it passes. */
const issueFailure = (entries: [string, bigint][], old: AccountState, keys: AccountKeys, context: Context): string | undefined => {
  if (!signedByDevice(old, context.requiredSigners)) {
    return 'No device of the account signs the mint';
  }
  const control = controlOutputOf(context.outputs, keys);
  const next = control && stateOf(control);
  if (!next) {
    return 'Issuing grants needs the control UTxO recreated';
  }
  for (const [index, [name, quantity]] of entries.entries()) {
    const slot = old.nextSlot + BigInt(index);
    const output = tokenOutputOf(context.outputs, `${keys.scriptHash}${name}`);
    const grant = output && grantOf(output);
    if (quantity !== 1n || name !== grantTokenName(keys.stakeScriptHash, slot)) {
      return `The minted names must be the next slots in order, starting at ${old.nextSlot}`;
    }
    if (!output || output.address !== keys.address || !holdsOnlyLovelaceAnd(output.value, `${keys.scriptHash}${name}`) || output.scriptReference !== undefined) {
      return `The grant token of slot ${slot} must land in one output at the account address holding only lovelace and the token`;
    }
    if (!grant || grant.slot !== slot || grant.generation !== next.grantGeneration || scopeDefect(grant.scope)) {
      return `The grant output of slot ${slot} must carry a well formed grant of that slot under the recreated generation`;
    }
  }
  return undefined;
};

/** Why a burn breaks the logic's burn rule over the minted entries, or undefined when it passes. */
const burnFailure = (entries: [string, bigint][], old: AccountState, keys: AccountKeys, context: Context): string | undefined => {
  if (!signedByDevice(old, context.requiredSigners)) {
    return 'No device of the account signs the mint';
  }
  return entries.every(([name, quantity]) => quantity === -1n && isGrantTokenName(name) && accountOfTokenName(name) === keys.stakeScriptHash)
    ? undefined
    : 'Every burned token must be one grant token of the account';
};

/**
 * Why the mint under the policy breaks the owner path, or undefined when
 * nothing is minted or the mint passes the rule its proxy redeemer names.
 */
const ownerMintFailure = (old: AccountState, keys: AccountKeys, context: Context): string | undefined => {
  const entries = mintedUnder(context.mint, keys.scriptHash);
  if (entries.length === 0) {
    return undefined;
  }
  const data = context.mintRedeemers.get(keys.scriptHash);
  if (!data) {
    return 'The account policy is minted under without running the proxy';
  }
  switch (decodeMintRedeemer(data).kind) {
    case 'issueGrants':
      return issueFailure(entries, old, keys, context);
    case 'burnGrants':
      return burnFailure(entries, old, keys, context);
    case 'createAccount':
      return 'The owner path refuses a creation mint';
  }
};

/**
 * The walk over the proxy redeemers the logic makes: every spent input at
 * the account address carrying a proxy redeemer other than `Fund` must
 * pass the rule its redeemer names.
 */
const spendsFailure = (keys: AccountKeys, context: Context, rule: (redeemer: AccountRedeemer, own: UTxO) => string | undefined): string | undefined => {
  for (const own of context.spent.filter((utxo) => utxo.output.address === keys.address)) {
    const redeemer = context.spendRedeemers.get(referenceKey(own.input));
    if (!redeemer) {
      return `The input ${referenceKey(own.input)} at the account address carries no proxy redeemer`;
    }
    if (redeemer.kind === 'fund') {
      continue;
    }
    const failure = rule(redeemer, own);
    if (failure) {
      return failure;
    }
  }
  return undefined;
};

/** The control outputs naming a logic among the outputs, of any account. */
const outputsNaming = (outputs: TxOut[], logic: string): TxOut[] =>
  outputs.filter((output) => {
    const keys = accountOf(output.address);
    return keys !== undefined && isControlOutput(output, keys) && logicOf(output) === logic;
  });

/**
 * The owner path of a logic: the account's control UTxO is spent under
 * `Device`, the only control output naming the logic is the recreated
 * control of that account, and the mint and every other account input
 * pass their rules.
 */
const ownerTransactionFailure = (control: UTxO, ownHash: string, context: Context): string | undefined => {
  const keys = accountOf(control.output.address)!;
  const state = stateOf(control.output);
  if (!state) {
    return 'The spent control UTxO carries no state of the shape the logic keeps';
  }
  if (context.spendRedeemers.get(referenceKey(control.input))?.kind !== 'device') {
    return 'The control UTxO is spent without the device redeemer';
  }
  if (outputsNaming(context.outputs, ownHash).some((output) => output.address !== keys.address)) {
    return `A control output of another account names logic ${ownHash}`;
  }
  const mintFailure = ownerMintFailure(state, keys, context);
  if (mintFailure) {
    return mintFailure;
  }
  return spendsFailure(keys, context, (redeemer, own) => {
    switch (redeemer.kind) {
      case 'device':
        return deviceFailure(own, state, ownHash, keys, context);
      case 'sweepGrant':
        return sweepFailure(own, state, keys, context);
      default:
        return 'The owner path refuses a grant spend';
    }
  });
};

/**
 * The agent path of a logic: the account's control UTxO is referenced, no
 * control output names the logic, nothing is minted under the policy and
 * every account input is a grant spend passing its rule.
 */
const agentTransactionFailure = (control: UTxO, ownHash: string, context: Context): string | undefined => {
  const keys = accountOf(control.output.address)!;
  const state = stateOf(control.output);
  if (!state) {
    return 'The referenced control UTxO carries no state of the shape the logic keeps';
  }
  if (outputsNaming(context.outputs, ownHash).length > 0) {
    return `A control output names logic ${ownHash} on the agent path`;
  }
  if (mintedUnder(context.mint, keys.scriptHash).length > 0) {
    return 'A grant spend mints under the account policy';
  }
  return spendsFailure(keys, context, (redeemer, own) =>
    redeemer.kind === 'spendWithGrant' ? grantSpendFailure(own, state, keys, context) : 'The agent path refuses anything but a grant spend',
  );
};

/**
 * The arrival at a logic: exactly one control output names it, holding
 * only lovelace and the NFT with a well formed state; at creation the NFT
 * is the only mint and the counters are zero; at an upgrade the account's
 * control UTxO is spent under another logic that runs as well, the
 * generation grows strictly, the devices stay and nothing is minted.
 */
const arrivalFailure = (ownHash: string, context: Context): string | undefined => {
  const arriving = context.outputs.filter((output) => {
    const keys = accountOf(output.address);
    return keys !== undefined && isControlOutput(output, keys) && logicOf(output) === ownHash;
  });
  if (arriving.length !== 1) {
    return `Logic ${ownHash} runs with ${arriving.length} control outputs naming it and none present`;
  }
  const next = arriving[0]!;
  const keys = accountOf(next.address)!;
  if (!holdsOnlyLovelaceAnd(next.value, keys.nftAssetId)) {
    return 'The arriving control output does not hold only lovelace and the state NFT';
  }
  const state = stateOf(next);
  if (!state) {
    return 'The arriving control output carries no state of the shape the logic keeps';
  }
  const defect = stateDefect(state);
  if (defect) {
    return `The arriving state is not well formed: ${defect}`;
  }
  const previous = controlsOf(context.spent, keys)[0];
  if (previous) {
    const left = logicOf(previous.output);
    if (left === undefined || !withdrawsFrom(context, left)) {
      return 'The logic the account leaves does not run';
    }
    const generation = generationOf(previous.output);
    if (generation === undefined || state.grantGeneration <= generation) {
      return 'An upgrade must grow the grant generation strictly';
    }
    const devices = devicesOf(previous.output);
    if (!devices || devices.length !== state.devices.length || !devices.every((device, index) => device === state.devices[index])) {
      return 'An upgrade must keep the devices';
    }
    return mintedUnder(context.mint, keys.scriptHash).length === 0 ? undefined : 'An upgrade mints or burns under the account policy';
  }
  const entries = mintedUnder(context.mint, keys.scriptHash);
  if (entries.length !== 1 || entries[0]![0] !== keys.stakeScriptHash || entries[0]![1] !== 1n) {
    return 'Creation must mint the state NFT and nothing else under the policy';
  }
  return hasZeroCounters(state) ? undefined : 'Creation must start from zero counters';
};

/**
 * Why a logic run breaks its withdraw handler, or undefined when it
 * passes: the control UTxOs naming the logic among the inputs and the
 * reference inputs select the owner path, the agent path or an arrival,
 * and two of them are refused.
 */
const logicFailure = (ownHash: string, context: Context): string | undefined => {
  const spent = controlsNaming(context.spent, ownHash);
  const referenced = controlsNaming(context.referenced, ownHash);
  if (spent.length === 1 && referenced.length === 0) {
    return ownerTransactionFailure(spent[0]!, ownHash, context);
  }
  if (spent.length === 0 && referenced.length === 1) {
    return agentTransactionFailure(referenced[0]!, ownHash, context);
  }
  if (spent.length === 0 && referenced.length === 0) {
    return arrivalFailure(ownHash, context);
  }
  return `Logic ${ownHash} is named by ${spent.length} spent and ${referenced.length} referenced control UTxOs; one account per logic version per transaction`;
};

/** Why a withdrawal from a script credential breaks the script that owns it: the account stake script when a present control UTxO's address stakes with it, a logic otherwise. */
const withdrawalFailure = (withdrawal: Withdrawal, context: Context): string | undefined => {
  if (!withdrawal.script) {
    return undefined;
  }
  const control = [...context.spent, ...context.referenced].find((utxo) => {
    const keys = accountOf(utxo.output.address);
    return keys !== undefined && keys.stakeScriptHash === withdrawal.credential && isControlOutput(utxo.output, keys);
  });
  if (control) {
    const devices = devicesOf(control.output);
    return devices && signedByOneOf(devices, context.requiredSigners) ? undefined : 'No device of the account signs the stake withdrawal';
  }
  return logicFailure(withdrawal.credential, context);
};

/** Why a mint under the account policy breaks the proxy's mint handler, or undefined when it passes. */
const mintFailure = (policyId: string, redeemerData: PlutusData, context: Context): string | undefined => {
  const entries = mintedUnder(context.mint, policyId);
  const [first] = entries;
  if (!first) {
    return 'Nothing is minted under the policy';
  }
  const keys: AccountKeys = {
    scriptHash: policyId,
    stakeScriptHash: accountOfTokenName(first[0]),
    address: accountAddress(policyId, accountOfTokenName(first[0])).toString(),
    nftAssetId: stateNftAssetId(policyId, accountOfTokenName(first[0])),
  };
  const kind = decodeMintRedeemer(redeemerData).kind;
  if (kind !== 'createAccount') {
    const wanted = kind === 'issueGrants' ? 1n : -1n;
    for (const [name, quantity] of entries) {
      if (!isGrantTokenName(name) || accountOfTokenName(name) !== keys.stakeScriptHash) {
        return `${name} is not a grant token name of the account ${keys.stakeScriptHash}`;
      }
      if (quantity !== wanted) {
        return `Every grant token must be minted in quantity ${wanted} under ${kind}`;
      }
    }
    if (kind === 'issueGrants' && !tokensSitAtTheirOwnAddresses(context.outputs, policyId)) {
      return 'An account token sits away from its own account address';
    }
    return runsTheLogicFailure(keys, context);
  }
  if (entries.length !== 1 || first[0].length !== 56 || first[1] !== 1n) {
    return 'Creation must mint exactly one state NFT';
  }
  const control = controlOutputOf(context.outputs, keys);
  if (!control || !holdsOnlyLovelaceAnd(control.value, keys.nftAssetId)) {
    return 'Creation must lock the state NFT in a single control output holding only lovelace and the NFT';
  }
  if (control.scriptReference !== undefined) {
    return 'The control output carries a reference script';
  }
  if (!context.certificates.some((certificate) => REGISTRATION_TAGS.includes(certificate.tag) && certificate.credential?.value === keys.stakeScriptHash)) {
    return 'Creation must register the account stake credential';
  }
  if (!tokensSitAtTheirOwnAddresses(context.outputs, policyId)) {
    return 'An account token sits away from its own account address';
  }
  const logic = logicOf(control);
  if (logic === undefined) {
    return 'The control datum must name a script hash in its first field';
  }
  return withdrawsFrom(context, logic) ? undefined : `The transaction does not withdraw from the logic ${logic} the control datum names`;
};

/** The certificates of a transaction as the inspection reports them, in the order the redeemers index them. */
const certificatesOf = (tx: string): InspectedCertificate[] =>
  (Cometa.inspectTx(tx) as { body: { certs?: InspectedCertificate[] } }).body.certs ?? [];

/**
 * Why a registration of a script stake credential breaks the stake
 * script's registration arm, or undefined when it creates the account:
 * the account's single control output names the account policy, that
 * policy mints exactly one token named after the credential, the owner
 * the stake script is applied to signs, which is the required signer
 * whose stake script hashes to the credential, and the control output's
 * state lists the owner among its devices.
 */
const registrationFailure = (credential: string, context: Context): string | undefined => {
  const controls = context.outputs.filter((output) => {
    const candidate = accountOf(output.address);
    return candidate !== undefined && candidate.stakeScriptHash === credential && isControlOutput(output, candidate);
  });
  const control = controls.length === 1 ? controls[0] : undefined;
  const keys = control && accountOf(control.address);
  if (!control || !keys) {
    return `Registering ${credential} needs a single control output of its account`;
  }
  if (context.mint[keys.nftAssetId] !== 1n) {
    return `Registering ${credential} must mint exactly one state NFT named after it under the account policy`;
  }
  const owner = context.requiredSigners.find((signer) => stakeScriptHash(stakeScript(signer, keys.scriptHash)) === credential);
  if (owner === undefined) {
    return `The owner of the stake credential ${credential} does not sign its registration`;
  }
  const devices = devicesOf(control);
  if (!devices || !devices.includes(owner)) {
    return `The control output does not list the owner ${owner} among its devices`;
  }
  return undefined;
};

/** Whether a transaction creates the account of a stake credential: it mints a token named after the credential or pays a control output of it. */
const createsAccountOf = (credential: string, context: Context): boolean =>
  Object.keys(context.mint).some((assetId) => assetId.slice(56) === credential) ||
  context.outputs.some((output) => {
    const keys = accountOf(output.address);
    return keys !== undefined && keys.stakeScriptHash === credential && isControlOutput(output, keys);
  });

/** Why a delegation of a script stake credential breaks the stake script, or undefined when a device of the account authorises it. */
const delegationFailure = (credential: string, context: Context): string | undefined => {
  const control = [...context.referenced, ...context.spent].find((utxo) => {
    const keys = accountOf(utxo.output.address);
    return keys !== undefined && keys.stakeScriptHash === credential && isControlOutput(utxo.output, keys);
  });
  if (!control) {
    return `Delegating ${credential} needs the control UTxO of its account present, and a logic credential cannot be delegated`;
  }
  const devices = devicesOf(control.output);
  return devices && signedByOneOf(devices, context.requiredSigners) ? undefined : 'No device of the account signs the delegation';
};

/**
 * Why a certificate a script witnesses breaks it, or undefined when it
 * passes: a registration creating an account, alone or with a
 * delegation, runs the stake script's registration arm, any other
 * registration of a script credential is a logic credential anyone may
 * register, a delegation needs a device, and a deregistration is refused
 * by every script of the contract.
 */
const certificateFailure = (certificate: InspectedCertificate, context: Context): string | undefined => {
  if (certificate.credential?.tag !== 'script_hash') {
    return undefined;
  }
  if (REGISTRATION_TAGS.includes(certificate.tag)) {
    return createsAccountOf(certificate.credential.value, context) ? registrationFailure(certificate.credential.value, context) : undefined;
  }
  switch (certificate.tag) {
    case 'stake_delegation':
      return delegationFailure(certificate.credential.value, context);
    default:
      return `The ${certificate.tag} of ${certificate.credential.value} is refused: the credential stays registered`;
  }
};

/**
 * Why a spend redeemer on an account UTxO breaks the proxy, or undefined
 * when the spend passes or the UTxO is not an account's: a fund spend
 * follows the fund path; any other defers to the logic and, when the UTxO
 * holds any token of the policy, requires every token of the policy among
 * the outputs to sit in quantity one at its own account address, and when
 * it holds the state NFT, pins the control output.
 */
const spendFailure = (utxo: UTxO, redeemerData: PlutusData, context: Context): string | undefined => {
  const keys = accountOf(utxo.output.address);
  if (!keys) {
    return undefined;
  }
  if (decodeAccountRedeemer(redeemerData).kind === 'fund') {
    return fundFailure(utxo, keys, context);
  }
  const pinned = utxo.output.value.assets?.[keys.nftAssetId] === 1n ? pinnedControlFailure(keys, context) : undefined;
  const placed =
    holdsPolicyToken(utxo.output.value, keys.scriptHash) && !tokensSitAtTheirOwnAddresses(context.outputs, keys.scriptHash)
      ? 'The spent UTxO holds a token of the account policy and a token of the policy among the outputs sits away from its own account address'
      : undefined;
  return pinned ?? placed ?? runsTheLogicFailure(keys, context);
};

/** The proxy redeemer a spend redeemer carries, or undefined when it has another shape. */
const accountRedeemerOf = (data: PlutusData): AccountRedeemer | undefined => {
  try {
    return decodeAccountRedeemer(data);
  } catch {
    return undefined;
  }
};

/**
 * A provider serving canned UTxOs per address and fixed execution units.
 * Evaluation models the checks of the validators that a built transaction
 * can break, on every script: the proxy's fund path and its deferral of
 * every other spend and of every grant mint to the logic the control UTxO
 * names, present exactly once and withdrawn from, with the control output
 * pinned on every spend of the control UTxO, every token of the policy
 * placed at its own account address on every spend of a UTxO holding one
 * and every grant mint over grant names of one account in the quantity
 * its redeemer names; the proxy's creation mint, with no reference script
 * on the control output; the logic's walk over the proxy redeemers on the
 * owner path, the device path's signature, placement and control
 * recreation with counters following the mint or a leave for another
 * logic that runs, the sweep path's deadness read from the slot and the
 * generation of the datum alone, with expiry counting only for a datum of
 * the full grant shape, and its burn, and the issue and burn rules; the agent path's single account token,
 * liveness, signature, expiry, scope, recipients, plain deposits and
 * grant output whose caps sit between zero and the reduced value; the
 * logic's arrival at creation and at an upgrade, with the generation
 * grown, the devices kept and the old logic running; and the stake
 * script's registration, delegation and withdrawal arms. A draft that
 * fails a check is refused the way a network provider refuses a
 * transaction whose scripts fail.
 */
export class FakeProvider implements Provider {
  private readonly utxos = new Map<string, UTxO[]>();

  /** Why each refused evaluation failed, in order. */
  readonly phaseTwoFailures: string[] = [];

  /** Makes a UTxO visible at its own address. */
  addUtxo(utxo: UTxO): void {
    const list = this.utxos.get(utxo.output.address) ?? [];
    list.push(utxo);
    this.utxos.set(utxo.output.address, list);
  }

  getName(): string {
    return 'Fake provider';
  }

  getNetworkMagic(): NetworkMagic {
    return Cometa.NetworkMagic.Preprod;
  }

  getRewardsBalance(): Promise<bigint> {
    return Promise.resolve(0n);
  }

  getParameters(): Promise<ProtocolParameters> {
    return Promise.resolve(PROTOCOL_PARAMETERS);
  }

  getUnspentOutputs(address: Address | string): Promise<UTxO[]> {
    return Promise.resolve([...(this.utxos.get(addressKey(address)) ?? [])]);
  }

  async getUnspentOutputsWithAsset(address: Address | string, assetId: string): Promise<UTxO[]> {
    const utxos = await this.getUnspentOutputs(address);
    return utxos.filter((utxo) => (utxo.output.value.assets?.[assetId] ?? 0n) > 0n);
  }

  getUnspentOutputByNft(assetId: string): Promise<UTxO> {
    const match = [...this.utxos.values()].flat().find((utxo) => (utxo.output.value.assets?.[assetId] ?? 0n) === 1n);
    return match ? Promise.resolve(match) : Promise.reject(new Error(`No UTxO holds ${assetId}`));
  }

  resolveUnspentOutputs(txIns: TxIn[]): Promise<UTxO[]> {
    const all = [...this.utxos.values()].flat();
    return Promise.resolve(
      txIns.flatMap((txIn) => all.filter((utxo) => utxo.input.txId === txIn.txId && utxo.input.index === txIn.index)),
    );
  }

  resolveDatum(): Promise<string> {
    return Promise.reject(new Error('The fake provider holds no datums by hash'));
  }

  confirmTransaction(): Promise<boolean> {
    return Promise.resolve(true);
  }

  submitTransaction(): Promise<string> {
    return Promise.reject(new Error('The fake provider does not submit transactions'));
  }

  async evaluateTransaction(tx: string): Promise<Redeemer[]> {
    const redeemers = Cometa.readRedeemersFromTx(tx);
    const parts = transactionBodyParts(tx);
    const spent = await this.resolveUnspentOutputs(parts.inputs);
    const policies = [...new Set(Object.keys(parts.mint).map((assetId) => assetId.slice(0, 56)))].sort();
    const spendRedeemers = new Map<string, AccountRedeemer>();
    const mintRedeemers = new Map<string, PlutusData>();
    for (const redeemer of redeemers) {
      const input = redeemer.purpose === Cometa.RedeemerPurpose.spend ? parts.inputs[redeemer.index] : undefined;
      const accountRedeemer = input && accountRedeemerOf(redeemer.data);
      if (input && accountRedeemer) {
        spendRedeemers.set(referenceKey(input), accountRedeemer);
      }
      const policyId = redeemer.purpose === Cometa.RedeemerPurpose.mint ? policies[redeemer.index] : undefined;
      if (policyId !== undefined) {
        mintRedeemers.set(policyId, redeemer.data);
      }
    }
    const context: Context = {
      spent,
      referenced: await this.resolveUnspentOutputs(parts.referenceInputs),
      outputs: parts.outputs,
      mint: parts.mint,
      validityRange: parts.validityRange,
      requiredSigners: parts.requiredSigners,
      certificates: certificatesOf(tx),
      withdrawals: parts.withdrawals,
      spendRedeemers,
      mintRedeemers,
    };
    for (const redeemer of redeemers) {
      let failure: string | undefined;
      if (redeemer.purpose === Cometa.RedeemerPurpose.spend) {
        const input = parts.inputs[redeemer.index];
        const utxo = spent.find((candidate) => candidate.input.txId === input?.txId && candidate.input.index === input.index);
        failure = utxo && spendFailure(utxo, redeemer.data, context);
      } else if (redeemer.purpose === Cometa.RedeemerPurpose.mint) {
        const policyId = policies[redeemer.index];
        failure = policyId === undefined ? 'The mint redeemer names no policy' : mintFailure(policyId, redeemer.data, context);
      } else if (redeemer.purpose === Cometa.RedeemerPurpose.certificate) {
        const certificate = context.certificates[redeemer.index];
        failure = certificate === undefined ? 'The certificate redeemer names no certificate' : certificateFailure(certificate, context);
      } else if (redeemer.purpose === Cometa.RedeemerPurpose.withdrawal) {
        const withdrawal = context.withdrawals[redeemer.index];
        failure = withdrawal === undefined ? 'The withdrawal redeemer names no withdrawal' : withdrawalFailure(withdrawal, context);
      }
      if (failure) {
        this.phaseTwoFailures.push(failure);
        throw new Error(failure);
      }
    }
    return redeemers.map((redeemer) => ({ ...redeemer, executionUnits: FAKE_EXECUTION_UNITS }));
  }
}

/** A wallet owning one base address, backed by the fake provider's UTxOs. */
export class FakeWallet implements Wallet {
  readonly address: Address;

  constructor(
    private readonly provider: FakeProvider,
    readonly paymentKeyHash: string,
    readonly stakeKeyHash: string,
  ) {
    this.address = Cometa.BaseAddress.fromCredentials(
      Cometa.NetworkId.Testnet,
      { hash: paymentKeyHash, type: Cometa.CredentialType.KeyHash },
      { hash: stakeKeyHash, type: Cometa.CredentialType.KeyHash },
    ).toAddress();
  }

  getNetworkId(): Promise<NetworkId> {
    return Promise.resolve(Cometa.NetworkId.Testnet);
  }

  getUnspentOutputs(): Promise<UTxO[]> {
    return this.provider.getUnspentOutputs(this.address);
  }

  async getBalance(): Promise<Value> {
    const utxos = await this.getUnspentOutputs();
    return { coins: utxos.reduce((total, utxo) => total + utxo.output.value.coins, 0n) };
  }

  getUsedAddresses(): Promise<Address[]> {
    return Promise.resolve([this.address]);
  }

  getUnusedAddresses(): Promise<Address[]> {
    return Promise.resolve([]);
  }

  getChangeAddress(): Promise<Address> {
    return Promise.resolve(this.address);
  }

  getRewardAddresses(): Promise<RewardAddress[]> {
    return Promise.resolve([]);
  }

  signTransaction(): Promise<VkeyWitnessSet> {
    return Promise.reject(new Error('The fake wallet does not sign'));
  }

  signData(): Promise<{ signature: string; key: string }> {
    return Promise.reject(new Error('The fake wallet does not sign'));
  }

  submitTransaction(): Promise<string> {
    return this.provider.submitTransaction();
  }

  getCollateral(): Promise<UTxO[]> {
    return Promise.resolve([]);
  }

  getNetworkMagic = (): Promise<number> => Promise.resolve(Cometa.NetworkMagic.Preprod);

  getPubDRepKey = (): Promise<string> => Promise.reject(new Error('The fake wallet has no DRep key'));

  getRegisteredPubStakeKeys = (): Promise<string[]> => Promise.resolve([]);

  getUnregisteredPubStakeKeys = (): Promise<string[]> => Promise.resolve([]);

  async createTransactionBuilder(): Promise<TransactionBuilder> {
    const utxos = await this.getUnspentOutputs();
    return Cometa.TransactionBuilder.create({ params: PROTOCOL_PARAMETERS, slotConfig: Cometa.CARDANO_PREPROD_SLOT_CONFIG })
      .setTxEvaluator({ getName: () => 'Fake evaluator', evaluate: (tx) => this.provider.evaluateTransaction(tx) })
      .setChangeAddress(this.address)
      .setCollateralChangeAddress(this.address)
      .setCollateralUtxos(utxos)
      .setUtxos(utxos);
  }
}

/** A UTxO at a fictitious earlier transaction. */
export const utxo = (txId: string, index: number, address: string, value: Value, datum?: PlutusData): UTxO => ({
  input: { txId, index },
  output: datum === undefined ? { address, value } : { address, value, datum },
});
