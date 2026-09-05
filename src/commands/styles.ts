import { absolute, harnessScript, run } from "../harness";

export function styles(targetPath: string, options: { downloadCss: boolean; force: boolean }): void {
  const args = [harnessScript("extract_style_inventory.py"), absolute(targetPath)];
  if (options.downloadCss) args.push("--download-css");
  if (options.force) args.push("--force");
  run("python3", args);
}
