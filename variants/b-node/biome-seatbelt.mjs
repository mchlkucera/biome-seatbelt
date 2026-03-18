#!/usr/bin/env node

// biome-seatbelt — Ratcheting baseline for Biome lint
// Zero dependencies. Node.js 18+ only built-ins.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const NO_COLOR = !!process.env.NO_COLOR || !process.stdout.isTTY;

const c = {
  reset: NO_COLOR ? "" : "\x1b[0m",
  bold: NO_COLOR ? "" : "\x1b[1m",
  dim: NO_COLOR ? "" : "\x1b[2m",
  red: NO_COLOR ? "" : "\x1b[31m",
  green: NO_COLOR ? "" : "\x1b[32m",
  yellow: NO_COLOR ? "" : "\x1b[33m",
  cyan: NO_COLOR ? "" : "\x1b[36m",
  white: NO_COLOR ? "" : "\x1b[37m",
};

function bold(s) {
  return `${c.bold}${s}${c.reset}`;
}
function red(s) {
  return `${c.red}${s}${c.reset}`;
}
function green(s) {
  return `${c.green}${s}${c.reset}`;
}
function yellow(s) {
  return `${c.yellow}${s}${c.reset}`;
}
function cyan(s) {
  return `${c.cyan}${s}${c.reset}`;
}
function dim(s) {
  return `${c.dim}${s}${c.reset}`;
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    command: null,
    file:
      process.env.BIOME_SEATBELT_FILE || "biome-seatbelt.tsv",
    frozen: process.env.BIOME_SEATBELT_FROZEN === "1",
    verbose: false,
    severity: process.env.BIOME_SEATBELT_SEVERITY || "warning",
    biomeBin: process.env.BIOME_SEATBELT_BIOME_BIN || "biome",
    biomeArgs: [],
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    if (arg === "--") {
      args.biomeArgs = argv.slice(i + 1);
      break;
    }

    if (arg === "--file" && i + 1 < argv.length) {
      args.file = argv[++i];
    } else if (arg.startsWith("--file=")) {
      args.file = arg.slice("--file=".length);
    } else if (arg === "--frozen") {
      args.frozen = true;
    } else if (arg === "--verbose") {
      args.verbose = true;
    } else if (arg === "--severity" && i + 1 < argv.length) {
      args.severity = argv[++i];
    } else if (arg.startsWith("--severity=")) {
      args.severity = arg.slice("--severity=".length);
    } else if (arg === "--biome-bin" && i + 1 < argv.length) {
      args.biomeBin = argv[++i];
    } else if (arg.startsWith("--biome-bin=")) {
      args.biomeBin = arg.slice("--biome-bin=".length);
    } else if (arg === "--help" || arg === "-h") {
      args.command = "help";
    } else if (arg === "--version" || arg === "-v") {
      args.command = "version";
    } else if (!arg.startsWith("-") && !args.command) {
      args.command = arg;
    } else if (arg.startsWith("-")) {
      console.error(red(`Unknown flag: ${arg}`));
      process.exit(2);
    }

    i++;
  }

  // --frozen is an alias for check
  if (args.frozen && !args.command) {
    args.command = "check";
  }

  // Validate severity
  const validSeverities = ["error", "warning", "info"];
  if (!validSeverities.includes(args.severity)) {
    console.error(
      red(
        `Invalid severity "${args.severity}". Must be one of: ${validSeverities.join(", ")}`,
      ),
    );
    process.exit(2);
  }

  return args;
}

// ---------------------------------------------------------------------------
// Biome runner
// ---------------------------------------------------------------------------

const SEVERITY_RANK = { error: 3, warning: 2, information: 1 };

function severityThreshold(level) {
  // Map user-facing names to biome's internal names
  const map = { error: 3, warning: 2, info: 1 };
  return map[level] ?? 2;
}

function runBiome(biomeBin, extraArgs) {
  const cmdArgs = ["lint", "--reporter=json", ...extraArgs];

  try {
    const stdout = execFileSync(biomeBin, cmdArgs, {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024, // 50 MB
      stdio: ["pipe", "pipe", "pipe"],
    });
    return stdout;
  } catch (err) {
    // Biome exits 1 when diagnostics are found — that's expected.
    // It also exits 1 for real errors, but those typically have no stdout.
    if (err.stdout && err.stdout.trim().length > 0) {
      return err.stdout;
    }

    // Check if biome is not found
    if (err.code === "ENOENT") {
      console.error(red(`Could not find biome binary: ${biomeBin}`));
      console.error(
        dim("Install biome: npm install --save-dev @biomejs/biome"),
      );
      console.error(
        dim("Or specify a custom path: --biome-bin ./node_modules/.bin/biome"),
      );
      process.exit(127);
    }

    // Real execution failure with no parseable output
    const stderr = err.stderr?.toString().trim() || "";
    if (stderr) {
      console.error(red("Biome failed:"));
      console.error(stderr);
    } else {
      console.error(red(`Biome exited with code ${err.status} and no output`));
    }
    process.exit(err.status || 1);
  }
}

function parseBiomeOutput(raw, minSeverity) {
  const threshold = severityThreshold(minSeverity);

  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    console.error(red("Failed to parse Biome JSON output."));
    console.error(dim("Is Biome's --reporter=json format supported?"));
    console.error(dim(`Raw output (first 500 chars): ${raw.slice(0, 500)}`));
    process.exit(1);
  }

  if (!json.diagnostics || !Array.isArray(json.diagnostics)) {
    console.error(
      red("Unexpected Biome JSON structure: missing diagnostics array."),
    );
    console.error(
      dim(
        "The Biome JSON reporter format may have changed. Please report this.",
      ),
    );
    process.exit(1);
  }

  // Aggregate: Map<"file\trule", count>
  const counts = new Map();

  for (const d of json.diagnostics) {
    const rule = d.category;
    const severity = d.severity;
    const file = d.location?.path?.file;

    if (!rule || !file) continue;

    const rank = SEVERITY_RANK[severity] ?? 0;
    if (rank < threshold) continue;

    const key = `${file}\t${rule}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return counts;
}

// ---------------------------------------------------------------------------
// Baseline TSV read / write
// ---------------------------------------------------------------------------

function readBaseline(filePath) {
  const absPath = resolve(filePath);
  if (!existsSync(absPath)) {
    return null;
  }

  const content = readFileSync(absPath, "utf-8");
  const entries = new Map();
  const comments = [];

  for (const line of content.split("\n")) {
    if (line.startsWith("#")) {
      comments.push(line);
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) continue;

    const parts = trimmed.split("\t");
    if (parts.length !== 3) continue;

    const [file, rule, countStr] = parts;
    const count = parseInt(countStr, 10);
    if (Number.isNaN(count)) continue;

    if (count > 0) {
      entries.set(`${file}\t${rule}`, count);
    }
  }

  return { entries, comments };
}

function writeBaseline(filePath, entries, timestamp) {
  const absPath = resolve(filePath);
  const ts = timestamp || new Date().toISOString();

  const lines = [
    "# biome-seatbelt baseline",
    `# Generated: ${ts}`,
    "# file\trule\tcount",
  ];

  // Sort by file, then rule
  const sorted = [...entries.entries()]
    .filter(([, count]) => count > 0)
    .sort((a, b) => {
      const [aFile, aRule] = a[0].split("\t");
      const [bFile, bRule] = b[0].split("\t");
      return aFile.localeCompare(bFile) || aRule.localeCompare(bRule);
    });

  for (const [key, count] of sorted) {
    const [file, rule] = key.split("\t");
    lines.push(`${file}\t${rule}\t${count}`);
  }

  writeFileSync(absPath, lines.join("\n") + "\n", "utf-8");
  return sorted.length;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdInit(args) {
  console.log(bold("biome-seatbelt init"));
  console.log(dim(`Running biome lint...`));

  const raw = runBiome(args.biomeBin, args.biomeArgs);
  const counts = parseBiomeOutput(raw, args.severity);

  const entryCount = writeBaseline(args.file, counts);

  console.log(
    green(`Baseline created: ${bold(args.file)} (${entryCount} entries)`),
  );

  // Summary by rule
  const byRule = new Map();
  for (const [key, count] of counts) {
    const rule = key.split("\t")[1];
    byRule.set(rule, (byRule.get(rule) || 0) + count);
  }

  if (byRule.size > 0) {
    const totalViolations = [...byRule.values()].reduce((a, b) => a + b, 0);
    console.log(
      dim(
        `${totalViolations} total violations across ${byRule.size} rules in ${new Set([...counts.keys()].map((k) => k.split("\t")[0])).size} files`,
      ),
    );

    if (args.verbose) {
      console.log("");
      const sorted = [...byRule.entries()].sort((a, b) => b[1] - a[1]);
      for (const [rule, count] of sorted) {
        console.log(`  ${yellow(String(count).padStart(5))}  ${rule}`);
      }
    }
  } else {
    console.log(green("No violations found. Clean slate!"));
  }
}

function cmdCheck(args) {
  console.log(bold("biome-seatbelt check"));

  const baseline = readBaseline(args.file);
  if (!baseline) {
    console.error(
      red(`No baseline found at ${bold(args.file)}`),
    );
    console.error(dim("Run `biome-seatbelt init` first."));
    process.exit(1);
  }

  console.log(dim("Running biome lint..."));

  const raw = runBiome(args.biomeBin, args.biomeArgs);
  const current = parseBiomeOutput(raw, args.severity);

  // Find regressions and new violations
  const regressions = [];
  const newViolations = [];
  const improvements = [];

  // Check current against baseline
  for (const [key, currentCount] of current) {
    const baselineCount = baseline.entries.get(key);

    if (baselineCount === undefined) {
      // New violation not in baseline
      newViolations.push({ key, count: currentCount });
    } else if (currentCount > baselineCount) {
      regressions.push({
        key,
        baseline: baselineCount,
        current: currentCount,
        delta: currentCount - baselineCount,
      });
    }
  }

  // Check for improvements
  for (const [key, baselineCount] of baseline.entries) {
    const currentCount = current.get(key) || 0;
    if (currentCount < baselineCount) {
      improvements.push({
        key,
        baseline: baselineCount,
        current: currentCount,
        delta: baselineCount - currentCount,
      });
    }
  }

  const hasFailures = regressions.length > 0 || newViolations.length > 0;

  if (hasFailures) {
    console.log("");

    if (regressions.length > 0) {
      console.log(red(bold(`  Regressions (${regressions.length}):`)));
      console.log("");
      for (const r of regressions) {
        const [file, rule] = r.key.split("\t");
        console.log(
          `  ${red("+")}${red(String(r.delta).padStart(3))}  ${file}  ${dim(rule)}  ${dim(`(${r.baseline} -> ${r.current})`)}`,
        );
      }
      console.log("");
    }

    if (newViolations.length > 0) {
      console.log(red(bold(`  New violations (${newViolations.length}):`)));
      console.log("");
      for (const v of newViolations) {
        const [file, rule] = v.key.split("\t");
        console.log(
          `  ${red("+")}${red(String(v.count).padStart(3))}  ${file}  ${dim(rule)}  ${dim("(new)")}`,
        );
      }
      console.log("");
    }

    const totalNew = newViolations.reduce((a, v) => a + v.count, 0);
    const totalRegressed = regressions.reduce((a, r) => a + r.delta, 0);
    console.log(
      red(
        bold(
          `  FAIL: ${totalRegressed + totalNew} new violations (${regressions.length} regressions, ${newViolations.length} new)`,
        ),
      ),
    );
    process.exit(1);
  }

  // Success
  const totalBaseline = [...baseline.entries.values()].reduce(
    (a, b) => a + b,
    0,
  );
  const totalCurrent = [...current.values()].reduce((a, b) => a + b, 0);
  const improved = improvements.reduce((a, i) => a + i.delta, 0);

  console.log("");
  console.log(
    green(
      bold("  All clear!"),
    ) +
      ` ${totalCurrent} violations remaining` +
      (improved > 0
        ? ` (${green(`${improved} improved`)})`
        : ""),
  );

  if (improved > 0) {
    console.log(
      dim("  Run `biome-seatbelt update` to tighten the baseline."),
    );
  }

  if (args.verbose && improvements.length > 0) {
    console.log("");
    console.log(green("  Improvements:"));
    for (const imp of improvements) {
      const [file, rule] = imp.key.split("\t");
      console.log(
        `  ${green("-")}${green(String(imp.delta).padStart(3))}  ${file}  ${dim(rule)}  ${dim(`(${imp.baseline} -> ${imp.current})`)}`,
      );
    }
  }
}

function cmdUpdate(args) {
  console.log(bold("biome-seatbelt update"));

  const baseline = readBaseline(args.file);
  if (!baseline) {
    console.error(red(`No baseline found at ${bold(args.file)}`));
    console.error(dim("Run `biome-seatbelt init` first."));
    process.exit(1);
  }

  console.log(dim("Running biome lint..."));

  const raw = runBiome(args.biomeBin, args.biomeArgs);
  const current = parseBiomeOutput(raw, args.severity);

  let tightened = 0;
  let removed = 0;
  const updated = new Map();

  for (const [key, baselineCount] of baseline.entries) {
    const currentCount = current.get(key) || 0;

    if (currentCount === 0) {
      // Fully resolved — remove
      removed++;
    } else if (currentCount < baselineCount) {
      // Improved — ratchet down
      updated.set(key, currentCount);
      tightened++;
    } else {
      // Same or worse — keep baseline (never loosen)
      updated.set(key, baselineCount);
    }
  }

  // Note: we do NOT add new violations that aren't in the baseline.
  // Use `init` to capture those.

  const entryCount = writeBaseline(args.file, updated);

  console.log("");
  if (tightened > 0 || removed > 0) {
    console.log(
      green(
        `  Tightened ${bold(String(tightened))} entries, removed ${bold(String(removed))} resolved entries`,
      ),
    );
  } else {
    console.log(dim("  No changes — baseline already matches current state."));
  }
  console.log(dim(`  ${entryCount} entries remaining in ${args.file}`));
}

function cmdStatus(args) {
  console.log(bold("biome-seatbelt status"));

  const baseline = readBaseline(args.file);
  if (!baseline) {
    console.error(red(`No baseline found at ${bold(args.file)}`));
    console.error(dim("Run `biome-seatbelt init` first."));
    process.exit(1);
  }

  console.log(dim("Running biome lint..."));

  const raw = runBiome(args.biomeBin, args.biomeArgs);
  const current = parseBiomeOutput(raw, args.severity);

  // Totals
  const totalBaseline = [...baseline.entries.values()].reduce(
    (a, b) => a + b,
    0,
  );
  const totalCurrent = [...current.values()].reduce((a, b) => a + b, 0);
  const totalDelta = totalCurrent - totalBaseline;

  console.log("");
  console.log(`  Baseline:  ${bold(String(totalBaseline))} violations`);
  console.log(`  Current:   ${bold(String(totalCurrent))} violations`);
  console.log(
    `  Delta:     ${totalDelta <= 0 ? green(String(totalDelta)) : red(`+${totalDelta}`)} violations`,
  );

  // Per-rule breakdown
  const ruleBaseline = new Map();
  const ruleCurrent = new Map();

  for (const [key, count] of baseline.entries) {
    const rule = key.split("\t")[1];
    ruleBaseline.set(rule, (ruleBaseline.get(rule) || 0) + count);
  }

  for (const [key, count] of current) {
    const rule = key.split("\t")[1];
    ruleCurrent.set(rule, (ruleCurrent.get(rule) || 0) + count);
  }

  const allRules = new Set([...ruleBaseline.keys(), ...ruleCurrent.keys()]);
  const ruleStats = [];

  for (const rule of allRules) {
    const base = ruleBaseline.get(rule) || 0;
    const curr = ruleCurrent.get(rule) || 0;
    ruleStats.push({ rule, baseline: base, current: curr, delta: curr - base });
  }

  // Sort: most improved first, then most regressed
  ruleStats.sort((a, b) => a.delta - b.delta);

  const improved = ruleStats.filter((r) => r.delta < 0);
  const regressed = ruleStats.filter((r) => r.delta > 0);
  const stuck = ruleStats.filter((r) => r.delta === 0 && r.current > 0);

  if (improved.length > 0) {
    console.log("");
    console.log(green(bold("  Improving:")));
    for (const r of improved) {
      console.log(
        `  ${green(String(r.delta).padStart(5))}  ${r.rule}  ${dim(`(${r.baseline} -> ${r.current})`)}`,
      );
    }
  }

  if (regressed.length > 0) {
    console.log("");
    console.log(red(bold("  Regressed:")));
    for (const r of regressed) {
      console.log(
        `  ${red(`+${String(r.delta).padStart(4)}`)}  ${r.rule}  ${dim(`(${r.baseline} -> ${r.current})`)}`,
      );
    }
  }

  if (args.verbose && stuck.length > 0) {
    console.log("");
    console.log(yellow(bold("  Unchanged:")));
    for (const r of stuck) {
      console.log(`  ${dim(String(r.current).padStart(5))}  ${r.rule}`);
    }
  }

  // Files summary
  const baselineFiles = new Set(
    [...baseline.entries.keys()].map((k) => k.split("\t")[0]),
  );
  const currentFiles = new Set(
    [...current.keys()].map((k) => k.split("\t")[0]),
  );

  console.log("");
  console.log(
    dim(
      `  ${currentFiles.size} files with violations (baseline: ${baselineFiles.size})`,
    ),
  );
  console.log(dim(`  ${allRules.size} rules tracked`));

  if (totalDelta < 0) {
    const pct = ((Math.abs(totalDelta) / totalBaseline) * 100).toFixed(1);
    console.log("");
    console.log(green(`  ${pct}% progress since baseline was created`));
  }
}

function cmdHelp() {
  console.log(`
${bold("biome-seatbelt")} — Ratcheting baseline for Biome lint

${bold("USAGE")}
  biome-seatbelt <command> [flags] [-- <biome args>]

${bold("COMMANDS")}
  ${cyan("init")}      Create initial baseline from current violations
  ${cyan("check")}     Verify no new violations (CI command)
  ${cyan("update")}    Tighten baseline after fixing violations
  ${cyan("status")}    Show progress report vs baseline

${bold("FLAGS")}
  --file <path>       Baseline file (default: biome-seatbelt.tsv)
  --frozen            Alias for 'check' (eslint-seatbelt compat)
  --verbose           Show per-file details
  --severity <level>  Min severity: error, warning, info (default: warning)
  --biome-bin <path>  Path to biome binary (default: biome)
  -- <args>           Forward remaining args to biome lint

${bold("ENVIRONMENT VARIABLES")}
  BIOME_SEATBELT_FILE        Same as --file
  BIOME_SEATBELT_FROZEN=1    Same as --frozen
  BIOME_SEATBELT_SEVERITY    Same as --severity
  BIOME_SEATBELT_BIOME_BIN   Same as --biome-bin

${bold("EXAMPLES")}
  biome-seatbelt init                    # Create baseline
  biome-seatbelt check                   # CI check (exit 1 on regressions)
  biome-seatbelt update                  # Tighten after fixes
  biome-seatbelt status --verbose        # Full progress report
  biome-seatbelt check -- --changed      # Only lint changed files
`);
}

function cmdVersion() {
  console.log("biome-seatbelt 0.1.0");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));

switch (args.command) {
  case "init":
    cmdInit(args);
    break;
  case "check":
    cmdCheck(args);
    break;
  case "update":
    cmdUpdate(args);
    break;
  case "status":
    cmdStatus(args);
    break;
  case "help":
    cmdHelp();
    break;
  case "version":
    cmdVersion();
    break;
  default:
    if (!args.command) {
      cmdHelp();
    } else {
      console.error(red(`Unknown command: ${args.command}`));
      console.error(dim("Run `biome-seatbelt --help` for usage."));
      process.exit(2);
    }
}
