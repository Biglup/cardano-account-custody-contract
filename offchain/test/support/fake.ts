import type {
  Address,
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
import { stakeKeyHashOf, toAddress } from '../../src/address.js';
import { Cometa } from '../../src/cometa.js';
import { decodeAccountRedeemer, decodeAccountState, encodeAccountState } from '../../src/data.js';
import { type ValidityRange, transactionBodyParts, upperBoundTime, withoutCborCache } from '../../src/message.js';
import { findGrant, scopeViolation, stateAfterSpend } from '../../src/state.js';
import { type Balance, LOVELACE_ASSET_ID, addBalances, quantityOf, subtractBalances, toBalance } from '../../src/value.js';

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

/** The bech32 form of an address, used to key the canned UTxOs. */
const addressKey = (address: Address | string): string => (typeof address === 'string' ? address : address.toString());

/** The asset id of the state NFT an account address's control UTxO holds, when the address is a script base address. */
const stateNftOf = (address: string): string | undefined => {
  const payment = toAddress(address).asBase()?.getPaymentCredential();
  const stakeKeyHash = stakeKeyHashOf(address);
  return payment?.type === Cometa.CredentialType.ScriptHash && stakeKeyHash !== undefined ? `${payment.hash}${stakeKeyHash}` : undefined;
};

/**
 * A provider serving canned UTxOs per address and fixed execution units.
 * Evaluation models the checks of the validator's agent path that a
 * built transaction can break: the validity range must end before the
 * grant expires, what leaves the account must stay within the grant's
 * scope, every output away from the account must go to a recipient, and
 * the control UTxO must be recreated with the state after the value the
 * draft lets leave, fee included. A draft that fails a check is refused
 * the way a network provider refuses a transaction whose scripts fail.
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
    for (const redeemer of redeemers.filter((candidate) => candidate.purpose === Cometa.RedeemerPurpose.spend)) {
      const input = parts.inputs[redeemer.index];
      const utxo = spent.find((candidate) => candidate.input.txId === input?.txId && candidate.input.index === input.index);
      const failure = utxo && this.grantSpendFailure(utxo, redeemer.data, spent, parts.outputs, parts.validityRange);
      if (failure) {
        this.phaseTwoFailures.push(failure);
        throw new Error(failure);
      }
    }
    return redeemers.map((redeemer) => ({ ...redeemer, executionUnits: FAKE_EXECUTION_UNITS }));
  }

  /** Why a control UTxO spent with the grant redeemer breaks the agent path as the validator checks it, or undefined when it passes. */
  private grantSpendFailure(
    control: UTxO,
    redeemerData: PlutusData,
    spent: UTxO[],
    outputs: TxOut[],
    validityRange: ValidityRange,
  ): string | undefined {
    const nftAssetId = stateNftOf(control.output.address);
    const redeemer = decodeAccountRedeemer(redeemerData);
    if (nftAssetId === undefined || redeemer.kind !== 'spendWithGrant' || control.output.datum === undefined) {
      return undefined;
    }
    const address = control.output.address;
    const state = decodeAccountState(control.output.datum);
    const grant = findGrant(state, redeemer.slot);
    if (!grant) {
      return `The account has no grant in slot ${redeemer.slot}`;
    }
    const ends = upperBoundTime(validityRange);
    if (ends === undefined || ends > grant.scope.expiresAt) {
      return `The validity range ends after grant ${grant.slot} expires`;
    }
    const leaving: Balance = subtractBalances(
      addBalances(...spent.filter((utxo) => utxo.output.address === address).map((utxo) => toBalance(utxo.output.value))),
      addBalances(...outputs.filter((output) => output.address === address).map((output) => toBalance(output.value))),
    );
    const violation = scopeViolation(grant.scope, leaving);
    if (violation) {
      return `Grant ${grant.slot} refuses the spend: ${violation}`;
    }
    const stranger = outputs.find(
      (output) => output.address !== address && grant.scope.recipients.length > 0 && !grant.scope.recipients.includes(output.address),
    );
    if (stranger) {
      return `${stranger.address} is not a recipient of grant ${grant.slot}`;
    }
    const expected = encodeAccountState(stateAfterSpend(state, redeemer.slot, leaving));
    const recreated = outputs.find((output) => output.address === address && output.value.assets?.[nftAssetId] === 1n);
    if (recreated?.datum === undefined) {
      return 'The control UTxO is not recreated with an inline datum';
    }
    return Cometa.deepEqualsPlutusData(withoutCborCache(recreated.datum), expected)
      ? undefined
      : `The control output datum does not carry the state after a spend of ${quantityOf(leaving, LOVELACE_ASSET_ID)} lovelace`;
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

/** A wallet whose builders keep the provider's evaluator whatever evaluator they are told to use. */
export class ProviderEvaluatedWallet extends FakeWallet {
  override async createTransactionBuilder(): Promise<TransactionBuilder> {
    const builder = await super.createTransactionBuilder();
    builder.setTxEvaluator = () => builder;
    return builder;
  }
}

/** A UTxO at a fictitious earlier transaction. */
export const utxo = (txId: string, index: number, address: string, value: Value, datum?: PlutusData): UTxO => ({
  input: { txId, index },
  output: datum === undefined ? { address, value } : { address, value, datum },
});
