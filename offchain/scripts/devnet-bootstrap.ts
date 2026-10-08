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

import { randomBytes } from 'node:crypto';
import type { Provider, Wallet } from '@biglup/cometa';
import { config as loadEnv } from 'dotenv';
import { Cometa } from '../src/cometa.js';
import { DEVNET_NETWORK, loadRunEnvironment, providerConfiguration } from '../src/config.js';
import { MINIMUM_FUNDING_LOVELACE } from './flow-plan.js';

/* CONSTANTS ******************************************************************/

/** The lovelace in one ADA and what the bootstrap moves to the funding wallet, enough for every flow of a run. */
const LOVELACE = 1_000_000n;
const BOOTSTRAP_LOVELACE = 9_000n * LOVELACE;

/** How long the bootstrap waits for the faucet payment and for the transaction it then makes. */
const WAIT_TIMEOUT_MS = 120_000;
const WAIT_POLL_MS = 250;

/** The lovelace of the plain transaction the bootstrap confirms to show the devnet accepts one. */
const PROBE_LOVELACE = 5n * LOVELACE;

/** The password cometa encrypts the derived keys with, fresh for every process. */
const password = randomBytes(32);

/* FUNCTIONS ******************************************************************/

/** Hands cometa a copy of the password, since it wipes what it is given after use. */
const getPassword = (): Promise<Uint8Array> => Promise.resolve(new Uint8Array(password));

/** Sleeps for a number of milliseconds. */
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** A single address wallet of one account of the funding mnemonic. */
const walletOf = (provider: Provider, mnemonics: string[], account: number): Promise<Wallet> =>
  Cometa.SingleAddressWallet.createFromMnemonics({
    mnemonics,
    provider,
    getPassword,
    credentialsConfig: { account, paymentIndex: 0, stakingIndex: 0 },
  });

/** The words of a mnemonic the environment holds under a name. */
const mnemonicOf = (name: string): string[] => {
  const words = (process.env[name] ?? '').trim().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) {
    throw new Error(`${name} is not set in the devnet environment`);
  }
  return words;
};

/** Signs a transaction with a wallet and submits it through the provider, returning the transaction id. */
const submit = async (wallet: Wallet, tx: string): Promise<string> =>
  wallet.submitTransaction(Cometa.applyVkeyWitnessSet(tx, await wallet.signTransaction(tx, true)));

/** Polls until the provider reports at least an amount of lovelace at an address. */
const waitForBalance = async (provider: Provider, address: string, lovelace: bigint): Promise<bigint> => {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  for (;;) {
    const balance = (await provider.getUnspentOutputs(address)).reduce((total, utxo) => total + utxo.output.value.coins, 0n);
    if (balance >= lovelace) {
      return balance;
    }
    if (Date.now() >= deadline) {
      throw new Error(`The devnet never reported ${lovelace} lovelace at ${address}`);
    }
    await sleep(WAIT_POLL_MS);
  }
};

/** Polls until the provider lists an output of a transaction at an address, and returns how long it took. */
const waitForTransaction = async (provider: Provider, address: string, txId: string): Promise<number> => {
  const started = Date.now();
  const deadline = started + WAIT_TIMEOUT_MS;
  for (;;) {
    if ((await provider.getUnspentOutputs(address)).some((utxo) => utxo.input.txId === txId)) {
      return Date.now() - started;
    }
    if (Date.now() >= deadline) {
      throw new Error(`The devnet never listed an output of ${txId} at ${address}`);
    }
    await sleep(WAIT_POLL_MS);
  }
};

/* MAIN ***********************************************************************/

const main = async (): Promise<void> => {
  const network = loadRunEnvironment(loadEnv as (options: { path: string; override?: boolean }) => unknown);
  if (network !== DEVNET_NETWORK) {
    throw new Error(`The bootstrap only runs against the devnet; CARDANO_NETWORK is ${network}`);
  }
  await Cometa.ready();
  const { baseUrl, networkMagic, projectId } = providerConfiguration();
  const provider = new Cometa.BlockfrostProvider({ network: networkMagic, projectId, baseUrl });
  const mnemonics = mnemonicOf('FUNDING_MNEMONIC');
  const funding = await walletOf(provider, mnemonics, 0);
  const fundingAddress = (await funding.getChangeAddress()).toString();
  console.log(`Funding address: ${fundingAddress}`);

  const parameters = await provider.getParameters();
  console.log(`Protocol version ${parameters.protocolVersion.major}.${parameters.protocolVersion.minor}, ${parameters.adaPerUtxoByte} lovelace per UTxO byte`);

  const held = (await provider.getUnspentOutputs(fundingAddress)).reduce((total, utxo) => total + utxo.output.value.coins, 0n);
  if (held < MINIMUM_FUNDING_LOVELACE) {
    const genesis = await walletOf(provider, mnemonicOf('DEVNET_GENESIS_MNEMONIC'), 0);
    const payment = await (await genesis.createTransactionBuilder()).sendLovelace({ address: fundingAddress, amount: BOOTSTRAP_LOVELACE }).build();
    await submit(genesis, payment);
    const balance = await waitForBalance(provider, fundingAddress, MINIMUM_FUNDING_LOVELACE);
    console.log(`The genesis wallet filled the funding wallet to ${balance} lovelace`);
  } else {
    console.log(`The funding wallet already holds ${held} lovelace`);
  }

  const probe = await walletOf(provider, mnemonics, 1);
  const probeAddress = (await probe.getChangeAddress()).toString();
  const builder = await funding.createTransactionBuilder();
  const tx = await builder.sendLovelace({ address: probeAddress, amount: PROBE_LOVELACE }).build();
  const submitted = Date.now();
  const txId = await submit(funding, tx);
  const waited = await waitForTransaction(provider, probeAddress, txId);
  console.log(`Confirmed ${txId} in ${waited} ms, ${Date.now() - submitted} ms from the build`);
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
