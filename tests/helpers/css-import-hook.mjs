// t_6c564822 — the pane's stylesheet is loaded through the frame's MODULE GRAPH
// (`hermes-review-extension/view.js` → `import "./view.css";`), because that is
// the only route by which the host injects a custom entry's CSS (see the pane
// design reference). Plain `node` refuses a `.css` specifier
// (`ERR_UNKNOWN_FILE_EXTENSION`), so a suite that mounts the REAL `view.js`
// registers this hook first and node treats the specifier as an empty module.
//
// Deliberately narrow, so the hook can never become a silent stand-in for the
// host's injection:
//   - the suites read the sheet's actual CONTENTS from disk (`view.css`) and the
//     new structure suite asserts that the entry imports it — the hook supplies
//     no CSS and no behaviour;
//   - it only short-circuits specifiers ending in `.css`; every other resolution
//     goes through node's own loader.
import { registerHooks } from "node:module";

let registered = false;

/** Registers the `.css` side-effect-import hook once per process. */
export function registerCssImportHook() {
  if (registered) return;
  registered = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (typeof specifier === "string" && specifier.endsWith(".css")) {
        const parent = context?.parentURL;
        if (!parent) return nextResolve(specifier, context);
        return { url: new URL(specifier, parent).href, format: "css-import", shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (typeof url === "string" && url.endsWith(".css")) {
        // An empty module: the frame's CSS is not a JS dependency, and the
        // injection itself is the host's job.
        return { format: "module", source: "export default undefined;\n", shortCircuit: true };
      }
      return nextLoad(url, context);
    }
  });
}
