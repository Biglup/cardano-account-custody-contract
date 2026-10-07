import type {
  CoinSelector,
  Datum,
  ExUnits,
  ExUnitsPrices,
  NetworkId,
  PlutusScript,
  ProtocolParameters,
  Provider,
  RewardAddress,
  SlotConfig,
  TransactionBuilder,
  TxEvaluator,
  TxIn,
  TxOut,
  UTxO,
  Value,
  Wallet,
} from '@biglup/cometa';
import { accountAddress, paymentKeyHashOf, rewardAddress, stateNftAssetId } from './address.js';
import { accountScript } from './blueprint.js';
import { Cometa } from './cometa.js';
import {
  type AccountState,
  type Grant,
  decodeAccountState,
  encodeAccountRedeemer,
  encodeAccountState,
  encodeAddress,
  encodeMintRedeemer,
  encodeStakeRedeemer,
} from './data.js';
import { compareInputs, slotToPosixTime, transactionBodyParts } from './body.js';
import type { AccountRecord } from './discovery.js';
import { DEFAULT_ADA_PER_UTXO_BYTE, minimumUtxoLovelace } from './output.js';
import { stakeScript, stakeScriptHash } from './stake-script.js';
import {
  assertWellFormed,
  findGrant,
  scopeViolation,
  stateAfterSpend,
  stateWithDevice,
  stateWithGrant,
  stateWithoutDevice,
  stateWithoutGrant,
  stateWithoutGrants,
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
   * the account's own fund UTxOs and the device wallet provides the
   * collateral alone, while creation, which has no account to pay from
   * yet, is paid by the device wallet.
   */
  sponsor?: Wallet;
  /** The account script; the blueprint's validator when omitted. */
  script?: PlutusScript;
  /** The network the account address lives on; the testnet when omitted. */
  networkId?: NetworkId;
};

/** Account parameters for builders that must read the account's UTxOs. */
export type AccountUtxoParams = AccountParams & {
  /** The provider that lists the UTxOs at the account address. */
  provider: Provider;
  /**
   * A wallet that provides the collateral and nothing else: the account
   * pays the outputs, the fee and the lovelace the control output needs
   * beyond what it held from its own fund UTxOs, the collateral and its
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
};

/** Parameters of account creation. */
export type CreateAccountParams = AccountParams & {
  /** The initial state, which must be well formed. */
  state: AccountState;
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

/** Parameters of an agent spend. */
export type SpendWithGrantParams = AccountUtxoParams & {
  slot: bigint;
  outputs: AccountOutput[];
  /** The key hash of the grant's grantee, which signs the transaction as a required signer. */
  grantee: string;
  /** The slot the transaction stops being valid at, which must start no later than the grant's expiry. */
  validUntilSlot: bigint;
  /** The slot timing of the network; preprod's when omitted. */
  slotConfig?: SlotConfig;
  /** The execution budget to assume per redeemer kind instead of the defaults. */
  executionUnits?: { control?: ExUnits; fund?: ExUnits };
  /**
   * Skips the builder's scope, recipient and expiry checks, for evidence
   * and testing only. The transaction is built exactly as the validator
   * will see it: the control output carries the state after the spend as
   * the validator computes it, every output goes where it was asked to
   * and the validity range ends at the slot it was asked to, so that the
   * node refuses the transaction with the validator's own failure. The
   * grant must still exist, since its state is what the datum rewrites.
   */
  unchecked?: boolean;
};

/** The lovelace a freshly created control UTxO carries unless its state needs more. */
export const DEFAULT_CONTROL_LOVELACE = 2_000_000n;

/**
 * The default execution budget of the control UTxO's spend on the agent
 * path. It covers the heaviest grant spend the contract allows, the
 * lovelace scope over the largest well formed state and nine inputs,
 * which the security review measures at about 5.8 million memory units
 * net of its fixture and 2.2 billion steps in all, with a margin for the
 * script context decoding that measurement leaves out and for a few more
 * inputs.
 */
export const DEFAULT_CONTROL_EXECUTION_UNITS: ExUnits = { memory: 7_000_000, steps: 3_500_000_000 };

/**
 * The default execution budget of a fund UTxO's spend, which measures at
 * about 211 thousand memory units and 63 million steps.
 */
export const DEFAULT_FUND_EXECUTION_UNITS: ExUnits = { memory: 500_000, steps: 200_000_000 };

/** The most times a grant spend is rebuilt while its fee and state settle. */
const MAX_BALANCING_ROUNDS = 4;

/** The identifiers derived from the account script and the owner of an account. */
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
}

/** The UTxOs of an account and the state its control UTxO carries. */
export interface AccountUtxos {
  control: UTxO;
  funds: UTxO[];
  state: AccountState;
}

/** The fund UTxOs chosen for a spend and what they hold beyond its needs. */
export interface FundSelection {
  selected: UTxO[];
  remainder: Balance;
}

/**
 * Derives the account identifiers from the builder parameters, applying
 * the stake script to the owner and the account script. A record names
 * the same owner, so the derivation is the same either way; the stake
 * script is always rebuilt since the record cannot carry it.
 */
const resolveAccount = (params: AccountParams): Account => {
  const { script = accountScript(), networkId = Cometa.NetworkId.Testnet, record } = params;
  const owner = record ? record.owner : params.owner;
  const scriptHash = Cometa.computeScriptHash(script);
  const stake = stakeScript(owner, scriptHash);
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
  };
};

/** Whether a UTxO holds exactly one state NFT of the account. */
const holdsStateNft = (utxo: UTxO, nftAssetId: string): boolean => (utxo.output.value.assets?.[nftAssetId] ?? 0n) === 1n;

/**
 * Locates the account's control UTxO, the one holding its state NFT, and
 * the fund UTxOs sitting alongside it, and decodes the account state.
 */
export const findAccountUtxos = async (provider: Provider, params: AccountParams): Promise<AccountUtxos> => {
  const account = resolveAccount(params);
  const utxos = await provider.getUnspentOutputs(account.address);
  const controls = utxos.filter((utxo) => holdsStateNft(utxo, account.nftAssetId));
  const control = controls[0];
  if (!control || controls.length > 1) {
    throw new Error(`Expected exactly one control UTxO at ${account.address}, found ${controls.length}`);
  }
  if (control.output.datum === undefined) {
    throw new Error('The control UTxO carries no inline datum');
  }
  return {
    control,
    funds: utxos.filter((utxo) => utxo !== control),
    state: decodeAccountState(control.output.datum, account.networkId),
  };
};

/** The redeemers of the owner path and the fund path, which carry no data. */
const deviceRedeemer = encodeAccountRedeemer({ kind: 'device' });
const fundRedeemer = encodeAccountRedeemer({ kind: 'fund' });

/** The redeemer of every stake script run, which carries no data. */
const operateRedeemer = encodeStakeRedeemer();

/** An account state as the inline datum of a control output. */
const stateDatum = (state: AccountState): Datum => ({
  type: Cometa.DatumType.InlineData,
  inlineDatum: encodeAccountState(state),
});

/** The value of a control output: lovelace and the state NFT only. */
const controlValue = (account: Account, coins: bigint): Value => ({ coins, assets: { [account.nftAssetId]: 1n } });

/** The control output carrying a state, as the ledger will see it. */
const controlOutput = (account: Account, coins: bigint, state: AccountState): TxOut => ({
  address: account.address,
  value: controlValue(account, coins),
  datum: encodeAccountState(state),
});

/** The lovelace per byte the protocol charges for a UTxO. */
const adaPerUtxoByteOf = (parameters: ProtocolParameters): bigint => BigInt(parameters.adaPerUtxoByte);

/**
 * The lovelace a control output carrying a state must hold: what it
 * holds already, or its minimum UTxO value when the state has grown
 * past what that covers, since every grant and device enlarges the datum.
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

/** Fund UTxOs holding an asset the spend needs come first, then larger lovelace amounts first. */
const sortFunds = (funds: UTxO[], required: Balance): UTxO[] => {
  const neededAssets = Object.keys(required).filter((assetId) => assetId !== LOVELACE_ASSET_ID);
  const usefulness = (utxo: UTxO): number =>
    neededAssets.some((assetId) => (utxo.output.value.assets?.[assetId] ?? 0n) > 0n) ? 1 : 0;
  return [...funds].sort((a, b) => usefulness(b) - usefulness(a) || Number(b.output.value.coins - a.output.value.coins));
};

/**
 * Picks fund UTxOs covering a required balance such that what remains
 * either vanishes or forms an output of at least the minimum change.
 */
export const selectFundUtxos = (funds: UTxO[], required: Balance, minimumChange: bigint): FundSelection => {
  const selected: UTxO[] = [];
  let total: Balance = {};
  for (const utxo of sortFunds(funds, required)) {
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
  builder.lockValue({ scriptAddress: account.address, value: controlValue(account, coins), datum: stateDatum(state) });

/** Throws when a UTxO holding the account's state NFT already exists at its address. */
const assertAccountAbsent = async (provider: Provider, account: Account): Promise<void> => {
  const utxos = await provider.getUnspentOutputs(account.address);
  if (utxos.some((utxo) => holdsStateNft(utxo, account.nftAssetId))) {
    throw new Error(`An account for owner ${account.owner} already exists at ${account.address}`);
  }
};

/**
 * Builds the transaction that creates an account: it registers the
 * account's stake credential with the deposit the protocol parameters
 * set, which the stake script authorises on the owner's signature, mints
 * the state NFT named after that credential, and locks it at the account
 * address with the initial state inline. The control output holds the
 * requested lovelace or its minimum UTxO value, whichever is higher, with
 * the sponsor, or the wallet when there is none, paying for it and for the
 * deposit while the owner only signs. The ledger refuses to
 * register a credential twice, so the account can be created only once
 * for as long as it exists; when a provider is given, creation is also
 * refused ahead of the chain while a UTxO holding the state NFT sits at
 * the address.
 */
export const createAccount = async (params: CreateAccountParams): Promise<string> => {
  const account = resolveAccount(params);
  const state = assertWellFormed(params.state);
  let adaPerUtxoByte = DEFAULT_ADA_PER_UTXO_BYTE;
  if (params.provider) {
    await assertAccountAbsent(params.provider, account);
    adaPerUtxoByte = adaPerUtxoByteOf(await params.provider.getParameters());
  }
  const builder = await (params.sponsor ?? params.wallet).createTransactionBuilder();
  builder.registerStakeAddress({ rewardAddress: account.rewardAddress, redeemer: operateRedeemer });
  builder.mintToken({ assetIdHex: account.nftAssetId, amount: 1n, redeemer: encodeMintRedeemer() });
  inlineState(builder, account, controlLovelace(account, params.lovelace ?? DEFAULT_CONTROL_LOVELACE, state, adaPerUtxoByte), state);
  return builder.addSigner(account.owner).addScript(account.script).addScript(account.stakeScript).build();
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

/** Builds a plain transfer to the account address, which anyone can make. */
export const deposit = async (params: AccountParams & { value: Value }): Promise<string> => {
  const account = resolveAccount(params);
  const builder = await params.wallet.createTransactionBuilder();
  return builder.sendValue({ address: account.address, value: params.value }).build();
};

/** A step adding a withdrawal or a certificate of the account's stake credential to a builder. */
type StakeOperation = (builder: TransactionBuilder, account: Account) => TransactionBuilder;

/**
 * The fee no transaction exceeds under the protocol parameters: the size
 * fee of the largest transaction allowed plus the price of the largest
 * execution budget allowed. An owner operation paid from the account
 * reserves this much before its real fee is known, and what the reserve
 * leaves over returns to the account as change.
 */
const maximumFee = (parameters: ProtocolParameters): bigint =>
  BigInt(parameters.minFeeB) + BigInt(parameters.minFeeA) * BigInt(parameters.maxTxSize) + executionFee(parameters.maxTxExUnits, parameters.executionCosts);

/**
 * Builds an owner transaction: the control UTxO is spent with the device
 * redeemer and recreated with the next state, fund UTxOs are spent
 * alongside it with the fund redeemer, and the outputs are paid. Without a
 * sponsor the account pays its own way: the funds spent also cover the
 * fee, the lovelace the control output needs beyond what it held once the
 * state has grown, and a change output back to the account, with the fee
 * reserved at the most a transaction can cost so that the change settles
 * whatever the real fee turns out to be; the device wallet, which must
 * hold one of the account's device keys, then only signs and provides the
 * collateral, or only signs when a collateral wallet provides it. With a
 * sponsor the funds spent cover the outputs alone, whatever they hold
 * beyond the outputs returns to the account, and the sponsor pays the fee
 * and the control output's growth and receives the change. A stake
 * operation, when given, rides on the same transaction
 * with the stake script attached, the spent control UTxO showing the stake
 * script the device that signs.
 */
const buildDeviceSpend = async (
  params: AccountUtxoParams,
  outputs: AccountOutput[],
  nextState: (state: AccountState) => AccountState,
  stakeOperation?: StakeOperation,
): Promise<string> => {
  assertOnePayer(params);
  const account = resolveAccount(params);
  const { control, funds, state } = await findAccountUtxos(params.provider, params);
  const device = await deviceOf(params.wallet, state);
  const next = assertWellFormed(nextState(state));
  const parameters = await params.provider.getParameters();
  const adaPerUtxoByte = adaPerUtxoByteOf(parameters);
  const coins = controlLovelace(account, control.output.value.coins, next, adaPerUtxoByte);
  const requested = sumOutputs(outputs);
  const floor = changeFloor(params, account, adaPerUtxoByte);
  let builder: TransactionBuilder;
  let selected: UTxO[];
  if (params.sponsor) {
    builder = await params.sponsor.createTransactionBuilder();
    const selection = selectWithChangeFloor(floor, (minimumChange) => selectFundUtxos(funds, requested, minimumChange));
    selected = selection.selected;
    if (!isZeroBalance(selection.remainder)) {
      builder.sendValue({ address: account.address, value: toValue(selection.remainder) });
    }
  } else {
    builder = await accountPaidBuilder(params, account);
    const required = addBalances(requested, { [LOVELACE_ASSET_ID]: coins - control.output.value.coins + maximumFee(parameters) });
    selected = selectWithChangeFloor(floor, (minimumChange) =>
      selectFundUtxos(funds, addBalances(required, { [LOVELACE_ASSET_ID]: minimumChange }), 0n),
    ).selected;
  }
  builder.addInput({ utxo: control, redeemer: deviceRedeemer });
  for (const utxo of selected) {
    builder.addInput({ utxo, redeemer: fundRedeemer });
  }
  inlineState(builder, account, coins, next);
  for (const output of outputs) {
    builder.sendValue(output);
  }
  if (stakeOperation) {
    stakeOperation(builder, account).addScript(account.stakeScript);
  }
  return builder.addSigner(device).addScript(account.script).build();
};

/** Builds an owner spend paying the outputs, optionally rewriting the state in the same transaction. */
export const spendWithDevice = (
  params: AccountUtxoParams & { outputs: AccountOutput[]; newState?: AccountState },
): Promise<string> => buildDeviceSpend(params, params.outputs, (state) => params.newState ?? state);

/** Builds an owner transaction that only rewrites the account state. */
export const rewriteState = (params: AccountUtxoParams & { newState: AccountState }): Promise<string> =>
  buildDeviceSpend(params, [], () => params.newState);

/** Builds an owner transaction adding a device key. */
export const addDevice = (params: AccountUtxoParams & { device: string }): Promise<string> =>
  buildDeviceSpend(params, [], (state) => stateWithDevice(state, params.device));

/** Builds an owner transaction removing a device key. */
export const removeDevice = (params: AccountUtxoParams & { device: string }): Promise<string> =>
  buildDeviceSpend(params, [], (state) => stateWithoutDevice(state, params.device));

/** Builds an owner transaction issuing a grant. */
export const issueGrant = (params: AccountUtxoParams & { grant: Grant }): Promise<string> =>
  buildDeviceSpend(params, [], (state) => stateWithGrant(state, params.grant));

/** Builds an owner transaction revoking the grant in a slot. */
export const revokeGrant = (params: AccountUtxoParams & { slot: bigint }): Promise<string> =>
  buildDeviceSpend(params, [], (state) => stateWithoutGrant(state, params.slot));

/** Builds an owner transaction revoking every grant and bumping the grant generation. */
export const revokeAllGrants = (params: AccountUtxoParams): Promise<string> =>
  buildDeviceSpend(params, [], stateWithoutGrants);

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
export const withdrawRewards = async (params: AccountUtxoParams & { amount?: bigint }): Promise<string> => {
  const amount = params.amount ?? (await params.provider.getRewardsBalance(resolveAccount(params).rewardAddress.toBech32()));
  return buildDeviceSpend(params, [], sameState, (builder, account) =>
    builder.withdrawRewards({ rewardAddress: account.rewardAddress, amount, redeemer: operateRedeemer }),
  );
};

/** Builds an owner transaction delegating the account's stake credential to a pool, given by its bech32 id. */
export const delegateStake = (params: AccountUtxoParams & { poolId: string }): Promise<string> =>
  buildDeviceSpend(params, [], sameState, (builder, account) =>
    builder.delegateStake({ rewardAddress: account.rewardAddress, poolId: params.poolId, redeemer: operateRedeemer }),
  );

/**
 * A coin selector that spends nothing beyond the inputs the builder was
 * given explicitly, so that an agent spend is funded by the account alone
 * and fails instead of reaching into the wallet when the account cannot
 * cover it. The wallet's UTxOs stay available to the builder for the
 * collateral only.
 */
export const accountOnlyCoinSelector: CoinSelector = {
  getName: () => 'Account only',
  select: ({ preSelectedUtxo, availableUtxo }) => Promise.resolve({ selection: preSelectedUtxo ?? [], remaining: availableUtxo }),
};

/**
 * An evaluator that assigns a fixed budget per redeemer instead of running
 * the scripts: the control UTxO's spend gets the control budget and every
 * other redeemer the fund budget. Every grant spend needs it, because the
 * state the control output carries depends on the fee, the fee depends on
 * the execution units, and an evaluator runs the scripts over drafts
 * whose fee differs from the one the state was computed against; the
 * validator refuses those drafts, and a provider reports the refusal as a
 * failure instead of returning a budget.
 */
export const fixedBudgetEvaluator = (
  control: TxIn,
  budgets: { control: ExUnits; fund: ExUnits },
): TxEvaluator => ({
  getName: () => 'Fixed budget evaluator',
  evaluate: (tx) => {
    const inputs = transactionBodyParts(tx).inputs;
    const controlIndex = inputs.findIndex((input) => compareInputs(input, control) === 0);
    return Promise.resolve(
      Cometa.readRedeemersFromTx(tx).map((redeemer) => ({
        ...redeemer,
        executionUnits:
          redeemer.purpose === Cometa.RedeemerPurpose.spend && redeemer.index === controlIndex ? budgets.control : budgets.fund,
      })),
    );
  },
});

/** A quantity priced at a protocol rate, rounded up. */
const priceOf = (quantity: number, rate: { numerator: number; denominator: number }): bigint =>
  (BigInt(quantity) * BigInt(rate.numerator) + BigInt(rate.denominator) - 1n) / BigInt(rate.denominator);

/** The fee an execution budget costs under the protocol's execution prices. */
const executionFee = (units: ExUnits, prices: ExUnitsPrices): bigint =>
  priceOf(units.memory, prices.memory) + priceOf(units.steps, prices.steps);

/**
 * A fee no grant spend exceeds: the size fee of the largest transaction
 * the protocol allows plus the price of the control budget and of the fund
 * budget for every fund UTxO spent. The account pays the fee, so the fund
 * selection reserves this much lovelace before the fee is known.
 */
const feeAllowance = (parameters: ProtocolParameters, budgets: { control: ExUnits; fund: ExUnits }, fundCount: number): bigint =>
  BigInt(parameters.minFeeB) +
  BigInt(parameters.minFeeA) * BigInt(parameters.maxTxSize) +
  executionFee(budgets.control, parameters.executionCosts) +
  executionFee(budgets.fund, parameters.executionCosts) * BigInt(fundCount);

/**
 * Selects the fund UTxOs of a grant spend: they must cover the outputs,
 * the fee allowance for as many fund UTxOs as end up spent, and the change
 * floor, so that what returns to the account after the fee always forms
 * a valid output.
 */
const selectGrantFunds = (
  funds: UTxO[],
  requested: Balance,
  floor: (remainder: Balance) => bigint,
  allowance: (fundCount: number) => bigint,
): FundSelection => {
  let fundCount = 1;
  for (;;) {
    const reserve = allowance(fundCount);
    const selection = selectWithChangeFloor(floor, (minimumChange) =>
      selectFundUtxos(funds, addBalances(requested, { [LOVELACE_ASSET_ID]: reserve + minimumChange }), 0n),
    );
    if (selection.selected.length <= fundCount) {
      return selection;
    }
    fundCount = selection.selected.length;
  }
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

/** The value the account's inputs hold beyond what its outputs in a built transaction return to it. */
const leavingBalance = (txCbor: string, account: Account, inputs: UTxO[]): Balance => {
  const spent = addBalances(...inputs.map((utxo) => toBalance(utxo.output.value)));
  const returned = addBalances(
    ...transactionBodyParts(txCbor)
      .outputs.filter((output) => sameAddress(output.address, account.address))
      .map((output) => toBalance(output.value)),
  );
  return subtractBalances(spent, returned);
};

/**
 * Builds an agent spend. The control UTxO is spent with the grant
 * redeemer and recreated, with the lovelace it held, carrying the grant's
 * caps reduced by what leaves; the fund UTxOs covering the outputs are
 * spent with the fund redeemer, and the fee and the change come out of
 * and go back to the account, so that only the requested outputs leave
 * it. The grantee is a required signer and the wallet, which must hold
 * its key, provides the signature and the collateral, or the signature
 * alone when a collateral wallet provides the collateral; a sponsor is
 * refused, since nothing of the spend is the sponsor's to pay.
 *
 * The fee is part of what leaves, and the recreated state depends on it,
 * so the transaction is rebuilt until the state it carries matches the
 * value that leaves.
 *
 * The scripts are never evaluated: the validator refuses every draft
 * whose fee differs from the one the state was computed against, and a
 * provider reports that refusal as a failure, so the redeemers carry the
 * fixed budgets instead. The defaults cover the largest state over a
 * handful of inputs; many more inputs raise the real cost, and the
 * execution units option raises the budgets for them.
 *
 * The scope, recipient and expiry checks mirror the validator's rules so
 * that a spend the validator would refuse never reaches the chain; the
 * unchecked option drops them to build such a spend on purpose, which
 * shows the validator refusing it.
 */
export const spendWithGrant = async (params: SpendWithGrantParams): Promise<string> => {
  assertNoSponsor(params);
  const account = resolveAccount(params);
  const { control, funds, state } = await findAccountUtxos(params.provider, params);
  const grant = findGrant(state, params.slot);
  if (!grant) {
    throw new Error(`The account has no grant in slot ${params.slot}`);
  }
  assertGranteeMatches(grant, params.grantee);
  const slotConfig = params.slotConfig ?? Cometa.CARDANO_PREPROD_SLOT_CONFIG;
  if (!params.unchecked) {
    assertRecipientsAllowed(grant, params.outputs);
    if (slotToPosixTime(params.validUntilSlot, slotConfig) > grant.scope.expiresAt) {
      throw new Error(`Slot ${params.validUntilSlot} starts after grant ${grant.slot} expires`);
    }
  }
  const parameters = await params.provider.getParameters();
  const budgets = {
    control: params.executionUnits?.control ?? DEFAULT_CONTROL_EXECUTION_UNITS,
    fund: params.executionUnits?.fund ?? DEFAULT_FUND_EXECUTION_UNITS,
  };
  const requested = sumOutputs(params.outputs);
  const { selected } = selectGrantFunds(
    funds,
    requested,
    changeFloor(params, account, adaPerUtxoByteOf(parameters)),
    (fundCount) => feeAllowance(parameters, budgets, fundCount),
  );
  const inputs = [control, ...selected];
  const evaluator = fixedBudgetEvaluator(control.input, budgets);

  const build = async (leaving: Balance): Promise<{ tx: string; state: AccountState }> => {
    const violation = params.unchecked ? undefined : scopeViolation(grant.scope, leaving);
    if (violation) {
      throw new Error(`Grant ${grant.slot} refuses the spend: ${violation}`);
    }
    const next = stateAfterSpend(state, params.slot, leaving);
    const builder = (await accountPaidBuilder(params, account)).setTxEvaluator(evaluator);
    builder.addInput({ utxo: control, redeemer: encodeAccountRedeemer({ kind: 'spendWithGrant', slot: params.slot }) });
    for (const utxo of selected) {
      builder.addInput({ utxo, redeemer: fundRedeemer });
    }
    inlineState(builder, account, control.output.value.coins, next);
    for (const output of params.outputs) {
      builder.sendValue(output);
    }
    const tx = await builder.addSigner(params.grantee).setInvalidAfter(params.validUntilSlot).addScript(account.script).build();
    return { tx, state: next };
  };

  let built = await build(requested);
  for (let round = 0; round < MAX_BALANCING_ROUNDS; round += 1) {
    const actual = leavingBalance(built.tx, account, inputs);
    if (Cometa.deepEqualsPlutusData(encodeAccountState(stateAfterSpend(state, params.slot, actual)), encodeAccountState(built.state))) {
      return built.tx;
    }
    if (round === MAX_BALANCING_ROUNDS - 1) {
      throw new Error('The grant spend did not settle on a fee and state');
    }
    built = await build(actual);
  }
  return built.tx;
};
