// Driver for the make.fun "Make Markdown rendering faster" bounty.
// Reads /input/cases.json (or $MAKEFUN_INPUT_DIR/cases.json), renders each
// case with parse.js, and writes the HTML array to /output/html.json
// (or $MAKEFUN_OUTPUT_DIR/html.json). Runs with plain `node main.ts`.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR || '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));
const html = cases.map((c) => parse(c.markdown));
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
