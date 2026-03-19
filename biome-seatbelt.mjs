#!/usr/bin/env node

// biome-seatbelt — Ratcheting baseline for Biome lint
// Zero dependencies. Node.js 18+ only built-ins.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

const VERSION = "0.2.0";

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
    file: process.env.BIOME_SEATBELT_FILE || "biome-seatbelt.tsv",
    frozen: process.env.BIOME_SEATBELT_FROZEN === "1",
    verbose: false,
    json: false,
    severity: process.env.BIOME_SEATBELT_SEVERITY || "warning",
    biomeBin: process.env.BIOME_SEATBELT_BIOME_BIN || "biome",
    biomeArgs: [],
    allowIncrease: false,
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    if (arg === "--") {
      args.biomeArgs = argv.slice(i + 1);
      break;
    }

    // Support both --flag value and --flag=value
    function getFlagValue(flag) {
      if (arg === flag && i + 1 < argv.length) {
        return argv[++i];
      }
      if (arg.startsWith(`${flag}=`)) {
        return arg.slice(flag.length + 1);
      }
      return undefined;
    }

    const fileVal = getFlagValue("--file");
    if (fileVal !== undefined) {
      args.file = fileVal;
    } else if (arg === "--frozen") {
      args.frozen = true;
    } else if (arg === "--verbose") {
      args.verbose = true;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--update") {
      args.allowIncrease = true;
    } else {
      const sevVal = getFlagValue("--severity");
      if (sevVal !== undefined) {
        args.severity = sevVal;
      } else {
        const binVal = getFlagValue("--biome-bin");
        if (binVal !== undefined) {
          args.biomeBin = binVal;
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
      }
    }

    i++;
  }

  // --frozen is an alias for check
  if (args.frozen && !args.command) {
    args.command = "check";
  }

  // CI=1 auto-detection: default to check if no command given
  if (!args.command && process.env.CI) {
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
// Biome runner (streaming — no buffer limit)
// ---------------------------------------------------------------------------

const SEVERITY_RANK = { error: 3, warning: 2, information: 1 };

function severityThreshold(level) {
  const map = { error: 3, warning: 2, info: 1 };
  return map[level] ?? 2;
}

function runBiome(biomeBin, extraArgs) {
  return new Promise((resolve, reject) => {
    const cmdArgs = ["lint", "--reporter=json", ...extraArgs];

    let proc;
    try {
      proc = spawn(biomeBin, cmdArgs, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      if (err.code === "ENOENT") {
        console.error(red(`Could not find biome binary: ${biomeBin}`));
        console.error(
          dim("Install biome: npm install --save-dev @biomejs/biome"),
        );
        console.error(
          dim(
            "Or specify a custom path: --biome-bin ./node_modules/.bin/biome",
          ),
        );
        process.exit(127);
      }
      reject(err);
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];

    proc.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    proc.stderr.on("data", (chunk) => stderrChunks.push(chunk));

    proc.on("error", (err) => {
      if (err.code === "ENOENT") {
        console.error(red(`Could not find biome binary: ${biomeBin}`));
        console.error(
          dim("Install biome: npm install --save-dev @biomejs/biome"),
        );
        console.error(
          dim(
            "Or specify a custom path: --biome-bin ./node_modules/.bin/biome",
          ),
        );
        process.exit(127);
      }
      reject(err);
    });

    proc.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");

      // Biome exits 1 when diagnostics are found — that's expected.
      // But if stdout is empty and exit code is non-zero, it's a real error.
      if (code !== 0 && (!stdout || !stdout.trim())) {
        if (stderr && stderr.trim()) {
          console.error(red("Biome failed:"));
          console.error(stderr.trim());
        } else {
          console.error(
            red(`Biome exited with code ${code} and produced no output.`),
          );
        }
        process.exit(code || 1);
      }

      // Empty stdout with exit code 0 means no files matched — valid empty result
      if (!stdout || !stdout.trim()) {
        resolve("");
        return;
      }

      resolve(stdout);
    });
  });
}

function parseBiomeOutput(raw, minSeverity) {
  if (!raw || !raw.trim()) {
    return new Map();
  }

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

// Byte-level sort for deterministic output regardless of locale
function sortKey(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function writeBaseline(filePath, entries, timestamp) {
  const absPath = resolve(filePath);
  const ts = timestamp || new Date().toISOString();

  const lines = [
    "# biome-seatbelt baseline",
    `# Generated: ${ts}`,
    "# file\trule\tcount",
  ];

  const sorted = [...entries.entries()]
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => sortKey(a, b));

  for (const [key, count] of sorted) {
    const [file, rule] = key.split("\t");
    lines.push(`${file}\t${rule}\t${count}`);
  }

  writeFileSync(absPath, lines.join("\n") + "\n", "utf-8");
  return sorted.length;
}

// ---------------------------------------------------------------------------
// JSON output helper
// ---------------------------------------------------------------------------

function jsonOutput(data) {
  console.log(JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdInit(args) {
  if (!args.json) {
    console.log(bold("biome-seatbelt init"));
    console.log(dim("Running biome lint..."));
  }

  const raw = await runBiome(args.biomeBin, args.biomeArgs);
  const counts = parseBiomeOutput(raw, args.severity);

  // If --update flag, merge with existing baseline
  if (args.allowIncrease) {
    const existing = readBaseline(args.file);
    if (existing) {
      // Keep existing entries, add new ones
      for (const [key, count] of counts) {
        if (!existing.entries.has(key)) {
          existing.entries.set(key, count);
        }
        // Don't update existing entries — only add new ones
      }
      const entryCount = writeBaseline(args.file, existing.entries);

      if (args.json) {
        const newKeys = [...counts.keys()].filter(
          (k) => !existing.entries.has(k) || existing.entries.get(k) !== counts.get(k),
        );
        jsonOutput({
          status: "ok",
          command: "init",
          file: args.file,
          entries: entryCount,
          newEntries: newKeys.length,
        });
        return;
      }

      console.log(
        green(`Baseline updated: ${bold(args.file)} (${entryCount} entries)`),
      );
      console.log(dim("Existing entries preserved, new violations added."));
      return;
    }
    // No existing baseline — fall through to normal init
  }

  const entryCount = writeBaseline(args.file, counts);

  if (args.json) {
    const byRule = new Map();
    for (const [key, count] of counts) {
      const rule = key.split("\t")[1];
      byRule.set(rule, (byRule.get(rule) || 0) + count);
    }
    jsonOutput({
      status: "ok",
      command: "init",
      file: args.file,
      entries: entryCount,
      totalViolations: [...counts.values()].reduce((a, b) => a + b, 0),
      rules: Object.fromEntries(byRule),
    });
    return;
  }

  // Summary by rule
  const byRule = new Map();
  for (const [key, count] of counts) {
    const rule = key.split("\t")[1];
    byRule.set(rule, (byRule.get(rule) || 0) + count);
  }

  console.log(
    green(`Baseline created: ${bold(args.file)} (${entryCount} entries)`),
  );

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

async function cmdCheck(args) {
  if (!args.json) {
    console.log(bold("biome-seatbelt check"));
  }

  const baseline = readBaseline(args.file);
  if (!baseline) {
    if (args.json) {
      jsonOutput({
        status: "error",
        command: "check",
        message: `No baseline found at ${args.file}. Run biome-seatbelt init first.`,
      });
      process.exit(1);
    }
    console.error(red(`No baseline found at ${bold(args.file)}`));
    console.error(dim("Run `biome-seatbelt init` first."));
    process.exit(1);
  }

  if (!args.json) {
    console.log(dim("Running biome lint..."));
  }

  const raw = await runBiome(args.biomeBin, args.biomeArgs);
  const current = parseBiomeOutput(raw, args.severity);

  // Find regressions and new violations
  const regressions = [];
  const newViolations = [];
  const improvements = [];

  for (const [key, currentCount] of current) {
    const baselineCount = baseline.entries.get(key);

    if (baselineCount === undefined) {
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

  if (args.json) {
    const totalBaseline = [...baseline.entries.values()].reduce(
      (a, b) => a + b,
      0,
    );
    const totalCurrent = [...current.values()].reduce((a, b) => a + b, 0);

    jsonOutput({
      status: hasFailures ? "fail" : "pass",
      command: "check",
      regressions: regressions.map((r) => {
        const [file, rule] = r.key.split("\t");
        return { file, rule, baseline: r.baseline, current: r.current, delta: r.delta };
      }),
      newViolations: newViolations.map((v) => {
        const [file, rule] = v.key.split("\t");
        return { file, rule, count: v.count };
      }),
      improvements: improvements.map((imp) => {
        const [file, rule] = imp.key.split("\t");
        return { file, rule, baseline: imp.baseline, current: imp.current, delta: imp.delta };
      }),
      summary: {
        baselineTotal: totalBaseline,
        currentTotal: totalCurrent,
        delta: totalCurrent - totalBaseline,
      },
    });
    if (hasFailures) process.exit(1);
    return;
  }

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
    green(bold("  All clear!")) +
      ` ${totalCurrent} violations remaining` +
      (improved > 0 ? ` (${green(`${improved} improved`)})` : ""),
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

async function cmdUpdate(args) {
  if (!args.json) {
    console.log(bold("biome-seatbelt update"));
  }

  const baseline = readBaseline(args.file);
  if (!baseline) {
    if (args.json) {
      jsonOutput({
        status: "error",
        command: "update",
        message: `No baseline found at ${args.file}. Run biome-seatbelt init first.`,
      });
      process.exit(1);
    }
    console.error(red(`No baseline found at ${bold(args.file)}`));
    console.error(dim("Run `biome-seatbelt init` first."));
    process.exit(1);
  }

  if (!args.json) {
    console.log(dim("Running biome lint..."));
  }

  const raw = await runBiome(args.biomeBin, args.biomeArgs);
  const current = parseBiomeOutput(raw, args.severity);

  let tightened = 0;
  let removed = 0;
  const updated = new Map();

  for (const [key, baselineCount] of baseline.entries) {
    const currentCount = current.get(key) || 0;

    if (currentCount === 0) {
      removed++;
    } else if (currentCount < baselineCount) {
      updated.set(key, currentCount);
      tightened++;
    } else {
      // Same or worse — keep baseline (never loosen)
      updated.set(key, baselineCount);
    }
  }

  const entryCount = writeBaseline(args.file, updated);

  if (args.json) {
    jsonOutput({
      status: "ok",
      command: "update",
      tightened,
      removed,
      entriesRemaining: entryCount,
    });
    return;
  }

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

async function cmdStatus(args) {
  if (!args.json) {
    console.log(bold("biome-seatbelt status"));
  }

  const baseline = readBaseline(args.file);
  if (!baseline) {
    if (args.json) {
      jsonOutput({
        status: "error",
        command: "status",
        message: `No baseline found at ${args.file}. Run biome-seatbelt init first.`,
      });
      process.exit(1);
    }
    console.error(red(`No baseline found at ${bold(args.file)}`));
    console.error(dim("Run `biome-seatbelt init` first."));
    process.exit(1);
  }

  if (!args.json) {
    console.log(dim("Running biome lint..."));
  }

  const raw = await runBiome(args.biomeBin, args.biomeArgs);
  const current = parseBiomeOutput(raw, args.severity);

  // Totals
  const totalBaseline = [...baseline.entries.values()].reduce(
    (a, b) => a + b,
    0,
  );
  const totalCurrent = [...current.values()].reduce((a, b) => a + b, 0);
  const totalDelta = totalCurrent - totalBaseline;

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
    ruleStats.push({
      rule,
      baseline: base,
      current: curr,
      delta: curr - base,
    });
  }

  ruleStats.sort((a, b) => a.delta - b.delta);

  if (args.json) {
    jsonOutput({
      status: "ok",
      command: "status",
      summary: {
        baselineTotal: totalBaseline,
        currentTotal: totalCurrent,
        delta: totalDelta,
      },
      rules: ruleStats,
      files: {
        baseline: new Set(
          [...baseline.entries.keys()].map((k) => k.split("\t")[0]),
        ).size,
        current: new Set([...current.keys()].map((k) => k.split("\t")[0]))
          .size,
      },
    });
    return;
  }

  console.log("");
  console.log(`  Baseline:  ${bold(String(totalBaseline))} violations`);
  console.log(`  Current:   ${bold(String(totalCurrent))} violations`);
  console.log(
    `  Delta:     ${totalDelta <= 0 ? green(String(totalDelta)) : red(`+${totalDelta}`)} violations`,
  );

  // Per-rule table
  const improving = ruleStats.filter((r) => r.delta < 0);
  const regressed = ruleStats.filter((r) => r.delta > 0);
  const stuck = ruleStats.filter((r) => r.delta === 0 && r.current > 0);

  if (improving.length > 0) {
    console.log("");
    console.log(green(bold("  Improving:")));
    for (const r of improving) {
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
  --json              Output structured JSON (for agents/tooling)
  --severity <level>  Min severity: error, warning, info (default: warning)
  --biome-bin <path>  Path to biome binary (default: biome)
  --update            With 'init': add new violations without resetting existing
  -- <args>           Forward remaining args to biome lint

${bold("ENVIRONMENT VARIABLES")}
  CI=1                     Auto-run 'check' when no command given
  BIOME_SEATBELT_FILE      Same as --file
  BIOME_SEATBELT_FROZEN=1  Same as --frozen
  BIOME_SEATBELT_SEVERITY  Same as --severity
  BIOME_SEATBELT_BIOME_BIN Same as --biome-bin

${bold("EXAMPLES")}
  biome-seatbelt init                    # Create baseline
  biome-seatbelt init --update           # Add new rule violations to existing baseline
  biome-seatbelt check                   # CI check (exit 1 on regressions)
  biome-seatbelt check --json            # CI check with structured output
  biome-seatbelt update                  # Tighten after fixes
  biome-seatbelt status --verbose        # Full progress report
  biome-seatbelt check -- --changed      # Only lint changed files
`);
}

function cmdVersion() {
  console.log(`biome-seatbelt ${VERSION}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));

switch (args.command) {
  case "init":
    await cmdInit(args);
    break;
  case "check":
    await cmdCheck(args);
    break;
  case "update":
    await cmdUpdate(args);
    break;
  case "status":
    await cmdStatus(args);
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
