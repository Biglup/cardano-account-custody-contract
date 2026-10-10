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

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BASELINE_PATH,
  BUDGET_PREFIX,
  type Baseline,
  type CheckReport,
  type ReportedTest,
  budgetRefusals,
  budgetsOf,
  formatBaseline,
  gate,
  loadBaseline,
  tracingTests,
} from '../scripts/budget-gate.js';

/* CONSTANTS ******************************************************************/

/** A recorded baseline of two budget tests. */
const BASELINE: Baseline = { budget_a: { mem: 1000, cpu: 2000 }, budget_b: { mem: 500, cpu: 800 } };

/* FUNCTIONS ******************************************************************/

/** A unit test as the report lists it: passed, expected to pass and without traces, unless the rest says otherwise. */
const passing = (title: string, mem: number, cpu: number, rest: Partial<ReportedTest> = {}): ReportedTest => ({
  title,
  status: 'pass',
  on_failure: 'fail_immediately',
  traces: null,
  execution_units: { mem, cpu },
  ...rest,
});

/** A report of one module holding the given tests. */
const reportOf = (...tests: ReportedTest[]): CheckReport => ({ modules: [{ name: 'attacks.test', tests }] });

/* TESTS **********************************************************************/

describe('budgetsOf', () => {
  it('records the execution units of the budget tests and nothing else', () => {
    const report = reportOf(passing('budget_a', 1, 2), passing('attack_a', 3, 4), passing('budget_b', 5, 6));
    expect(budgetsOf(report)).toEqual({ budget_a: { mem: 1, cpu: 2 }, budget_b: { mem: 5, cpu: 6 } });
  });

  it('reads every module of the report', () => {
    const report: CheckReport = {
      modules: [
        { name: 'account.test', tests: [passing('budget_a', 1, 2)] },
        { name: 'attacks.test', tests: [passing('budget_b', 3, 4)] },
      ],
    };
    expect(Object.keys(budgetsOf(report))).toEqual(['budget_a', 'budget_b']);
  });

  it('refuses a budget test that did not pass', () => {
    expect(() => budgetsOf(reportOf(passing('budget_a', 1, 2, { status: 'fail' })))).toThrow('budget_a did not pass');
  });

  it('refuses a budget test that reports no execution units', () => {
    const property: ReportedTest = { title: 'budget_a', status: 'pass', on_failure: 'fail_immediately' };
    expect(() => budgetsOf(reportOf(property))).toThrow('budget_a reports no execution units');
  });
});

describe('tracingTests', () => {
  it('names a test that is expected to pass and carries a trace', () => {
    const report = reportOf(passing('prints', 1, 2, { traces: ['hello'] }), passing('quiet', 1, 2));
    expect(tracingTests(report)).toEqual(['prints']);
  });

  it('leaves a test that is expected to fail with the message of its crash', () => {
    const report = reportOf(passing('crashes', 1, 2, { on_failure: 'succeed_eventually', traces: ['the validator crashed / exited prematurely'] }));
    expect(tracingTests(report)).toEqual([]);
  });

  it('leaves a test without traces, whether the report lists none or an empty list', () => {
    const report = reportOf(passing('none', 1, 2, { traces: null }), passing('empty', 1, 2, { traces: [] }), { title: 'absent', status: 'pass', on_failure: 'fail_immediately' });
    expect(tracingTests(report)).toEqual([]);
  });
});

describe('budgetRefusals', () => {
  it('holds a run whose figures match the baseline', () => {
    expect(budgetRefusals(BASELINE, BASELINE)).toEqual([]);
  });

  it('holds a figure one percent above its record and nothing beyond', () => {
    expect(budgetRefusals(BASELINE, { ...BASELINE, budget_a: { mem: 1010, cpu: 2020 } })).toEqual([]);
    expect(budgetRefusals(BASELINE, { ...BASELINE, budget_a: { mem: 1011, cpu: 2000 } })).toEqual(['budget_a mem 1011 exceeds the recorded 1000 by more than 1 percent']);
    expect(budgetRefusals(BASELINE, { ...BASELINE, budget_a: { mem: 1000, cpu: 2021 } })).toEqual(['budget_a cpu 2021 exceeds the recorded 2000 by more than 1 percent']);
  });

  it('holds a figure below its record', () => {
    expect(budgetRefusals(BASELINE, { ...BASELINE, budget_b: { mem: 1, cpu: 1 } })).toEqual([]);
  });

  it('takes the tolerance it is given', () => {
    expect(budgetRefusals(BASELINE, { ...BASELINE, budget_a: { mem: 1100, cpu: 2000 } }, 0.1)).toEqual([]);
    expect(budgetRefusals(BASELINE, { ...BASELINE, budget_a: { mem: 1001, cpu: 2000 } }, 0)).toEqual(['budget_a mem 1001 exceeds the recorded 1000 by more than 0 percent']);
  });

  it('refuses a recorded test that is not among the measured ones', () => {
    expect(budgetRefusals(BASELINE, { budget_a: { mem: 1000, cpu: 2000 } })).toEqual(['budget_b is recorded in the baseline and is not among the tests']);
  });

  it('refuses a measured test that is not recorded', () => {
    expect(budgetRefusals(BASELINE, { ...BASELINE, budget_c: { mem: 1, cpu: 1 } })).toEqual(['budget_c is not recorded in the baseline']);
  });

  it('lists the refusals in baseline order, then the unrecorded tests', () => {
    const measured: Baseline = { budget_c: { mem: 1, cpu: 1 }, budget_b: { mem: 600, cpu: 900 }, budget_a: { mem: 2000, cpu: 2000 } };
    expect(budgetRefusals(BASELINE, measured)).toEqual([
      'budget_a mem 2000 exceeds the recorded 1000 by more than 1 percent',
      'budget_b mem 600 exceeds the recorded 500 by more than 1 percent',
      'budget_b cpu 900 exceeds the recorded 800 by more than 1 percent',
      'budget_c is not recorded in the baseline',
    ]);
  });
});

describe('gate', () => {
  it('holds a quiet run within the baseline', () => {
    expect(gate(reportOf(passing('budget_a', 1000, 2000), passing('budget_b', 500, 800), passing('attack_a', 9, 9)), BASELINE)).toEqual([]);
  });

  it('names the tests that print before the budgets that do not hold', () => {
    const report = reportOf(passing('budget_a', 1000, 2000), passing('budget_b', 600, 800), passing('attack_a', 9, 9, { traces: ['debug'] }));
    expect(gate(report, BASELINE)).toEqual(['attack_a prints: it carries a trace', 'budget_b mem 600 exceeds the recorded 500 by more than 1 percent']);
  });
});

describe('formatBaseline', () => {
  it('writes one line per test, sorted by title, and ends the file with a newline', () => {
    expect(formatBaseline({ budget_b: { mem: 500, cpu: 800 }, budget_a: { mem: 1000, cpu: 2000 } })).toBe(
      '{\n  "budget_a": { "mem": 1000, "cpu": 2000 },\n  "budget_b": { "mem": 500, "cpu": 800 }\n}\n',
    );
  });

  it('round trips through JSON', () => {
    expect(JSON.parse(formatBaseline(BASELINE))).toEqual(BASELINE);
  });
});

describe('the committed baseline', () => {
  it('records budget tests only, with positive figures, in the written form', () => {
    const baseline = loadBaseline();
    const titles = Object.keys(baseline);
    expect(titles.length).toBeGreaterThan(0);
    for (const title of titles) {
      expect(title.startsWith(BUDGET_PREFIX)).toBe(true);
      expect(Number.isInteger(baseline[title]?.mem) && (baseline[title]?.mem ?? 0) > 0).toBe(true);
      expect(Number.isInteger(baseline[title]?.cpu) && (baseline[title]?.cpu ?? 0) > 0).toBe(true);
    }
    expect(readFileSync(BASELINE_PATH, 'utf8')).toBe(formatBaseline(baseline));
  });
});
