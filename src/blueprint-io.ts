import * as fs from "node:fs";
import * as path from "node:path";
import { Blueprint, Parser } from "@etothepii/satisfactory-file-parser";

function toArrayBuffer(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Builds a minimal .sbpcfg payload for blueprints that ship without one. */
function defaultConfigBytes(): ArrayBuffer {
  // configVersion (int32 = 3, AddedIconLibraryPath), description (empty FString = int32 0), iconID (int32 -1),
  // color (4 x float32), referencedIconLibrary + iconLibraryType (empty FStrings).
  const view = new DataView(new ArrayBuffer(4 + 4 + 4 + 16 + 4 + 4));
  let offset = 0;
  view.setInt32(offset, 3, true); offset += 4;
  view.setInt32(offset, 0, true); offset += 4;
  view.setInt32(offset, -1, true); offset += 4;
  for (const channel of [1, 1, 1, 1]) { view.setFloat32(offset, channel, true); offset += 4; }
  view.setInt32(offset, 0, true); offset += 4;
  view.setInt32(offset, 0, true);
  return view.buffer;
}

/** Reads a blueprint from its .sbp path; the matching .sbpcfg is picked up automatically if present. */
export function readBlueprint(sbpPath: string): Blueprint {
  const name = path.basename(sbpPath, ".sbp");
  const configPath = sbpPath.replace(/\.sbp$/i, ".sbpcfg");
  const main = toArrayBuffer(fs.readFileSync(sbpPath));
  const config = fs.existsSync(configPath) ? toArrayBuffer(fs.readFileSync(configPath)) : defaultConfigBytes();
  return Parser.ParseBlueprintFiles(name, main, config, { throwErrors: true });
}

/** Serializes a blueprint to `<dir>/<name>.sbp` and `<dir>/<name>.sbpcfg`. */
export function writeBlueprint(blueprint: Blueprint, dir: string, name = blueprint.name): { sbp: string; sbpcfg: string } {
  fs.mkdirSync(dir, { recursive: true });

  const parts: Uint8Array[] = [];
  const { configFileBinary } = Parser.WriteBlueprintFiles(
    blueprint,
    (header) => parts.push(header),
    (chunk) => parts.push(chunk),
  );

  const sbp = path.join(dir, `${name}.sbp`);
  const sbpcfg = path.join(dir, `${name}.sbpcfg`);
  fs.writeFileSync(sbp, Buffer.concat(parts));
  fs.writeFileSync(sbpcfg, Buffer.from(configFileBinary));
  return { sbp, sbpcfg };
}

/** Converts a parsed blueprint to JSON text (handles BigInt and other values plain JSON cannot). */
export function blueprintToJson(blueprint: Blueprint): string {
  return Parser.JSONStringifyModified(blueprint, 2);
}
