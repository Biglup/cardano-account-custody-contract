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

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PlutusScript } from '@biglup/cometa';
import { type Blueprint, loadBlueprint, logicValidator } from '../src/blueprint.js';
import { logicScript } from '../src/logic.js';

/* CONSTANTS ******************************************************************/

/**
 * The blueprint of the throwaway second logic, committed by the fixture
 * project that builds it. It is a second file on purpose: the shipped
 * blueprint carries only the scripts accounts run, and nothing that reads
 * it can mistake the fixture for one of them.
 */
export const FIXTURE_BLUEPRINT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'upgrade-logic', 'plutus.json');

/* FUNCTIONS ******************************************************************/

/**
 * The fixture project's blueprint, read from the file above, which the
 * fixture project commits as this repository commits its own. A missing
 * file names itself and the build that writes it rather than failing as a
 * missing path.
 */
export const loadFixtureBlueprint = (): Blueprint => {
  if (!existsSync(FIXTURE_BLUEPRINT_PATH)) {
    throw new Error(`${FIXTURE_BLUEPRINT_PATH} is missing: run aiken build in fixtures/upgrade-logic to write the blueprint of the upgrade fixture`);
  }
  return loadBlueprint(FIXTURE_BLUEPRINT_PATH);
};

/**
 * The throwaway second logic applied to the proxy hash, which the upgrade
 * proof moves an account to. No account of the contract runs it, so the
 * builders are given it alongside the blueprint rather than finding it in
 * one.
 */
export const fixtureLogicScript = (proxyHash: string): PlutusScript => logicScript(logicValidator(loadFixtureBlueprint()), proxyHash);
