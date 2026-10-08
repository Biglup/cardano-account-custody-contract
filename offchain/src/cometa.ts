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

import { createRequire } from 'node:module';
import type * as CometaModule from '@biglup/cometa';

/* CONSTANTS ******************************************************************/

/**
 * The cometa.js library, loaded through its CommonJS build. The ES module
 * build bundles its WebAssembly loader with a dynamic require that Node
 * refuses to run, so every module here imports cometa from this one place.
 * Callers must await `Cometa.ready()` once before using anything else.
 */
export const Cometa: typeof CometaModule = createRequire(import.meta.url)('@biglup/cometa') as typeof CometaModule;
