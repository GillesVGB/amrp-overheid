import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
for (const folder of ["server", "public", "scripts", "test"])
  for (const file of readdirSync(folder, { recursive: true }).filter((x) =>
    /\.(?:mjs|js)$/.test(x),
  )) {
    const result = spawnSync(
      process.execPath,
      ["--check", folder + "/" + file],
      { stdio: "inherit" },
    );
    if (result.status) process.exit(result.status);
  }
console.log("Alle JavaScript-bestanden zijn syntactisch geldig.");
