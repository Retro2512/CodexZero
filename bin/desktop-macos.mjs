#!/usr/bin/env node
import path from "node:path";
import { buildMacDesktop, installMacDesktop } from "../src/desktop-macos.mjs";

const [command, ...args] = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const packageRoot = path.resolve(option("--package") || path.join(import.meta.dirname, ".."));

try {
  if (process.platform !== "darwin") throw new Error("The CodexZero Mac app requires macOS.");
  if (command === "install") {
    const applications = option("--applications");
    const target = await installMacDesktop({
      packageRoot, open: !args.includes("--no-open"), skipInstalled: args.includes("--skip-installed"),
      ...(applications ? { applications: path.resolve(applications) } : {})
    });
    console.log(`CodexZero is installed in ${path.dirname(target)}.`);
  } else if (command === "build") {
    const output = option("--output");
    if (!output) throw new Error("Use build --output <CodexZero.app>");
    await buildMacDesktop({ packageRoot, output: path.resolve(output), skipInstalled: args.includes("--skip-installed") });
  } else {
    throw new Error("Use install or build.");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
