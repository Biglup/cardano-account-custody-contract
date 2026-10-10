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

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* CONSTANTS ******************************************************************/

/** The committed execution units of every budget test, which continuous integration holds a check run against. */
export const BASELINE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'budgets.json');

/** The prefix of the tests that measure the heaviest path of each validator handler. */
export const BUDGET_PREFIX = 'budget_';

/**
 * How far above its recorded memory or CPU a budget test may land before
 * the gate refuses it, as a fraction of the recorded figure. The
 * evaluator charges the same units for the same code, so the margin
 * admits only a change too small to be worth recording.
 */
export const TOLERANCE = 0.01;

/** The argument that writes the baseline from a check run instead of holding the run against it. */
const REFRESH_FLAG = '--refresh';

/** How `aiken check` marks a test that is expected to pass. */
const EXPECTED_TO_PASS = 'fail_immediately';

/* TYPES **********************************************************************/

/** The memory units and CPU steps the evaluator charged one test. */
export interface Budget {
  mem: number;
  cpu: number;
}

/** The recorded budget of every budget test, by title. */
export type Baseline = Record<string, Budget>;

/** One test of the report `aiken check` writes when its output is not a terminal, reduced to the fields the gate reads. */
export interface ReportedTest {
  title: string;
  status: string;
  on_failure: string;
  traces?: string[] | null;
  execution_units?: Budget;
}

/** The report `aiken check` writes when its output is not a terminal, reduced to the fields the gate reads. */
export interface CheckReport {
  modules: { name: string; tests: ReportedTest[] }[];
}

/* FUNCTIONS ******************************************************************/

/** Every test of the report, in module order. */
const testsOf = (report: CheckReport): ReportedTest[] => report.modules.flatMap((module) => module.tests);

/**
 * The budget of every budget test of the report, by title. A budget test
 * that did not pass, or that reports no execution units, is refused
 * rather than recorded: its figure measures nothing.
 */
export const budgetsOf = (report: CheckReport): Baseline => {
  const budgets: Baseline = {};
  for (const test of testsOf(report)) {
    if (!test.title.startsWith(BUDGET_PREFIX)) {
      continue;
    }
    if (test.status !== 'pass') {
      throw new Error(`${test.title} did not pass, so its execution units measure nothing`);
    }
    if (!test.execution_units) {
      throw new Error(`${test.title} reports no execution units`);
    }
    budgets[test.title] = { mem: test.execution_units.mem, cpu: test.execution_units.cpu };
  }
  return budgets;
};

/**
 * The titles of the tests that print. A test that is expected to pass
 * carries a trace only when it traces on purpose. A test that is expected
 * to fail carries the message of the crash that fails it, so it is not
 * among them. A run with traces compiled out reports none, so the report
 * comes from a run at the default trace level.
 */
export const tracingTests = (report: CheckReport): string[] =>
  testsOf(report)
    .filter((test) => test.on_failure === EXPECTED_TO_PASS && (test.traces?.length ?? 0) > 0)
    .map((test) => test.title);

/**
 * Why the measured budgets do not hold against the baseline, one line
 * each, or nothing when they do. A recorded test that is not among the
 * measured ones is a refusal, as is a measured one that is not recorded:
 * the baseline lists every budget test and nothing else.
 */
export const budgetRefusals = (baseline: Baseline, measured: Baseline, tolerance = TOLERANCE): string[] => {
  const refusals: string[] = [];
  for (const [title, recorded] of Object.entries(baseline)) {
    const budget = measured[title];
    if (!budget) {
      refusals.push(`${title} is recorded in the baseline and is not among the tests`);
      continue;
    }
    for (const unit of ['mem', 'cpu'] as const) {
      if (budget[unit] > Math.floor(recorded[unit] * (1 + tolerance))) {
        refusals.push(`${title} ${unit} ${budget[unit]} exceeds the recorded ${recorded[unit]} by more than ${tolerance * 100} percent`);
      }
    }
  }
  for (const title of Object.keys(measured)) {
    if (!baseline[title]) {
      refusals.push(`${title} is not recorded in the baseline`);
    }
  }
  return refusals;
};

/** The refusals of a report against the baseline: every test that prints, then every budget that does not hold. */
export const gate = (report: CheckReport, baseline: Baseline, tolerance = TOLERANCE): string[] => [
  ...tracingTests(report).map((title) => `${title} prints: it carries a trace`),
  ...budgetRefusals(baseline, budgetsOf(report), tolerance),
];

/** The baseline as it is committed: one line per test, sorted by title, so that a diff names the tests whose figures moved. */
export const formatBaseline = (baseline: Baseline): string => {
  const lines = Object.entries(baseline)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([title, budget]) => `  "${title}": { "mem": ${budget.mem}, "cpu": ${budget.cpu} }`);
  return `{\n${lines.join(',\n')}\n}\n`;
};

/** The report a check run wrote to the given path. */
export const loadReport = (path: string): CheckReport => JSON.parse(readFileSync(path, 'utf8')) as CheckReport;

/** The committed baseline. */
export const loadBaseline = (path = BASELINE_PATH): Baseline => JSON.parse(readFileSync(path, 'utf8')) as Baseline;

/* MAIN ***********************************************************************/

const main = async (): Promise<void> => {
  const refresh = process.argv.includes(REFRESH_FLAG);
  const [path] = process.argv.slice(2).filter((argument) => argument !== REFRESH_FLAG);
  if (!path) {
    throw new Error(`usage: budget-gate.ts [${REFRESH_FLAG}] <report>, where the report is what aiken check -D writes when its output is not a terminal`);
  }
  const report = loadReport(path);
  if (refresh) {
    const budgets = budgetsOf(report);
    if (Object.keys(budgets).length === 0) {
      throw new Error(`${path} holds no ${BUDGET_PREFIX} test`);
    }
    writeFileSync(BASELINE_PATH, formatBaseline(budgets));
    console.log(`${Object.keys(budgets).length} budget tests recorded in ${BASELINE_PATH}`);
    return;
  }
  const refusals = gate(report, loadBaseline());
  if (refusals.length > 0) {
    throw new Error(refusals.join('\n'));
  }
  console.log(`${Object.keys(budgetsOf(report)).length} budget tests within ${TOLERANCE * 100} percent of ${BASELINE_PATH}, and no test prints`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
