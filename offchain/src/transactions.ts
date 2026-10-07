import type {
  CoinSelector,
  Datum,
  ExUnits,
  ExUnitsPrices,
  NetworkId,
  PlutusScript,
  ProtocolParameters,
  Provider,
  SlotConfig,
  TransactionBuilder,
  TxEvaluator,
  TxIn,
  TxOut,
  UTxO,
  Value,
  Wallet,
} from '@biglup/cometa';
import { accountAddress, paymentKeyHashOf, stateNftAssetId } from './address.js';
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
} from './data.js';
import {
  compareInputs,
  granteeMessage,
  granteePublicKey,
  grantMessagePartsOf,
  signGrantMessage,
  slotToPosixTime,
  transactionBodyParts,
} from './message.js';
import { DEFAULT_ADA_PER_UTXO_BYTE, minimumUtxoLovelace } from './output.js';
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

/** What every builder needs to know about the account it acts on. */
export interface AccountParams {
  /** The wallet that builds, pays for and signs the transaction. */
  wallet: Wallet;
  /** The stake key hash naming the account. */
  stakeKeyHash: string;
  /** The account script; the blueprint's validator when omitted. */
  script?: PlutusScript;
  /** The network the account address lives on; the testnet when omitted. */
  networkId?: NetworkId;
}

/** Account parameters for builders that must read the account's UTxOs. */
export interface AccountUtxoParams extends AccountParams {
  /** The provider that lists the UTxOs at the account address. */
  provider: Provider;
  /**
   * The least lovelace a fund output returned to the account may hold.
   * When omitted it is the minimum UTxO value of that output, which is
   * higher when the output carries tokens than when it carries lovelace
   * alone.
   */
  minimumChangeLovelace?: bigint;
}

/** Parameters of account creation. */
export interface CreateAccountParams extends AccountParams {
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
}

/** The keys that authorise an agent spend, by grantee kind. */
export type GranteeSigner = { kind: 'ed25519'; keyHash: string } | { kind: 'secp256k1'; privateKey: Uint8Array | string };

/** Parameters of an agent spend. */
export interface SpendWithGrantParams extends AccountUtxoParams {
  slot: bigint;
  outputs: AccountOutput[];
  grantee: GranteeSigner;
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
}

/** The lovelace a freshly created control UTxO carries unless its state needs more. */
export const DEFAULT_CONTROL_LOVELACE = 2_000_000n;

/**
 * The default execution budget of the control UTxO's spend on the agent
 * path. A secp256k1 spend over a small state measures at about 1.36
 * million memory units and 615 million steps, so the budget leaves room
 * for larger states and more inputs, which raise the real cost because
 * the validator serialises the transaction for the grantee message.
 */
export const DEFAULT_CONTROL_EXECUTION_UNITS: ExUnits = { memory: 4_000_000, steps: 2_000_000_000 };

/**
 * The default execution budget of a fund UTxO's spend, which measures at
 * about 211 thousand memory units and 63 million steps.
 */
export const DEFAULT_FUND_EXECUTION_UNITS: ExUnits = { memory: 500_000, steps: 200_000_000 };

/** The most times a grant spend is rebuilt while its fee and state settle. */
const MAX_BALANCING_ROUNDS = 4;

/** A signature sized placeholder that stands in for the grantee's signature while the transaction settles. */
const SIGNATURE_PLACEHOLDER = '00'.repeat(64);

/** The identifiers derived from the script and the stake key hash of an account. */
interface Account {
  script: PlutusScript;
  scriptHash: string;
  stakeKeyHash: string;
  address: string;
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

/** Derives the account identifiers from the builder parameters. */
const resolveAccount = ({ stakeKeyHash, script = accountScript(), networkId = Cometa.NetworkId.Testnet }: AccountParams): Account => {
  const scriptHash = Cometa.computeScriptHash(script);
  return {
    script,
    scriptHash,
    stakeKeyHash,
    address: accountAddress(scriptHash, stakeKeyHash, networkId).toString(),
    nftAssetId: stateNftAssetId(scriptHash, stakeKeyHash),
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
    throw new Error(`An account for stake key hash ${account.stakeKeyHash} already exists at ${account.address}`);
  }
};

/**
 * Builds the transaction that creates an account: it mints the state NFT
 * named after the stake key hash, which the stake key must sign for, and
 * locks it at the account address with the initial state inline. The
 * control output holds the requested lovelace or its minimum UTxO value,
 * whichever is higher, with the wallet paying for it. The validator
 * cannot tell that an account already exists, and a second control UTxO
 * would split the account in two, so when a provider is given creation
 * is refused while a UTxO holding the state NFT sits at the address.
 */
export const createAccount = async (params: CreateAccountParams): Promise<string> => {
  const account = resolveAccount(params);
  const state = assertWellFormed(params.state);
  let adaPerUtxoByte = DEFAULT_ADA_PER_UTXO_BYTE;
  if (params.provider) {
    await assertAccountAbsent(params.provider, account);
    adaPerUtxoByte = adaPerUtxoByteOf(await params.provider.getParameters());
  }
  const builder = await params.wallet.createTransactionBuilder();
  builder.mintToken({ assetIdHex: account.nftAssetId, amount: 1n, redeemer: encodeMintRedeemer({ kind: 'createAccount' }) });
  inlineState(builder, account, controlLovelace(account, params.lovelace ?? DEFAULT_CONTROL_LOVELACE, state, adaPerUtxoByte), state);
  return builder.addSigner(account.stakeKeyHash).addScript(account.script).build();
};

/** Builds a plain transfer to the account address, which anyone can make. */
export const deposit = async (params: AccountParams & { value: Value }): Promise<string> => {
  const account = resolveAccount(params);
  const builder = await params.wallet.createTransactionBuilder();
  return builder.sendValue({ address: account.address, value: params.value }).build();
};

/**
 * Builds an owner transaction: the control UTxO is spent with the device
 * redeemer and recreated with the next state, the fund UTxOs needed for
 * the outputs are spent alongside it with the fund redeemer, and whatever
 * they hold beyond the outputs returns to the account. The wallet pays
 * the fee, funds any lovelace the control output needs beyond what it
 * held once the state has grown, and must hold one of the account's
 * device keys.
 */
const buildDeviceSpend = async (
  params: AccountUtxoParams,
  outputs: AccountOutput[],
  nextState: (state: AccountState) => AccountState,
): Promise<string> => {
  const account = resolveAccount(params);
  const { control, funds, state } = await findAccountUtxos(params.provider, params);
  const device = await deviceOf(params.wallet, state);
  const next = assertWellFormed(nextState(state));
  const adaPerUtxoByte = adaPerUtxoByteOf(await params.provider.getParameters());
  const required = sumOutputs(outputs);
  const { selected, remainder } = selectWithChangeFloor(changeFloor(params, account, adaPerUtxoByte), (minimumChange) =>
    selectFundUtxos(funds, required, minimumChange),
  );
  const builder = await params.wallet.createTransactionBuilder();
  builder.addInput({ utxo: control, redeemer: deviceRedeemer });
  for (const utxo of selected) {
    builder.addInput({ utxo, redeemer: fundRedeemer });
  }
  inlineState(builder, account, controlLovelace(account, control.output.value.coins, next, adaPerUtxoByte), next);
  for (const output of outputs) {
    builder.sendValue(output);
  }
  if (!isZeroBalance(remainder)) {
    builder.sendValue({ address: account.address, value: toValue(remainder) });
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

/**
 * Builds the transaction that retires an account: the control UTxO and
 * every fund UTxO are spent, the state NFT is burned, and what the
 * account held goes to the wallet as change.
 */
export const deleteAccount = async (params: AccountUtxoParams): Promise<string> => {
  const account = resolveAccount(params);
  const { control, funds, state } = await findAccountUtxos(params.provider, params);
  const device = await deviceOf(params.wallet, state);
  const builder = await params.wallet.createTransactionBuilder();
  builder.addInput({ utxo: control, redeemer: deviceRedeemer });
  for (const utxo of funds) {
    builder.addInput({ utxo, redeemer: fundRedeemer });
  }
  return builder
    .mintToken({ assetIdHex: account.nftAssetId, amount: -1n, redeemer: encodeMintRedeemer({ kind: 'deleteAccount' }) })
    .addSigner(device)
    .addScript(account.script)
    .build();
};

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

/** Throws unless the signer holds the key the grant names as its grantee. */
const assertGranteeMatches = (grant: Grant, grantee: GranteeSigner): void => {
  const matches =
    grant.grantee.kind === grantee.kind &&
    (grantee.kind === 'ed25519'
      ? grant.grantee.kind === 'ed25519' && grant.grantee.keyHash === grantee.keyHash
      : grant.grantee.kind === 'secp256k1' && grant.grantee.publicKey === granteePublicKey(grantee.privateKey));
  if (!matches) {
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
 * it. The wallet provides the collateral and, for an Ed25519 grantee, the
 * signature.
 *
 * The fee is part of what leaves, and the recreated state depends on it,
 * so the transaction is rebuilt until the state it carries matches the
 * value that leaves. A secp256k1 grantee then signs the settled body and
 * the transaction is built once more with the signature in the redeemer,
 * which changes nothing the signature covers.
 *
 * The scripts are never evaluated: the validator refuses every draft
 * whose fee differs from the one the state was computed against, and a
 * provider reports that refusal as a failure, so the redeemers carry the
 * fixed budgets instead. The defaults cover a small state; a larger state
 * or more inputs raise the real cost, since the validator serialises the
 * transaction for the grantee message, and the execution units option
 * raises the budgets for them.
 *
 * The scope, recipient and expiry checks mirror the validator's rules so
 * that a spend the validator would refuse never reaches the chain; the
 * unchecked option drops them to build such a spend on purpose, which
 * shows the validator refusing it.
 */
export const spendWithGrant = async (params: SpendWithGrantParams): Promise<string> => {
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

  const build = async (leaving: Balance, signature?: string): Promise<{ tx: string; state: AccountState }> => {
    const violation = params.unchecked ? undefined : scopeViolation(grant.scope, leaving);
    if (violation) {
      throw new Error(`Grant ${grant.slot} refuses the spend: ${violation}`);
    }
    const next = stateAfterSpend(state, params.slot, leaving);
    const builder = await params.wallet.createTransactionBuilder();
    builder.setTxEvaluator(evaluator).setCoinSelector(accountOnlyCoinSelector).setChangeAddress(account.address);
    builder.addInput({
      utxo: control,
      redeemer: encodeAccountRedeemer(
        signature === undefined ? { kind: 'spendWithGrant', slot: params.slot } : { kind: 'spendWithGrant', slot: params.slot, signature },
      ),
    });
    for (const utxo of selected) {
      builder.addInput({ utxo, redeemer: fundRedeemer });
    }
    inlineState(builder, account, control.output.value.coins, next);
    for (const output of params.outputs) {
      builder.sendValue(output);
    }
    if (params.grantee.kind === 'ed25519') {
      builder.addSigner(params.grantee.keyHash);
    }
    const tx = await builder.setInvalidAfter(params.validUntilSlot).addScript(account.script).build();
    return { tx, state: next };
  };

  const placeholder = params.grantee.kind === 'secp256k1' ? SIGNATURE_PLACEHOLDER : undefined;
  let leaving = requested;
  let built = await build(leaving, placeholder);
  for (let round = 0; round < MAX_BALANCING_ROUNDS; round += 1) {
    const actual = leavingBalance(built.tx, account, inputs);
    if (Cometa.deepEqualsPlutusData(encodeAccountState(stateAfterSpend(state, params.slot, actual)), encodeAccountState(built.state))) {
      leaving = actual;
      break;
    }
    if (round === MAX_BALANCING_ROUNDS - 1) {
      throw new Error('The grant spend did not settle on a fee and state');
    }
    leaving = actual;
    built = await build(leaving, placeholder);
  }
  if (params.grantee.kind !== 'secp256k1') {
    return built.tx;
  }
  const message = granteeMessage(grantMessagePartsOf(built.tx, control.input, slotConfig));
  const signature = Cometa.uint8ArrayToHex(signGrantMessage(params.grantee.privateKey, message));
  const signed = await build(leaving, signature);
  const signedMessage = granteeMessage(grantMessagePartsOf(signed.tx, control.input, slotConfig));
  if (Cometa.uint8ArrayToHex(signedMessage) !== Cometa.uint8ArrayToHex(message)) {
    throw new Error('The transaction body changed after the grantee signed it');
  }
  return signed.tx;
};
