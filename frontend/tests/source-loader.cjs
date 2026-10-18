const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const cache = new Map();

function loadTs(filename) {
  if (cache.has(filename)) return cache.get(filename).exports;
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;
  const mod = new Module(filename, module);
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod.require = (name) => {
    if (name.startsWith(".")) {
      const target = [".ts", ".tsx"]
        .map((ext) => path.resolve(path.dirname(filename), name + ext))
        .find((file) => fs.existsSync(file));
      if (target) return loadTs(target);
    }
    return Module.createRequire(filename)(name);
  };
  cache.set(filename, mod);
  mod._compile(output, filename + ".cjs");
  return mod.exports;
}

module.exports = { loadTs };
