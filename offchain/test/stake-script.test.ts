import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { accountScript, accountScriptHash, loadBlueprint } from '../src/blueprint.js';
import { Cometa } from '../src/cometa.js';
import { bytes } from '../src/data.js';
import { accountByOwner } from '../src/discovery.js';
import { applyParameters, stakeCredential, stakeScript, stakeScriptHash, stakeValidator } from '../src/stake-script.js';
import { OWNER_PAYMENT_KEY } from './support/account.js';

/**
 * The fixture was produced once with the Aiken CLI from the committed
 * blueprint, applying the owner key hash `aa` repeated 28 times and then
 * the account script hash `0524f57b785cf3a45b7ed6029b387dc39ffb2411bd1cb4300c58c2c3`,
 * each given as the CBOR of its bytes:
 *
 *   aiken blueprint apply -m account_stake -o step1.json 581caaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
 *   aiken blueprint apply -i step1.json -m account_stake -o step2.json 581c0524f57b785cf3a45b7ed6029b387dc39ffb2411bd1cb4300c58c2c3
 *   aiken blueprint hash -i step2.json -m account_stake
 *
 * The hash printed for step2.json is `APPLIED_HASH`, the hash step1.json
 * reports is `OWNER_APPLIED_HASH`, and `APPLIED_CODE_DIGEST` is the
 * SHA-256 digest of the compiled code step2.json carries, which pins
 * the applied bytes without embedding them.
 */
const ACCOUNT_HASH = '0524f57b785cf3a45b7ed6029b387dc39ffb2411bd1cb4300c58c2c3';
const OWNER_APPLIED_HASH = 'b945854c0c29fdd5dbb953792b7ef095a42a546892ad450f0ec8a223';
const APPLIED_HASH = '24b19db325b612942292f5cb144e5eed1335aeb5c39ec45ac588cb4e';
const APPLIED_CODE_DIGEST = '9d3aa8f1c880ebf5c0f2fb32c4b28f7f05ff9839911bce2e272a577d1c7c502a';

const digestOf = (compiledCode: string): string => createHash('sha256').update(bytes(compiledCode)).digest('hex');

describe('stake script', () => {
  const blueprint = loadBlueprint();

  it('loads the parameterised stake validator from the blueprint', () => {
    const validator = stakeValidator(blueprint);
    expect(validator.title.startsWith('account_stake.account_stake.')).toBe(true);
    expect(validator.hash).not.toBe(accountScriptHash(accountScript(blueprint)));
    expect(() => stakeValidator({ preamble: { title: 'x', plutusVersion: 'v3' }, validators: [] })).toThrow(/account_stake/);
  });

  it('applies the owner and the account script hash exactly as the Aiken CLI does', () => {
    const compiledCode = stakeValidator(blueprint).compiledCode;
    const ownerApplied = applyParameters(compiledCode, [bytes(OWNER_PAYMENT_KEY)]);
    expect(Cometa.computeScriptHash({ type: Cometa.ScriptType.Plutus, bytes: ownerApplied, version: Cometa.PlutusLanguageVersion.V3 })).toBe(
      OWNER_APPLIED_HASH,
    );
    const applied = applyParameters(compiledCode, [bytes(OWNER_PAYMENT_KEY), bytes(ACCOUNT_HASH)]);
    expect(applyParameters(ownerApplied, [bytes(ACCOUNT_HASH)])).toBe(applied);
    expect(digestOf(applied)).toBe(APPLIED_CODE_DIGEST);
    expect(Cometa.computeScriptHash({ type: Cometa.ScriptType.Plutus, bytes: applied, version: Cometa.PlutusLanguageVersion.V3 })).toBe(APPLIED_HASH);
  });

  it('leaves the unapplied code as the blueprint reports it', () => {
    const validator = stakeValidator(blueprint);
    expect(applyParameters(validator.compiledCode, [])).toBe(validator.compiledCode);
    expect(stakeScriptHash({ type: Cometa.ScriptType.Plutus, bytes: validator.compiledCode, version: Cometa.PlutusLanguageVersion.V3 })).toBe(
      validator.hash,
    );
  });

  it('derives a per owner stake script whose hash is the account stake credential', () => {
    expect(accountScriptHash(accountScript(blueprint))).toBe(ACCOUNT_HASH);
    const script = stakeScript(OWNER_PAYMENT_KEY, ACCOUNT_HASH, blueprint);
    expect(script.version).toBe(Cometa.PlutusLanguageVersion.V3);
    expect(stakeScriptHash(script)).toBe(APPLIED_HASH);
    expect(stakeScriptHash(stakeScript(OWNER_PAYMENT_KEY, ACCOUNT_HASH))).toBe(APPLIED_HASH);
    expect(stakeScriptHash(stakeScript('bb'.repeat(28), ACCOUNT_HASH, blueprint))).not.toBe(APPLIED_HASH);
    expect(stakeScriptHash(stakeScript(ACCOUNT_HASH, OWNER_PAYMENT_KEY, blueprint))).not.toBe(APPLIED_HASH);
    expect(stakeCredential(APPLIED_HASH)).toEqual({ hash: APPLIED_HASH, type: Cometa.CredentialType.ScriptHash });
    expect(accountByOwner(OWNER_PAYMENT_KEY, blueprint).stakeScriptHash).toBe(APPLIED_HASH);
  });
});
