import { Blueprint, SaveComponent, SaveEntity, isSaveEntity } from "@etothepii/satisfactory-file-parser";
import { readSpline } from "../analysis/connectors.js";
import { toWorld } from "../geometry.js";
import { GameData } from "../gamedata/index.js";
import { perMinute } from "../planner/plan.js";
import {
  BUFFER_BUILDINGS, CONSUMER_BUILDINGS, HEAD_LIFT_MARGIN, HEAD_LIFT_SOURCES, HORIZONTAL_PIPE_HEAD_LIFT,
  JUNCTION_BUILDINGS, LOOPBACK_MIN_JUNCTIONS, PIPE_BUILDINGS, PRODUCER_BUILDINGS, PUMP_BUILDINGS, VALVE_BUILDINGS,
} from "./rules.js";

/**
 * Splits a blueprint's pipes into networks and checks each one against the fluid rules.
 *
 * A network is everything fluid can move through freely: pipes, junctions, valves and buffers
 * joined by their connectors. Machines are endpoints (they consume or produce), and powered pumps
 * split networks because they reset head lift: the pump's input side is a consumer of one network
 * and its output side is a head-lift source for the next one.
 */

export type EndpointRole = "consumer" | "producer";

export interface Endpoint {
  entity: SaveEntity;
  connector: string;
  role: EndpointRole;
  /** Fluid and m³/min, when the building's recipe is known. */
  fluids: { item: string; perMinute: number }[];
  /** Elevation (m) of the connector, and of the building's base for head-lift sources. */
  elevation: number;
  baseElevation: number;
  /** Head lift (m) this endpoint provides when it is a producer. */
  headLift?: number;
}

export interface OpenEnd {
  entity: SaveEntity;
  connector: string;
  elevation: number;
}

export interface FluidNetwork {
  id: number;
  pipes: SaveEntity[];
  junctions: SaveEntity[];
  endpoints: Endpoint[];
  openEnds: OpenEnd[];
  /** Lowest and highest pipe centerline elevation (m). */
  minElevation: number;
  maxElevation: number;
  /** m³/min of the slowest pipe in the network. */
  capacity: number;
  /** True when the pipes form at least one loop (e.g. a manifold with a loopback pipe). */
  hasLoop: boolean;
}

export type Severity = "error" | "warning" | "info";
export interface Finding {
  severity: Severity;
  network: number;
  message: string;
}

const PIPE_CONNECTION = /FGPipeConnection(Component|ComponentBase|Factory)$/;
const capacityOf = (typePath: string) => (/MK2/i.test(typePath) ? 600 : 300);
const className = (typePath: string) => typePath.split(".").pop() ?? typePath;
const isRouting = (typePath: string) =>
  PIPE_BUILDINGS.test(typePath) || JUNCTION_BUILDINGS.test(typePath) || VALVE_BUILDINGS.test(typePath) || BUFFER_BUILDINGS.test(typePath);

export function findNetworks(blueprint: Blueprint, data?: GameData): FluidNetwork[] {
  const byName = new Map(blueprint.objects.map((o) => [o.instanceName, o]));
  const entities = blueprint.objects.filter(isSaveEntity);
  const ownerOf = (component: string) => byName.get(component.slice(0, component.lastIndexOf("."))) as SaveEntity | undefined;
  const pipeConnectors = (entity: SaveEntity) =>
    entity.components.map((ref) => byName.get(ref.pathName) as SaveComponent | undefined).filter((c): c is SaveComponent => !!c && PIPE_CONNECTION.test(c.typePath));
  const linkOf = (component: SaveComponent): string | undefined => (component.properties as any).mConnectedComponent?.value?.pathName || undefined;

  // Union-find over routing buildings.
  const parent = new Map<string, string>();
  const find = (x: string): string => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x)!)), parent.get(x)!));
  const union = (a: string, b: string) => parent.set(find(a), find(b));
  for (const e of entities) if (isRouting(e.typePath)) parent.set(e.instanceName, e.instanceName);
  for (const e of entities) {
    if (!isRouting(e.typePath)) continue;
    for (const c of pipeConnectors(e)) {
      const other = linkOf(c);
      const owner = other ? ownerOf(other) : undefined;
      if (owner && isRouting(owner.typePath)) {
        union(e.instanceName, owner.instanceName);
      }
    }
  }

  const networks = new Map<string, FluidNetwork>();
  const networkOf = (entity: SaveEntity): FluidNetwork => {
    const key = find(entity.instanceName);
    let network = networks.get(key);
    if (!network) {
      network = { id: networks.size + 1, pipes: [], junctions: [], endpoints: [], openEnds: [], minElevation: Infinity, maxElevation: -Infinity, capacity: Infinity, hasLoop: false };
      networks.set(key, network);
    }
    return network;
  };

  for (const e of entities) {
    if (!isRouting(e.typePath)) continue;
    const network = networkOf(e);
    const t = e.transform as any;
    if (PIPE_BUILDINGS.test(e.typePath)) {
      network.pipes.push(e);
      network.capacity = Math.min(network.capacity, capacityOf(e.typePath));
      for (const point of readSpline(e) ?? []) {
        const z = toWorld(t, point.location).z / 100;
        network.minElevation = Math.min(network.minElevation, z);
        network.maxElevation = Math.max(network.maxElevation, z);
      }
    } else {
      network.junctions.push(e);
      const z = t.translation.z / 100;
      network.minElevation = Math.min(network.minElevation, z);
      network.maxElevation = Math.max(network.maxElevation, z);
    }
    for (const c of pipeConnectors(e)) {
      if (/SupportSnap/.test(c.instanceName)) continue;
      const other = linkOf(c);
      if (!other) network.openEnds.push({ entity: e, connector: c.instanceName.split(".").pop()!, elevation: endElevation(e, c) });
    }
  }

  // Endpoints: machines, extractors, generators and pumps attached to a network.
  for (const e of entities) {
    if (isRouting(e.typePath)) continue;
    for (const c of pipeConnectors(e)) {
      const other = linkOf(c);
      const owner = other ? ownerOf(other) : undefined;
      if (!owner || !isRouting(owner.typePath)) continue;
      const network = networkOf(owner);
      const connector = c.instanceName.split(".").pop()!;
      const role = roleOf(e, connector);
      const cls = className(e.typePath);
      const base = (e.transform as any).translation.z / 100;
      network.endpoints.push({
        entity: e,
        connector,
        role,
        fluids: data ? fluidsOf(e, role, data) : [],
        elevation: endElevation(owner, byName.get(other!) as SaveComponent),
        baseElevation: base,
        headLift: role === "producer" ? HEAD_LIFT_SOURCES[cls]?.recommended : undefined,
      });
    }
  }

  // A network with more internal links than a tree can have contains a loop.
  for (const network of networks.values()) {
    const nodes = network.pipes.length + network.junctions.length;
    const internalLinks = [...network.pipes, ...network.junctions]
      .flatMap((e) => pipeConnectors(e).map((c) => linkOf(c)).filter((o) => o && ownerOf(o) && isRouting(ownerOf(o)!.typePath) && find(ownerOf(o)!.instanceName) === find(e.instanceName)))
      .length / 2;
    network.hasLoop = internalLinks > nodes - 1;
  }
  return [...networks.values()];
}

/** Elevation (m) of a routing building's connector: the matching spline end for pipes, the center otherwise. */
function endElevation(entity: SaveEntity, component: SaveComponent | undefined): number {
  const t = entity.transform as any;
  const spline = readSpline(entity);
  if (spline && component) {
    const point = component.instanceName.endsWith("1") ? spline[spline.length - 1] : spline[0];
    return toWorld(t, point.location).z / 100;
  }
  return t.translation.z / 100;
}

function roleOf(entity: SaveEntity, connector: string): EndpointRole {
  if (PUMP_BUILDINGS.test(entity.typePath)) return connector.endsWith("1") ? "producer" : "consumer";
  if (PRODUCER_BUILDINGS.test(entity.typePath)) return "producer";
  if (CONSUMER_BUILDINGS.test(entity.typePath)) return "consumer";
  return /output/i.test(connector) ? "producer" : "consumer";
}

/** Fluid flows of a machine from its recipe and clock speed. A machine with two fluid inputs reports both. */
function fluidsOf(entity: SaveEntity, role: EndpointRole, data: GameData): { item: string; perMinute: number }[] {
  const recipePath: string | undefined = (entity.properties as any).mCurrentRecipe?.value?.pathName;
  if (!recipePath) return [];
  const recipe = data.recipes[recipePath.split(".").pop()!];
  if (!recipe) return [];
  const clock = (entity.properties as any).mCurrentPotential?.value ?? (entity.properties as any).mPendingPotential?.value ?? 1;
  const side = role === "consumer" ? "inputs" : "outputs";
  return recipe[side]
    .filter((f) => data.items[f.item]?.form !== "solid")
    .map((f) => ({ item: f.item, perMinute: perMinute(recipe, f.item, side) * clock }));
}

/** Runs every fluid rule against the networks. */
export function checkNetworks(networks: FluidNetwork[], data?: GameData): Finding[] {
  const findings: Finding[] = [];
  const name = (item: string) => data?.items[item]?.name ?? item;
  for (const n of networks) {
    const add = (severity: Severity, message: string) => findings.push({ severity, network: n.id, message });
    const producers = n.endpoints.filter((e) => e.role === "producer");
    const consumers = n.endpoints.filter((e) => e.role === "consumer");

    // One fluid per network.
    const produced = new Set(producers.flatMap((e) => e.fluids.map((f) => f.item)));
    const consumed = new Set(consumers.flatMap((e) => e.fluids.map((f) => f.item)));
    if (produced.size > 1) add("error", `Mixes fluids: ${[...produced].map(name).join(", ")}. A pipe network can carry only one fluid.`);
    const singleFluidConsumers = consumers.filter((e) => e.fluids.length === 1);
    const consumedSingles = new Set(singleFluidConsumers.map((e) => e.fluids[0].item));
    if (consumedSingles.size > 1) add("error", `Consumers need different fluids: ${[...consumedSingles].map(name).join(", ")}.`);
    for (const item of produced) if (consumed.size > 0 && !consumed.has(item)) add("warning", `${name(item)} is produced here but no consumer on this network uses it.`);

    // Throughput.
    const fluid = [...produced][0] ?? [...consumedSingles][0];
    const demand = consumers.reduce((s, e) => s + (e.fluids.find((f) => f.item === fluid)?.perMinute ?? 0), 0);
    const supply = producers.reduce((s, e) => s + (e.fluids.find((f) => f.item === fluid)?.perMinute ?? 0), 0);
    if (Number.isFinite(n.capacity)) {
      if (demand > n.capacity + 1e-6) add("error", `Consumers need ${demand.toFixed(1)} m³/min but the slowest pipe carries ${n.capacity} m³/min.`);
      if (supply > n.capacity + 1e-6) add("error", `Producers push ${supply.toFixed(1)} m³/min but the slowest pipe carries ${n.capacity} m³/min.`);
    }

    // Head lift (liquids only; gases ignore it).
    const isGas = fluid && data?.items[fluid]?.form === "gas";
    const top = n.maxElevation + 0.65; // fluid surface at the top of the highest pipe (inner radius ~0.65 m)
    if (!isGas) {
      const sources = producers.filter((p) => p.headLift !== undefined);
      for (const s of sources) {
        const needed = top - s.baseElevation;
        if (needed > s.headLift! + 1e-6) {
          add("error", `${className(s.entity.typePath)} gives ${s.headLift} m of head lift but the network rises ${needed.toFixed(1)} m above its base. Add a pump or lower the pipes.`);
        } else if (needed > s.headLift! - HEAD_LIFT_MARGIN) {
          add("warning", `${className(s.entity.typePath)} head lift margin is only ${(s.headLift! - needed).toFixed(1)} m (needs ${needed.toFixed(1)} of ${s.headLift} m).`);
        }
      }
      const inlets = n.openEnds.filter(() => sources.length === 0);
      for (const inlet of inlets) {
        const needed = top - inlet.elevation;
        if (needed > HORIZONTAL_PIPE_HEAD_LIFT) add("info", `Port ${inlet.connector} at ${inlet.elevation.toFixed(1)} m: whatever feeds it must provide at least ${needed.toFixed(1)} m of head lift at that height.`);
      }
    }

    // Manifold loopback.
    if (n.junctions.length >= LOOPBACK_MIN_JUNCTIONS && !n.hasLoop && consumers.length >= LOOPBACK_MIN_JUNCTIONS) {
      add("warning", `Manifold with ${n.junctions.length} junctions and no loopback pipe; flow may drop and slosh at the far end.`);
    }
    if (n.endpoints.length === 0 && n.openEnds.length > 0 && n.pipes.length > 0) add("info", "Not attached to any machine (only open ends).");
  }
  return findings;
}

export function formatNetworks(networks: FluidNetwork[], findings: Finding[], data?: GameData): string {
  if (networks.length === 0) return "No pipe networks in this blueprint.";
  const name = (item: string) => data?.items[item]?.name ?? item;
  const lines: string[] = [];
  for (const n of networks) {
    const fluids = [...new Set(n.endpoints.flatMap((e) => e.fluids.map((f) => name(f.item))))];
    lines.push(`Network ${n.id}: ${fluids.join(" / ") || "fluid unknown"}`);
    lines.push(`  ${n.pipes.length} pipe(s), ${n.junctions.length} junction/valve/buffer(s), capacity ${Number.isFinite(n.capacity) ? `${n.capacity} m³/min` : "-"}, elevation ${n.minElevation.toFixed(1)}..${n.maxElevation.toFixed(1)} m${n.hasLoop ? ", has loop" : ""}`);
    for (const e of n.endpoints) {
      const flows = e.fluids.map((f) => `${f.perMinute.toFixed(1)} m³/min ${name(f.item)}`).join(" + ") || "rate unknown";
      const lift = e.headLift !== undefined ? `, head lift ${e.headLift} m from base ${e.baseElevation.toFixed(1)} m` : "";
      lines.push(`  ${e.role === "producer" ? "out of" : "into  "} ${className(e.entity.typePath)}.${e.connector} at ${e.elevation.toFixed(1)} m: ${flows}${lift}`);
    }
    // Open pipe ends are ports (what Auto-Connect links); unused junction sides are normal in manifolds.
    const openPipes = n.openEnds.filter((o) => PIPE_BUILDINGS.test(o.entity.typePath));
    const unusedSides = n.openEnds.length - openPipes.length;
    for (const o of openPipes) lines.push(`  port   ${className(o.entity.typePath)}.${o.connector} at ${o.elevation.toFixed(1)} m (open end)`);
    if (unusedSides > 0) lines.push(`  (${unusedSides} unused junction side(s))`);
    const own = findings.filter((f) => f.network === n.id);
    for (const f of own) lines.push(`  ${f.severity.toUpperCase().padEnd(7)} ${f.message}`);
    if (own.length === 0) lines.push("  OK");
    lines.push("");
  }
  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.filter((f) => f.severity === "warning").length;
  lines.push(`${networks.length} network(s), ${errors} error(s), ${warnings} warning(s).`);
  return lines.join("\n");
}
