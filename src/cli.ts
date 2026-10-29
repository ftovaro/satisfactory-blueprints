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
import { GENERATED_MARKER } from "./builder.js";
import { checkNetworks, findNetworks, formatNetworks } from "./fluids/network.js";
import { checkBlueprint, formatCheck } from "./analysis/check.js";
import { GAME_DATA_FILE, GameData, findItem, findRecipe as findGameRecipe, loadGameData, pickTier, recipesFor } from "./gamedata/index.js";
import { findDocsFile, importGameData } from "./gamedata/import.js";
import { fmt, machineClocks, perMinute, plan } from "./planner/plan.js";
import { MachineRowOptions, PortSpec, planLine } from "./generators/machine-row.js";
import { generateFactory } from "./generators/factory.js";
import { rowOptionsFor } from "./generators/row-options.js";
import { Blueprint as BlueprintType } from "@etothepii/satisfactory-file-parser";
import { formatPlan } from "./planner/format.js";

const USAGE = `Usage: sbp <command> [options]

Commands:
  list [session]              List sessions, or the blueprints inside one session
  inspect <file|session/name> Print a readable summary of a blueprint
  dump <file|session/name>    Print the full blueprint as JSON (use --out <file> to save it)
  roundtrip <file|session/name>
                              Parse and re-serialize a blueprint, then compare it to the original
  scan [session]              Parse every blueprint and report which ones fail
  check <file|session/name>   Check links, belt and lift geometry, clashes, power and pipe networks
  connectors                  Print the belt/pipe connector positions learned from all blueprints
  learn                       Rebuild data/templates.json and data/connectors.json from your blueprints
  import-game-data [--game-dir <path>]
                              Read recipes, items and machines from your Satisfactory install
  recipes <item>              List the recipes that produce an item
  plan <item> <rate per min> [--recipe "<item>=<recipe>"]... [--input <item>]...
                              Plan a production chain: machines, clock speeds, belts and power
  generate factory <item> <rate per min> [--recipe "<item>=<recipe>"]... [--input <item>]...
               (--session <name> | --out-dir <path>) [--name <name>] [--force]
                              Generate a complete factory: every step stacked in floors, raw inputs
                              and the product at ground level
  generate row --machine <constructor|smelter> (--count <n> | --rate <per min>) [--recipe <name>]
               [--belt <1-6>] [--pole <1-2>] (--session <name> | --out-dir <path>) [--name <name>] [--force]
                              Generate a row of machines with input/output manifolds and power.
                              With --rate, all machines run at 100% except the last one.

Options:
  --dir <path>   Blueprint root folder (default: %LOCALAPPDATA%\\FactoryGame\\Saved\\SaveGames\\blueprints,
                 or the SATISFACTORY_BLUEPRINT_DIR environment variable)
  --out <path>   Output file for "dump"
  --json         Print "inspect" output as JSON
`;

interface Args {
  command?: string;
  positional: string[];
  /** Last value of each flag. */
  flags: Record<string, string | true>;
  /** Every value of flags that may repeat, e.g. --recipe a --recipe b. */
  repeated: Record<string, string[]>;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { positional: [], flags: {}, repeated: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        args.flags[arg.slice(2)] = next;
        (args.repeated[arg.slice(2)] ??= []).push(next);
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
  // Learn only from blueprints made in the game, never from our own output.
  const blueprints = readAllBlueprints(root).filter((b) => !b.config.description.includes(GENERATED_MARKER));
  const catalog = learnConnectors(blueprints);
  fs.mkdirSync(path.dirname(CONNECTOR_FILE), { recursive: true });
  fs.writeFileSync(CONNECTOR_FILE, JSON.stringify(catalog, null, 2));
  console.log(`Connector data for ${Object.keys(catalog).length} building type(s) -> ${CONNECTOR_FILE}`);

  // Production, logistics and power buildings, plus the 1 m foundations used for factory floors.
  const templates = extractTemplates(blueprints, (typePath) => typePath.includes("/Buildable/Factory/") || /Build_Foundation(_Concrete)?_8x1(_01)?_C$/.test(typePath));
  saveTemplates(templates);
  const counts = templates.versions.map((v) => `save ${v.header.saveVersion}: ${Object.keys(v.types).length}`).join(", ");
  console.log(`Templates (${counts}) -> ${TEMPLATE_FILE}`);
}

function cmdGenerate(root: string, args: Args): void {
  const kind = args.positional[0];
  const flag = (name: string) => (typeof args.flags[name] === "string" ? (args.flags[name] as string) : undefined);
  const number = (name: string) => (flag(name) !== undefined ? Number(flag(name)) : undefined);
  const session = flag("session");
  const outDir = flag("out-dir") ?? (session ? path.join(root, session) : undefined);
  if (!outDir) throw new Error("Pass --session <name> to install into a game session, or --out-dir <path>.");
  if (session && !fs.existsSync(outDir)) throw new Error(`Session folder not found: ${outDir}. Existing sessions: ${listSessions(root).join(", ")}`);

  let blueprint: BlueprintType;
  if (kind === "row") {
    const options = number("rate") !== undefined ? rowFromRate(flag("recipe"), number("rate")!, number("belt")) : rowFromCount(flag("machine"), number("count"), flag("recipe"), number("belt"));
    blueprint = generateMachineRow({ ...options, pole: number("pole"), name: flag("name") });
  } else if (kind === "factory") {
    const rate = Number(args.positional[args.positional.length - 1]);
    const target = args.positional.slice(1, -1).join(" ");
    if (!target || !(rate > 0)) throw new Error('Usage: sbp generate factory <item> <rate per minute> (--session <name> | --out-dir <path>)');
    const result = generateFactory(loadGameData(), { target, rate, recipes: recipeFlags(args), inputs: args.repeated.input, name: flag("name"), pole: number("pole") });
    console.log(`${result.report}\n`);
    blueprint = result.blueprint;
  } else {
    throw new Error(`Unknown generator "${kind ?? ""}". Available: row, factory`);
  }

  const fileName = blueprint.name.replace(/[<>:"/\\|?*]/g, "_");
  if (fs.existsSync(path.join(outDir, `${fileName}.sbp`)) && args.flags.force !== true) {
    throw new Error(`"${fileName}.sbp" already exists in ${outDir}. Use --force to overwrite or --name to pick another name.`);
  }
  const written = writeBlueprint(blueprint, outDir, fileName);
  // Read it back to make sure the file we produced is valid.
  const reread = readBlueprint(written.sbp);
  console.log(formatSummary(summarize(reread)));
  const structure = checkBlueprint(reread);
  console.log(`
${formatCheck(structure)}`);
  // A generated blueprint should be spotless: any finding is a generator bug.
  if (structure.errors.length + structure.warnings.length > 0) process.exitCode = 1;
  // Every generated blueprint with pipes gets the fluid check; problems are printed in full.
  const networks = findNetworks(reread, tryLoadGameData());
  if (networks.length > 0) {
    const findings = checkNetworks(networks, tryLoadGameData());
    const problems = findings.filter((f) => f.severity !== "info");
    console.log(problems.length === 0
      ? `\nFluids: ${networks.length} pipe network(s), no problems found ("sbp fluids check" for details).`
      : `\n${formatNetworks(networks, findings, tryLoadGameData())}`);
  }
  console.log(`\nWrote ${written.sbp}`);
  if ((blueprint.header.designerDimension?.x ?? 0) > 6) {
    console.log("Warning: this layout is larger than the biggest Blueprint Designer (6 x 6 foundations).");
  }
}

type RowOptions = Omit<MachineRowOptions, "pole" | "name">;

function rowFromCount(machine: string | undefined, count: number | undefined, recipe: string | undefined, belt: number | undefined): RowOptions {
  if (!machine || count === undefined) throw new Error('"generate row" needs --rate and --recipe, or --machine and --count.');
  return { machine, count, recipe, belt };
}

/** Sizes the row with the planner: machines at 100% except the last, belts fast enough for the main lines. */
function rowFromRate(recipeQuery: string | undefined, rate: number, belt: number | undefined): RowOptions {
  if (!recipeQuery) throw new Error('"generate row --rate" needs --recipe (any recipe name, e.g. "Iron Plate" or "Cast Screws").');
  const data = loadGameData();
  const recipe = findGameRecipe(data, recipeQuery);
  const options: RowOptions = rowOptionsFor(data, recipe, rate, belt);
  const clocks = options.clocks!;
  const spec = { key: options.machine };

  const tiers = (list: number[]) => list.map((t) => `Mk${t}`).join(" ") || "-";
  console.log(`${spec.key}: ${clocks.length} machine(s), clocks ${clocks.map((c) => `${fmt(c * 100)}%`).join(", ")}`);
  for (const [side, ports] of [["input", options.inputs!], ["output", options.outputs!]] as const) {
    for (const p of ports) {
      const line = planLine(clocks.length, side, p, options);
      const total = fmt(p.perMachine!.reduce((a, b) => a + b, 0));
      console.log(`  ${side.padEnd(6)} ${p.label} (${total}/min, ${p.kind}): ${side === "input" ? `supply Mk${line.end} -> line ${tiers(line.chain)}` : `line ${tiers(line.chain)} -> exit Mk${line.end}`}, feeders ${tiers(line.feeders)}`);
    }
  }
  console.log();
  return options;
}

function tryLoadGameData(): GameData | undefined {
  try {
    return loadGameData();
  } catch {
    return undefined;
  }
}

/** "check <blueprint>": structural checks plus the fluid check. */
function cmdCheck(root: string, args: Args): void {
  const target = args.positional.join(" ");
  if (!target) throw new Error("Usage: sbp check <file|session/name>");
  const blueprint = readBlueprint(resolveBlueprintPath(target, root));
  const structure = checkBlueprint(blueprint);
  console.log(formatCheck(structure));
  const data = tryLoadGameData();
  const networks = findNetworks(blueprint, data);
  if (networks.length > 0) console.log(`
${formatNetworks(networks, checkNetworks(networks, data), data)}`);
  if (structure.errors.length > 0) process.exitCode = 1;
}

/** "fluids check <blueprint>": every pipe network with its endpoints, flows, elevations and rule violations. */
function cmdFluids(root: string, args: Args): void {
  const [sub, ...rest] = args.positional;
  if (sub !== "check" || rest.length === 0) throw new Error('Usage: sbp fluids check <file|session/name>');
  const blueprint = readBlueprint(resolveBlueprintPath(rest.join(" "), root));
  const data = tryLoadGameData();
  if (!data) console.log('(No game data: flows and fluid names are unknown. Run "sbp import-game-data" for a full check.)\n');
  const networks = findNetworks(blueprint, data);
  const findings = checkNetworks(networks, data);
  console.log(formatNetworks(networks, findings, data));
  if (findings.some((f) => f.severity === "error")) process.exitCode = 1;
}

function cmdImportGameData(args: Args): void {
  const docs = findDocsFile(typeof args.flags["game-dir"] === "string" ? args.flags["game-dir"] : undefined);
  const data = importGameData(docs);
  fs.mkdirSync(path.dirname(GAME_DATA_FILE), { recursive: true });
  fs.writeFileSync(GAME_DATA_FILE, JSON.stringify(data));
  console.log(`Read ${docs}`);
  console.log(`${Object.keys(data.items).length} items, ${Object.keys(data.recipes).length} machine recipes, ${Object.keys(data.machines).length} machines -> ${GAME_DATA_FILE}`);
}

function cmdRecipes(args: Args): void {
  const query = args.positional.join(" ");
  if (!query) throw new Error('"recipes" needs an item name.');
  const data = loadGameData();
  const item = findItem(data, query);
  for (const r of recipesFor(data, item.className)) {
    const io = (flows: typeof r.inputs, side: "inputs" | "outputs") =>
      flows.map((f) => `${fmt(perMinute(r, f.item, side))} ${data.items[f.item]?.name ?? f.item}`).join(" + ");
    console.log(`${r.name.padEnd(36)} ${data.machines[r.machine].name.padEnd(14)} ${io(r.inputs, "inputs")} -> ${io(r.outputs, "outputs")} (per min)`);
  }
}

/** --recipe "<item>=<recipe>" flags as an item -> recipe map. */
function recipeFlags(args: Args): Record<string, string> {
  return Object.fromEntries((args.repeated.recipe ?? []).map((pair) => {
    const [itemQuery, recipeQuery] = pair.split("=");
    if (!recipeQuery) throw new Error(`--recipe expects "<item>=<recipe>", got "${pair}".`);
    return [itemQuery.trim(), recipeQuery.trim()];
  }));
}

function cmdPlan(args: Args): void {
  const rate = Number(args.positional[args.positional.length - 1]);
  const item = args.positional.slice(0, -1).join(" ");
  if (!item || !(rate > 0)) throw new Error('Usage: sbp plan <item> <rate per minute>, e.g. sbp plan "Motor" 10');
  const data = loadGameData();
  console.log(formatPlan(plan(data, item, rate, { recipes: recipeFlags(args), inputs: args.repeated.input }), data));
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
    case "import-game-data":
      return cmdImportGameData(args);
    case "recipes":
      return cmdRecipes(args);
    case "plan":
      return cmdPlan(args);
    case "check":
      return cmdCheck(root, args);
    case "fluids":
      return cmdFluids(root, args);
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
