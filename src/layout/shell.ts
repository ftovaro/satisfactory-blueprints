import { BlueprintBuilder, Placed } from "../builder.js";
import { Quat, Transform, Vec3, multiply, transform, vec, yaw } from "../geometry.js";
import { cloneDeep } from "../templates.js";
import { StyleKit, loadPaints } from "./styles.js";

/**
 * The building around a factory, in a style kit (src/layout/styles.ts): walls standing on the ground
 * it is placed on, windows, a door, belt and pipe openings, small pillars at the corners and in bands
 * along the walls, beams along the roof's edges, a parapet, the roof (glass in places) and a
 * wall-mounted power inlet. Every piece gets the paint the kit's source blueprints give it.
 *
 * Geometry learned from real blueprints:
 * - an 8 m x 4 m (or 8 m x 1 m) wall has its origin at the bottom center; it spans its local Y (8 m)
 *   and Z, and its local +X points away from the foundation it stands on (outward);
 * - a conveyor wall panel passes its belt through its middle, 1 m above its base;
 * - wall accessories (Conveyor Wall Hole, Pipeline Wall Support, Wall Power Pole) sit in the wall
 *   plane with their +X along the wall's normal;
 * - a small pillar is 4 m long with its origin in its middle, standing along Z; turned by
 *   (0, -√½, 0, √½) it lies along X. Corner columns stand on the wall corners, bands lie in the wall plane;
 * - a painted beam starts at its origin and runs mLength along its local +X; on a roof edge it sits
 *   10 cm above the wall tops, with Beam Connectors 30 cm above them at the corners;
 * - a 1 m foundation's top is 50 cm above its origin.
 */

const WALL_WIDTH = 800;
const WALL_HEIGHT = 400;
const FOUNDATION = 800;
const PILLAR = 400;
const LYING_ALONG_X: Quat = { x: 0, y: -Math.SQRT1_2, z: 0, w: Math.SQRT1_2 };

export interface Opening {
  /** Where a belt or pipe crosses the envelope (on one of its sides). */
  at: Vec3;
  kind: "belt" | "pipe";
}

export interface ShellOptions {
  envelope: { minX: number; maxX: number; minY: number; maxY: number };
  /** Height of the ground the walls stand on. */
  floorZ: number;
  /** Heights of the upper floors' tops (pillar bands run there). */
  levels?: number[];
  /** Height of the roof's underside (whole 4 m walls above the floor). */
  roofZ: number;
  openings: Opening[];
  /** Whether a door at ground level, at `at` on the wall and opening along `inward`, would be clear. */
  doorway?: (at: Vec3, inward: Vec3) => boolean;
  kit: StyleKit;
}

export interface Shell {
  /** Wall power pole on the outside of the back wall: connect the factory to your grid here. */
  inlet?: { pole: Placed; position: Vec3 };
  pieces: number;
}

export function buildShell(b: BlueprintBuilder, options: ShellOptions): Shell {
  const { envelope: e, floorZ, roofZ, openings, kit } = options;
  const paints = loadPaints()[kit.name] ?? {};
  const pick = (list?: string[]) => (list ? b.pick(...list) : undefined);
  const solid = pick(kit.wall);
  if (!solid) return { pieces: 0 };
  const window = pick(kit.window) ?? solid;
  const door = pick(kit.door) ?? solid;
  const beltPanel = pick(kit.beltPanel);
  const beltHole = b.pick("Build_ConveyorWallHole_C");
  const pipeHole = b.pick("Build_PipelineSupportWallHole_C");
  const pillar = pick(kit.pillar);
  const beam = pick(kit.beam);
  const connector = pick(kit.beamConnector);
  const trim = pick(kit.trim);
  const roof = pick(kit.roof) ?? b.pick("Build_Foundation_Concrete_8x1_C");
  const glass = kit.roofGlass ? b.pick("Build_FoundationGlass_01_C") : undefined;
  const wallPole = b.pick("Build_PowerPoleWall_C");

  let pieces = 0;
  // Places a piece with the kit's paint (walls' paint for wall pieces the sources never painted).
  const place = (type: string, at: Transform): Placed => {
    const placed = b.place(type, at);
    const paint = (paints[type] ?? (/Wall_/.test(type) ? paints[solid] : undefined)) as { mCustomizationData?: unknown; mColorSlot?: unknown } | undefined;
    const props = placed.entity.properties as any;
    if (paint?.mCustomizationData) props.mCustomizationData = cloneDeep(paint.mCustomizationData);
    if (paint?.mColorSlot) props.mColorSlot = cloneDeep(paint.mColorSlot);
    pieces++;
    return placed;
  };
  const turned = (at: Vec3, rotation: Quat): Transform => ({ rotation, translation: at, scale3d: vec(1, 1, 1) });

  const courses = Math.round((roofZ - floorZ) / WALL_HEIGHT);
  const inwardOf = (yawDeg: number) => vec(-Math.round(Math.cos((yawDeg * Math.PI) / 180)), -Math.round(Math.sin((yawDeg * Math.PI) / 180)), 0);
  // Sides: [fixed coordinate, along axis range, outward yaw]; a wall's +X points outward.
  const sides = [
    { name: "back", x: e.minX, y: undefined, from: e.minY, to: e.maxY, yaw: 180 },
    { name: "front", x: e.maxX, y: undefined, from: e.minY, to: e.maxY, yaw: 0 },
    { name: "right", x: undefined, y: e.minY, from: e.minX, to: e.maxX, yaw: -90 },
    { name: "left", x: undefined, y: e.maxY, from: e.minX, to: e.maxX, yaw: 90 },
  ] as const;
  type Side = (typeof sides)[number];
  const pointOn = (side: Side, along: number, z: number) => (side.x !== undefined ? vec(side.x, along, z) : vec(along, side.y!, z));

  // Every panel: which openings cross it and where.
  const panels = sides.flatMap((side) => {
    const segments = Math.round((side.to - side.from) / WALL_WIDTH);
    const onSide = openings.filter((o) => (side.x !== undefined ? Math.abs(o.at.x - side.x) < 50 : Math.abs(o.at.y - side.y!) < 50));
    return Array.from({ length: segments }, (_, s) => {
      const along = side.from + (s + 0.5) * WALL_WIDTH;
      return Array.from({ length: courses }, (_, c) => {
        const z = floorZ + c * WALL_HEIGHT;
        const here = onSide.filter((o) => {
          const pos = side.x !== undefined ? o.at.y : o.at.x;
          return Math.abs(pos - along) <= WALL_WIDTH / 2 && o.at.z >= z && o.at.z < z + WALL_HEIGHT;
        });
        return { side, s, segments, c, z, at: pointOn(side, along, z), here };
      });
    }).flat();
  });

  // The door: on the ground course, in a panel no line crosses, preferring the right side and the
  // middle of a side, where the way in is clear.
  const order = ["right", "left", "front", "back"];
  const fromMiddle = (p: { s: number; segments: number }) => Math.abs(p.s - (p.segments - 1) / 2);
  const candidates = panels
    .filter((p) => p.c === 0 && p.here.length === 0)
    .sort((a, c) => order.indexOf(a.side.name) - order.indexOf(c.side.name) || fromMiddle(a) - fromMiddle(c));
  const doorPanel = candidates.find((p) => options.doorway?.(p.at, inwardOf(p.side.yaw)) ?? true) ?? candidates[0];

  // Windows: on the long sides above the ground course ("sides"), on the courses between ground and
  // top ("middle"), or on every other panel above the ground course ("upper").
  const glazed = (p: (typeof panels)[number]) => {
    if (p.c === 0) return false;
    if (kit.windows === "sides") return p.side.x === undefined;
    if (kit.windows === "middle") return p.c < courses - 1 || courses <= 2;
    return p.s % 2 === 1;
  };
  for (const p of panels) {
    const { side, here } = p;
    const centered = here.length === 1 && here[0].kind === "belt" && beltPanel
      && Math.abs((side.x !== undefined ? here[0].at.y - p.at.y : here[0].at.x - p.at.x)) < 1 && Math.abs(here[0].at.z - p.z - 100) < 1;
    // Openings without a matching hole piece leave the panel out.
    if (!centered && here.some((o) => !(o.kind === "belt" ? beltHole : pipeHole))) continue;
    const type = centered ? beltPanel! : p === doorPanel ? door : glazed(p) && here.length === 0 ? window : solid;
    place(type, transform(p.at, side.yaw));
    if (centered) continue;
    for (const o of here) place((o.kind === "belt" ? beltHole : pipeHole)!, transform(o.at, side.yaw));
  }

  if (pillar) {
    // Corner columns from the ground to the roof.
    for (const x of [e.minX, e.maxX]) {
      for (const y of [e.minY, e.maxY]) {
        for (let c = 0; c < courses; c++) place(pillar, transform(vec(x, y, floorZ + c * WALL_HEIGHT + PILLAR / 2)));
      }
    }
    // Bands of pillars lying in the walls: at every floor line, or as a cornice under the roof.
    const bandHeights = kit.bands === "cornice" ? [roofZ - 100]
      : kit.bands === "floors" ? [...new Set([floorZ + WALL_HEIGHT, ...(options.levels ?? [])])].filter((z) => z < roofZ) : [];
    for (const z of bandHeights) {
      for (const side of sides) {
        const rotation = side.x !== undefined ? multiply(yaw(90), LYING_ALONG_X) : LYING_ALONG_X;
        for (let along = side.from + PILLAR / 2; along < side.to; along += PILLAR) place(pillar, turned(pointOn(side, along, z), rotation));
      }
    }
  }

  // Beams along the roof's edges, joined at the corners.
  if (beam) {
    const edges = [
      { from: vec(e.minX, e.minY), yaw: 90, length: e.maxY - e.minY },
      { from: vec(e.minX, e.maxY), yaw: 0, length: e.maxX - e.minX },
      { from: vec(e.maxX, e.maxY), yaw: -90, length: e.maxY - e.minY },
      { from: vec(e.maxX, e.minY), yaw: 180, length: e.maxX - e.minX },
    ];
    for (const edge of edges) {
      const placed = place(beam, transform(vec(edge.from.x, edge.from.y, roofZ + 10), edge.yaw));
      const props = placed.entity.properties as any;
      if (props.mLength) props.mLength.value = edge.length;
      if (connector) place(connector, transform(vec(edge.from.x, edge.from.y, roofZ + 30), edge.yaw));
    }
  }

  // Roof of 1 m foundations resting on the walls: glass away from the edges ("all") or a
  // checkerboard of skylights ("skylights").
  if (roof) {
    const nx = Math.round((e.maxX - e.minX) / FOUNDATION), ny = Math.round((e.maxY - e.minY) / FOUNDATION);
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        const inner = i > 0 && j > 0 && i < nx - 1 && j < ny - 1;
        const isGlass = glass && inner && (kit.roofGlass === "all" || (i + j) % 2 === 0);
        place(isGlass ? glass! : roof, transform(vec(e.minX + (i + 0.5) * FOUNDATION, e.minY + (j + 0.5) * FOUNDATION, roofZ + 50)));
      }
    }
  }
  // A low wall around the roof.
  if (trim) {
    for (const side of sides) {
      for (let along = side.from + WALL_WIDTH / 2; along < side.to; along += WALL_WIDTH) place(trim, transform(pointOn(side, along, roofZ + 100), side.yaw));
    }
  }

  // Power inlet: a wall pole on the outside of the back wall, at head height.
  let inlet: Shell["inlet"];
  if (wallPole) {
    const position = vec(e.minX, e.minY + WALL_WIDTH / 2, floorZ + 250);
    inlet = { pole: place(wallPole, transform(position, 180)), position };
  }
  return { inlet, pieces };
}
