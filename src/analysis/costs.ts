import { Blueprint, isSaveEntity } from "@etothepii/satisfactory-file-parser";
import { length, sub } from "../geometry.js";
import { readSpline } from "./connectors.js";

/**
 * Estimates the build cost of each building type from real blueprints.
 *
 * Every blueprint header lists its total item cost. Treating each blueprint as an equation
 * (count of each building x unit cost = total), the unit costs can be recovered with a
 * non-negative least-squares fit. Spline buildings (belts, pipes) are measured in meters,
 * power lines in segments.
 */

export interface CostObservation {
  features: Map<string, number>;
  costs: Map<string, number>;
}

export interface CostFit {
  /** feature -> item -> amount */
  unitCosts: Record<string, Record<string, number>>;
  /** item -> worst absolute error across all blueprints */
  maxError: Record<string, number>;
}

function splineLengthMeters(points: { location: { x: number; y: number; z: number } }[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += length(sub(points[i].location, points[i - 1].location));
  return total / 100;
}

export function featureKey(typePath: string, isSpline: boolean): string {
  return isSpline ? `${typePath}#meters` : typePath;
}

export function observeCosts(blueprint: Blueprint): CostObservation {
  const features = new Map<string, number>();
  for (const obj of blueprint.objects) {
    if (!isSaveEntity(obj)) continue;
    const spline = readSpline(obj);
    const key = featureKey(obj.typePath, !!spline);
    features.set(key, (features.get(key) ?? 0) + (spline ? splineLengthMeters(spline) : 1));
  }
  const costs = new Map<string, number>();
  for (const [ref, amount] of blueprint.header.itemCosts) costs.set(ref.pathName, amount);
  return { features, costs };
}

/** Coordinate-descent non-negative least squares: min |A x - b|^2 subject to x >= 0. */
function nnls(AtA: number[][], Atb: number[], sweeps = 2000): number[] {
  const n = Atb.length;
  const x = new Array(n).fill(0);
  for (let sweep = 0; sweep < sweeps; sweep++) {
    let change = 0;
    for (let j = 0; j < n; j++) {
      if (AtA[j][j] === 0) continue;
      let dot = 0;
      for (let k = 0; k < n; k++) dot += AtA[j][k] * x[k];
      const next = Math.max(0, x[j] - (dot - Atb[j]) / AtA[j][j]);
      change = Math.max(change, Math.abs(next - x[j]));
      x[j] = next;
    }
    if (change < 1e-7) break;
  }
  return x;
}

export function fitCosts(observations: CostObservation[]): CostFit {
  const featureNames = [...new Set(observations.flatMap((o) => [...o.features.keys()]))].sort();
  const items = [...new Set(observations.flatMap((o) => [...o.costs.keys()]))].sort();
  const A = observations.map((o) => featureNames.map((f) => o.features.get(f) ?? 0));
  const AtA = featureNames.map((_, j) => featureNames.map((_, k) => A.reduce((s, row) => s + row[j] * row[k], 0)));

  const unitCosts: CostFit["unitCosts"] = {};
  const maxError: CostFit["maxError"] = {};
  for (const item of items) {
    const b = observations.map((o) => o.costs.get(item) ?? 0);
    const Atb = featureNames.map((_, j) => A.reduce((s, row, i) => s + row[j] * b[i], 0));
    const x = nnls(AtA, Atb);
    featureNames.forEach((f, j) => {
      if (x[j] > 0.05) (unitCosts[f] ??= {})[item] = Math.round(x[j] * 100) / 100;
    });
    maxError[item] = Math.max(...A.map((row, i) => Math.abs(row.reduce((s, v, j) => s + v * x[j], 0) - b[i])));
  }
  return { unitCosts, maxError };
}
