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
 *
 * The devnet store speaks the Blockfrost shapes for everything the library
 * and the runs need except the answers below, where it differs from the
 * hosted API in ways the clients notice. This service sits in front of it,
 * passes every request through and corrects only those answers. It also
 * folds repeated slashes in a path, which the hosted API accepts and the
 * clients produce when they join a base URL to a path.
 *
 * Where its answers still differ from the hosted API: a pool answered
 * under /pools/{id} carries an empty retirement list and the maximum
 * supply as its live and active stake, since the store keeps neither; a
 * credential whose registrations are all undone answers 404 where the
 * hosted API answers the account with active false; and the stake
 * registrations and deregistrations are read without pagination, which
 * holds for the fresh chain of a devnet run and not for a long one.
 */

/* IMPORTS ********************************************************************/

import { createServer } from 'node:http';

/* CONSTANTS ******************************************************************/

/** Where the devnet store listens and where this service listens. */
const STORE_URL = process.env['STORE_URL'] ?? 'http://localhost:8081';
const PORT = Number(process.env['PORT'] ?? 8080);

/** The paths this service corrects the answer of. */
const PARAMETERS = /^\/api\/v1\/epochs\/(latest|\d+)\/parameters$/;
const ACCOUNT = /^\/api\/v1\/accounts\/(stake[^/]*)$/;
const METADATA_CBOR = /^\/api\/v1\/txs\/([0-9a-fA-F]{64})\/metadata\/cbor$/;
const POOLS = /^\/api\/v1\/pools(\?.*)?$/;
const POOL = /^\/api\/v1\/pools\/([^/?]+)$/;
const EVALUATE = /^\/api\/v1\/utils\/txs\/evaluate(\/utxos)?$/;

/**
 * The script purposes the devnet evaluator names a redeemer by, as the
 * hosted API names them. A client matches an evaluation to the redeemer
 * of its transaction by this name, so a certificate or a withdrawal
 * would otherwise keep the budget it was built with.
 */
const PURPOSE_NAMES = { publish: 'certificate', withdraw: 'withdrawal' };

/** The headers of a JSON answer of this service. */
const JSON_HEADERS = { 'content-type': 'application/json' };

/** The bech32 alphabet and the generator of its checksum, which pool ids are encoded with. */
const BECH32_ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

/* FUNCTIONS ******************************************************************/

/** The bech32 checksum step over one value. */
const polymodStep = (value) => {
  const top = value >> 25;
  let next = (value & 0x1ffffff) << 5;
  for (let bit = 0; bit < 5; bit += 1) {
    next ^= (top >> bit) & 1 ? BECH32_GENERATOR[bit] : 0;
  }
  return next;
};

/** Bytes as the five bit groups bech32 encodes. */
const toFiveBits = (bytes) => {
  const groups = [];
  let accumulator = 0;
  let bits = 0;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      groups.push((accumulator >> bits) & 31);
    }
  }
  if (bits > 0) {
    groups.push((accumulator << (5 - bits)) & 31);
  }
  return groups;
};

/** A hex string as bech32 under a prefix, which is how the hosted API names a pool. */
const toBech32 = (prefix, hex) => {
  const groups = toFiveBits(Buffer.from(hex, 'hex'));
  let checksum = 1;
  for (const character of prefix) {
    checksum = polymodStep(checksum) ^ (character.charCodeAt(0) >> 5);
  }
  checksum = polymodStep(checksum);
  for (const character of prefix) {
    checksum = polymodStep(checksum) ^ (character.charCodeAt(0) & 31);
  }
  for (const group of groups) {
    checksum = polymodStep(checksum) ^ group;
  }
  for (let round = 0; round < 6; round += 1) {
    checksum = polymodStep(checksum);
  }
  checksum ^= 1;
  const digits = [...groups];
  for (let position = 0; position < 6; position += 1) {
    digits.push((checksum >> (5 * (5 - position))) & 31);
  }
  return `${prefix}1${digits.map((digit) => BECH32_ALPHABET[digit]).join('')}`;
};

/** The store's answer to a path, as its status and its parsed body. */
const fromStore = async (path, init) => {
  const response = await fetch(`${STORE_URL}${path}`, init);
  const text = await response.text();
  let body;
  try {
    body = text.length === 0 ? undefined : JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: response.status, text, body, contentType: response.headers.get('content-type') };
};

/**
 * The protocol parameters with the minimum UTxO cost under the name the
 * hosted API also answers with, which is the one the clients read.
 */
const parameters = async (path) => {
  const answer = await fromStore(path);
  if (answer.status !== 200 || !answer.body) {
    return answer;
  }
  return { status: 200, body: { ...answer.body, coins_per_utxo_word: String(answer.body.coins_per_utxo_size) } };
};

/**
 * A reward account with its amounts as strings and with the registration
 * flag, which the store does not answer with. A credential the chain has
 * no registration certificate for is not an account at all, as on the
 * hosted API.
 */
const account = async (path, stakeAddress) => {
  const answer = await fromStore(path);
  if (answer.status !== 200 || !answer.body) {
    return { status: 404, body: { status_code: 404, error: 'Not Found', message: 'The requested component has not been found.' } };
  }
  const registrations = (await fromStore('/api/v1/stake/registrations')).body ?? [];
  const deregistrations = (await fromStore('/api/v1/stake/deregistrations')).body ?? [];
  const registered = registrations.filter((entry) => entry.address === stakeAddress).length;
  const deregistered = deregistrations.filter((entry) => entry.address === stakeAddress).length;
  if (registered <= deregistered) {
    return { status: 404, body: { status_code: 404, error: 'Not Found', message: 'The requested component has not been found.' } };
  }
  const { withdrawable_amount: withdrawable, controlled_amount: controlled, ...rest } = answer.body;
  return {
    status: 200,
    body: { ...rest, active: true, controlled_amount: String(controlled ?? 0), withdrawable_amount: String(withdrawable ?? 0) },
  };
};

/**
 * The metadata of a transaction, answered as not found while the chain
 * holds no such transaction. The store answers an empty list for any hash,
 * which the clients read as the transaction being confirmed.
 */
const metadataCbor = async (path, txId) => {
  const transaction = await fromStore(`/api/v1/txs/${txId}`);
  if (transaction.status !== 200) {
    return { status: 404, body: { status_code: 404, error: 'Not Found', message: 'The requested component has not been found.' } };
  }
  return fromStore(path);
};

/** The pool ids the chain has registrations for, which the store only answers under another path. */
const pools = async () => {
  const registrations = (await fromStore('/api/v1/pools/registrations')).body ?? [];
  return { status: 200, body: [...new Set(registrations.map((entry) => toBech32('pool', entry.pool_id)))] };
};

/** One pool, as the runs read it: not retiring and holding live stake. */
const pool = async (poolId) => {
  const registrations = (await fromStore('/api/v1/pools/registrations')).body ?? [];
  const registration = registrations.find((entry) => toBech32('pool', entry.pool_id) === poolId);
  if (!registration) {
    return { status: 404, body: { status_code: 404, error: 'Not Found', message: 'The requested component has not been found.' } };
  }
  const total = (await fromStore('/api/v1/network')).body?.supply?.max ?? '1';
  return { status: 200, body: { pool_id: poolId, retirement: [], live_stake: String(total), active_stake: String(total) } };
};

/** An evaluation with every redeemer named by the script purpose the hosted API names it by. */
const evaluate = async (path, requestBody, contentType) => {
  const answer = await fromStore(path, { method: 'POST', body: requestBody, headers: { 'content-type': contentType ?? 'application/json' } });
  const evaluation = answer.body?.result?.EvaluationResult;
  if (answer.status >= 300 || !evaluation) {
    return answer;
  }
  const renamed = {};
  for (const [key, units] of Object.entries(evaluation)) {
    const [purpose, index] = key.split(':');
    renamed[`${PURPOSE_NAMES[purpose] ?? purpose}:${index}`] = units;
  }
  return { status: answer.status, body: { ...answer.body, result: { EvaluationResult: renamed } } };
};

/** The answer this service gives to a request, correcting the store's where it must. */
const answer = async (method, path, requestBody, contentType) => {
  if (method === 'GET') {
    const parametersMatch = PARAMETERS.exec(path);
    if (parametersMatch) {
      return parameters(path);
    }
    const accountMatch = ACCOUNT.exec(path);
    if (accountMatch) {
      return account(path, accountMatch[1]);
    }
    const metadataMatch = METADATA_CBOR.exec(path);
    if (metadataMatch) {
      return metadataCbor(path, metadataMatch[1]);
    }
    if (POOLS.test(path)) {
      return pools();
    }
    const poolMatch = POOL.exec(path);
    if (poolMatch) {
      return pool(poolMatch[1]);
    }
  }
  if (method === 'POST' && EVALUATE.test(path)) {
    return evaluate(path, requestBody, contentType);
  }
  return fromStore(path, { method, body: requestBody.length === 0 ? undefined : requestBody, headers: { 'content-type': contentType ?? 'application/json' } });
};

/** Reads the whole body of a request. */
const readBody = (request) =>
  new Promise((done, failed) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => done(Buffer.concat(chunks)));
    request.on('error', failed);
  });

/* MAIN ***********************************************************************/

createServer(async (request, response) => {
  try {
    const body = await readBody(request);
    const path = (request.url ?? '/').replace(/\/{2,}/g, '/');
    const result = await answer(request.method ?? 'GET', path, body, request.headers['content-type']);
    if (result.body !== undefined) {
      response.writeHead(result.status, JSON_HEADERS).end(JSON.stringify(result.body));
      return;
    }
    response.writeHead(result.status, result.contentType ? { 'content-type': result.contentType } : {}).end(result.text ?? '');
  } catch (error) {
    response.writeHead(502, JSON_HEADERS).end(JSON.stringify({ status_code: 502, error: 'Bad Gateway', message: String(error) }));
  }
}).listen(PORT, () => console.log(`Blockfrost compatibility in front of ${STORE_URL} on port ${PORT}`));
