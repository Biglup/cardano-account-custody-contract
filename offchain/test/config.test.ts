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

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Cometa } from '../src/cometa.js';
import { DEVNET_NETWORK, ENV_PATH, PREPROD_BASE_URL, PREPROD_NETWORK, isSetupOnly, isWithoutUpgrade, loadRunEnvironment, providerConfiguration } from '../src/config.js';

/* CONSTANTS ******************************************************************/

/** A system start and the slot configuration it stands for. */
const SYSTEM_START = '2026-10-08T10:43:34Z';
const ZERO_TIME = 1791456214000n;

/** The devnet endpoint, environment file and network magic a devnet run takes. */
const DEVNET_BASE_URL = 'http://localhost:8080/api/v1';
const DEVNET_ENV_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'devnet', 'devnet.env');
const DEVNET_NETWORK_MAGIC = Cometa.NetworkMagic.Preprod;

/** The directories a test wrote a genesis into, removed after it. */
const directories: string[] = [];

/* FUNCTIONS ******************************************************************/

/** A loader that records the files it is asked for and puts the given variables of each into the environment it is handed. */
const recordingLoader = (env: NodeJS.ProcessEnv, contents: Record<string, Record<string, string>>) => {
  const loaded: { path: string; override?: boolean }[] = [];
  /** Records the file it is asked for and applies that file's variables. */
  const load = (options: { path: string; override?: boolean }): void => {
    loaded.push(options);
    for (const [name, value] of Object.entries(contents[options.path] ?? {})) {
      if (options.override || env[name] === undefined) {
        env[name] = value;
      }
    }
  };
  return { load, loaded };
};

/** A fresh directory holding a Shelley genesis file, removed after the test. */
const genesisWith = (content: unknown): string => {
  const directory = mkdtempSync(join(tmpdir(), 'custody-devnet-'));
  directories.push(directory);
  const path = join(directory, 'shelley-genesis.json');
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
};

/* TESTS **********************************************************************/

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('loadRunEnvironment', () => {
  it('loads only the devnet environment when the process environment names the devnet', () => {
    const env: NodeJS.ProcessEnv = { CARDANO_NETWORK: DEVNET_NETWORK };
    const { load, loaded } = recordingLoader(env, { [ENV_PATH]: { FUNDING_MNEMONIC: 'preprod words', BLOCKFROST_PREPROD_PROJECT_ID: 'project' }, [DEVNET_ENV_PATH]: { FUNDING_MNEMONIC: 'devnet words' } });
    expect(loadRunEnvironment(load, env)).toBe(DEVNET_NETWORK);
    expect(loaded).toEqual([{ path: DEVNET_ENV_PATH, override: true }]);
    expect(env['FUNDING_MNEMONIC']).toBe('devnet words');
    expect(env['BLOCKFROST_PREPROD_PROJECT_ID']).toBeUndefined();
  });

  it('loads the repository environment for preprod', () => {
    const env: NodeJS.ProcessEnv = {};
    const { load, loaded } = recordingLoader(env, { [ENV_PATH]: { BLOCKFROST_PREPROD_PROJECT_ID: 'project' } });
    expect(loadRunEnvironment(load, env)).toBe(PREPROD_NETWORK);
    expect(loaded).toEqual([{ path: ENV_PATH }]);
    expect(env['BLOCKFROST_PREPROD_PROJECT_ID']).toBe('project');
  });

  it('loads the devnet environment on top when the repository file names the devnet', () => {
    const env: NodeJS.ProcessEnv = {};
    const { load, loaded } = recordingLoader(env, { [ENV_PATH]: { CARDANO_NETWORK: DEVNET_NETWORK, FUNDING_MNEMONIC: 'preprod words' }, [DEVNET_ENV_PATH]: { FUNDING_MNEMONIC: 'devnet words' } });
    expect(loadRunEnvironment(load, env)).toBe(DEVNET_NETWORK);
    expect(loaded).toEqual([{ path: ENV_PATH }, { path: DEVNET_ENV_PATH, override: true }]);
    expect(env['FUNDING_MNEMONIC']).toBe('devnet words');
  });
});

describe('providerConfiguration', () => {
  it('targets preprod with the project id of the environment by default', () => {
    const configuration = providerConfiguration({ BLOCKFROST_PREPROD_PROJECT_ID: 'project' });
    expect(configuration.network).toBe(PREPROD_NETWORK);
    expect(configuration.baseUrl).toBe(PREPROD_BASE_URL);
    expect(configuration.projectId).toBe('project');
    expect(configuration.networkMagic).toBe(Cometa.NetworkMagic.Preprod);
    expect(configuration.slotConfig).toEqual(Cometa.CARDANO_PREPROD_SLOT_CONFIG);
  });

  it('takes the endpoint of the environment over the one of the network', () => {
    const configuration = providerConfiguration({ BLOCKFROST_PREPROD_PROJECT_ID: 'project', PROVIDER_BASE_URL: 'http://elsewhere/api' });
    expect(configuration.baseUrl).toBe('http://elsewhere/api');
  });

  it('refuses preprod without a project id and an unknown network', () => {
    expect(() => providerConfiguration({})).toThrow(/BLOCKFROST_PREPROD_PROJECT_ID is not set/);
    expect(() => providerConfiguration({ CARDANO_NETWORK: 'mainnet' })).toThrow(/is neither preprod nor devnet/);
  });

  it('targets the devnet with no project id and the slot configuration of its chain', () => {
    const path = genesisWith({ systemStart: SYSTEM_START, slotLength: 1 });
    const configuration = providerConfiguration({ CARDANO_NETWORK: DEVNET_NETWORK }, path);
    expect(configuration.network).toBe(DEVNET_NETWORK);
    expect(configuration.baseUrl).toBe(DEVNET_BASE_URL);
    expect(configuration.projectId).toBe('');
    expect(configuration.networkMagic).toBe(DEVNET_NETWORK_MAGIC);
    expect(configuration.slotConfig).toEqual({ zeroTime: ZERO_TIME, zeroSlot: 0n, slotLength: 1000n });
  });

  it('reads a slot length in fractions of a second', () => {
    const path = genesisWith({ systemStart: SYSTEM_START, slotLength: 0.2 });
    expect(providerConfiguration({ CARDANO_NETWORK: DEVNET_NETWORK }, path).slotConfig).toEqual({ zeroTime: ZERO_TIME, zeroSlot: 0n, slotLength: 200n });
  });

  it('refuses the devnet while its chain has not been started', () => {
    const absent = join(tmpdir(), 'custody-devnet-absent', 'shelley-genesis.json');
    expect(() => providerConfiguration({ CARDANO_NETWORK: DEVNET_NETWORK }, absent)).toThrow(/npm run devnet:start/);
  });

  it('refuses a devnet genesis whose start and slot length it cannot read', () => {
    /** Builds the devnet configuration over a genesis holding the given content. */
    const configurationOf = (content: unknown): void => {
      providerConfiguration({ CARDANO_NETWORK: DEVNET_NETWORK }, genesisWith(content));
    };
    expect(() => configurationOf({ epochLength: 300 })).toThrow(/does not record a system start and a slot length/);
    expect(() => configurationOf({ systemStart: 'not a time', slotLength: 1 })).toThrow(/is not a system start time/);
    expect(() => configurationOf({ systemStart: SYSTEM_START, slotLength: 0 })).toThrow(/is not a slot length/);
  });
});

describe('isWithoutUpgrade', () => {
  it('runs the upgrade flows when the environment does not ask to skip them', () => {
    expect(isWithoutUpgrade({})).toBe(false);
    expect(isWithoutUpgrade({ WITHOUT_UPGRADE: ' ' })).toBe(false);
  });

  it('stops before the upgrade flows when the environment asks for it', () => {
    expect(isWithoutUpgrade({ WITHOUT_UPGRADE: '1' })).toBe(true);
    expect(isWithoutUpgrade({ WITHOUT_UPGRADE: ' True ' })).toBe(true);
  });

  it('refuses a value it cannot read rather than running every flow', () => {
    expect(() => isWithoutUpgrade({ WITHOUT_UPGRADE: 'no' })).toThrow(/WITHOUT_UPGRADE is no, which is none of 1, true/);
  });
});

describe('isSetupOnly', () => {
  it('runs everything when the environment does not ask for the setup alone', () => {
    expect(isSetupOnly({})).toBe(false);
    expect(isSetupOnly({ SETUP_ONLY: '' })).toBe(false);
    expect(isSetupOnly({ SETUP_ONLY: '  ' })).toBe(false);
  });

  it('stops after the setup when the environment asks for it', () => {
    expect(isSetupOnly({ SETUP_ONLY: '1' })).toBe(true);
    expect(isSetupOnly({ SETUP_ONLY: 'true' })).toBe(true);
    expect(isSetupOnly({ SETUP_ONLY: ' TRUE ' })).toBe(true);
  });

  it('refuses a value it cannot read rather than running every flow', () => {
    expect(() => isSetupOnly({ SETUP_ONLY: '0' })).toThrow(/SETUP_ONLY is 0, which is none of 1, true/);
    expect(() => isSetupOnly({ SETUP_ONLY: 'yes' })).toThrow(/which is none of 1, true/);
  });
});
