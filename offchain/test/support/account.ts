import type { PlutusData, UTxO, Value } from '@biglup/cometa';
import { accountAddress, rewardAddress, stateNftAssetId } from '../../src/address.js';
import { accountScript, accountScriptHash } from '../../src/blueprint.js';
import { Cometa } from '../../src/cometa.js';
import { transactionBodyParts } from '../../src/body.js';
import { type AccountState, type Scope, encodeAccountState } from '../../src/data.js';
import { stakeScript, stakeScriptHash } from '../../src/stake-script.js';
import { FakeProvider, FakeWallet, utxo } from './fake.js';

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

/** The scripts and derived identifiers of the account under test, whose owner is the owner wallet's payment key. */
export const script = accountScript();
export const scriptHash = accountScriptHash(script);
export const ownerStakeScript = stakeScript(OWNER_PAYMENT_KEY, scriptHash);
export const ownerStakeScriptHash = stakeScriptHash(ownerStakeScript);
export const nftAssetId = stateNftAssetId(scriptHash, ownerStakeScriptHash);
export const address = accountAddress(scriptHash, ownerStakeScriptHash).toString();
export const ownerRewardAddress = rewardAddress(ownerStakeScriptHash).toBech32();

/** A key address outside the account, usable as a destination. */
export const enterpriseAddress = (keyHash: string): string =>
  Cometa.EnterpriseAddress.fromCredentials(Cometa.NetworkId.Testnet, { hash: keyHash, type: Cometa.CredentialType.KeyHash })
    .toAddress()
    .toString();

/** The destination the fixture grants allow. */
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

/** The state of a freshly created account. */
export const initialState: AccountState = { devices: [OWNER_PAYMENT_KEY], grants: [], grantGeneration: 0n };

/** A state holding a lovelace grant, a token grant and a restricted lovelace grant, all held by the agent key. */
export const grantedState: AccountState = {
  devices: [OWNER_PAYMENT_KEY],
  grants: [
    { slot: 0n, grantee: AGENT_PAYMENT_KEY, scope: lovelaceScope() },
    { slot: 1n, grantee: AGENT_PAYMENT_KEY, scope: tokenScope([recipientAddress]) },
    { slot: 2n, grantee: AGENT_PAYMENT_KEY, scope: lovelaceScope([recipientAddress]) },
  ],
  grantGeneration: 0n,
};

/** The control UTxO of the account under test, carrying a state inline. */
export const controlUtxo = (state: AccountState, index = 0): UTxO =>
  utxo('11'.repeat(32), index, address, { coins: CONTROL_LOVELACE, assets: { [nftAssetId]: 1n } }, encodeAccountState(state));

/** A deposit UTxO at the account address. */
export const fundUtxo = (index: number, value: Value): UTxO => utxo('22'.repeat(32), index, address, value);

/** A provider holding the owner, agent and sponsor wallets' funds and the account's UTxOs. */
export interface Scenario {
  provider: FakeProvider;
  owner: FakeWallet;
  agent: FakeWallet;
  sponsor: FakeWallet;
}

/** The transaction ids of the UTxOs each wallet holds in a scenario. */
export const OWNER_UTXO_TX = '33'.repeat(32);
export const AGENT_UTXO_TX = '44'.repeat(32);
export const SPONSOR_UTXO_TX = '55'.repeat(32);

/** A funded owner, agent and sponsor wallet plus the account's UTxOs, served by one fake provider. */
export const scenario = (state: AccountState | undefined, funds: UTxO[]): Scenario => {
  const provider = new FakeProvider();
  const owner = new FakeWallet(provider, OWNER_PAYMENT_KEY, OWNER_STAKE_KEY);
  const agent = new FakeWallet(provider, AGENT_PAYMENT_KEY, AGENT_STAKE_KEY);
  const sponsor = new FakeWallet(provider, SPONSOR_PAYMENT_KEY, SPONSOR_STAKE_KEY);
  provider.addUtxo(utxo(OWNER_UTXO_TX, 0, owner.address.toString(), { coins: 50_000_000n }));
  provider.addUtxo(utxo(AGENT_UTXO_TX, 0, agent.address.toString(), { coins: 20_000_000n }));
  provider.addUtxo(utxo(SPONSOR_UTXO_TX, 0, sponsor.address.toString(), { coins: 60_000_000n }));
  if (state) {
    provider.addUtxo(controlUtxo(state));
  }
  for (const fund of funds) {
    provider.addUtxo(fund);
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
