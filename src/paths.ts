import * as os from "node:os";
import * as path from "node:path";

/**
 * Resolves the root folder where Satisfactory stores blueprints.
 * Each subfolder inside it is named after a save session.
 *
 * Priority: explicit argument > SATISFACTORY_BLUEPRINT_DIR env var > default Windows location.
 */
export function resolveBlueprintRoot(explicitDir?: string): string {
  if (explicitDir) return path.resolve(explicitDir);
  if (process.env.SATISFACTORY_BLUEPRINT_DIR) return path.resolve(process.env.SATISFACTORY_BLUEPRINT_DIR);

  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "FactoryGame", "Saved", "SaveGames", "blueprints");
}
