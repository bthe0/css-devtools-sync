#!/usr/bin/env node
// cli.ts — the `css-sync` bin. `css-sync init` onboards the tool onto a Vite
// project: detect the stack, preview a config diff, and (only on confirm) write
// css.devSourcemap + css-in-js babel plugins into the vite config.
//
// The interactive shell (readline / console / jailed write) is thin wiring.
// The tested core is renderPlan (InitPlan -> text) and runInit (plan -> gated
// write via injected IO). Writing a user-owned build config is irreversible-ish,
// so it happens ONLY behind an explicit confirm (or --yes) and NEVER for a
// non-"ready" status.
import fs from "node:fs";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { writeWorkspaceFile } from "./workspace.js";
import { planInit, type InitPlan } from "./init/index.js";

export interface InitIO {
  /** realpath-resolved target repo root. */
  readonly workspaceRoot: string;
  /** Print a block of text to the user. */
  readonly log: (msg: string) => void;
  /** Ask the user to approve the write. Not called when assumeYes is true. */
  readonly confirm: () => Promise<boolean>;
  /** Jailed write of the config file (workspaceRoot, target, content). */
  readonly write: (workspaceRoot: string, target: string, content: string) => void;
  /** --yes: skip the prompt and write. */
  readonly assumeYes?: boolean;
}

export interface InitOutcome {
  readonly status: InitPlan["status"];
  readonly written: boolean;
}

/** Format an InitPlan as the text the CLI prints before asking to write. */
export function renderPlan(plan: InitPlan): string {
  const lines: string[] = [plan.message, ""];

  if (plan.status === "ready") {
    lines.push(plan.diff.trimEnd(), "");
  }

  if (plan.requiredDevDeps.length > 0) {
    const names = plan.requiredDevDeps.map((d) => d.pkg).join(" ");
    lines.push("Install these dev dependencies to unlock the full mapping, then re-run css-sync init:");
    for (const d of plan.requiredDevDeps) lines.push(`  • ${d.pkg} — ${d.reason}`);
    lines.push(`  npm i -D ${names}`, "");
  }

  if (plan.tailwindNote) lines.push(plan.tailwindNote, "");

  for (const w of plan.warnings) lines.push(`⚠ ${w}`);
  if (plan.warnings.length > 0) lines.push("");

  return lines.join("\n").trimEnd() + "\n";
}

/** Run init end to end against injected IO. Writes only on confirm + "ready". */
export async function runInit(io: InitIO): Promise<InitOutcome> {
  const plan = planInit(io.workspaceRoot);
  io.log(renderPlan(plan));

  if (plan.status !== "ready" || plan.newSource === null || plan.configPath === null) {
    return { status: plan.status, written: false };
  }

  const approved = io.assumeYes === true || (await io.confirm());
  if (!approved) {
    io.log("No changes written.");
    return { status: plan.status, written: false };
  }

  io.write(io.workspaceRoot, plan.configPath, plan.newSource);
  io.log(`Updated ${plan.relConfigPath ?? plan.configPath}. Start your dev server and open the css-sync DevTools panel.`);
  return { status: plan.status, written: true };
}

interface ParsedArgs {
  readonly command: string | undefined;
  readonly dir: string;
  readonly yes: boolean;
  readonly help: boolean;
}

function parse(argv: string[]): ParsedArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dir: { type: "string", short: "d" },
      yes: { type: "boolean", short: "y", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  return {
    command: positionals[0],
    dir: values.dir ?? process.cwd(),
    yes: values.yes ?? false,
    help: values.help ?? false,
  };
}

const USAGE = `css-sync — DevTools-to-source CSS sync

Usage:
  css-sync init [--dir <path>] [--yes]

Options:
  -d, --dir <path>   Target project root (default: current directory)
  -y, --yes          Apply the config edit without an interactive prompt
  -h, --help         Show this help
`;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parse(argv);

  if (args.help || args.command === undefined) {
    process.stdout.write(USAGE);
    return args.command === undefined && !args.help ? 1 : 0;
  }
  if (args.command !== "init") {
    process.stderr.write(`Unknown command: ${args.command}\n\n${USAGE}`);
    return 1;
  }

  let workspaceRoot: string;
  try {
    workspaceRoot = fs.realpathSync(args.dir);
  } catch {
    process.stderr.write(`Directory not found: ${args.dir}\n`);
    return 1;
  }

  const confirm = async (): Promise<boolean> => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await rl.question("Apply this change to your vite config? [y/N] ")).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    } finally {
      rl.close();
    }
  };

  const outcome = await runInit({
    workspaceRoot,
    assumeYes: args.yes,
    log: (m) => process.stdout.write(m.endsWith("\n") ? m : m + "\n"),
    confirm,
    write: writeWorkspaceFile,
  });

  // ready-but-not-written (declined) is not an error; genuine non-actionable
  // states exit non-zero so scripts can branch on "nothing to onboard here".
  if (outcome.status === "no-vite" || outcome.status === "no-config" || outcome.status === "framework") {
    return 1;
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`css-sync: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
