import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { absolute } from "../harness";

const targetDirectories = [
  "input/page-source",
  "input/bundles/raw",
  "input/bundles/js-assets/beautified",
  "output/chunks",
  "output/modules",
  "output/style-inventory",
];

export function initTarget(input: string, allowExisting: boolean): void {
  const target = absolute(input);
  if (existsSync(target) && readdirSync(target).length > 0 && !allowExisting) {
    throw new Error(`Target is not empty: ${target} (pass --allow-existing to add missing directories)`);
  }
  for (const directory of targetDirectories) mkdirSync(resolve(target, directory), { recursive: true });
  console.log(target);
}
