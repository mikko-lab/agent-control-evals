import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sha256File(path: string): string {
  return sha256Hex(readFileSync(path));
}
