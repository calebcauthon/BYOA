/**
 * Prompt images — inputs the operator attached to the prompt (pasted screenshots,
 * uploaded files) that the agent should be able to look at while it works.
 *
 * The transport is provider-agnostic on purpose: rather than assume a given agent
 * program speaks a multimodal wire format, we materialize each image as a real
 * file the agent can open with its own file tools, and append a short prompt
 * section pointing at those paths. Two copies are written:
 *   • into the backend scratch dir  → so the agent (which runs inside the backend)
 *                                      can read the bytes with its file tools;
 *   • into <outDir>/prompt-images/   → on the host, so the session is a complete,
 *                                      reproducible record (§2.9) after the backend
 *                                      is disposed.
 *
 * An image input is either a `data:<mime>;base64,<…>` URL (what the console sends)
 * or a filesystem path (convenient for standalone CLI specs).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { Backend } from "./backends/index.ts";
import type { SessionLog } from "./logging.ts";

/** A data URL (console) or a filesystem path (CLI). */
export type ImageInput = string;

interface DecodedImage {
  bytes: Buffer;
  /** file extension including the dot, e.g. ".png" */
  ext: string;
}

const MIME_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/bmp": ".bmp",
};

function decode(input: ImageInput): DecodedImage {
  if (input.startsWith("data:")) {
    const comma = input.indexOf(",");
    if (comma === -1) throw new Error("malformed data URL (no comma)");
    const header = input.slice(5, comma); // between "data:" and ","
    const isBase64 = /;base64/i.test(header);
    const mime = header.split(";")[0]?.toLowerCase() ?? "";
    const body = input.slice(comma + 1);
    const bytes = isBase64 ? Buffer.from(body, "base64") : Buffer.from(decodeURIComponent(body), "utf8");
    return { bytes, ext: MIME_EXT[mime] ?? ".bin" };
  }
  // Otherwise treat it as a filesystem path.
  return { bytes: readFileSync(input), ext: extname(input) || ".bin" };
}

export interface MaterializedImages {
  /** absolute paths inside the backend the agent can read */
  backendPaths: string[];
  /** filenames written under <outDir>/prompt-images/ (the durable record) */
  names: string[];
}

/**
 * Decode every attached image, write it into both the backend scratch dir and the
 * host session dir, and return where they landed. Best-effort per image: one bad
 * input is logged and skipped, never fatal to the run.
 */
export async function materializeImages(
  images: ImageInput[],
  backend: Backend,
  scratchDir: string,
  outDir: string,
  log: SessionLog,
): Promise<MaterializedImages> {
  const backendPaths: string[] = [];
  const names: string[] = [];
  const recordDir = join(outDir, "prompt-images");
  let wroteRecordDir = false;
  let i = 0;
  for (const input of images) {
    i += 1;
    let decoded: DecodedImage;
    try {
      decoded = decode(input);
    } catch (err) {
      log.emit("orchestrator", "warn", `skipping prompt image ${i}: ${String(err)}`);
      continue;
    }
    const name = `prompt-image-${String(i).padStart(2, "0")}${decoded.ext}`;
    const backendPath = `${scratchDir}/${name}`;
    try {
      await backend.writeBytes(backendPath, decoded.bytes, log);
    } catch (err) {
      log.emit("orchestrator", "warn", `could not stage prompt image ${name} into the backend: ${String(err)}`);
      continue;
    }
    // Keep a host-side copy so the session record is complete after dispose.
    try {
      if (!wroteRecordDir) {
        mkdirSync(recordDir, { recursive: true });
        wroteRecordDir = true;
      }
      writeFileSync(join(recordDir, name), decoded.bytes);
    } catch (err) {
      log.emit("orchestrator", "warn", `could not save prompt image ${name} to the session dir: ${String(err)}`);
    }
    backendPaths.push(backendPath);
    names.push(name);
    log.emit("orchestrator", "info", `staged prompt image ${name} (${decoded.bytes.length} bytes) at ${backendPath}`);
  }
  return { backendPaths, names };
}

/** The prompt section that tells the agent the attached images exist and where
 *  to read them. Empty string when nothing was staged. */
export function imagePromptSection(backendPaths: string[]): string {
  if (backendPaths.length === 0) return "";
  const list = backendPaths.map((p) => `- ${p}`).join("\n");
  const noun = backendPaths.length === 1 ? "image" : "images";
  return (
    `\n\n## Attached ${noun}\n` +
    `The operator attached ${backendPaths.length} ${noun} to this prompt. ` +
    `Each is saved as a file you can open with your file-reading tools:\n${list}\n` +
    `Read the relevant ${noun} before you begin if the request refers to them.`
  );
}
