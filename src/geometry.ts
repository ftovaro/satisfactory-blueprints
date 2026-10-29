/** Minimal vector/quaternion math in Unreal Engine conventions (centimeters, Z up). */

export interface Vec3 { x: number; y: number; z: number }
export interface Quat { x: number; y: number; z: number; w: number }
export interface Transform { rotation: Quat; translation: Vec3; scale3d: Vec3 }

export const vec = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const add = (a: Vec3, b: Vec3): Vec3 => vec(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a: Vec3, b: Vec3): Vec3 => vec(a.x - b.x, a.y - b.y, a.z - b.z);
export const scale = (a: Vec3, s: number): Vec3 => vec(a.x * s, a.y * s, a.z * s);
export const length = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
export const normalize = (a: Vec3): Vec3 => { const l = length(a); return l === 0 ? vec() : scale(a, 1 / l); };

export const conjugate = (q: Quat): Quat => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });

export function multiply(a: Quat, b: Quat): Quat {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

/** Rotates a vector by a unit quaternion (q * v * q^-1). */
export function rotate(q: Quat, v: Vec3): Vec3 {
  const p = multiply(multiply(q, { x: v.x, y: v.y, z: v.z, w: 0 }), conjugate(q));
  return vec(p.x, p.y, p.z);
}

/** Quaternion for a rotation of `degrees` around the Z (up) axis, i.e. a yaw. */
export function yaw(degrees: number): Quat {
  const half = (degrees * Math.PI) / 360;
  return { x: 0, y: 0, z: Math.sin(half), w: Math.cos(half) };
}

/** Yaw angle in degrees (-180..180] of a quaternion that only rotates around Z. */
export function yawOf(q: Quat): number {
  return (Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z)) * 180) / Math.PI;
}

export const toWorld = (t: Transform, local: Vec3): Vec3 => add(rotate(t.rotation, local), t.translation);
export const toLocal = (t: Transform, world: Vec3): Vec3 => rotate(conjugate(t.rotation), sub(world, t.translation));
export const directionToWorld = (t: Transform, local: Vec3): Vec3 => rotate(t.rotation, local);
export const directionToLocal = (t: Transform, world: Vec3): Vec3 => rotate(conjugate(t.rotation), world);

export function transform(translation: Vec3, yawDegrees = 0): Transform {
  return { rotation: yaw(yawDegrees), translation, scale3d: vec(1, 1, 1) };
}

/** Rounds to a grid step to get rid of float noise (e.g. 800.0048 -> 800). */
export const snap = (n: number, step = 1): number => Math.round(n / step) * step;
