#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { blueprintToJson, readBlueprint, writeBlueprint } from "./blueprint-io.js";
import { resolveBlueprintRoot } from "./paths.js";
import { formatSummary, shortName, summarize } from "./summary.js";
import { Blueprint } from "@etothepii/satisfactory-file-parser";
import { ConnectorCatalog, ConnectorSample, buildConnectorCatalog, collectConnectorSamples } from "./analysis/connectors.js";
import { CONNECTOR_FILE } from "./connectors.js";
import { TEMPLATE_FILE, extractTemplates, saveTemplates } from "./templates.js";
import { generateMachineRow } from "./generators/machine-row.js";

const USAGE = `Usage: sbp <command> [options]

Commands:
  list [session]              List sessions, or the blueprints inside one session
  inspect <file|session/name> Print a readable summary of a blueprint
  dump <file|session/name>    Print the full blueprint as JSON (use --out <file> to save it)
  roundtrip <file|session/name>
                              Parse and re-serialize a blueprint, then compare it to the original
  scan [session]              Parse every blueprint and report which ones fail
  connectors                  Print the belt/pipe connector positions learned from all blueprints
  learn                       Rebuild data/templates.json and data/connectors.json from your blueprints
  generate row --machine <constructor|smelter> --count <n> [--recipe <name>] [--belt <1-5>] [--pole <1-2>]
               (--session <name> | --out-dir <path>) [--name <blueprint name>] [--force]
                              Generate a row of machines with input/output manifolds and power

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

function readAllBlueprints(root: string): Blueprint[] {
  const blueprints: Blueprint[] = [];
  for (const session of listSessions(root)) {
    for (const file of listSbpFiles(path.join(root, session))) {
      try {
        blueprints.push(readBlueprint(file));
      } catch {
        // Unparseable blueprints are reported by "scan"; skip them here.
      }
    }
  }
  return blueprints;
}

function learnConnectors(blueprints: Blueprint[]): ConnectorCatalog {
  const samples = new Map<string, Map<string, ConnectorSample[]>>();
  for (const blueprint of blueprints) collectConnectorSamples(blueprint, samples);
  return buildConnectorCatalog(samples);
}

function cmdLearn(root: string): void {
  const blueprints = readAllBlueprints(root);
  const catalog = learnConnectors(blueprints);
  fs.mkdirSync(path.dirname(CONNECTOR_FILE), { recursive: true });
  fs.writeFileSync(CONNECTOR_FILE, JSON.stringify(catalog, null, 2));
  console.log(`Connector data for ${Object.keys(catalog).length} building type(s) -> ${CONNECTOR_FILE}`);

  // Production, logistics and power buildings only; architecture is not needed by the generators.
  const library = extractTemplates(blueprints, (typePath) => typePath.includes("/Buildable/Factory/"));
  saveTemplates(library);
  console.log(`Templates for ${Object.keys(library.types).length} building type(s) -> ${TEMPLATE_FILE}`);
}

function cmdGenerate(root: string, args: Args): void {
  const kind = args.positional[0];
  if (kind !== "row") throw new Error(`Unknown generator "${kind ?? ""}". Available: row`);

  const flag = (name: string) => (typeof args.flags[name] === "string" ? (args.flags[name] as string) : undefined);
  const number = (name: string) => (flag(name) !== undefined ? Number(flag(name)) : undefined);
  if (!flag("machine") || number("count") === undefined) throw new Error('"generate row" needs --machine and --count.');

  const session = flag("session");
  const outDir = flag("out-dir") ?? (session ? path.join(root, session) : undefined);
  if (!outDir) throw new Error("Pass --session <name> to install into a game session, or --out-dir <path>.");
  if (session && !fs.existsSync(outDir)) throw new Error(`Session folder not found: ${outDir}. Existing sessions: ${listSessions(root).join(", ")}`);

  const blueprint = generateMachineRow({
    machine: flag("machine")!,
    count: number("count")!,
    recipe: flag("recipe"),
    belt: number("belt"),
    pole: number("pole"),
    name: flag("name"),
  });

  const fileName = blueprint.name.replace(/[<>:"/\\|?*]/g, "_");
  if (fs.existsSync(path.join(outDir, `${fileName}.sbp`)) && args.flags.force !== true) {
    throw new Error(`"${fileName}.sbp" already exists in ${outDir}. Use --force to overwrite or --name to pick another name.`);
  }
  const written = writeBlueprint(blueprint, outDir, fileName);
  // Read it back to make sure the file we produced is valid.
  console.log(formatSummary(summarize(readBlueprint(written.sbp))));
  console.log(`\nWrote ${written.sbp}`);
  if ((blueprint.header.designerDimension?.x ?? 0) > 6) {
    console.log("Warning: this layout is larger than the biggest Blueprint Designer (6 x 6 foundations).");
  }
}

function cmdConnectors(root: string): void {
  const catalog = learnConnectors(readAllBlueprints(root));
  const fmt = (v: { x: number; y: number; z: number }) => `${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)}`;
  for (const [typePath, connectors] of Object.entries(catalog)) {
    console.log(shortName(typePath));
    for (const c of connectors) {
      console.log(`  ${c.name.padEnd(22)} ${c.kind}  offset [${fmt(c.offset)}]  normal [${fmt(c.normal)}]  n=${c.samples}  spread=${c.spread}`);
    }
  }
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
    case "connectors":
      return cmdConnectors(root);
    case "learn":
      return cmdLearn(root);
    case "generate":
      return cmdGenerate(root, args);
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
