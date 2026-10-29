import { Blueprint, SaveComponent, SaveEntity, isSaveEntity } from "@etothepii/satisfactory-file-parser";
import { Vec3, directionToLocal, directionToWorld, normalize, scale, snap, toLocal, toWorld, vec } from "../geometry.js";

/**
 * Learns where buildings have their belt/pipe connectors by looking at real blueprints.
 *
 * The save format does not store connector positions for machines, but belts and pipes are splines
 * whose end points sit exactly on the connector they attach to. Transforming those end points into
 * the machine's local space gives the connector offset relative to the machine origin.
 */

export type ConnectorKind = "belt" | "pipe";

export interface ConnectorSample {
  offset: Vec3;
  /** Unit vector pointing away from the building, in building-local space. */
  normal: Vec3;
  kind: ConnectorKind;
}

export interface ConnectorStats {
  name: string;
  kind: ConnectorKind;
  offset: Vec3;
  normal: Vec3;
  samples: number;
  /** Largest distance (cm) between a sample and the median offset; high values mean inconsistent data. */
  spread: number;
}

export type ConnectorCatalog = Record<string, ConnectorStats[]>;

type SplinePoint = { location: Vec3; arrive: Vec3; leave: Vec3 };

function readVec(prop: any): Vec3 {
  const v = prop?.value ?? prop;
  return vec(v?.x ?? 0, v?.y ?? 0, v?.z ?? 0);
}

export function readSpline(entity: SaveEntity): SplinePoint[] | undefined {
  const data = (entity.properties as any).mSplineData;
  if (!data?.values) return undefined;
  return data.values.map((point: any) => ({
    location: readVec(point.properties.Location),
    arrive: readVec(point.properties.ArriveTangent),
    leave: readVec(point.properties.LeaveTangent),
  }));
}

function kindOf(typePath: string): ConnectorKind | undefined {
  if (/Conveyor(Belt)/.test(typePath)) return "belt";
  if (/Pipeline/.test(typePath) && !/Pump|Support|Junction/.test(typePath)) return "pipe";
  return undefined;
}

/** Spline end component name -> world position and the direction pointing out of the spline. */
function splineEnds(entity: SaveEntity): Map<string, { position: Vec3; outward: Vec3 }> | undefined {
  const spline = readSpline(entity);
  if (!spline || spline.length < 2) return undefined;
  const first = spline[0];
  const last = spline[spline.length - 1];
  const t = entity.transform as any;
  const ends = new Map<string, { position: Vec3; outward: Vec3 }>();
  // Index 0 is always the start of the spline, index 1 the end (ConveyorAny0/1, PipelineConnection0/1).
  ends.set("0", { position: toWorld(t, first.location), outward: normalize(directionToWorld(t, scale(first.leave, -1))) });
  ends.set("1", { position: toWorld(t, last.location), outward: normalize(directionToWorld(t, last.arrive)) });
  return ends;
}

/** Collects one sample per (building, connector) attachment found in the blueprint. */
export function collectConnectorSamples(blueprint: Blueprint, into: Map<string, Map<string, ConnectorSample[]>>): void {
  const byName = new Map(blueprint.objects.map((o) => [o.instanceName, o]));

  // Connector instance name -> where the attached spline touches it.
  const splineContacts = new Map<string, { position: Vec3; outward: Vec3; kind: ConnectorKind }>();
  for (const obj of blueprint.objects) {
    if (!isSaveEntity(obj)) continue;
    const kind = kindOf(obj.typePath);
    if (!kind) continue;
    const ends = splineEnds(obj);
    if (!ends) continue;
    for (const ref of obj.components) {
      const component = byName.get(ref.pathName) as SaveComponent | undefined;
      const target = (component?.properties as any)?.mConnectedComponent?.value?.pathName;
      const end = ends.get(ref.pathName.slice(-1));
      if (target && end) splineContacts.set(target, { ...end, kind });
    }
  }

  for (const obj of blueprint.objects) {
    if (!isSaveEntity(obj) || kindOf(obj.typePath)) continue;
    for (const ref of obj.components) {
      const contact = splineContacts.get(ref.pathName);
      if (!contact) continue;
      const connectorName = ref.pathName.split(".").pop()!;
      const t = obj.transform as any;
      // The spline's outward direction points away from the spline, i.e. into the building.
      const sample: ConnectorSample = {
        offset: toLocal(t, contact.position),
        normal: normalize(directionToLocal(t, scale(contact.outward, -1))),
        kind: contact.kind,
      };
      const perType = into.get(obj.typePath) ?? new Map<string, ConnectorSample[]>();
      const list = perType.get(connectorName) ?? [];
      list.push(sample);
      perType.set(connectorName, list);
      into.set(obj.typePath, perType);
    }
  }
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export function buildConnectorCatalog(samples: Map<string, Map<string, ConnectorSample[]>>): ConnectorCatalog {
  const catalog: ConnectorCatalog = {};
  for (const [typePath, connectors] of [...samples].sort((a, b) => a[0].localeCompare(b[0]))) {
    catalog[typePath] = [...connectors]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, list]) => {
        const offset = vec(
          snap(median(list.map((s) => s.offset.x)), 0.1),
          snap(median(list.map((s) => s.offset.y)), 0.1),
          snap(median(list.map((s) => s.offset.z)), 0.1),
        );
        const normal = normalize(vec(
          median(list.map((s) => s.normal.x)),
          median(list.map((s) => s.normal.y)),
          median(list.map((s) => s.normal.z)),
        ));
        const spread = Math.max(...list.map((s) => Math.hypot(s.offset.x - offset.x, s.offset.y - offset.y, s.offset.z - offset.z)));
        return {
          name,
          kind: list[0].kind,
          offset,
          normal: vec(snap(normal.x, 0.001), snap(normal.y, 0.001), snap(normal.z, 0.001)),
          samples: list.length,
          spread: snap(spread, 0.1),
        };
      });
  }
  return catalog;
}
