#!/usr/bin/env node
import chalk from 'chalk';
import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { runValidatedPhantom, PhantomInputError } from './request';
import { BlockedByBotProtectionError } from './errors';
import type { RunPhantomInput } from './run';

function printUsage() {
  console.log(`Usage:
  tsx src/phantom/index.ts --url <url> [options]
  tsx src/phantom/index.ts --input <json-or-path> [options]

Options (same input fields as /api/phantom):
  --url <string>
  --matcher <string>
  --matcherRegex | --no-matcherRegex
  --findAll | --no-findAll
  --fuzzyMatch | --no-fuzzyMatch
  --minWaitMs <number>                     (min ms before idle check, default: 75)
  --idleWaitMs <number>                    (ms of zero activity to settle, default: 100)
  --maxWaitMs <number>                     (hard cap ms on wait, default: 2000)
  --moduleWaitMs <number>                  (max ms for module bundling, default: 6000)
  --prefetchExternalScripts | --no-prefetchExternalScripts
  --includeBodies | --no-includeBodies
  --input <json-or-path>                   (full request body, same shape as /api/phantom)
  --output <path>                          (optional output file)
  --help`);
}

async function readInputArg(inputArg: string): Promise<Partial<RunPhantomInput>> {
  const raw = inputArg.trim();
  if (raw.startsWith('{')) {
    return JSON.parse(raw) as Partial<RunPhantomInput>;
  }
  const fileContents = await readFile(raw, 'utf8');
  return JSON.parse(fileContents) as Partial<RunPhantomInput>;
}

async function main() {
  const { values } = parseArgs({
    options: {
      url: { type: 'string' },
      matcher: { type: 'string' },
      matcherRegex: { type: 'boolean' },
      findAll: { type: 'boolean' },
      fuzzyMatch: { type: 'boolean' },
      minWaitMs: { type: 'string' },
      idleWaitMs: { type: 'string' },
      maxWaitMs: { type: 'string' },
      moduleWaitMs: { type: 'string' },
      prefetchExternalScripts: { type: 'boolean' },
      includeBodies: { type: 'boolean' },
      input: { type: 'string' },
      output: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowNegative: true,
  });

  if (values.help) {
    printUsage();
    return;
  }

  const input: Partial<RunPhantomInput> = values.input
    ? await readInputArg(values.input)
    : {};

  if (typeof values.url === 'string') input.url = values.url;
  if (typeof values.matcher === 'string') input.matcher = values.matcher;
  if (typeof values.matcherRegex === 'boolean') input.matcherRegex = values.matcherRegex;
  if (typeof values.findAll === 'boolean') input.findAll = values.findAll;
  if (typeof values.fuzzyMatch === 'boolean') input.fuzzyMatch = values.fuzzyMatch;
  if (typeof values.minWaitMs === 'string') input.minWaitMs = Number(values.minWaitMs);
  if (typeof values.idleWaitMs === 'string') input.idleWaitMs = Number(values.idleWaitMs);
  if (typeof values.maxWaitMs === 'string') input.maxWaitMs = Number(values.maxWaitMs);
  if (typeof values.moduleWaitMs === 'string') input.moduleWaitMs = Number(values.moduleWaitMs);
  if (typeof values.prefetchExternalScripts === 'boolean') input.prefetchExternalScripts = values.prefetchExternalScripts;
  if (typeof values.includeBodies === 'boolean') input.includeBodies = values.includeBodies;

  if (!input.url) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  console.log(chalk.blue(`[Phantom CLI] Running for ${input.url}`));
  const start = Date.now();

  try {
    const result = await runValidatedPhantom(input);
    const output = JSON.stringify(result, null, 2);
    if (typeof values.output === 'string') {
      await writeFile(values.output, output, 'utf8');
      console.log(chalk.green(`[Phantom CLI] Wrote output to ${values.output}`));
    }
    process.stdout.write(`${output}\n`);
    console.log(chalk.blue(`[Phantom CLI] Completed in ${Date.now() - start}ms`));
    if (result.matcher) {
      if (result.match_count > 0) {
        console.log(chalk.green(`[Phantom CLI] MATCH FOUND for "${result.matcher}" (${result.match_count} request${result.match_count === 1 ? '' : 's'})`));
        for (const match of result.matches) {
          console.log(chalk.green(`  - ${match.type}: ${match.url}`));
        }
      } else {
        console.log(chalk.yellow(`[Phantom CLI] NO MATCH for "${result.matcher}"`));
      }
    } else {
      console.log(chalk.gray('[Phantom CLI] Match summary skipped (no matcher provided)'));
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red('[Phantom CLI] Error:'), message);

    if (error instanceof PhantomInputError) {
      process.exitCode = 2;
      return;
    }
    if (error instanceof BlockedByBotProtectionError) {
      process.exitCode = 3;
      return;
    }
    process.exitCode = 1;
  }
}

void main();
