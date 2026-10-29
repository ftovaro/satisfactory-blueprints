#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { blueprintToJson, readBlueprint, writeBlueprint } from "./blueprint-io.js";
import { resolveBlueprintRoot } from "./paths.js";
import { formatSummary, summarize } from "./summary.js";

const USAGE = `Usage: sbp <command> [options]

Commands:
  list [session]              List sessions, or the blueprints inside one session
  inspect <file|session/name> Print a readable summary of a blueprint
  dump <file|session/name>    Print the full blueprint as JSON (use --out <file> to save it)
  roundtrip <file|session/name>
                              Parse and re-serialize a blueprint, then compare it to the original
  scan [session]              Parse every blueprint and report which ones fail

Options:
  --dir <path>   Blueprint root folder (default: %LOCALAPPDATA%\\FactoryGame\\Saved\\SaveGames\\blueprints,
                 or the SATISFACTORY_BLUEPRINT_DIR environment variable)
  --out <path>   Output file for "dump"
  --json         Print "inspect" output as JSON
`;

interface Args {
  command?: string;
  positional: string[];
  flags: Record<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { positional: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        args.flags[arg.slice(2)] = next;
        i++;
      } else {
        args.flags[arg.slice(2)] = true;
      }
    } else if (!args.command) {
      args.command = arg;
    } else {
      args.positional.push(arg);
    }
  }
  return args;
}

/** Accepts a direct path to an .sbp file, or "Session/Blueprint Name" relative to the blueprint root. */
function resolveBlueprintPath(target: string, root: string): string {
  const candidates = [target, `${target}.sbp`, path.join(root, target), path.join(root, `${target}.sbp`)];
  const found = candidates.find((c) => c.toLowerCase().endsWith(".sbp") && fs.existsSync(c));
  if (!found) throw new Error(`Blueprint not found: ${target}`);
  return found;
}

function listSbpFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".sbp")).sort().map((f) => path.join(dir, f));
}

function listSessions(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
}

function cmdList(root: string, session?: string): void {
  if (session) {
    for (const file of listSbpFiles(path.join(root, session))) console.log(path.basename(file, ".sbp"));
    return;
  }
  console.log(`Blueprint root: ${root}\n`);
  for (const name of listSessions(root)) {
    console.log(`${String(listSbpFiles(path.join(root, name)).length).padStart(4)}  ${name}`);
  }
}

function cmdInspect(file: string, asJson: boolean): void {
  const summary = summarize(readBlueprint(file));
  console.log(asJson ? JSON.stringify(summary, null, 2) : formatSummary(summary));
}

function cmdDump(file: string, out?: string): void {
  const json = blueprintToJson(readBlueprint(file));
  if (out) {
    fs.writeFileSync(out, json);
    console.log(`Wrote ${out}`);
  } else {
    console.log(json);
  }
}

function cmdRoundtrip(file: string): void {
  const blueprint = readBlueprint(file);
  const tempDir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TEMP ?? "/tmp"), "sbp-roundtrip-"));
  try {
    const written = writeBlueprint(blueprint, tempDir);
    const reparsed = readBlueprint(written.sbp);
    // Compressed bytes may legitimately differ, so compare the decoded content instead.
    const same = blueprintToJson(reparsed) === blueprintToJson(blueprint);
    console.log(same ? "OK: re-serialized blueprint decodes to identical content." : "MISMATCH: content changed after round trip.");
    if (!same) process.exitCode = 1;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function cmdScan(root: string, session?: string): void {
  const sessions = session ? [session] : listSessions(root);
  let ok = 0;
  let failed = 0;
  for (const name of sessions) {
    for (const file of listSbpFiles(path.join(root, name))) {
      try {
        readBlueprint(file);
        ok++;
      } catch (error) {
        failed++;
        console.log(`FAIL  ${name}/${path.basename(file)}: ${(error as Error).message.split("\n")[0]}`);
      }
    }
  }
  console.log(`\nParsed ${ok} blueprint(s), ${failed} failed.`);
  if (failed > 0) process.exitCode = 1;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const root = resolveBlueprintRoot(typeof args.flags.dir === "string" ? args.flags.dir : undefined);
  const target = args.positional[0];
  const requireTarget = () => {
    if (!target) throw new Error(`"${args.command}" needs a blueprint file or "Session/Name".`);
    return resolveBlueprintPath(target, root);
  };

  switch (args.command) {
    case "list":
      return cmdList(root, target);
    case "inspect":
      return cmdInspect(requireTarget(), args.flags.json === true);
    case "dump":
      return cmdDump(requireTarget(), typeof args.flags.out === "string" ? args.flags.out : undefined);
    case "roundtrip":
      return cmdRoundtrip(requireTarget());
    case "scan":
      return cmdScan(root, target);
    default:
      console.log(USAGE);
  }
}

try {
  main();
} catch (error) {
  console.error(`Error: ${(error as Error).message}`);
  process.exitCode = 1;
}
