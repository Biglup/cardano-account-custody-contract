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
import { type ValidityRange, transactionBodyParts, upperBoundTime } from '../../src/body.js';
import {
  type AccountState,
  type Grant,
  decodeAccountRedeemer,
  decodeAccountState,
  decodeGrant,
  decodeMintRedeemer,
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

/** What the fake evaluator sees of a transaction: the script context the validator reads. */
interface Context {
  spent: UTxO[];
  referenced: UTxO[];
  outputs: TxOut[];
  mint: AssetAmounts;
  validityRange: ValidityRange;
  requiredSigners: string[];
  certificates: InspectedCertificate[];
}

/* FUNCTIONS ******************************************************************/

/** The bech32 form of an address, used to key the canned UTxOs. */
const addressKey = (address: Address | string): string => (typeof address === 'string' ? address : address.toString());

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

/** Whether an output sits at the account address and holds its state NFT. */
const isControlOutput = (output: TxOut, keys: AccountKeys): boolean =>
  output.address === keys.address && output.value.assets?.[keys.nftAssetId] === 1n;

/** Whether a value holds nothing but lovelace and one unit of an asset. */
const holdsOnlyLovelaceAnd = (value: Value, assetId: string): boolean => {
  const assets = Object.entries(value.assets ?? {}).filter(([, quantity]) => quantity !== 0n);
  return assets.length === 1 && assets[0]?.[0] === assetId && assets[0]?.[1] === 1n;
};

/** The state an output carries as its inline datum, or undefined without one. */
const stateOf = (output: TxOut): AccountState | undefined => (output.datum === undefined ? undefined : decodeAccountState(output.datum));

/** The grant an output carries as its inline datum, or undefined without one. */
const grantOf = (output: TxOut): Grant | undefined => (output.datum === undefined ? undefined : decodeGrant(output.datum));

/** Whether one of the state's devices is among the required signers. */
const signedByDevice = (state: AccountState, signers: string[]): boolean => state.devices.some((device) => signers.includes(device));

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

/** Whether every account token among the outputs sits in quantity one at the address its name denotes. */
const tokensSitAtTheirOwnAddresses = (outputs: TxOut[], scriptHash: string): boolean =>
  outputs.every((output) =>
    Object.entries(output.value.assets ?? {})
      .filter(([assetId]) => assetId.startsWith(scriptHash))
      .every(([assetId, quantity]) => quantity === 1n && output.address === accountAddress(scriptHash, accountOfTokenName(assetId.slice(scriptHash.length))).toString()),
  );

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

/** Why the control UTxO's state is not recreated as the device path demands, or undefined when it is. */
const controlRecreationFailure = (old: AccountState, keys: AccountKeys, context: Context): string | undefined => {
  const control = controlOutputOf(context.outputs, keys);
  if (!control || !holdsOnlyLovelaceAnd(control.value, keys.nftAssetId)) {
    return 'The control UTxO is not recreated holding only lovelace and the state NFT';
  }
  const next = stateOf(control);
  if (!next) {
    return 'The control UTxO is not recreated with an inline datum';
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

/** The state of the account's control UTxO among the spent inputs, or undefined when it is not spent. */
const spentControlState = (keys: AccountKeys, context: Context): AccountState | undefined => {
  const control = context.spent.find((utxo) => isControlOutput(utxo.output, keys));
  return control ? stateOf(control.output) : undefined;
};

/** Why a device spend of the control UTxO breaks the owner path, or undefined when it passes. */
const deviceFailure = (control: UTxO, keys: AccountKeys, context: Context): string | undefined => {
  const old = stateOf(control.output);
  if (control.output.value.assets?.[keys.nftAssetId] !== 1n || !old) {
    return 'The device redeemer spends a UTxO that is not the control UTxO';
  }
  if (!signedByDevice(old, context.requiredSigners)) {
    return 'No device of the account signs the device spend';
  }
  if (!tokensSitAtTheirOwnAddresses(context.spent.map((utxo) => utxo.output), keys.scriptHash) || !tokensSitAtTheirOwnAddresses(context.outputs, keys.scriptHash)) {
    return 'An account token sits away from its own account address';
  }
  return controlRecreationFailure(old, keys, context);
};

/** Why a grant spend breaks the agent path as the validator checks it, or undefined when it passes. */
const grantSpendFailure = (grantUtxo: UTxO, keys: AccountKeys, context: Context): string | undefined => {
  const grant = grantOf(grantUtxo.output);
  if (!grant) {
    return 'The grant UTxO carries no grant';
  }
  const assetId = grantAssetId(keys.scriptHash, keys.stakeScriptHash, grant.slot);
  if (!holdsOnlyLovelaceAnd(grantUtxo.output.value, assetId)) {
    return `The grant UTxO does not hold only lovelace and the grant token of slot ${grant.slot}`;
  }
  if (context.spent.filter((utxo) => accountTokenNames(utxo.output.value, keys).length > 0).length !== 1) {
    return 'A grant spend must spend exactly one account token';
  }
  const controls = context.referenced.filter((utxo) => isControlOutput(utxo.output, keys));
  const state = controls.length === 1 ? stateOf(controls[0]!.output) : undefined;
  if (!state) {
    return 'The control UTxO is not referenced exactly once';
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
  if (mintedUnder(context.mint, keys.scriptHash).length > 0) {
    return 'A grant spend mints under the account policy';
  }
  return undefined;
};

/** A value as Plutus data, so that two values compare by content. */
const toValueData = (value: Value): PlutusData => ({
  items: [value.coins, ...Object.entries(value.assets ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)).map(([assetId, quantity]) => ({ items: [Cometa.hexToUint8Array(assetId), quantity] }))],
});

/** Why a sweep of a grant UTxO breaks the owner path, or undefined when it passes. */
const sweepFailure = (grantUtxo: UTxO, keys: AccountKeys, context: Context): string | undefined => {
  const grant = grantOf(grantUtxo.output);
  if (!grant) {
    return 'The grant UTxO carries no grant';
  }
  const assetId = grantAssetId(keys.scriptHash, keys.stakeScriptHash, grant.slot);
  if (!holdsOnlyLovelaceAnd(grantUtxo.output.value, assetId)) {
    return `The grant UTxO does not hold only lovelace and the grant token of slot ${grant.slot}`;
  }
  const state = spentControlState(keys, context);
  if (!state) {
    return 'A sweep needs the control UTxO spent';
  }
  if (!signedByDevice(state, context.requiredSigners)) {
    return 'No device of the account signs the sweep';
  }
  const start = context.validityRange.lowerBound.bound;
  const reason = grantDeathReason(grant, state, start.kind === 'finite' ? start.time : undefined);
  if (reason === undefined) {
    return `Grant ${grant.slot} is live and cannot be swept`;
  }
  if (context.mint[assetId] !== -1n) {
    return `The grant token of slot ${grant.slot} is not burned`;
  }
  return undefined;
};

/** Why a fund spend breaks the fund path, or undefined when it passes. */
const fundFailure = (utxo: UTxO, keys: AccountKeys, context: Context): string | undefined => {
  if (accountTokenNames(utxo.output.value, keys).length > 0) {
    return 'The fund redeemer spends a UTxO holding an account token';
  }
  if (utxo.output.datum === undefined && utxo.output.datumHash === undefined) {
    return context.spent.some((spent) => spent.output.address === keys.address && accountTokenNames(spent.output.value, keys).length > 0)
      ? undefined
      : 'A plain deposit is only spendable alongside an account token';
  }
  return spentControlState(keys, context) ? undefined : 'A reserve is only spendable with the control UTxO';
};

/** Why a mint under the account policy breaks the mint handler as the validator checks it, or undefined when it passes. */
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
  const redeemer = decodeMintRedeemer(redeemerData);
  if (redeemer.kind === 'createAccount') {
    const control = controlOutputOf(context.outputs, keys);
    const state = control && stateOf(control);
    if (entries.length !== 1 || first[0].length !== 56 || first[1] !== 1n) {
      return 'Creation must mint exactly one state NFT';
    }
    if (!control || !holdsOnlyLovelaceAnd(control.value, keys.nftAssetId) || !state || stateDefect(state) || !hasZeroCounters(state)) {
      return 'Creation must lock the state NFT in a single valid control output with zero counters';
    }
    return tokensSitAtTheirOwnAddresses(context.outputs, policyId) ? undefined : 'An account token sits away from its own account address';
  }
  const old = spentControlState(keys, context);
  if (!old) {
    return 'Minting grant tokens needs the control UTxO spent';
  }
  if (!signedByDevice(old, context.requiredSigners)) {
    return 'No device of the account signs the mint';
  }
  if (redeemer.kind === 'burnGrants') {
    return entries.every(([name, quantity]) => quantity === -1n && isGrantTokenName(name) && accountOfTokenName(name) === keys.stakeScriptHash)
      ? undefined
      : 'Every burned token must be one grant token of the account';
  }
  const control = controlOutputOf(context.outputs, keys);
  const next = control && stateOf(control);
  if (!next) {
    return 'Issuing grants needs the control UTxO recreated';
  }
  for (const [index, [name, quantity]] of entries.entries()) {
    const slot = old.nextSlot + BigInt(index);
    const output = tokenOutputOf(context.outputs, `${policyId}${name}`);
    const grant = output && grantOf(output);
    if (quantity !== 1n || name !== grantTokenName(keys.stakeScriptHash, slot)) {
      return `The minted names must be the next slots in order, starting at ${old.nextSlot}`;
    }
    if (!output || output.address !== keys.address || !holdsOnlyLovelaceAnd(output.value, `${policyId}${name}`) || output.scriptReference !== undefined) {
      return `The grant token of slot ${slot} must land in one output at the account address holding only lovelace and the token`;
    }
    if (!grant || grant.slot !== slot || grant.generation !== next.grantGeneration || scopeDefect(grant.scope)) {
      return `The grant output of slot ${slot} must carry a well formed grant of that slot under the recreated generation`;
    }
  }
  return undefined;
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
  const state = stateOf(control);
  if (!state || !state.devices.includes(owner)) {
    return `The control output does not list the owner ${owner} among its devices`;
  }
  return undefined;
};

/** Why a certificate the stake script witnesses breaks it, or undefined when it passes or the certificate is not a script credential registration. */
const certificateFailure = (certificate: InspectedCertificate, context: Context): string | undefined =>
  certificate.tag === 'registration' && certificate.credential?.tag === 'script_hash'
    ? registrationFailure(certificate.credential.value, context)
    : undefined;

/** Why a spend redeemer on an account UTxO breaks the validator, or undefined when the spend passes or the UTxO is not an account's. */
const spendFailure = (utxo: UTxO, redeemerData: PlutusData, context: Context): string | undefined => {
  const keys = accountOf(utxo.output.address);
  if (!keys) {
    return undefined;
  }
  switch (decodeAccountRedeemer(redeemerData).kind) {
    case 'device':
      return deviceFailure(utxo, keys, context);
    case 'spendWithGrant':
      return grantSpendFailure(utxo, keys, context);
    case 'sweepGrant':
      return sweepFailure(utxo, keys, context);
    case 'fund':
      return fundFailure(utxo, keys, context);
  }
};

/**
 * A provider serving canned UTxOs per address and fixed execution units.
 * Evaluation models the checks of the validator that a built transaction
 * can break, on every path: the device path's signature, placement and
 * control recreation with counters following the mint; the agent path's
 * single account token, referenced control UTxO, liveness, signature,
 * expiry, scope, recipients, plain deposits and grant output whose caps
 * sit between zero and the reduced value; the sweep path's deadness and
 * burn; the fund path's reserve rule; the mint handler's creation,
 * issuance and burn rules; and the stake script's registration arm, which
 * needs the owner signing, one state NFT of the credential minted and the
 * owner among the devices of the control output. A draft that fails a
 * check is refused the way a network provider refuses a transaction whose
 * scripts fail.
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
    const context: Context = {
      spent: await this.resolveUnspentOutputs(parts.inputs),
      referenced: await this.resolveUnspentOutputs(parts.referenceInputs),
      outputs: parts.outputs,
      mint: parts.mint,
      validityRange: parts.validityRange,
      requiredSigners: parts.requiredSigners,
      certificates: certificatesOf(tx),
    };
    const policies = [...new Set(Object.keys(parts.mint).map((assetId) => assetId.slice(0, 56)))].sort();
    for (const redeemer of redeemers) {
      let failure: string | undefined;
      if (redeemer.purpose === Cometa.RedeemerPurpose.spend) {
        const input = parts.inputs[redeemer.index];
        const utxo = context.spent.find((candidate) => candidate.input.txId === input?.txId && candidate.input.index === input.index);
        failure = utxo && spendFailure(utxo, redeemer.data, context);
      } else if (redeemer.purpose === Cometa.RedeemerPurpose.mint) {
        const policyId = policies[redeemer.index];
        failure = policyId === undefined ? 'The mint redeemer names no policy' : mintFailure(policyId, redeemer.data, context);
      } else if (redeemer.purpose === Cometa.RedeemerPurpose.certificate) {
        const certificate = context.certificates[redeemer.index];
        failure = certificate === undefined ? 'The certificate redeemer names no certificate' : certificateFailure(certificate, context);
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
