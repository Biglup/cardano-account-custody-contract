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
  CoinSelector,
  Datum,
  ExUnitsPrices,
  ExUnits,
  NetworkId,
  PlutusData,
  PlutusScript,
  ProtocolParameters,
  Provider,
  RewardAddress,
  SlotConfig,
  TransactionBuilder,
  TxEvaluator,
  TxOut,
  UTxO,
  Value,
  Wallet,
} from '@biglup/cometa';
import { accountAddress, grantAssetId, paymentKeyHashOf, rewardAddress, stateNftAssetId } from './address.js';
import { accountScript, loadBlueprint } from './blueprint.js';
import { Cometa } from './cometa.js';
import {
  type AccountState,
  type Grant,
  type Scope,
  decodeAccountState,
  encodeAccountRedeemer,
  encodeAccountState,
  encodeAddress,
  encodeGrant,
  encodeLogicRedeemer,
  encodeMintRedeemer,
  encodeReserveDatum,
  encodeStakeRedeemer,
} from './data.js';
import { slotToPosixTime, transactionBodyParts } from './body.js';
import { type AccountRecord, type GrantUtxo, classifyAccountUtxos } from './discovery.js';
import { type LogicCatalog, currentLogicHash, logicCatalog } from './logic.js';
import { type NetworkScripts, type ScriptSource, attachScript, resolveScriptSource } from './network.js';
import { DEFAULT_ADA_PER_UTXO_BYTE, minimumUtxoLovelace } from './output.js';
import { stakeScript, stakeScriptHash } from './stake-script.js';
import {
  assertScopeWellFormed,
  assertWellFormed,
  grantAfterSpend,
  grantDeathReason,
  hasZeroCounters,
  isGrantCurrent,
  isRevokedListFull,
  scopeViolation,
  stateAfterIssue,
  stateAfterSweep,
  stateWithDevice,
  stateWithLogic,
  stateWithNextGeneration,
  stateWithRevokedSlot,
  stateWithoutDevice,
} from './state.js';
import {
  type Balance,
  addBalances,
  coversBalance,
  isZeroBalance,
  LOVELACE_ASSET_ID,
  quantityOf,
  subtractBalances,
  toBalance,
  toValue,
} from './value.js';

/* CONSTANTS ******************************************************************/

/** The lovelace a freshly created control UTxO carries unless its state needs more. */
export const DEFAULT_CONTROL_LOVELACE = 2_000_000n;

/**
 * The most grants one issuance or one sweep handles. Each grant adds its
 * own script run to the transaction, and sixteen of either exceed the
 * transaction's memory limit while eight use about half of it.
 */
export const MAX_GRANT_BATCH = 8;

/**
 * The most fund UTxOs one checked grant spend takes. On chain every script
 * execution pays to decode the whole transaction context on top of its
 * own work, so each fund input adds a proxy run whose cost grows with the
 * transaction: a spend over twelve deposits measured about six million
 * two hundred thousand memory units on chain, a little over a third of
 * the limit of seventeen and a half million, each fund input between a
 * quarter and four tenths of a million against the sixth of a million
 * the test runner charges, so a spend over many more would not fit. A
 * spend needing more is refused with this bound named, and `fundBatches`
 * splits the funds into sweeps of at most this many.
 */
export const MAX_FUND_INPUTS = 12;

/**
 * The lovelace a grant spend reduces the grant's remaining caps by on top
 * of its outputs, ahead of the fee it will pay. The fee of a grant spend
 * over a handful of fund UTxOs measures at about 760,000 lovelace with
 * the proxy and the logic referenced from their parked UTxOs and about
 * 1,050,000 with both embedded as witnesses, most of it the size of the
 * logic, so the bound leaves room for more inputs on either path; a spend
 * whose fee ends above it is refused before submission.
 */
export const DEFAULT_GRANT_FEE_BOUND = 1_500_000n;

/**
 * The execution budgets an unchecked transaction carries in place of an
 * evaluation: the logic's withdrawal gets the logic budget, which covers
 * the heaviest grant spend over a handful of inputs with margin since the
 * logic runs the grant rules once over the whole transaction, and every
 * other redeemer, the proxy spends among them, the proxy budget. A
 * provider evaluating a transaction a validator refuses reports the
 * refusal instead of a budget, so a transaction built to show that refusal
 * on chain cannot be evaluated. The budgets are kept for the unchecked
 * path only; every checked builder has the provider evaluate the scripts
 * for real.
 */
export const UNCHECKED_EXECUTION_UNITS: { logic: ExUnits; proxy: ExUnits } = {
  logic: { memory: 4_000_000, steps: 1_500_000_000 },
  proxy: { memory: 500_000, steps: 200_000_000 },
};

/** The text cometa reports when a build fails, without the reason the evaluator gave. */
const BUILD_FAILURE = /^Transaction build failed/;

/** The most times an owner transaction drawing its fee from a reserve is rebuilt while the fee settles. */
const MAX_BALANCING_ROUNDS = 4;

/** The spend redeemers, which carry no data. */
const deviceRedeemer = encodeAccountRedeemer({ kind: 'device' });
const spendWithGrantRedeemer = encodeAccountRedeemer({ kind: 'spendWithGrant' });
const sweepGrantRedeemer = encodeAccountRedeemer({ kind: 'sweepGrant' });
const fundRedeemer = encodeAccountRedeemer({ kind: 'fund' });

/** The mint redeemers, which carry no data. */
const createAccountRedeemer = encodeMintRedeemer({ kind: 'createAccount' });
const issueGrantsRedeemer = encodeMintRedeemer({ kind: 'issueGrants' });
const burnGrantsRedeemer = encodeMintRedeemer({ kind: 'burnGrants' });

/** The redeemer of every stake script run, which carries no data. */
const operateRedeemer = encodeStakeRedeemer();

/** The redeemer of every logic run, which carries no data. */
const runRedeemer = encodeLogicRedeemer();

/** The lovelace a logic withdrawal draws: the logic credential earns nothing, and the ledger runs the script on any amount. */
const LOGIC_WITHDRAWAL = 0n;

/**
 * A coin selector that spends nothing beyond the inputs the builder was
 * given explicitly, so that an account paid operation is funded by the
 * account alone and fails instead of reaching into the wallet when the
 * account cannot cover it. The wallet's UTxOs stay available to the
 * builder for the collateral only.
 */
export const accountOnlyCoinSelector: CoinSelector = {
  getName: () => 'Account only',
  select: ({ preSelectedUtxo, availableUtxo }) => Promise.resolve({ selection: preSelectedUtxo ?? [], remaining: availableUtxo }),
};

/* TYPES **********************************************************************/

/** An output a spend pays away from the account. */
export interface AccountOutput {
  address: string;
  value: Value;
}

/**
 * How a builder identifies the account: by the verification key hash of
 * its initial device, the owner its stake script is applied to, from
 * which the stake credential, the address and the state NFT all derive,
 * or by the record a client persisted, which a device other than the
 * owner holds instead since it cannot derive the address from its own key.
 */
export type AccountIdentity = { owner: string; record?: never } | { record: AccountRecord; owner?: never };

/** What every builder needs to know about the account it acts on. */
export type AccountParams = AccountIdentity & {
  /** The wallet that builds, pays for and signs the transaction. */
  wallet: Wallet;
  /**
   * A wallet that pays for the transaction in place of the account: it
   * funds the fee, the lovelace the control output needs beyond what it
   * held, and at creation the control UTxO and the registration deposit,
   * provides the collateral and receives the change, so that the device
   * wallet only signs. Without a sponsor an owner operation is paid from
   * the account's own reserve and fund UTxOs and the device wallet
   * provides the collateral alone, while creation, which has no account
   * to pay from yet, is paid by the device wallet.
   */
  sponsor?: Wallet;
  /** The account proxy script; the blueprint's when omitted. */
  script?: PlutusScript;
  /** The network the account address lives on; the testnet when omitted. */
  networkId?: NetworkId;
  /**
   * The reference scripts recorded for the network, as `loadNetworkScripts`
   * reads them: the proxy and each logic version parked on it are then
   * referenced instead of embedded. When omitted, or for a script the
   * network records none for, the script is embedded in the witness set.
   */
  network?: NetworkScripts;
  /**
   * Logic scripts beyond the one the blueprint carries, already applied
   * to the proxy hash, so that an account an upgrade moved to a later
   * version can be served. A control UTxO names its logic by hash and
   * the builder refuses an account whose logic it cannot attach.
   */
  logics?: PlutusScript[];
};

/** Account parameters for builders that must read the account's UTxOs. */
export type AccountUtxoParams = AccountParams & {
  /** The provider that lists the UTxOs at the account address. */
  provider: Provider;
  /**
   * A wallet that provides the collateral and nothing else: the account
   * pays the outputs, the fee and the lovelace the control output needs
   * beyond what it held from its own UTxOs, the collateral and its
   * return come from this wallet, and the transaction spends none of its
   * UTxOs. Use it when a wallet other than the signing one stands behind
   * the collateral, such as a sponsor service that will not pay the fee
   * of an operation the account can pay for itself. On the device path
   * `sponsor` is the alternative, for a wallet that is to pay the fee
   * too, and the two cannot be given together; on the grant path the
   * account always pays, so `collateral` is the only option and a
   * `sponsor` is refused. Without either, the device wallet provides the
   * collateral, and on the agent path the agent wallet does.
   */
  collateral?: Wallet;
  /**
   * The least lovelace a fund output returned to the account may hold.
   * When omitted it is the minimum UTxO value of that output, which is
   * higher when the output carries tokens than when it carries lovelace
   * alone.
   */
  minimumChangeLovelace?: bigint;
  /** The slot timing of the network, which converts validity slots to the times the validator sees; preprod's when omitted. */
  slotConfig?: SlotConfig;
};

/** Parameters every owner builder shares. */
export type DeviceParams = AccountUtxoParams & {
  /**
   * The slot the transaction stops being valid at, when the owner wants
   * one: a revoke built against a control UTxO that is then spent by
   * another device would otherwise sit in a mempool until it is dropped.
   */
  validUntilSlot?: bigint;
  /**
   * Skips the device check and the evaluation, for evidence and testing
   * only: the wallet's payment key is the required signer whether or not
   * it is a device of the account, and the transaction carries
   * `UNCHECKED_EXECUTION_UNITS` instead of an evaluation, so that the
   * node refuses it with the logic's own failure. The state written back
   * is still held to the shape the builder can encode.
   */
  unchecked?: boolean;
};

/** The initial state of an account: the state without its logic, which defaults to the version this library pins. */
export type InitialState = Omit<AccountState, 'logic'> & { logic?: string };

/** Parameters of account creation. */
export type CreateAccountParams = AccountParams & {
  /**
   * The initial state, which must be well formed with zero counters. Its
   * logic names the version the account runs and must be one the builder
   * can attach; the version this library pins is used when it is omitted.
   */
  state: InitialState;
  /** The lovelace the control UTxO carries, raised to its minimum UTxO value when too low. */
  lovelace?: bigint;
  /**
   * The provider that lists the UTxOs at the account address. When given,
   * creation is refused while a UTxO holding the account's state NFT
   * already exists, and the minimum UTxO value is priced with the
   * network's protocol parameters.
   */
  provider?: Provider;
};

/** Parameters of a deposit. */
export type DepositParams = AccountParams & {
  value: Value;
  /**
   * Marks the deposit as a reserve by writing the reserve datum on it: a
   * UTxO the owner alone can spend, from which the owner's own operations
   * draw their fee without touching the funds an agent may be spending.
   */
  reserve?: boolean;
};

/** A grant to issue: the grantee and the scope; the slot and the generation come from the account. */
export interface GrantRequest {
  grantee: string;
  scope: Scope;
}

/** Parameters of a grant issuance. */
export type IssueGrantParams = DeviceParams & {
  /** The grants to issue in order, at most `MAX_GRANT_BATCH`; the first takes the account's next slot. */
  grants: GrantRequest[];
};

/** Parameters of a sweep of dead grants. */
export type SweepGrantParams = DeviceParams & {
  /** The slots of the dead grants to sweep, at most `MAX_GRANT_BATCH`. */
  slots: bigint[];
  /**
   * The slot the transaction becomes valid at, which a grant dead by
   * expiry alone needs: the validator reads the expiry from the validity
   * range, so the range must start after the grant expired.
   */
  validFromSlot?: bigint;
};

/** Parameters of an agent spend. */
export type SpendWithGrantParams = AccountUtxoParams & {
  slot: bigint;
  outputs: AccountOutput[];
  /** The key hash of the grant's grantee, which signs the transaction as a required signer. */
  grantee: string;
  /** The slot the transaction stops being valid at, which must start no later than the grant's expiry. */
  validUntilSlot: bigint;
  /** The lovelace the remaining caps are reduced by ahead of the fee, in place of `DEFAULT_GRANT_FEE_BOUND`. */
  feeBound?: bigint;
  /**
   * Skips the builder's liveness, scope, recipient, expiry and fee bound
   * checks, for evidence and testing only. The transaction is built
   * exactly as the validator will see it, with the caps reduced by the
   * outputs and the fee bound, every output where it was asked to go and
   * the validity range ending at the slot it was asked to, and carries
   * `UNCHECKED_EXECUTION_UNITS` instead of an evaluation, so that the
   * node refuses the transaction with the validator's own failure. The
   * grant UTxO must still exist, since its grant is what the datum
   * rewrites.
   */
  unchecked?: boolean;
};

/**
 * The identifiers derived from the account proxy and the owner of an
 * account, with the logic scripts the builder can attach and where the
 * network parks its reference scripts.
 */
interface Account {
  script: PlutusScript;
  scriptHash: string;
  owner: string;
  stakeScript: PlutusScript;
  stakeScriptHash: string;
  address: string;
  rewardAddress: RewardAddress;
  nftAssetId: string;
  networkId: NetworkId;
  logics: LogicCatalog;
  network: NetworkScripts | undefined;
}

/**
 * The UTxOs of an account by kind and the state its control UTxO carries.
 * The reserves include any UTxO at the address carrying only a datum
 * hash, which anyone can park there: such a UTxO is listed but inert,
 * since a transaction spending it would need the datum the chain does not
 * carry, and this library never selects it for a fee or for outputs.
 */
export interface AccountUtxos {
  control: UTxO;
  state: AccountState;
  grants: GrantUtxo[];
  reserves: UTxO[];
  funds: UTxO[];
}

/** The fund UTxOs chosen for a spend and what they hold beyond its needs. */
export interface FundSelection {
  selected: UTxO[];
  remainder: Balance;
}

/** A step adding a withdrawal or a certificate of the account's stake credential to a builder. */
type StakeOperation = (builder: TransactionBuilder, account: Account) => TransactionBuilder;

/**
 * What an owner transaction does beyond spending and recreating the
 * control UTxO: the outputs it pays away, the state it writes, the grants
 * it issues, the dead grants it sweeps, the stake operation it carries
 * and the slot it becomes valid at.
 */
interface DeviceOperation {
  outputs: AccountOutput[];
  nextState: (state: AccountState, utxos: AccountUtxos) => AccountState;
  issued?: (state: AccountState) => GrantRequest[];
  swept?: (utxos: AccountUtxos) => GrantUtxo[];
  stakeOperation?: StakeOperation;
  validFromSlot?: bigint;
}

/** A grant output to create at issuance: the grant and the lovelace it needs. */
interface GrantIssue {
  grant: Grant;
  assetId: string;
  coins: bigint;
}

/** Where a transaction takes the proxy and each logic it runs from, keyed by logic hash. */
interface ScriptSources {
  proxy: ScriptSource;
  logics: Map<string, ScriptSource>;
}

/* FUNCTIONS ******************************************************************/

/**
 * Derives the account identifiers from the builder parameters, applying
 * the stake script to the owner and the proxy hash and the blueprint's
 * logic to the proxy hash. A record names the same owner, so the
 * derivation is the same either way; the stake script is always rebuilt
 * since the record cannot carry it.
 */
const resolveAccount = (params: AccountParams): Account => {
  const blueprint = loadBlueprint();
  const { script = accountScript(blueprint), networkId = Cometa.NetworkId.Testnet, record } = params;
  const owner = record ? record.owner : params.owner;
  const scriptHash = Cometa.computeScriptHash(script);
  const stake = stakeScript(owner, scriptHash, blueprint);
  const stakeHash = stakeScriptHash(stake);
  if (record && record.stakeScriptHash !== stakeHash) {
    throw new Error(`The record's stake credential ${record.stakeScriptHash} does not match the owner ${record.owner}`);
  }
  return {
    script,
    scriptHash,
    owner,
    stakeScript: stake,
    stakeScriptHash: stakeHash,
    address: accountAddress(scriptHash, stakeHash, networkId).toString(),
    rewardAddress: rewardAddress(stakeHash, networkId),
    nftAssetId: stateNftAssetId(scriptHash, stakeHash),
    networkId,
    logics: logicCatalog(scriptHash, params.logics ?? [], blueprint),
    network: params.network,
  };
};

/** The logic script of a hash the builder can attach; fails naming the hash when neither the blueprint nor the given logics carry it. */
const logicScriptOf = (account: Account, logic: string): PlutusScript => {
  const script = account.logics.get(logic);
  if (!script) {
    throw new Error(`The logic ${logic} is not a version this library can attach: neither the blueprint nor the logics given carry it`);
  }
  return script;
};

/**
 * Where the proxy and the logics a transaction runs come from: their
 * reference UTxOs on the network, checked through the provider when one
 * is given so that a stale record is refused before anything is built, or
 * the scripts themselves. Resolved once per transaction, ahead of the
 * builds a fee may take to settle.
 */
const resolveSources = async (account: Account, logics: string[], provider?: Provider): Promise<ScriptSources> => ({
  proxy: await resolveScriptSource(provider, account.network, account.script),
  logics: new Map(
    await Promise.all([...new Set(logics)].map(async (logic): Promise<[string, ScriptSource]> => [logic, await resolveScriptSource(provider, account.network, logicScriptOf(account, logic))])),
  ),
});

/**
 * Runs a logic over the transaction: a zero withdrawal from the logic
 * credential with the `Run` redeemer, which the proxy requires whenever a
 * control UTxO naming that logic is spent or referenced and the ledger
 * answers by running the script once, with the logic made available
 * through its reference UTxO or embedded. Fails on a logic the sources
 * were not resolved for.
 */
const runLogic = (builder: TransactionBuilder, account: Account, sources: ScriptSources, logic: string): TransactionBuilder => {
  const source = sources.logics.get(logic);
  if (!source) {
    throw new Error(`The logic ${logic} was not resolved for this transaction`);
  }
  return attachScript(builder, source).withdrawRewards({
    rewardAddress: rewardAddress(logic, account.networkId),
    amount: LOGIC_WITHDRAWAL,
    redeemer: runRedeemer,
  });
};

/** The account state a control UTxO carries; fails when it carries no inline datum. */
const stateOf = (control: UTxO): AccountState => {
  if (control.output.datum === undefined) {
    throw new Error('The control UTxO carries no inline datum');
  }
  return decodeAccountState(control.output.datum);
};

/**
 * Locates the account's UTxOs and decodes the account state. The control
 * UTxO holds the state NFT, a grant UTxO holds a grant token, a reserve
 * is any other UTxO carrying a datum, and the rest are funds. A reserve
 * carrying only a datum hash is listed among the reserves for inspection
 * but is inert: no builder of this library ever spends it, since the
 * ledger refuses a transaction spending it without the datum itself.
 */
export const findAccountUtxos = async (provider: Provider, params: AccountParams): Promise<AccountUtxos> => {
  const account = resolveAccount(params);
  const utxos = await provider.getUnspentOutputs(account.address);
  const { control, grants, reserves, funds } = classifyAccountUtxos(utxos, account.scriptHash, account.stakeScriptHash, account.networkId);
  if (!control) {
    throw new Error(`Expected exactly one control UTxO at ${account.address}, found 0`);
  }
  return { control, state: stateOf(control), grants, reserves, funds };
};

/** A Plutus data value as an inline datum. */
const inlineDatum = (data: PlutusData): Datum => ({ type: Cometa.DatumType.InlineData, inlineDatum: data });

/** The value of a control output: lovelace and the state NFT only. */
const controlValue = (account: Account, coins: bigint): Value => ({ coins, assets: { [account.nftAssetId]: 1n } });

/** The control output carrying a state, as the ledger will see it. */
const controlOutput = (account: Account, coins: bigint, state: AccountState): TxOut => ({
  address: account.address,
  value: controlValue(account, coins),
  datum: encodeAccountState(state),
});

/** The grant output carrying a grant, as the ledger will see it. */
const grantOutput = (account: Account, assetId: string, coins: bigint, grant: Grant): TxOut => ({
  address: account.address,
  value: { coins, assets: { [assetId]: 1n } },
  datum: encodeGrant(grant),
});

/** The lovelace per byte the protocol charges for a UTxO. */
const adaPerUtxoByteOf = (parameters: ProtocolParameters): bigint => BigInt(parameters.adaPerUtxoByte);

/**
 * The lovelace a control output carrying a state must hold: what it
 * holds already, or its minimum UTxO value when the state has grown
 * past what that covers, since every device and revoked slot enlarges
 * the datum.
 */
const controlLovelace = (account: Account, coins: bigint, state: AccountState, adaPerUtxoByte: bigint): bigint => {
  const minimum = minimumUtxoLovelace(controlOutput(account, coins, state), adaPerUtxoByte);
  return coins > minimum ? coins : minimum;
};

/** The balance a list of outputs pays away in total. */
const sumOutputs = (outputs: AccountOutput[]): Balance => addBalances(...outputs.map((output) => toBalance(output.value)));

/** Whether a remainder either vanishes or can form an output of the minimum change. */
const isSoundChange = (remainder: Balance, minimumChange: bigint): boolean =>
  isZeroBalance(remainder) || quantityOf(remainder, LOVELACE_ASSET_ID) >= minimumChange;

/** UTxOs holding an asset the spend needs come first, then larger lovelace amounts first. */
const sortFunds = (funds: UTxO[], required: Balance): UTxO[] => {
  const neededAssets = Object.keys(required).filter((assetId) => assetId !== LOVELACE_ASSET_ID);
  /** One when a UTxO holds an asset the spend needs, zero otherwise. */
  const usefulness = (utxo: UTxO): number =>
    neededAssets.some((assetId) => (utxo.output.value.assets?.[assetId] ?? 0n) > 0n) ? 1 : 0;
  return [...funds].sort((a, b) => usefulness(b) - usefulness(a) || Number(b.output.value.coins - a.output.value.coins));
};

/**
 * Picks UTxOs covering a required balance such that what remains either
 * vanishes or forms an output of at least the minimum change. Funds are
 * drawn before reserves, so a reserve is only spent for what the funds
 * cannot cover.
 */
export const selectFundUtxos = (funds: UTxO[], required: Balance, minimumChange: bigint, reserves: UTxO[] = []): FundSelection => {
  const selected: UTxO[] = [];
  let total: Balance = {};
  for (const utxo of [...sortFunds(funds, required), ...sortFunds(reserves, required)]) {
    if (coversBalance(total, required) && isSoundChange(subtractBalances(total, required), minimumChange)) {
      break;
    }
    selected.push(utxo);
    total = addBalances(total, toBalance(utxo.output.value));
  }
  if (!coversBalance(total, required)) {
    throw new Error('The account does not hold enough funds for the requested outputs');
  }
  const remainder = subtractBalances(total, required);
  if (!isSoundChange(remainder, minimumChange)) {
    throw new Error(`The funds left in the account cannot form an output of at least ${minimumChange} lovelace`);
  }
  return { selected, remainder };
};

/**
 * The least lovelace a change output returned to the account may hold
 * when it carries a remainder: the override when given, otherwise the
 * minimum UTxO value of a plain deposit holding the remainder's tokens.
 */
const changeFloor =
  (params: AccountUtxoParams, account: Account, adaPerUtxoByte: bigint) =>
  (remainder: Balance): bigint =>
    params.minimumChangeLovelace ??
    minimumUtxoLovelace({ address: account.address, value: toValue({ ...remainder, [LOVELACE_ASSET_ID]: 0n }) }, adaPerUtxoByte);

/**
 * Repeats a selection until the change floor it assumed holds for the
 * change it leaves: a change output carrying tokens needs more lovelace
 * than one carrying lovelace alone, and which tokens the change carries
 * is only known once the funds are chosen.
 */
const selectWithChangeFloor = (floor: (remainder: Balance) => bigint, select: (minimumChange: bigint) => FundSelection): FundSelection => {
  let minimumChange = floor({});
  for (;;) {
    const selection = select(minimumChange);
    const needed = floor(selection.remainder);
    if (needed <= minimumChange) {
      return selection;
    }
    minimumChange = needed;
  }
};

/** The wallet's payment key hash; fails on a wallet whose address pays to no key. */
const paymentKeyOf = async (wallet: Wallet): Promise<string> => {
  const key = paymentKeyHashOf(await wallet.getChangeAddress());
  if (key === undefined) {
    throw new Error('The wallet address pays to no key');
  }
  return key;
};

/** The wallet's payment key hash, which must be a device of the account. */
const deviceOf = async (wallet: Wallet, state: AccountState): Promise<string> => {
  const device = paymentKeyHashOf(await wallet.getChangeAddress());
  if (device === undefined || !state.devices.includes(device)) {
    throw new Error('The wallet payment key is not a device of the account');
  }
  return device;
};

/** Adds the control output carrying a state to a transaction. */
const inlineState = (builder: TransactionBuilder, account: Account, coins: bigint, state: AccountState): TransactionBuilder =>
  builder.lockValue({ scriptAddress: account.address, value: controlValue(account, coins), datum: inlineDatum(encodeAccountState(state)) });

/** Throws when a UTxO holding the account's state NFT already exists at its address. */
const assertAccountAbsent = async (provider: Provider, account: Account): Promise<void> => {
  const utxos = await provider.getUnspentOutputs(account.address);
  if (utxos.some((utxo) => (utxo.output.value.assets?.[account.nftAssetId] ?? 0n) === 1n)) {
    throw new Error(`An account for owner ${account.owner} already exists at ${account.address}`);
  }
};

/**
 * An evaluator that assigns a fixed budget per redeemer instead of running
 * the scripts: the logic's withdrawal gets the logic budget and every
 * other redeemer the proxy budget. An unchecked transaction needs it,
 * since a provider reports a validator's refusal of such a transaction as
 * a failure instead of returning a budget.
 */
export const fixedBudgetEvaluator = (budgets: { logic: ExUnits; proxy: ExUnits }): TxEvaluator => ({
  getName: () => 'Fixed budget evaluator',
  evaluate: (tx) =>
    Promise.resolve(
      Cometa.readRedeemersFromTx(tx).map((redeemer) => ({
        ...redeemer,
        executionUnits: redeemer.purpose === Cometa.RedeemerPurpose.withdrawal ? budgets.logic : budgets.proxy,
      })),
    ),
});

/**
 * Builds a checked transaction and, when the build fails, explains why.
 * cometa reports a failed evaluation as a bare build failure, so the same
 * transaction is built again with fixed budgets in place of the evaluation
 * and evaluated through the provider: the validator's refusal the
 * provider reports, or the units it measured when the transaction only
 * exceeds a limit, are rethrown with the failure so that a refusal is
 * readable. A build that fails for another reason, or whose unchecked
 * form cannot be built either, is rethrown as it was.
 */
export const buildChecked = async (provider: Provider, make: () => Promise<TransactionBuilder>): Promise<string> => {
  try {
    return await (await make()).build();
  } catch (error) {
    if (!(error instanceof Error) || !BUILD_FAILURE.test(error.message)) {
      throw error;
    }
    let unchecked: string;
    try {
      unchecked = await (await make()).setTxEvaluator(fixedBudgetEvaluator(UNCHECKED_EXECUTION_UNITS)).build();
    } catch {
      throw error;
    }
    let reason: string;
    try {
      const redeemers = await provider.evaluateTransaction(unchecked);
      const memory = redeemers.reduce((total, redeemer) => total + BigInt(redeemer.executionUnits.memory), 0n);
      const steps = redeemers.reduce((total, redeemer) => total + BigInt(redeemer.executionUnits.steps), 0n);
      reason = `the provider evaluates the transaction at ${memory} memory units and ${steps} steps over ${redeemers.length} redeemers`;
    } catch (evaluation) {
      reason = evaluation instanceof Error ? evaluation.message : String(evaluation);
    }
    throw new Error(`${error.message.replace(/:?\s*$/, '')}: ${reason}`);
  }
};

/**
 * Builds the transaction that creates an account: it registers the
 * account's stake credential with the deposit the protocol parameters
 * set, which the stake script authorises on the owner's signature, mints
 * the state NFT named after that credential, locks it at the account
 * address with the initial state inline, and runs the logic the state
 * names through a zero withdrawal, as the proxy demands so that the
 * initial logic validates the state. The state must be well formed with
 * zero counters, as every new account starts, and must list the owner
 * among its devices, as the stake script demands of the registration so
 * that no account is created its owner is locked out of; its logic is
 * the version this library pins unless it names another the builder can
 * attach. The logic credential must be registered on the network, which
 * the network setup does once per version. The control output holds the
 * requested lovelace or its minimum UTxO value, whichever is higher, with
 * the sponsor, or the wallet when there is none, paying for it and for
 * the deposit while the owner only signs. The ledger refuses to register
 * a credential twice, so the account can be created only once for as long
 * as it exists; when a provider is given, creation is also refused ahead
 * of the chain while a UTxO holding the state NFT sits at the address,
 * the reference UTxOs the network records are checked to still carry
 * the proxy and the logic, and a failed build is explained through the
 * provider.
 */
export const createAccount = async (params: CreateAccountParams): Promise<string> => {
  const account = resolveAccount(params);
  const state = assertWellFormed({ ...params.state, logic: params.state.logic ?? currentLogicHash(account.scriptHash) });
  if (!hasZeroCounters(state)) {
    throw new Error('The initial state must have zero counters and no revoked slot');
  }
  if (!state.devices.includes(account.owner)) {
    throw new Error(`The initial state must list the owner ${account.owner} among its devices, or the stake script refuses the registration`);
  }
  logicScriptOf(account, state.logic);
  let adaPerUtxoByte = DEFAULT_ADA_PER_UTXO_BYTE;
  if (params.provider) {
    await assertAccountAbsent(params.provider, account);
    adaPerUtxoByte = adaPerUtxoByteOf(await params.provider.getParameters());
  }
  const coins = controlLovelace(account, params.lovelace ?? DEFAULT_CONTROL_LOVELACE, state, adaPerUtxoByte);
  const sources = await resolveSources(account, [state.logic], params.provider);
  /** Assembles the creation: the registration, the mint, the control output and the logic. */
  const make = async (): Promise<TransactionBuilder> => {
    const builder = await (params.sponsor ?? params.wallet).createTransactionBuilder();
    builder.registerStakeAddress({ rewardAddress: account.rewardAddress, redeemer: operateRedeemer });
    builder.mintToken({ assetIdHex: account.nftAssetId, amount: 1n, redeemer: createAccountRedeemer });
    inlineState(builder, account, coins, state);
    runLogic(builder, account, sources, state.logic);
    return attachScript(builder.addSigner(account.owner).addScript(account.stakeScript), sources.proxy);
  };
  return params.provider ? buildChecked(params.provider, make) : (await make()).build();
};

/** Throws when both a sponsor and a collateral wallet are given, since each asks for a different payer. */
const assertOnePayer = (params: AccountUtxoParams): void => {
  if (params.sponsor && params.collateral) {
    throw new Error('A device operation takes a sponsor or a collateral wallet, not both');
  }
};

/** Throws when a grant spend is given a sponsor, since the account pays for it and only the collateral can come from elsewhere. */
const assertNoSponsor = (params: AccountUtxoParams): void => {
  if (params.sponsor) {
    throw new Error('A grant spend takes a collateral wallet only, since the account pays for it; it refuses a sponsor');
  }
};

/**
 * The builder of an operation the account pays for: the collateral
 * wallet's when one is given, with nothing of that wallet left to spend,
 * so that the collateral and its return are its only part in the
 * transaction; otherwise the signing wallet's, which provides the
 * collateral as well. Either way the account's own UTxOs, added
 * explicitly, are all the transaction spends, and the change returns to
 * the account.
 */
const accountPaidBuilder = async (params: AccountUtxoParams, account: Account): Promise<TransactionBuilder> => {
  const builder = await (params.collateral ?? params.wallet).createTransactionBuilder();
  if (params.collateral) {
    builder.setUtxos([]);
  }
  return builder.setCoinSelector(accountOnlyCoinSelector).setChangeAddress(account.address);
};

/**
 * Builds a plain transfer to the account address, which anyone can make.
 * With the reserve option the deposit carries the reserve datum, which
 * makes it the owner's alone to spend.
 */
export const deposit = async (params: DepositParams): Promise<string> => {
  const account = resolveAccount(params);
  const builder = await params.wallet.createTransactionBuilder();
  if (params.reserve) {
    builder.lockValue({ scriptAddress: account.address, value: params.value, datum: inlineDatum(encodeReserveDatum()) });
  } else {
    builder.sendValue({ address: account.address, value: params.value });
  }
  return builder.build();
};

/** A quantity priced at a protocol rate, rounded up. */
const priceOf = (quantity: number, rate: { numerator: number; denominator: number }): bigint =>
  (BigInt(quantity) * BigInt(rate.numerator) + BigInt(rate.denominator) - 1n) / BigInt(rate.denominator);

/** The fee an execution budget costs under the protocol's execution prices. */
const executionFee = (units: ExUnits, prices: ExUnitsPrices): bigint =>
  priceOf(units.memory, prices.memory) + priceOf(units.steps, prices.steps);

/**
 * The fee no transaction exceeds under the protocol parameters: the size
 * fee of the largest transaction allowed plus the price of the largest
 * execution budget allowed. An owner operation paid from the account
 * reserves this much before its real fee is known, and what the reserve
 * leaves over returns to the account as change.
 */
const maximumFee = (parameters: ProtocolParameters): bigint =>
  BigInt(parameters.minFeeB) + BigInt(parameters.minFeeA) * BigInt(parameters.maxTxSize) + executionFee(parameters.maxTxExUnits, parameters.executionCosts);

/** A reserve output holding a value, as the ledger will see it: the reserve's own datum travels with it. */
const reserveOutput = (reserve: UTxO, coins: bigint): TxOut => ({ ...reserve.output, value: { ...reserve.output.value, coins } });

/**
 * The reserves a builder may spend: those carrying their datum inline. A
 * reserve carrying only a datum hash is left alone, since spending it
 * would need the datum itself as a witness and the ledger refuses the
 * transaction without it; selecting it would let anyone park such a UTxO
 * at the address and make the owner's unsponsored operations unsubmittable.
 */
const spendableReserves = (reserves: UTxO[]): UTxO[] => reserves.filter((reserve) => reserve.output.datum !== undefined);

/**
 * The reserve an owner operation draws its fee from: the largest reserve
 * that can pay the most a transaction can cost and still be recreated at
 * its minimum UTxO value while the surplus forms a plain change output,
 * or undefined when no reserve can, in which case the funds pay the fee.
 * The reserve is qualified before the transaction is priced, against the
 * protocol maximum fee rather than the fee the operation settles on, so
 * the threshold is the reserve's minimum UTxO value plus that maximum fee
 * plus the plain change floor, about 4.4 tADA under preprod's parameters;
 * a reserve below it is left whole and the funds pay, even when the real
 * fee, a fraction of the maximum, would have fit.
 */
const pickFeeReserve = (reserves: UTxO[], parameters: ProtocolParameters, plainFloor: bigint): UTxO | undefined =>
  [...reserves]
    .sort((a, b) => Number(b.output.value.coins - a.output.value.coins))
    .find((reserve) => reserve.output.value.coins >= minimumUtxoLovelace(reserveOutput(reserve, 0n), adaPerUtxoByteOf(parameters)) + maximumFee(parameters) + plainFloor);

/** A balance with every negative quantity dropped. */
const positivePart = (balance: Balance): Balance =>
  Object.fromEntries(Object.entries(balance).filter(([, quantity]) => quantity > 0n));

/** The grant outputs an issuance creates: the next slots in order under the recreated control's generation, each at its minimum lovelace. */
const grantIssues = (account: Account, state: AccountState, next: AccountState, requests: GrantRequest[], adaPerUtxoByte: bigint): GrantIssue[] =>
  requests.map((request, index) => {
    const slot = state.nextSlot + BigInt(index);
    const grant: Grant = { slot, grantee: request.grantee, generation: next.grantGeneration, scope: assertScopeWellFormed(request.scope) };
    const assetId = grantAssetId(account.scriptHash, account.stakeScriptHash, slot);
    return { grant, assetId, coins: minimumUtxoLovelace(grantOutput(account, assetId, 0n, grant), adaPerUtxoByte) };
  });

/** Throws unless the recreated state's counters follow the grant tokens the operation mints and burns, as the logic checks. */
const assertCountersFollow = (state: AccountState, next: AccountState, issued: number, swept: number): void => {
  if (next.grantGeneration < state.grantGeneration) {
    throw new Error('The grant generation cannot decrease');
  }
  if (next.nextSlot !== state.nextSlot + BigInt(issued)) {
    throw new Error(`The next slot must move by the ${issued} grants issued`);
  }
  if (next.outstanding !== state.outstanding + BigInt(issued) - BigInt(swept)) {
    throw new Error(`The outstanding count must move by the ${issued} grants issued and the ${swept} swept`);
  }
};

/**
 * Throws unless a rewrite that names another logic is an upgrade the
 * arriving logic accepts: the generation grows strictly so that every
 * grant issued under the old logic is dead, the devices stay the same,
 * nothing is minted or burned under the policy and the next logic is one
 * the builder can attach, as the arriving logic validates the state.
 */
const assertUpgradeAdmissible = (account: Account, state: AccountState, next: AccountState, issued: number, swept: number): void => {
  logicScriptOf(account, next.logic);
  if (next.grantGeneration <= state.grantGeneration) {
    throw new Error('An upgrade must bump the grant generation, so that every grant issued under the old logic is dead');
  }
  if (next.devices.length !== state.devices.length || !next.devices.every((device, index) => device === state.devices[index])) {
    throw new Error('An upgrade cannot change the devices');
  }
  if (issued > 0 || swept > 0) {
    throw new Error('An upgrade cannot issue or sweep grants in the same transaction');
  }
};

/** Throws when a batch of grants is empty or larger than one transaction can carry. */
const assertBatchSize = (count: number, what: string): void => {
  if (count === 0) {
    throw new Error(`At least one grant must be ${what}`);
  }
  if (count > MAX_GRANT_BATCH) {
    throw new Error(`At most ${MAX_GRANT_BATCH} grants can be ${what} in one transaction, not ${count}`);
  }
};

/**
 * Builds an owner transaction: the control UTxO is spent with the device
 * redeemer and recreated with the next state, the dead grants swept are
 * spent with the sweep redeemer and their tokens burned, the grants
 * issued are minted into grant UTxOs at their minimum lovelace, which the
 * account pays, and the outputs are paid. Without a sponsor the account
 * pays its own way: the fee comes from a reserve UTxO when one can cover
 * the most a transaction can cost, which is spent and recreated with the
 * fee taken out, so that an owner operation never has to touch a fund
 * UTxO an agent may be spending; otherwise the funds spent cover the fee
 * too, reserved at the most a transaction can cost. Either way the funds
 * cover the outputs, the grant lovelace and the control output's growth,
 * reserves carrying their datum inline are drawn only for what the funds
 * cannot cover, a reserve carrying only a datum hash is never drawn, and the rest
 * returns to the account as change; the device wallet, which must hold
 * one of the account's device keys, then only signs and provides the
 * collateral, or only signs when a collateral wallet provides it. With a
 * sponsor the funds spent cover the outputs, the grant lovelace and
 * nothing else, whatever they hold beyond that returns to the account,
 * and the sponsor pays the fee and the control output's growth and
 * receives the change. A stake operation, when given, rides on the same
 * transaction with the stake script attached, the spent control UTxO
 * showing the stake script the device that signs. The logic the control
 * UTxO names runs through its zero withdrawal, as the proxy demands, and
 * when the next state names another logic that one runs as well, the old
 * approving the leave and the new validating the arrival. The proxy and
 * the logics are referenced from the network's parked UTxOs when it
 * records them, each checked through the provider to still carry its
 * script, and embedded otherwise, and a failed build is explained
 * through the provider. Built `unchecked`, the transaction takes the
 * wallet's key as the signer without asking whether it is a device and
 * carries fixed budgets instead of an evaluation, so that the node is
 * the one to refuse it.
 */
const buildDeviceSpend = async (params: DeviceParams, operation: DeviceOperation): Promise<string> => {
  assertOnePayer(params);
  const account = resolveAccount(params);
  const utxos = await findAccountUtxos(params.provider, params);
  const { control, state, funds } = utxos;
  const reserves = spendableReserves(utxos.reserves);
  const device = params.unchecked ? await paymentKeyOf(params.wallet) : await deviceOf(params.wallet, state);
  const next = assertWellFormed(operation.nextState(state, utxos));
  const parameters = await params.provider.getParameters();
  const adaPerUtxoByte = adaPerUtxoByteOf(parameters);
  const issued = grantIssues(account, state, next, operation.issued?.(state) ?? [], adaPerUtxoByte);
  const swept = operation.swept?.(utxos) ?? [];
  if (next.logic === state.logic) {
    assertCountersFollow(state, next, issued.length, swept.length);
  } else {
    assertUpgradeAdmissible(account, state, next, issued.length, swept.length);
  }
  const sources = await resolveSources(account, [state.logic, next.logic], params.provider);
  const coins = controlLovelace(account, control.output.value.coins, next, adaPerUtxoByte);
  const growth = coins - control.output.value.coins;
  const freed = addBalances(...swept.map(({ utxo, assetId }) => toBalance({ ...utxo.output.value, assets: { ...utxo.output.value.assets, [assetId]: 0n } })));
  const requested = addBalances(sumOutputs(operation.outputs), { [LOVELACE_ASSET_ID]: issued.reduce((total, issue) => total + issue.coins, 0n) });
  const floor = changeFloor(params, account, adaPerUtxoByte);
  /** Builds an assembled transaction, with a fixed budget per redeemer when the caller asked for no checks. */
  const build = (make: () => Promise<TransactionBuilder>): Promise<string> =>
    params.unchecked ? make().then((builder) => builder.setTxEvaluator(fixedBudgetEvaluator(UNCHECKED_EXECUTION_UNITS)).build()) : buildChecked(params.provider, make);

  /** Adds the control spend, the selected funds, the reserve, the sweeps, the new state and the issuances to a builder. */
  const assemble = (builder: TransactionBuilder, selected: UTxO[], feeReserve: UTxO | undefined, reserveCoins: bigint): TransactionBuilder => {
    builder.addInput({ utxo: control, redeemer: deviceRedeemer });
    for (const utxo of selected) {
      builder.addInput({ utxo, redeemer: fundRedeemer });
    }
    if (feeReserve) {
      builder.addInput({ utxo: feeReserve, redeemer: fundRedeemer }).addOutput(reserveOutput(feeReserve, reserveCoins));
    }
    for (const { utxo, assetId } of swept) {
      builder.addInput({ utxo, redeemer: sweepGrantRedeemer }).mintToken({ assetIdHex: assetId, amount: -1n, redeemer: burnGrantsRedeemer });
    }
    inlineState(builder, account, coins, next);
    for (const issue of issued) {
      builder.mintToken({ assetIdHex: issue.assetId, amount: 1n, redeemer: issueGrantsRedeemer });
      builder.lockValue({ scriptAddress: account.address, value: { coins: issue.coins, assets: { [issue.assetId]: 1n } }, datum: inlineDatum(encodeGrant(issue.grant)) });
    }
    for (const output of operation.outputs) {
      builder.sendValue(output);
    }
    if (operation.stakeOperation) {
      operation.stakeOperation(builder, account).addScript(account.stakeScript);
    }
    if (operation.validFromSlot !== undefined) {
      builder.setInvalidBefore(operation.validFromSlot);
    }
    if (params.validUntilSlot !== undefined) {
      builder.setInvalidAfter(params.validUntilSlot);
    }
    runLogic(builder, account, sources, state.logic);
    if (next.logic !== state.logic) {
      runLogic(builder, account, sources, next.logic);
    }
    return attachScript(builder.addSigner(device), sources.proxy);
  };

  if (params.sponsor) {
    const need = subtractBalances(requested, freed);
    const selection = selectWithChangeFloor(floor, (minimumChange) => selectFundUtxos(funds, positivePart(need), minimumChange, reserves));
    const returned = addBalances(selection.remainder, positivePart(subtractBalances(freed, requested)));
    return build(async () => {
      const builder = await params.sponsor!.createTransactionBuilder();
      if (!isZeroBalance(returned)) {
        builder.sendValue({ address: account.address, value: toValue(returned) });
      }
      return assemble(builder, selection.selected, undefined, 0n);
    });
  }

  const feeReserve = pickFeeReserve(reserves, parameters, floor({}));
  const pool = reserves.filter((reserve) => reserve !== feeReserve);
  if (!feeReserve) {
    const required = positivePart(subtractBalances(addBalances(requested, { [LOVELACE_ASSET_ID]: growth + maximumFee(parameters) }), freed));
    const { selected } = selectWithChangeFloor(floor, (minimumChange) =>
      selectFundUtxos(funds, addBalances(required, { [LOVELACE_ASSET_ID]: minimumChange }), 0n, pool),
    );
    return build(async () => assemble(await accountPaidBuilder(params, account), selected, undefined, 0n));
  }

  const required = positivePart(subtractBalances(addBalances(requested, { [LOVELACE_ASSET_ID]: growth }), freed));
  const { selected } = selectWithChangeFloor(floor, (minimumChange) => selectFundUtxos(funds, required, minimumChange, pool));

  let reserveCoins = minimumUtxoLovelace(reserveOutput(feeReserve, 0n), adaPerUtxoByte);
  let assumedFee: bigint | undefined;
  for (let round = 0; round < MAX_BALANCING_ROUNDS; round += 1) {
    const minimumFee = assumedFee;
    const coinsForReserve = reserveCoins;
    const tx = await build(async () => {
      const builder = await accountPaidBuilder(params, account);
      if (minimumFee !== undefined) {
        builder.setMinimumFee(minimumFee);
      }
      return assemble(builder, selected, feeReserve, coinsForReserve);
    });
    const fee = transactionBodyParts(tx).fee;
    if (fee === assumedFee) {
      return tx;
    }
    assumedFee = fee;
    reserveCoins = feeReserve.output.value.coins - fee;
  }
  throw new Error('The owner transaction did not settle on a fee drawn from the reserve');
};

/** Builds an owner spend paying the outputs, optionally rewriting the state in the same transaction. */
export const spendWithDevice = (params: DeviceParams & { outputs: AccountOutput[]; newState?: AccountState }): Promise<string> =>
  buildDeviceSpend(params, { outputs: params.outputs, nextState: (state) => params.newState ?? state });

/**
 * Builds an owner transaction that only rewrites the account state. The
 * counters must stay as they are, since no grant token is minted or
 * burned, and the generation cannot decrease. A state naming another
 * logic is an upgrade and must be what `upgradeLogic` builds: the
 * generation bumped and the devices unchanged.
 */
export const rewriteState = (params: DeviceParams & { newState: AccountState }): Promise<string> =>
  buildDeviceSpend(params, { outputs: [], nextState: () => params.newState });

/**
 * Builds the owner transaction that points the account at another logic:
 * the control UTxO is rewritten with the new logic in its first field
 * and the generation bumped, carrying a zero withdrawal from the old
 * logic, which approves the leave on a device signature, and from the
 * new one, which validates the arriving state as fresh under its rules.
 * Every grant issued under the old logic is dead by generation from then
 * on: the owner sweeps them with `sweepGrant`, which reads nothing of a
 * grant but its stable prefix, so a grant of another shape is swept by
 * generation or revocation and never by expiry, and issues the survivors
 * again under the new logic from the requests `survivingGrantRequests`
 * lists, each step its own transaction. The new logic must be one the builder can attach, from the
 * blueprint or the logics given, and must differ from the one the account
 * runs; a downgrade is a change like any other, which only the signing
 * device gates.
 */
export const upgradeLogic = (params: DeviceParams & { newLogic: string }): Promise<string> =>
  buildDeviceSpend(params, {
    outputs: [],
    nextState: (state) => {
      if (state.logic === params.newLogic) {
        throw new Error(`The account already runs logic ${params.newLogic}`);
      }
      return stateWithLogic(state, params.newLogic);
    },
  });

/** Builds an owner transaction adding a device key. */
export const addDevice = (params: DeviceParams & { device: string }): Promise<string> =>
  buildDeviceSpend(params, { outputs: [], nextState: (state) => stateWithDevice(state, params.device) });

/** Builds an owner transaction removing a device key. */
export const removeDevice = (params: DeviceParams & { device: string }): Promise<string> =>
  buildDeviceSpend(params, { outputs: [], nextState: (state) => stateWithoutDevice(state, params.device) });

/**
 * Builds an owner transaction issuing grants: each grant takes the next
 * slot in order and the account's current generation, its token is minted
 * into a grant UTxO holding the token and its minimum lovelace, which the
 * account pays, and the control output's next slot and outstanding count
 * move by the number issued. At most `MAX_GRANT_BATCH` grants go in one
 * transaction, and the account may hold at most `MAX_GRANTS` outstanding.
 */
export const issueGrant = async (params: IssueGrantParams): Promise<string> => {
  assertBatchSize(params.grants.length, 'issued');
  return buildDeviceSpend(params, {
    outputs: [],
    nextState: (state) => stateAfterIssue(state, params.grants.length),
    issued: () => params.grants,
  });
};

/**
 * Builds an owner transaction revoking the grant in a slot. While the
 * revoked list holds fewer than `MAX_REVOKED` slots the slot is appended
 * to it, which kills that grant alone. Once the list is full the
 * transaction bumps the grant generation instead, which clears the list
 * and kills every outstanding grant of the account; the owner then
 * sweeps the dead grant UTxOs with `sweepGrant`, in batches, and issues
 * the survivors again with `issueGrant` from the requests
 * `survivingGrantRequests` lists, each step its own transaction, since a
 * sweep is judged against the state the control UTxO held before the
 * bump and an issuance cannot share a transaction with a burn. The slot
 * must have been issued and not be revoked already.
 */
export const revokeGrant = (params: DeviceParams & { slot: bigint }): Promise<string> =>
  buildDeviceSpend(params, {
    outputs: [],
    nextState: (state) => {
      if (params.slot < 0n || params.slot >= state.nextSlot) {
        throw new Error(`The account has not issued slot ${params.slot}`);
      }
      if (state.revoked.includes(params.slot)) {
        throw new Error(`Slot ${params.slot} is revoked already`);
      }
      return isRevokedListFull(state) ? stateWithNextGeneration(state) : stateWithRevokedSlot(state, params.slot);
    },
  });

/**
 * The grants to issue again after a revoke or an upgrade bumps the
 * generation: every grant live under the state before the bump other
 * than the revoked slot, when one is given, with the caps it had left and
 * its expiry, as `issueGrant` takes them. Grants expired at the given
 * time, which defaults to now, are left out, as are grants known by their
 * stable prefix alone: their scope is not read, so they are never issued
 * again, only swept once dead by generation or revocation.
 */
export const survivingGrantRequests = (grants: GrantUtxo[], state: AccountState, revokedSlot?: bigint, now: bigint = BigInt(Date.now())): GrantRequest[] =>
  grants
    .flatMap(({ grant }) => (grant === undefined ? [] : [grant]))
    .filter((grant) => grant.slot !== revokedSlot && isGrantCurrent(grant, state) && grant.scope.expiresAt > now)
    .sort((a, b) => Number(a.slot - b.slot))
    .map((grant) => ({ grantee: grant.grantee, scope: grant.scope }));

/** Builds an owner transaction revoking every grant by bumping the grant generation, which also clears the revoked list. */
export const revokeAllGrants = (params: DeviceParams): Promise<string> =>
  buildDeviceSpend(params, { outputs: [], nextState: stateWithNextGeneration });

/**
 * Builds an owner transaction sweeping dead grants: each grant UTxO is
 * spent with the sweep redeemer, its token burned, its lovelace freed to
 * the account and the control output's outstanding count lowered by the
 * number swept. A grant is dead when it was issued under an older
 * generation, which every grant issued before an upgrade was, when its
 * slot is revoked, or when it expired before the slot the transaction
 * becomes valid at, which `validFromSlot` sets. The sweep reads nothing
 * of a grant but its stable prefix, the slot and the generation, and the
 * expiry lives in the scope, so a grant known by its prefix alone, issued
 * under a logic whose scope shape this library does not read, is swept
 * by generation or revocation and never by expiry. At most
 * `MAX_GRANT_BATCH` grants go in one transaction.
 */
export const sweepGrant = async (params: SweepGrantParams): Promise<string> => {
  assertBatchSize(params.slots.length, 'swept');
  const slotConfig = params.slotConfig ?? Cometa.CARDANO_PREPROD_SLOT_CONFIG;
  const validityStart = params.validFromSlot === undefined ? undefined : slotToPosixTime(params.validFromSlot, slotConfig);
  /** The grant UTxOs of the named slots, each checked dead before it is swept. */
  const swept = ({ state, grants }: AccountUtxos): GrantUtxo[] =>
    params.slots.map((slot) => {
      const found = grants.find(({ prefix }) => prefix.slot === slot);
      if (!found) {
        throw new Error(`The account has no grant UTxO in slot ${slot}`);
      }
      if (grantDeathReason(found.grant ?? found.prefix, state, validityStart) === undefined) {
        throw new Error(
          `Grant ${slot} is live: it was issued under the current generation and its slot is not revoked${
            validityStart === undefined ? '; a grant that has expired needs validFromSlot past its expiry' : ', and the validity range starts before it expires'
          }`,
        );
      }
      return found;
    });
  const operation: DeviceOperation = { outputs: [], nextState: (state) => stateAfterSweep(state, params.slots.length), swept };
  if (params.validFromSlot !== undefined) {
    operation.validFromSlot = params.validFromSlot;
  }
  return buildDeviceSpend(params, operation);
};

/** The state of the account unchanged, for owner transactions that only operate the stake credential. */
const sameState = (state: AccountState): AccountState => state;

/**
 * Builds an owner transaction withdrawing the rewards of the account's
 * stake credential. The ledger only accepts a withdrawal of the whole
 * reward balance, which the provider reports when no amount is given; a
 * withdrawal of zero is valid and runs the stake script all the same. The
 * withdrawn lovelace joins the transaction's balance, so without a
 * sponsor it returns to the account as change.
 */
export const withdrawRewards = async (params: DeviceParams & { amount?: bigint }): Promise<string> => {
  const amount = params.amount ?? (await params.provider.getRewardsBalance(resolveAccount(params).rewardAddress.toBech32()));
  return buildDeviceSpend(params, {
    outputs: [],
    nextState: sameState,
    stakeOperation: (builder, account) => builder.withdrawRewards({ rewardAddress: account.rewardAddress, amount, redeemer: operateRedeemer }),
  });
};

/** Builds an owner transaction delegating the account's stake credential to a pool, given by its bech32 id. */
export const delegateStake = (params: DeviceParams & { poolId: string }): Promise<string> =>
  buildDeviceSpend(params, {
    outputs: [],
    nextState: sameState,
    stakeOperation: (builder, account) =>
      builder.delegateStake({ rewardAddress: account.rewardAddress, poolId: params.poolId, redeemer: operateRedeemer }),
  });

/**
 * Splits fund UTxOs into the batches a sequence of grant spends sweeps,
 * largest first, each of at most `MAX_FUND_INPUTS` UTxOs, so that every
 * batch stays within the execution budget a spend over many inputs costs
 * on chain. The change of each sweep is a fund UTxO the next may take.
 */
export const fundBatches = (funds: UTxO[], size: number = MAX_FUND_INPUTS): UTxO[][] => {
  if (!Number.isInteger(size) || size < 1 || size > MAX_FUND_INPUTS) {
    throw new Error(`A fund batch holds between one and ${MAX_FUND_INPUTS} UTxOs, not ${size}`);
  }
  const sorted = [...funds].sort((a, b) => Number(b.output.value.coins - a.output.value.coins));
  const batches: UTxO[][] = [];
  for (let start = 0; start < sorted.length; start += size) {
    batches.push(sorted.slice(start, start + size));
  }
  return batches;
};

/** Whether two addresses are equal as the validator compares them, ignoring the network id. */
const sameAddress = (a: string, b: string): boolean => Cometa.deepEqualsPlutusData(encodeAddress(a), encodeAddress(b));

/** Throws unless the signer is the key the grant names as its grantee. */
const assertGranteeMatches = (grant: Grant, grantee: string): void => {
  if (grant.grantee !== grantee) {
    throw new Error(`The signer is not the grantee of grant ${grant.slot}`);
  }
};

/** Throws when a grant lists recipients and an output goes elsewhere. */
const assertRecipientsAllowed = (grant: Grant, outputs: AccountOutput[]): void => {
  const { recipients } = grant.scope;
  if (recipients.length === 0) {
    return;
  }
  for (const output of outputs) {
    if (!recipients.some((recipient) => sameAddress(recipient, output.address))) {
      throw new Error(`${output.address} is not a recipient of grant ${grant.slot}`);
    }
  }
};

/** Throws when a grant is not current against the account's state, naming why. */
const assertGrantCurrent = (grant: Grant, state: AccountState): void => {
  const reason = grantDeathReason(grant, state);
  if (reason !== undefined) {
    throw new Error(`Grant ${grant.slot} is dead: ${reason}`);
  }
};

/**
 * Builds an agent spend. The grant UTxO of the slot is spent with the
 * grant redeemer and recreated at the same address with the same value,
 * carrying the grant with its remaining caps reduced by what leaves; the
 * control UTxO is a reference input, never spent, so an owner's revoke
 * never competes with the agent for it; the fund UTxOs covering the
 * outputs are spent with the fund redeemer, and the fee and the change
 * come out of and go back to the account as a plain deposit, so that
 * only the requested outputs leave it. The grantee is a required signer
 * and the wallet, which must hold its key, provides the signature and
 * the collateral, or the signature alone when a collateral wallet
 * provides the collateral; a sponsor is refused, since nothing of the
 * spend is the sponsor's to pay.
 *
 * The fee is part of what leaves, and the validator accepts a grant
 * output whose remaining caps sit anywhere between zero and the caps it
 * computes, so the caps are reduced by the outputs plus a bound on the
 * fee, `DEFAULT_GRANT_FEE_BOUND` unless `feeBound` says otherwise, the
 * datum is written once and the provider evaluates the scripts for real;
 * the fee then ends at or below the bound, the difference returns to the
 * account as change, and a fee above the bound is refused before
 * submission since the validator would refuse it too. The fund selection
 * covers the outputs, the bound and the change floor, so the change is
 * always a sound output.
 *
 * The logic the control UTxO names runs through its zero withdrawal, as
 * the proxy demands of every grant spend, so the agent runs the rules the
 * owner chose; the proxy and the logic are referenced from the network's
 * parked UTxOs when it records them, each checked through the provider
 * to still carry its script, and embedded otherwise. A checked spend
 * takes at most `MAX_FUND_INPUTS` fund UTxOs, since each adds a
 * proxy run that pays to decode the whole transaction; `fundBatches`
 * splits a larger sweep. A failed checked build is explained through the
 * provider.
 *
 * The liveness, scope, recipient and expiry checks mirror the logic's
 * rules so that a spend the logic would refuse never reaches the chain;
 * the unchecked option drops them to build such a spend on purpose, which
 * shows the logic refusing it. A grant known by its stable prefix alone,
 * issued under a logic whose scope shape this library does not read, is
 * refused either way.
 */
export const spendWithGrant = async (params: SpendWithGrantParams): Promise<string> => {
  assertNoSponsor(params);
  const account = resolveAccount(params);
  const { control, state, grants, funds } = await findAccountUtxos(params.provider, params);
  const found = grants.find(({ prefix }) => prefix.slot === params.slot);
  if (!found) {
    throw new Error(`The account has no grant UTxO in slot ${params.slot}`);
  }
  if (found.grant === undefined) {
    throw new Error(`Grant ${params.slot} was issued under a logic whose scope shape this library does not read; it can only be swept`);
  }
  const { grant, utxo: grantUtxo } = found;
  assertGranteeMatches(grant, params.grantee);
  const sources = await resolveSources(account, [state.logic], params.provider);
  const slotConfig = params.slotConfig ?? Cometa.CARDANO_PREPROD_SLOT_CONFIG;
  const feeBound = params.feeBound ?? DEFAULT_GRANT_FEE_BOUND;
  const requested = sumOutputs(params.outputs);
  const bounded = addBalances(requested, { [LOVELACE_ASSET_ID]: feeBound });
  if (!params.unchecked) {
    assertGrantCurrent(grant, state);
    assertRecipientsAllowed(grant, params.outputs);
    if (slotToPosixTime(params.validUntilSlot, slotConfig) > grant.scope.expiresAt) {
      throw new Error(`Slot ${params.validUntilSlot} starts after grant ${grant.slot} expires`);
    }
    const violation = scopeViolation(grant.scope, bounded);
    if (violation) {
      throw new Error(`Grant ${grant.slot} refuses the spend: ${violation}`);
    }
  }
  const parameters = await params.provider.getParameters();
  const floor = changeFloor(params, account, adaPerUtxoByteOf(parameters));
  const { selected } = selectWithChangeFloor(floor, (minimumChange) =>
    selectFundUtxos(funds, addBalances(bounded, { [LOVELACE_ASSET_ID]: minimumChange }), 0n),
  );
  if (!params.unchecked && selected.length > MAX_FUND_INPUTS) {
    throw new Error(`The spend needs ${selected.length} fund UTxOs, more than the ${MAX_FUND_INPUTS} one grant spend may take; sweep the funds in batches of fundBatches first`);
  }
  /** Assembles the grant spend: the referenced control, the grant UTxO, the funds, the recreated grant and the outputs. */
  const make = async (): Promise<TransactionBuilder> => {
    const builder = await accountPaidBuilder(params, account);
    if (params.unchecked) {
      builder.setTxEvaluator(fixedBudgetEvaluator(UNCHECKED_EXECUTION_UNITS));
    }
    builder.addReferenceInput(control).addInput({ utxo: grantUtxo, redeemer: spendWithGrantRedeemer });
    for (const utxo of selected) {
      builder.addInput({ utxo, redeemer: fundRedeemer });
    }
    builder.lockValue({ scriptAddress: account.address, value: grantUtxo.output.value, datum: inlineDatum(encodeGrant(grantAfterSpend(grant, bounded))) });
    for (const output of params.outputs) {
      builder.sendValue(output);
    }
    runLogic(builder, account, sources, state.logic);
    return attachScript(builder.addSigner(params.grantee).setInvalidAfter(params.validUntilSlot), sources.proxy);
  };
  const tx = params.unchecked ? await (await make()).build() : await buildChecked(params.provider, make);
  const fee = transactionBodyParts(tx).fee;
  if (!params.unchecked && fee > feeBound) {
    throw new Error(`The fee of ${fee} lovelace exceeds the fee bound of ${feeBound} the caps were reduced by; raise feeBound`);
  }
  return tx;
};
