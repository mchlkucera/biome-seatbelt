#!/usr/bin/env bun
// biome-seatbelt — Ratcheting tool for Biome lint
// Zero dependencies. Run with: bun run biome-seatbelt.ts <command>

// ---------------------------------------------------------------------------
// ANSI colors
// ---------------------------------------------------------------------------

const NO_COLOR = !!process.env.NO_COLOR;

const c = {
  reset: NO_COLOR ? "" : "\x1b[0m",
  bold: NO_COLOR ? "" : "\x1b[1m",
  dim: NO_COLOR ? "" : "\x1b[2m",
  red: NO_COLOR ? "" : "\x1b[31m",
  green: NO_COLOR ? "" : "\x1b[32m",
  yellow: NO_COLOR ? "" : "\x1b[33m",
  cyan: NO_COLOR ? "" : "\x1b[36m",
  gray: NO_COLOR ? "" : "\x1b[90m",
};

function bold(s: string): string {
  return `${c.bold}${s}${c.reset}`;
}
function red(s: string): string {
  return `${c.red}${s}${c.reset}`;
}
function green(s: string): string {
  return `${c.green}${s}${c.reset}`;
}
function yellow(s: string): string {
  return `${c.yellow}${s}${c.reset}`;
}
function cyan(s: string): string {
  return `${c.cyan}${s}${c.reset}`;
}
function dim(s: string): string {
  return `${c.dim}${s}${c.reset}`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BiomeDiagnostic {
  category: string;
  severity: "error" | "warning" | "information";
  location: {
    path: { file: string };
    span?: [number, number];
  };
}

interface BiomeOutput {
  summary?: { errors: number; warnings: number; infos: number };
  diagnostics: BiomeDiagnostic[];
  command?: string;
}

/** file -> rule -> count */
type ViolationMap = Map<string, Map<string, number>>;

interface BaselineEntry {
  file: string;
  rule: string;
  count: number;
}

type Severity = "error" | "warning" | "info";

interface CliOptions {
  command: string;
  baselineFile: string;
  verbose: boolean;
  severity: Severity;
  biomeBin: string;
  biomeArgs: string[];
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): CliOptions {
  // Strip bun / script path
  const args = argv.slice(2);

  let command = "";
  let baselineFile =
    process.env.BIOME_SEATBELT_FILE || "biome-seatbelt.tsv";
  let verbose = false;
  let severity: Severity =
    (process.env.BIOME_SEATBELT_SEVERITY as Severity) || "warning";
  let biomeBin = process.env.BIOME_SEATBELT_BIOME_BIN || "biome";
  const biomeArgs: string[] = [];

  let i = 0;
  let seenDoubleDash = false;

  while (i < args.length) {
    const arg = args[i];

    if (seenDoubleDash) {
      biomeArgs.push(arg);
      i++;
      continue;
    }

    if (arg === "--") {
      seenDoubleDash = true;
      i++;
      continue;
    }

    if (arg === "--file") {
      baselineFile = args[++i] ?? die("--file requires a value");
    } else if (arg === "--verbose") {
      verbose = true;
    } else if (arg === "--severity") {
      const val = args[++i];
      if (val !== "error" && val !== "warning" && val !== "info") {
        die(`--severity must be one of: error, warning, info (got "${val}")`);
      }
      severity = val as Severity;
    } else if (arg === "--biome-bin") {
      biomeBin = args[++i] ?? die("--biome-bin requires a value");
    } else if (arg === "--frozen") {
      command = "check";
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (arg.startsWith("-")) {
      die(`Unknown flag: ${arg}. Run with --help for usage.`);
    } else if (!command) {
      command = arg;
    } else {
      die(`Unexpected argument: ${arg}. Run with --help for usage.`);
    }

    i++;
  }

  // Check frozen env var
  if (!command && process.env.BIOME_SEATBELT_FROZEN === "1") {
    command = "check";
  }

  if (!command) {
    printUsage();
    process.exit(1);
  }

  const validCommands = ["init", "check", "update", "status"];
  if (!validCommands.includes(command)) {
    die(
      `Unknown command: "${command}". Valid commands: ${validCommands.join(", ")}`,
    );
  }

  return { command, baselineFile, verbose, severity, biomeBin, biomeArgs };
}

function printUsage(): void {
  console.log(`
${bold("biome-seatbelt")} — Ratcheting tool for Biome lint

${bold("Usage:")}
  biome-seatbelt <command> [flags] [-- <biome args>]

${bold("Commands:")}
  init      Create initial baseline from current violations
  check     Check for regressions against baseline (CI command)
  update    Tighten baseline to current state (post-fix command)
  status    Show progress report

${bold("Flags:")}
  --file <path>       Baseline file path (default: biome-seatbelt.tsv)
  --frozen            Alias for \`check\` (eslint-seatbelt compat)
  --verbose           Show per-file details
  --severity <level>  Minimum severity: error, warning, info (default: warning)
  --biome-bin <path>  Path to biome binary (default: biome)
  --help, -h          Show this help

${bold("Environment Variables:")}
  BIOME_SEATBELT_FILE        Same as --file
  BIOME_SEATBELT_FROZEN=1    Same as --frozen
  BIOME_SEATBELT_SEVERITY    Same as --severity
  BIOME_SEATBELT_BIOME_BIN   Same as --biome-bin
  NO_COLOR                   Disable colored output

${bold("Examples:")}
  biome-seatbelt init
  biome-seatbelt check --verbose
  biome-seatbelt update
  biome-seatbelt status
  biome-seatbelt check -- --changed
`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function die(message: string): never {
  console.error(`${red("error:")} ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Biome execution
// ---------------------------------------------------------------------------

async function runBiome(
  biomeBin: string,
  extraArgs: string[],
): Promise<BiomeOutput> {
  const args = ["lint", "--reporter=json", ...extraArgs];

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([biomeBin, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes("ENOENT") ||
      msg.includes("not found") ||
      msg.includes("No such file")
    ) {
      die(
        `Could not find biome binary at "${biomeBin}".\n` +
          `  Install: npm i -D @biomejs/biome\n` +
          `  Or specify: --biome-bin ./node_modules/.bin/biome`,
      );
    }
    die(`Failed to spawn biome: ${msg}`);
  }

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  // Exit code 1 = diagnostics found (normal). Exit code 0 = clean.
  // Anything else is a real error.
  if (exitCode !== 0 && exitCode !== 1) {
    die(
      `Biome exited with code ${exitCode}.\n` +
        (stderr ? `  stderr: ${stderr.trim()}` : "  (no stderr output)"),
    );
  }

  if (!stdout.trim()) {
    // No output at all — biome might not have produced JSON
    if (stderr.includes("not found") || stderr.includes("ENOENT")) {
      die(
        `Could not find biome binary at "${biomeBin}".\n` +
          `  Install: npm i -D @biomejs/biome\n` +
          `  Or specify: --biome-bin ./node_modules/.bin/biome`,
      );
    }
    // Empty stdout with exit code 0 might mean no files matched — return empty
    return { diagnostics: [], summary: { errors: 0, warnings: 0, infos: 0 } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    die(
      `Failed to parse Biome JSON output. The --reporter=json format may have changed.\n` +
        `  First 200 chars of stdout: ${stdout.slice(0, 200)}`,
    );
  }

  // Validate shape
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.diagnostics)) {
    die(
      `Unexpected Biome JSON structure: missing "diagnostics" array.\n` +
        `  Keys found: ${Object.keys(obj).join(", ")}`,
    );
  }

  return parsed as BiomeOutput;
}

// ---------------------------------------------------------------------------
// Severity filtering
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<string, number> = {
  error: 3,
  warning: 2,
  information: 1,
};

function severityToFilterRank(sev: Severity): number {
  if (sev === "info") return 1;
  if (sev === "warning") return 2;
  return 3;
}

function shouldInclude(
  diagnosticSeverity: string,
  minSeverity: Severity,
): boolean {
  const rank = SEVERITY_RANK[diagnosticSeverity] ?? 0;
  return rank >= severityToFilterRank(minSeverity);
}

// ---------------------------------------------------------------------------
// Violation aggregation
// ---------------------------------------------------------------------------

function aggregateDiagnostics(
  output: BiomeOutput,
  severity: Severity,
): ViolationMap {
  const map: ViolationMap = new Map();

  for (const diag of output.diagnostics) {
    if (!diag.category || !diag.location?.path?.file) continue;
    if (!shouldInclude(diag.severity, severity)) continue;

    const file = diag.location.path.file;
    const rule = diag.category;

    let fileMap = map.get(file);
    if (!fileMap) {
      fileMap = new Map();
      map.set(file, fileMap);
    }
    fileMap.set(rule, (fileMap.get(rule) ?? 0) + 1);
  }

  return map;
}

function mapToEntries(map: ViolationMap): BaselineEntry[] {
  const entries: BaselineEntry[] = [];
  for (const [file, rules] of map) {
    for (const [rule, count] of rules) {
      if (count > 0) {
        entries.push({ file, rule, count });
      }
    }
  }
  return sortEntries(entries);
}

function sortEntries(entries: BaselineEntry[]): BaselineEntry[] {
  return entries.sort((a, b) => {
    const fileCmp = a.file.localeCompare(b.file);
    if (fileCmp !== 0) return fileCmp;
    return a.rule.localeCompare(b.rule);
  });
}

function entriesToMap(entries: BaselineEntry[]): ViolationMap {
  const map: ViolationMap = new Map();
  for (const e of entries) {
    let fileMap = map.get(e.file);
    if (!fileMap) {
      fileMap = new Map();
      map.set(e.file, fileMap);
    }
    fileMap.set(e.rule, e.count);
  }
  return map;
}

function totalCount(entries: BaselineEntry[]): number {
  return entries.reduce((sum, e) => sum + e.count, 0);
}

// ---------------------------------------------------------------------------
// TSV read / write
// ---------------------------------------------------------------------------

function parseTsv(content: string): BaselineEntry[] {
  const entries: BaselineEntry[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const parts = trimmed.split("\t");
    if (parts.length !== 3) continue;

    const [file, rule, countStr] = parts;
    const count = parseInt(countStr, 10);
    if (Number.isNaN(count) || count <= 0) continue;

    entries.push({ file, rule, count });
  }
  return entries;
}

function formatTsv(entries: BaselineEntry[]): string {
  const sorted = sortEntries(entries);
  const lines = [
    "# biome-seatbelt baseline",
    `# Generated: ${new Date().toISOString()}`,
    "# file\trule\tcount",
  ];

  for (const e of sorted) {
    lines.push(`${e.file}\t${e.rule}\t${e.count}`);
  }

  return lines.join("\n") + "\n";
}

async function readBaseline(path: string): Promise<BaselineEntry[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    die(
      `No baseline found at "${path}".\n` +
        `  Run ${cyan("biome-seatbelt init")} to create one.`,
    );
  }
  const content = await file.text();
  return parseTsv(content);
}

async function writeBaseline(
  path: string,
  entries: BaselineEntry[],
): Promise<void> {
  await Bun.write(path, formatTsv(entries));
}

// ---------------------------------------------------------------------------
// Diff engine
// ---------------------------------------------------------------------------

interface DiffResult {
  regressions: BaselineEntry[]; // count increased or new violation
  improvements: BaselineEntry[]; // count decreased (shows delta)
  resolved: BaselineEntry[]; // count went to 0
  unchanged: BaselineEntry[];
}

function computeDiff(
  baseline: BaselineEntry[],
  current: ViolationMap,
): DiffResult {
  const result: DiffResult = {
    regressions: [],
    improvements: [],
    resolved: [],
    unchanged: [],
  };

  const baselineMap = entriesToMap(baseline);

  // Check each current violation against baseline
  for (const [file, rules] of current) {
    for (const [rule, curCount] of rules) {
      const baseCount = baselineMap.get(file)?.get(rule) ?? 0;

      if (baseCount === 0) {
        // New violation not in baseline
        result.regressions.push({ file, rule, count: curCount });
      } else if (curCount > baseCount) {
        // Regression: count increased
        result.regressions.push({
          file,
          rule,
          count: curCount - baseCount,
        });
      } else if (curCount < baseCount) {
        result.improvements.push({
          file,
          rule,
          count: baseCount - curCount,
        });
      } else {
        result.unchanged.push({ file, rule, count: curCount });
      }
    }
  }

  // Check for entries in baseline that are no longer in current (resolved)
  for (const entry of baseline) {
    const curCount = current.get(entry.file)?.get(entry.rule) ?? 0;
    if (curCount === 0) {
      result.resolved.push(entry);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdInit(opts: CliOptions): Promise<void> {
  console.log(dim("Running biome lint..."));
  const output = await runBiome(opts.biomeBin, opts.biomeArgs);
  const violations = aggregateDiagnostics(output, opts.severity);
  const entries = mapToEntries(violations);

  await writeBaseline(opts.baselineFile, entries);

  const ruleCount = new Set(entries.map((e) => e.rule)).size;
  const fileCount = new Set(entries.map((e) => e.file)).size;

  console.log(
    `\n${green("Baseline created:")} ${bold(opts.baselineFile)}`,
  );
  console.log(
    `  ${totalCount(entries)} violations across ${ruleCount} rules in ${fileCount} files`,
  );

  if (entries.length === 0) {
    console.log(
      `\n  ${green("Congratulations!")} No violations found.`,
    );
  }
}

async function cmdCheck(opts: CliOptions): Promise<void> {
  console.log(dim("Running biome lint..."));
  const output = await runBiome(opts.biomeBin, opts.biomeArgs);
  const currentMap = aggregateDiagnostics(output, opts.severity);
  const baseline = await readBaseline(opts.baselineFile);
  const diff = computeDiff(baseline, currentMap);

  if (diff.regressions.length > 0) {
    console.log(
      `\n${red(bold(`${diff.regressions.length} regression(s) found:`))}`,
    );
    console.log();

    // Group by file
    const byFile = new Map<string, BaselineEntry[]>();
    for (const r of sortEntries(diff.regressions)) {
      const list = byFile.get(r.file) ?? [];
      list.push(r);
      byFile.set(r.file, list);
    }

    for (const [file, regs] of byFile) {
      console.log(`  ${bold(file)}`);
      for (const r of regs) {
        const baseCount =
          entriesToMap(baseline).get(r.file)?.get(r.rule) ?? 0;
        if (baseCount === 0) {
          console.log(
            `    ${red("+")}${r.count}  ${r.rule}  ${dim("(new, not in baseline)")}`,
          );
        } else {
          console.log(
            `    ${red("+")}${r.count}  ${r.rule}  ${dim(`(was ${baseCount}, now ${baseCount + r.count})`)}`,
          );
        }
      }
    }

    const improvementNote =
      diff.improvements.length + diff.resolved.length > 0
        ? dim(
            `  (${diff.improvements.length} improved, ${diff.resolved.length} resolved — run \`update\` to tighten baseline)`,
          )
        : "";

    console.log(
      `\n${red("Check failed.")} Fix regressions or run ${cyan("biome-seatbelt update")} after fixing.`,
    );
    if (improvementNote) console.log(improvementNote);

    process.exit(1);
  }

  // All clear
  const currentEntries = mapToEntries(currentMap);
  const currentTotal = totalCount(currentEntries);
  const baselineTotal = totalCount(baseline);
  const improved = diff.improvements.length + diff.resolved.length;

  console.log(`\n${green(bold("All clear!"))} No regressions found.`);
  console.log(
    `  ${currentTotal} violations remaining${baselineTotal > currentTotal ? ` (${green(`-${baselineTotal - currentTotal}`)} from baseline)` : ""}`,
  );

  if (improved > 0) {
    console.log(
      `  ${green(`${improved}`)} entries improved — run ${cyan("biome-seatbelt update")} to tighten baseline`,
    );
  }

  if (opts.verbose && diff.improvements.length > 0) {
    console.log(`\n${bold("Improvements:")}`);
    for (const imp of sortEntries(diff.improvements)) {
      console.log(`  ${green(`-${imp.count}`)}  ${imp.file}  ${dim(imp.rule)}`);
    }
  }

  if (opts.verbose && diff.resolved.length > 0) {
    console.log(`\n${bold("Resolved:")}`);
    for (const res of sortEntries(diff.resolved)) {
      console.log(
        `  ${green("resolved")}  ${res.file}  ${dim(res.rule)}  ${dim(`(was ${res.count})`)}`,
      );
    }
  }
}

async function cmdUpdate(opts: CliOptions): Promise<void> {
  console.log(dim("Running biome lint..."));
  const output = await runBiome(opts.biomeBin, opts.biomeArgs);
  const currentMap = aggregateDiagnostics(output, opts.severity);
  const baseline = await readBaseline(opts.baselineFile);

  let tightened = 0;
  let removed = 0;
  const newEntries: BaselineEntry[] = [];

  // Process existing baseline entries
  for (const entry of baseline) {
    const curCount = currentMap.get(entry.file)?.get(entry.rule) ?? 0;

    if (curCount === 0) {
      // Resolved — remove entry
      removed++;
    } else if (curCount < entry.count) {
      // Improved — ratchet down
      newEntries.push({ file: entry.file, rule: entry.rule, count: curCount });
      tightened++;
    } else {
      // Same or higher — keep baseline (never loosen)
      newEntries.push(entry);
    }
  }

  await writeBaseline(opts.baselineFile, newEntries);

  console.log(`\n${green(bold("Baseline updated:"))} ${opts.baselineFile}`);
  if (tightened > 0) {
    console.log(`  ${green(`Tightened ${tightened}`)} entries`);
  }
  if (removed > 0) {
    console.log(`  ${green(`Removed ${removed}`)} resolved entries`);
  }
  if (tightened === 0 && removed === 0) {
    console.log(dim("  No changes — baseline already matches current state."));
  }

  const remaining = totalCount(newEntries);
  console.log(`  ${remaining} violations remaining`);

  if (opts.verbose) {
    // Check for new violations not in baseline (won't be added by update)
    const baselineMap = entriesToMap(baseline);
    const newViolations: BaselineEntry[] = [];
    for (const [file, rules] of currentMap) {
      for (const [rule, count] of rules) {
        if (!baselineMap.get(file)?.has(rule)) {
          newViolations.push({ file, rule, count });
        }
      }
    }
    if (newViolations.length > 0) {
      console.log(
        `\n${yellow("Note:")} ${newViolations.length} new violation(s) not in baseline (not added by update):`,
      );
      for (const v of sortEntries(newViolations)) {
        console.log(`  ${v.file}  ${v.rule}  ${dim(`(${v.count})`)}`);
      }
      console.log(
        dim(
          `  Run ${cyan("biome-seatbelt init")} to re-create baseline with all current violations.`,
        ),
      );
    }
  }
}

async function cmdStatus(opts: CliOptions): Promise<void> {
  console.log(dim("Running biome lint..."));
  const output = await runBiome(opts.biomeBin, opts.biomeArgs);
  const currentMap = aggregateDiagnostics(output, opts.severity);
  const currentEntries = mapToEntries(currentMap);
  const baseline = await readBaseline(opts.baselineFile);

  const baselineTotal = totalCount(baseline);
  const currentTotal = totalCount(currentEntries);
  const delta = currentTotal - baselineTotal;

  console.log(`\n${bold("biome-seatbelt status")}`);
  console.log(`${"─".repeat(50)}`);
  console.log(
    `  Baseline:  ${bold(String(baselineTotal))} violations`,
  );
  console.log(
    `  Current:   ${bold(String(currentTotal))} violations`,
  );

  if (delta < 0) {
    console.log(`  Delta:     ${green(`${delta}`)} ${green("(improving)")}`);
  } else if (delta > 0) {
    console.log(`  Delta:     ${red(`+${delta}`)} ${red("(regressing)")}`);
  } else {
    console.log(`  Delta:     ${dim("0 (no change)")}`);
  }

  // Per-rule breakdown
  const ruleBaseline = new Map<string, number>();
  const ruleCurrent = new Map<string, number>();

  for (const e of baseline) {
    ruleBaseline.set(e.rule, (ruleBaseline.get(e.rule) ?? 0) + e.count);
  }
  for (const e of currentEntries) {
    ruleCurrent.set(e.rule, (ruleCurrent.get(e.rule) ?? 0) + e.count);
  }

  const allRules = new Set([...ruleBaseline.keys(), ...ruleCurrent.keys()]);
  const ruleRows: { rule: string; base: number; cur: number; delta: number }[] =
    [];

  for (const rule of allRules) {
    const base = ruleBaseline.get(rule) ?? 0;
    const cur = ruleCurrent.get(rule) ?? 0;
    ruleRows.push({ rule, base, cur, delta: cur - base });
  }

  ruleRows.sort((a, b) => a.delta - b.delta); // improvements first

  console.log(`\n${bold("Per-rule breakdown:")}`);
  console.log(
    `  ${dim("rule".padEnd(45))} ${dim("base".padStart(6))} ${dim("now".padStart(6))} ${dim("delta".padStart(7))}`,
  );

  for (const row of ruleRows) {
    const deltaStr =
      row.delta < 0
        ? green(String(row.delta).padStart(7))
        : row.delta > 0
          ? red(`+${row.delta}`.padStart(7))
          : dim("0".padStart(7));

    const ruleName =
      row.rule.length > 44 ? `${row.rule.slice(0, 41)}...` : row.rule;

    console.log(
      `  ${ruleName.padEnd(45)} ${String(row.base).padStart(6)} ${String(row.cur).padStart(6)} ${deltaStr}`,
    );
  }

  // Summary
  const improving = ruleRows.filter((r) => r.delta < 0);
  const stuck = ruleRows.filter((r) => r.delta === 0 && r.cur > 0);
  const regressing = ruleRows.filter((r) => r.delta > 0);

  console.log(`\n${bold("Summary:")}`);
  if (improving.length > 0) {
    console.log(
      `  ${green(`${improving.length}`)} rules improving`,
    );
  }
  if (stuck.length > 0) {
    console.log(`  ${yellow(`${stuck.length}`)} rules unchanged`);
  }
  if (regressing.length > 0) {
    console.log(`  ${red(`${regressing.length}`)} rules regressing`);
  }

  if (opts.verbose) {
    const diff = computeDiff(baseline, currentMap);
    if (diff.resolved.length > 0) {
      console.log(`\n${bold("Fully resolved entries:")}`);
      for (const r of sortEntries(diff.resolved)) {
        console.log(
          `  ${green("resolved")}  ${r.file}  ${dim(r.rule)}  ${dim(`(was ${r.count})`)}`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);

  switch (opts.command) {
    case "init":
      await cmdInit(opts);
      break;
    case "check":
      await cmdCheck(opts);
      break;
    case "update":
      await cmdUpdate(opts);
      break;
    case "status":
      await cmdStatus(opts);
      break;
    default:
      die(`Unknown command: ${opts.command}`);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  die(`Unexpected error: ${msg}`);
});
