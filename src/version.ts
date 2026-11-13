import { readFileSync } from "node:fs";

/** Package version, read from package.json next to src/ or dist/. */
export const VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;
