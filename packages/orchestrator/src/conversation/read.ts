import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Read + parse a JSON file under a directory; null if missing/malformed. */
export function readJSONFile<T>(dir: string, name: string): T | null {
  try {
    return JSON.parse(readFileSync(join(dir, name), "utf8")) as T;
  } catch {
    return null;
  }
}
