/**
 * A 3D grid router for belts and pipes.
 *
 * Space is split into cells of CELL x CELL cm horizontally and LEVEL cm vertically (half a foundation
 * by one wall). A connection is a chain of cells; each cell holds one piece of it:
 *
 * - "straight": the line crosses the cell from one side to the opposite side;
 * - "turn": it enters by one side and leaves by an adjacent one (a 90° turn of radius CELL / 2);
 * - "rise": a vertical run (Conveyor Lift, or vertical pipe) that starts in this cell and ends in
 *   the cell `levels` above or below; it is entered and left horizontally, in any direction;
 * - "riser": a cell crossed by a vertical run;
 * - "branch": a splitter/junction inserted in a straight cell, sending part of the flow sideways.
 *
 * Cells are exclusive: once a connection uses a cell no other one can, so routed lines never clash.
 * Machines, their manifolds and floor slabs are blocked before routing. Routes are found with A*
 * (shortest path with turns and vertical moves costing a bit more than straight cells).
 */

export const CELL = 400;
export const LEVEL = 400;

export type Dir = 0 | 1 | 2 | 3;
/** +X, +Y, -X, -Y */
export const DIRS: readonly [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1]];
export const opposite = (d: Dir) => ((d + 2) % 4) as Dir;
export const perpendicular = (d: Dir): Dir[] => [((d + 1) % 4) as Dir, ((d + 3) % 4) as Dir];

export interface Cell { i: number; j: number; k: number }

export type Step =
  | { kind: "straight"; cell: Cell; dir: Dir }
  | { kind: "turn"; cell: Cell; from: Dir; to: Dir }
  | { kind: "rise"; cell: Cell; levels: number; from: Dir; to: Dir };

export interface Route {
  steps: Step[];
}

/** Where a route may start: a cell entered moving in `dir` (the piece before it is built by the caller). */
export interface Start { cell: Cell; dir: Dir; cost?: number; tag?: unknown }
/** Where a route may end: a cell it must leave moving in `dir` (toward the target). */
export interface Goal { cell: Cell; dir: Dir }

const COST = { straight: 1, turn: 1.3, riseBase: 2.5, risePerLevel: 1 };

export class Grid {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  /** Owner of each cell: -1 blocked, 0 free, >0 a route id. */
  private readonly owner: Int32Array;
  /** Vertical moves are not allowed between level k and k+1 in these (i, j, k) cells (a slab in between). */
  private readonly noVertical: Uint8Array;

  constructor(
    /** Blueprint coordinates of cell (0, 0, 0)'s center. */
    readonly origin: { x: number; y: number; z: number },
    size: { nx: number; ny: number; nz: number },
  ) {
    this.nx = size.nx;
    this.ny = size.ny;
    this.nz = size.nz;
    this.owner = new Int32Array(this.nx * this.ny * this.nz);
    this.noVertical = new Uint8Array(this.nx * this.ny * this.nz);
  }

  index(c: Cell) {
    return (c.k * this.ny + c.j) * this.nx + c.i;
  }
  inside(c: Cell) {
    return c.i >= 0 && c.j >= 0 && c.k >= 0 && c.i < this.nx && c.j < this.ny && c.k < this.nz;
  }
  center(c: Cell) {
    return { x: this.origin.x + c.i * CELL, y: this.origin.y + c.j * CELL, z: this.origin.z + c.k * LEVEL };
  }
  /** Cell whose center is nearest to a point (not clamped). */
  cellAt(p: { x: number; y: number; z: number }): Cell {
    return {
      i: Math.round((p.x - this.origin.x) / CELL),
      j: Math.round((p.y - this.origin.y) / CELL),
      k: Math.round((p.z - this.origin.z) / LEVEL),
    };
  }
  isFree(c: Cell) {
    return this.inside(c) && this.owner[this.index(c)] === 0;
  }
  ownerOf(c: Cell) {
    return this.inside(c) ? this.owner[this.index(c)] : -1;
  }
  take(c: Cell, id: number) {
    if (this.inside(c)) this.owner[this.index(c)] = id;
  }
  /** Blocks every cell whose center lies in the box (blueprint coordinates). */
  blockBox(box: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }) {
    this.forBox(box, (c) => this.take(c, -1));
  }
  /** Forbids vertical moves crossing height `z` over the box (a floor slab). */
  blockVerticalAt(box: { minX: number; maxX: number; minY: number; maxY: number }, z: number) {
    const k = Math.floor((z - this.origin.z) / LEVEL);
    this.forBox({ ...box, minZ: this.origin.z + k * LEVEL, maxZ: this.origin.z + k * LEVEL }, (c) => {
      this.noVertical[this.index(c)] = 1;
    });
  }
  private forBox(box: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }, f: (c: Cell) => void) {
    const i0 = Math.ceil((box.minX - this.origin.x) / CELL), i1 = Math.floor((box.maxX - this.origin.x) / CELL);
    const j0 = Math.ceil((box.minY - this.origin.y) / CELL), j1 = Math.floor((box.maxY - this.origin.y) / CELL);
    const k0 = Math.ceil((box.minZ - this.origin.z) / LEVEL), k1 = Math.floor((box.maxZ - this.origin.z) / LEVEL);
    for (let k = Math.max(0, k0); k <= Math.min(this.nz - 1, k1); k++)
      for (let j = Math.max(0, j0); j <= Math.min(this.ny - 1, j1); j++)
        for (let i = Math.max(0, i0); i <= Math.min(this.nx - 1, i1); i++) f({ i, j, k });
  }

  /**
   * Shortest route from any start to any goal through free cells. `maxRise` limits one vertical run
   * (a Conveyor Lift is at most ~48 m); longer climbs chain runs.
   */
  route(starts: Start[], goals: Goal[], options: { maxRise: number; allowRise: boolean }): Route | undefined {
    const goalAt = new Map<number, Dir[]>();
    for (const g of goals) goalAt.set(this.index(g.cell), [...(goalAt.get(this.index(g.cell)) ?? []), g.dir]);
    const h = (c: Cell) => Math.min(...goals.map((g) => Math.abs(g.cell.i - c.i) + Math.abs(g.cell.j - c.j) + Math.abs(g.cell.k - c.k)));

    type Node = { cell: Cell; dir: Dir; g: number; f: number; parent?: Node; step?: Step };
    const key = (c: Cell, d: Dir) => this.index(c) * 4 + d;
    const best = new Map<number, number>();
    const open = new MinHeap<Node>((a, b) => a.f - b.f);
    for (const s of starts) {
      if (!this.isFree(s.cell)) continue;
      const node: Node = { cell: s.cell, dir: s.dir, g: s.cost ?? 0, f: (s.cost ?? 0) + h(s.cell) };
      best.set(key(s.cell, s.dir), node.g);
      open.push(node);
    }
    let expanded = 0;
    while (open.size > 0 && expanded++ < 400000) {
      const node = open.pop()!;
      if ((best.get(key(node.cell, node.dir)) ?? Infinity) < node.g) continue;
      const { cell, dir } = node;

      // Finish here: leave the goal cell toward the target, straight or with a turn.
      const goalDirs = goalAt.get(this.index(cell));
      if (goalDirs) {
        const out = goalDirs.find((d) => d === dir) ?? goalDirs.find((d) => perpendicular(dir).includes(d));
        if (out !== undefined) {
          const last: Step = out === dir ? { kind: "straight", cell, dir } : { kind: "turn", cell, from: dir, to: out };
          const steps: Step[] = [last];
          for (let n: Node | undefined = node; n?.step; n = n.parent) steps.unshift(n.step);
          return { steps };
        }
      }

      const push = (next: Cell, nextDir: Dir, cost: number, step: Step) => {
        if (!this.isFree(next)) return;
        const g = node.g + cost;
        const k = key(next, nextDir);
        if (g >= (best.get(k) ?? Infinity)) return;
        best.set(k, g);
        open.push({ cell: next, dir: nextDir, g, f: g + h(next), parent: node, step });
      };
      const move = (c: Cell, d: Dir): Cell => ({ i: c.i + DIRS[d][0], j: c.j + DIRS[d][1], k: c.k });

      push(move(cell, dir), dir, COST.straight, { kind: "straight", cell, dir });
      for (const d of perpendicular(dir)) push(move(cell, d), d, COST.turn, { kind: "turn", cell, from: dir, to: d });
      if (!options.allowRise) continue;
      for (const sign of [1, -1]) {
        for (let levels = 1; levels <= options.maxRise; levels++) {
          const top = { i: cell.i, j: cell.j, k: cell.k + sign * levels };
          const crossed = sign > 0 ? cell.k + levels - 1 : cell.k - levels;
          if (this.noVertical[this.index({ ...cell, k: crossed })] || !this.isFree(top)) break;
          for (const d of [0, 1, 2, 3] as Dir[]) {
            const step: Step = { kind: "rise", cell, levels: sign * levels, from: dir, to: d };
            // A run may end right in the goal cell when it leaves it toward the target.
            if (goalAt.get(this.index(top))?.includes(d)) {
              const steps: Step[] = [step];
              for (let n: Node | undefined = node; n?.step; n = n.parent) steps.unshift(n.step);
              return { steps };
            }
            push(move(top, d), d, COST.riseBase + COST.risePerLevel * levels, step);
          }
        }
      }
    }
    return undefined;
  }

  /** Marks every cell a route uses (vertical runs included) as owned by `id`. */
  claim(route: Route, id: number) {
    for (const s of route.steps) {
      this.take(s.cell, id);
      if (s.kind === "rise") for (let l = 1; l <= Math.abs(s.levels); l++) this.take({ ...s.cell, k: s.cell.k + Math.sign(s.levels) * l }, id);
    }
  }
}

class MinHeap<T> {
  private items: T[] = [];
  constructor(private readonly less: (a: T, b: T) => number) {}
  get size() {
    return this.items.length;
  }
  push(item: T) {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.less(a[i], a[p]) >= 0) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }
  pop(): T | undefined {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && this.less(a[l], a[m]) < 0) m = l;
        if (r < a.length && this.less(a[r], a[m]) < 0) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}
