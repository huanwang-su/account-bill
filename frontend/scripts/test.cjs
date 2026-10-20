const fs = require("node:fs"),
  path = require("node:path"),
  { spawnSync } = require("node:child_process");
const directory = path.resolve(__dirname, "../tests");
const files = fs
  .readdirSync(directory)
  .filter(
    (name) =>
      name.endsWith(".cjs") &&
      !name.endsWith("-e2e.cjs") &&
      !["e2e.cjs", "source-loader.cjs"].includes(name),
  )
  .sort();
let failures = 0;
for (const name of files) {
  const source = fs.readFileSync(path.join(directory, name), "utf8");
  if (
    /require\(["'](?:@playwright|playwright)|launchPersistentContext|chromium\.launch/.test(
      source,
    )
  )
    throw new Error("Browser test must not be in the fast suite: " + name);
  const result = spawnSync(process.execPath, [path.join(directory, name)], {
    cwd: path.resolve(__dirname, ".."),
    encoding: "utf8",
    timeout: 90000,
  });
  if (result.status !== 0) {
    failures++;
    process.stdout.write(
      "FAIL " + name + "\n" + result.stdout + "\n" + result.stderr + "\n",
    );
  } else console.log("PASS " + name);
}
console.log(
  `${files.length - failures}/${files.length} non-browser suites passed`,
);
process.exitCode = failures ? 1 : 0;
