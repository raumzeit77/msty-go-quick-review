import assert from "node:assert/strict";
import extension, { renderSurface } from "../hermes-review-extension/extension.js";
import { THEME_REPORT_STORAGE_KEY } from "../hermes-review-extension/review-pane.js";

const DIAGNOSE_COMMAND = "hermes-review.diagnose";
const REVIEW_COMMAND = "hermes-review.run";
const DEADLINE_MS = 1_000;
const SURFACE_ID = "hermes-review.diagnose";
const SURFACE_TITLE = "Host diagnostics";

function withDeadline(value, label, milliseconds = DEADLINE_MS) {
  let timer;
  return Promise.race([
    Promise.resolve(value),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new DeadlineError(`${label} exceeded ${milliseconds} ms deadline`)), milliseconds);
    })
  ]).finally(() => clearTimeout(timer));
}

class DeadlineError extends Error {
  constructor(message) {
    super(message);
    this.name = "DeadlineError";
  }
}

function assertExactKeys(value, allowed, label) {
  assert.equal(value && typeof value === "object" && !Array.isArray(value), true, `${label} must be an object`);
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  assert.deepEqual(unexpected, [], `${label} contains undocumented fields: ${unexpected.join(", ")}`);
}

function assertKvBlock(block, label) {
  assertExactKeys(block, ["type", "title", "items"], label);
  assert.equal(block.type, "kv", `${label} type`);
  assert.equal(typeof block.title, "string", `${label} title`);
  assert.equal(Array.isArray(block.items), true, `${label} items`);
  for (const [index, item] of block.items.entries()) {
    assertExactKeys(item, ["label", "value"], `${label} item ${index}`);
    assert.equal(typeof item.label, "string", `${label} item ${index} label`);
    assert.equal(typeof item.value, "string", `${label} item ${index} value`);
  }
}

function assertDiagnoseContent(content, label) {
  assert.equal(Array.isArray(content), true, `${label} content must be an array`);
  // t_fa7ab623 appends the runtime's last failure (stage token + the bounded
  // reason it preserved) as the closing report section. t_5bffad26 adds the
  // Theme section (pane frame report + runtime theme probe) before it.
  const allowedTitles = ["Host & API", "Permissions", "Feature flags", "Storage quotas", "Model surfaces", "Theme", "Last failure"];
  const sections = [];
  assertCallout(content[0], `${label} lead callout`);
  for (const block of content.slice(1)) {
    if (block.type === "kv") {
      assertKvBlock(block, label);
      sections.push(block);
      continue;
    }
    assert.equal(block.type, "divider", `${label} unsupported block type ${block.type}`);
    assertExactKeys(block, ["type"], `${label} divider`);
  }
  assert.deepEqual(
    sections.map((block) => block.title),
    allowedTitles,
    `${label} must render exactly the documented probe sections in order`
  );
  return sections;
}

function assertCallout(block, label) {
  assertExactKeys(block, ["type", "title", "body", "tone"], label);
  assert.equal(block.type, "callout", `${label} type`);
  assert.equal(block.title, "Host capability probe", `${label} title`);
  assert.equal(typeof block.body, "string", `${label} body`);
  assert.equal(block.tone, "info", `${label} tone`);
}

function capabilitiesSnapshot() {
  return {
    extensionApiVersion: "1.4.0",
    manifestVersion: 1,
    extension: { id: "com.raumzeit77.hermes-review", name: "Hermes Review", version: "1.2.5", trustLevel: "local-unsigned", enabled: true },
    permissions: {
      granted: ["commands.provide", "context.read", "messages.read", "composer.read", "composer.write", "models.infer", "storage.local", "notifications.show", "ui.drawer", "ui.workspace"],
      pending: [],
      denied: [],
      revoked: [],
      unavailable: [],
      required: ["commands.provide", "context.read", "messages.read", "composer.read", "composer.write", "models.infer", "storage.local", "notifications.show", "ui.drawer"],
      optional: ["ui.workspace"]
    },
    surfaces: {
      drawer: { permission: "ui.drawer", state: "granted", declaredCount: 0, canUse: true },
      popup: { permission: "ui.popup", state: "unavailable", declaredCount: 0, canUse: false },
      workspace: { permission: "ui.workspace", state: "granted", declaredCount: 1, canUse: true }
    },
    storage: {
      local: { canUse: true, maxValueBytes: 262144, maxScopeBytes: 2097152, migrations: true },
      chat: { canUse: false, maxValueBytes: 262144, maxScopeBytes: 2097152, migrations: true },
      workspace: { canUse: true, maxValueBytes: 262144, maxScopeBytes: 2097152, migrations: true }
    },
    models: { canInfer: true, canProvideModels: false, canUseLocalModels: false, declaredAssignmentCount: 1 }
  };
}

function createHost(options = {}) {
  const calls = {
    capabilities: 0,
    statusRequests: [],
    updateSurface: [],
    openDrawer: [],
    openPopup: [],
    // t_fa7ab623: the failure-reporting gate drives a real review through the
    // runtime, which needs messages/models/notifications.
    messages: [],
    notifications: [],
    infer: []
  };

  const msty = {
    platform: {
      async getCapabilities() {
        calls.capabilities += 1;
        if (options.capabilitiesError) throw options.capabilitiesError;
        return options.capabilities ?? capabilitiesSnapshot();
      }
    },
    messages: {
      async list(request) {
        calls.messages.push(request);
        return options.messages ?? [{ id: "wo010-message-1", role: "user", content: "wo010-probe-transcript" }];
      }
    },
    context: {
      async getCurrentChat() {
        return options.currentChat ?? { chat: { id: "wo010-probe-chat" }, messages: [] };
      }
    },
    notifications: {
      async show(request) {
        assertExactKeys(request, ["title", "body", "tone", "durationMs"], "diagnose notifications.show request");
        calls.notifications.push(request);
      }
    },
    models: {
      async getStatus(request) {
        assert.equal(request, "reviewer", "diagnostic probe must inspect the contributed reviewer assignment");
        calls.statusRequests.push(request);
        if (options.statusError) throw options.statusError;
        return options.reviewerStatus ?? { ready: true, configured: true, source: "assignment", modelAssignment: "reviewer" };
      },
      async infer(request) {
        calls.infer.push(request);
        if (options.inferError) throw options.inferError;
        const review = { title: "wo010 probe review", summary: "No material issues found.", issues: [] };
        return { text: JSON.stringify(review), json: review };
      }
    },
    ui: {
      registerWorkspaceItem() {},
      async updateSurface(request) {
        assertExactKeys(request, ["id", "kind", "title", "content"], "diagnose updateSurface request");
        assert.equal(request.id, SURFACE_ID, "diagnose surface id");
        assert.equal(request.title, SURFACE_TITLE, "diagnose surface title");
        assert.equal(["drawer", "popup"].includes(request.kind), true, "diagnose surface kind");
        assertDiagnoseContent(request.content, "diagnose updateSurface content");
        calls.updateSurface.push(request);
        if (options.updateSurfaceUpdated === false) return { updated: false, id: request.id, kind: request.kind };
        return { updated: true, id: request.id, kind: request.kind };
      },
      async openDrawer(request) {
        assertExactKeys(request, ["id", "title", "content", "closeLabel"], "diagnose openDrawer request");
        assert.equal(request.id, SURFACE_ID, "diagnose openDrawer surface id");
        assert.equal(request.title, SURFACE_TITLE, "diagnose openDrawer surface title");
        assertDiagnoseContent(request.content, "diagnose openDrawer content");
        calls.openDrawer.push(request);
        return options.openError ? Promise.reject(options.openError) : { id: request.id, kind: "drawer", closed: false };
      },
      async openPopup(request) {
        assertExactKeys(request, ["id", "title", "content", "closeLabel"], "diagnose openPopup request");
        assert.equal(request.id, SURFACE_ID, "diagnose openPopup surface id");
        assert.equal(request.title, SURFACE_TITLE, "diagnose openPopup surface title");
        assertDiagnoseContent(request.content, "diagnose openPopup content");
        calls.openPopup.push(request);
        return options.openError ? Promise.reject(options.openError) : { id: request.id, kind: "popup", closed: false };
      }
    },
    commands: {
      register() {
        return () => {};
      }
    },
    composer: {
      async get() {
        return { text: "/hermes-review-diagnose", canEdit: true };
      },
      async clear() {}
    },
    storage: {
      local: {
        async get() {
          return undefined;
        },
        async set() {}
      },
      // t_5bffad26: the pane frame leaves its theme report in storage.chat and
      // the diagnostic reads it back.
      chat: {
        async get(key) {
          return options.chatStored?.get(key);
        },
        async set(key, value) {
          options.chatStored?.set(key, value);
        }
      }
    }
  };
  return { msty, calls };
}

function section(sections, title) {
  return sections.find((block) => block.title === title);
}

/** Lets fire-and-forget open promises settle before assertions. */
async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * PT5: the open choreography. The probe must render for the user on a first
 * native run (updated:false with nothing open) and refresh when already open.
 */
async function runSurfaceOpenChoreography() {
  // First native run: nothing open, updateSurface reports updated:false.
  const firstRun = createHost({ updateSurfaceUpdated: false });
  await withDeadline(renderSurface(firstRun.msty, { surface: "drawer" }), "first-run probe render");
  await tick();
  assert.equal(firstRun.calls.updateSurface.length, 1, "first run must attempt exactly one patch");
  assert.equal(firstRun.calls.openDrawer.length, 1, "first run must open the drawer when the patch finds nothing open");
  assert.equal(firstRun.calls.openPopup.length, 0, "first run must not open a popup when drawer was requested");

  // Requested kind flows through to the matching open call.
  const popupRun = createHost({ updateSurfaceUpdated: false });
  await withDeadline(renderSurface(popupRun.msty, { surface: "popup" }), "first-run popup render");
  await tick();
  assert.equal(popupRun.calls.openPopup.length, 1, "popup request must open a popup");
  assert.equal(popupRun.calls.openDrawer.length, 0, "popup request must not open a drawer");

  // Already-open surface: patch succeeds, no re-open.
  const reopen = createHost({ updateSurfaceUpdated: true });
  await withDeadline(renderSurface(reopen.msty, { surface: "drawer" }), "re-run probe render");
  await tick();
  assert.equal(reopen.calls.updateSurface.length, 1, "re-run must patch the open surface");
  assert.equal(reopen.calls.openDrawer.length + reopen.calls.openPopup.length, 0, "re-run must not open when the patch succeeded");

  // Host rejects even the open call: must not throw out of the seam.
  const rejected = createHost({ updateSurfaceUpdated: false, openError: new Error("open rejected") });
  await withDeadline(renderSurface(rejected.msty, { surface: "drawer" }), "rejected-open render");
  await tick();
  assert.equal(rejected.calls.openDrawer.length, 1, "rejected open must still have been attempted");
}

function kvItems(block) {
  return Object.fromEntries((block?.items ?? []).map((item) => [item.label, item.value]));
}

async function runHealthy() {
  const host = createHost();
  await withDeadline(renderSurface(host.msty, { surface: "drawer" }), "healthy probe render");
  await tick();
  assert.equal(host.calls.capabilities, 1, "healthy host must consult getCapabilities exactly once");
  assert.deepEqual(host.calls.statusRequests, ["reviewer"], "healthy host must consult the reviewer assignment exactly once");
  const request = host.calls.updateSurface[0];

  const sections = assertDiagnoseContent(request.content, "healthy render");
  assertCallout(request.content[0], "healthy render callout");
  assert.match(request.content[0].body, /1\.4\.0/);

  const hostRows = kvItems(section(sections, "Host & API"));
  assert.equal(hostRows["Trust level"], "local-unsigned", "trust level must be rendered");
  assert.equal(hostRows["Compatibility ^1.0.0"], "satisfied");

  const permissionRows = kvItems(section(sections, "Permissions"));
  assert.match(permissionRows["granted"], /commands\.provide/);
  assert.match(permissionRows["surface popup"], /blocked/);
  assert.match(permissionRows["surface popup"], /ui\.popup/);
  assert.match(permissionRows["surface workspace"], /usable/);

  const featureRows = kvItems(section(sections, "Feature flags"));
  assert.deepEqual(Object.keys(featureRows), [], "fixture has no features block, so flags section must render empty");
  assert.equal(section(sections, "Feature flags").items.length, 0);

  const storageRows = kvItems(section(sections, "Storage quotas"));
  assert.match(storageRows["storage.local"], /max value 256\.0 KB/);
  assert.match(storageRows["storage.local"], /max scope 2\.0 MB/);
  assert.equal(storageRows["storage.chat"], "unusable");

  const modelRows = kvItems(section(sections, "Model surfaces"));
  assert.equal(modelRows["canInfer"], "true");

  // t_fa7ab623: the closing section always renders; with no failure recorded it
  // reports "(none recorded)" rather than an empty or absent block.
  const failureRows = kvItems(section(sections, "Last failure"));
  assert.deepEqual(failureRows, { stage: "(none recorded)", reason: "(none recorded)", at: "(none recorded)" });

  // t_5bffad26: the Theme section is always present. With no frame report
  // stored and no runtime theme API on this host, both sources say so plainly
  // instead of throwing or rendering an empty block.
  const themeRows = kvItems(section(sections, "Theme"));
  assert.match(
    themeRows["pane frame report"],
    /diagnostic-stage=diagnose-theme/,
    "an absent pane frame report is reported as unavailable with its stage"
  );
  assert.equal(themeRows["runtime theme API"], "unavailable (diagnostic-stage=diagnose-theme)");
  assert.equal(themeRows["runtime colorScheme"], "(unreported)");
  assert.equal(themeRows["runtime theme.getTokens() --background"], "(absent)");
  for (const [label, value] of Object.entries(themeRows)) {
    assert.equal(
      /model|provider|api[-_ ]?key|token[-_ ]?key/i.test(value),
      false,
      `Theme row "${label}" must never carry a model key or provider identifier (got: ${value})`
    );
  }

  // A pane frame that published a report is rendered verbatim: the scheme the
  // pane resolved, whether the theme event fired, each computed token, and the
  // host token payload the frame saw.
  const chatStored = new Map();
  chatStored.set(THEME_REPORT_STORAGE_KEY, {
    scheme: "dark",
    hostScheme: "dark",
    themeChangedFired: true,
    computed: { "--background": "rgb(20, 22, 26)", "--foreground": "rgb(240, 241, 243)" },
    tokens: { "--foreground": "#f0f1f3", "--primary": "#2f333b" },
    at: "2026-09-22T20:00:00.000Z"
  });
  const frameHost = createHost({ chatStored });
  await withDeadline(renderSurface(frameHost.msty, { surface: "popup" }), "frame-report probe render");
  await tick();
  const frameSections = assertDiagnoseContent(frameHost.calls.updateSurface[0].content, "frame-report render");
  const frameRows = kvItems(section(frameSections, "Theme"));
  assert.equal(frameRows["pane data-rv-scheme"], "dark", "the pane's resolved scheme is reported");
  assert.equal(frameRows["host colorScheme"], "dark", "the host's reported scheme is reported");
  assert.equal(frameRows["surface.themeChanged fired"], "yes", "the pane reports whether the theme event fired");
  assert.equal(frameRows["reported at"], "2026-09-22T20:00:00.000Z");
  assert.equal(frameRows["computed --background"], "rgb(20, 22, 26)", "a computed token value is reported verbatim");
  assert.equal(frameRows["computed --primary"], "(absent)", "a token the frame could not compute reads as absent");
  assert.equal(frameRows["theme.getTokens() --foreground"], "#f0f1f3", "the host token payload the frame saw is reported");
  assert.equal(frameRows["theme.getTokens() --border"], "(absent)");
}

async function runDegraded() {
  const popupDenied = createHost({
    capabilities: (() => {
      const base = capabilitiesSnapshot();
      return {
        ...base,
        extensionApiVersion: "0.9.0",
        manifestVersion: 1,
        extension: { id: "com.raumzeit77.hermes-review", name: "Hermes Review", version: "1.2.5", trustLevel: "local-unsigned", enabled: true },
        permissions: {
          granted: ["commands.provide", "context.read", "models.infer", "storage.local", "notifications.show", "ui.drawer"],
          pending: ["ui.workspace"],
          denied: ["ui.popup"],
          revoked: [],
          unavailable: []
        },
        surfaces: {
          drawer: { permission: "ui.drawer", state: "granted", declaredCount: 0, canUse: true },
          popup: { permission: "ui.popup", state: "denied", declaredCount: 0, canUse: false }
        },
        storage: { local: { canUse: true } },
        features: { commands: true, notifications: true, clipboardWrite: false },
        models: { canInfer: true, declaredAssignmentCount: 1 }
      };
    })()
  });
  const first = null;
  void first;
  await withDeadline(renderSurface(popupDenied.msty, { surface: "popup" }), "degraded probe render popup");
  await tick();
  assert.equal(popupDenied.calls.updateSurface[0].kind, "popup", "seam must honor the requested surface kind");

  let sections = assertDiagnoseContent(popupDenied.calls.updateSurface[0].content, "degraded render");
  let hostRows = kvItems(section(sections, "Host & API"));
  assert.equal(hostRows["Compatibility ^1.0.0"], "behind", "host major behind wanted major must report 'behind'");
  let permissionRows = kvItems(section(sections, "Permissions"));
  assert.equal(permissionRows["denied"], "ui.popup");
  assert.equal(permissionRows["pending"], "ui.workspace");
  assert.match(permissionRows["surface popup"], /blocked/);

  const storageRows = kvItems(section(sections, "Storage quotas"));
  assert.match(storageRows["storage.local"], /max value \(unreported\)/);

  const featureRows = kvItems(section(sections, "Feature flags"));
  assert.equal(featureRows["features.commands"], "true");
  assert.equal(featureRows["features.clipboardWrite"], "false");

  // Fully degraded: getCapabilities() throws, quota fields missing entirely,
  // models.getStatus missing. Render must still be complete and never throw.
  const throwing = createHost({
    capabilitiesError: new Error("wo010 getCapabilities unavailable"),
    statusError: new Error("wo010 getStatus unavailable")
  });
  delete throwing.msty.models;
  await withDeadline(renderSurface(throwing.msty, { surface: "drawer" }), "throwing probe render");
  sections = assertDiagnoseContent(throwing.calls.updateSurface[0].content, "throwing render");
  permissionRows = kvItems(section(sections, "Permissions"));
  assert.match(permissionRows["getCapabilities"], /diagnostic-stage=diagnose-capabilities/);
  hostRows = kvItems(section(sections, "Host & API"));
  assert.equal(hostRows["Extension API version"], "(unavailable)");
  assert.equal(section(sections, "Feature flags").items.length, 1);
  const modelCallout = throwing.calls.updateSurface[0].content[0];
  assert.match(modelCallout.body, /models\.getStatus unavailable on this host/);

  // t_5bffad26: a host with none of the theme APIs (no `theme`, no frame
  // report, `getCapabilities()` throwing) still produces a readable Theme
  // section and never throws.
  const degradedTheme = kvItems(section(sections, "Theme"));
  assert.match(degradedTheme["pane frame report"], /diagnostic-stage=diagnose-theme/);
  assert.match(degradedTheme["runtime theme API"], /diagnostic-stage=diagnose-theme/);
  assert.equal(degradedTheme["runtime colorScheme"], "(unreported)");
  assert.equal(
    "computed --background" in degradedTheme,
    false,
    "with no frame report there is no computed-token row to read"
  );
}

async function runSeamRequestShape() {
  assert.equal(typeof renderSurface, "function", "renderSurface must be exported");
  assert.equal(renderSurface.constructor.name, "AsyncFunction", "renderSurface must be async");

  const host = createHost();
  await withDeadline(renderSurface(host.msty, {}), "seam default surface");
  await tick();
  assert.equal(host.calls.updateSurface[0].kind, "drawer", "seam must default to the drawer surface");
  assert.deepEqual(
    Object.keys(host.calls.updateSurface[0]),
    ["id", "kind", "title", "content"],
    "seam request must render exactly the documented surface patch keys"
  );

  // Must render without mutating host state beyond the surface update: no
  // notifications, no storage, no composer access.
  assert.deepEqual(host.calls.statusRequests, ["reviewer"]);
}

async function runCommandDispatch() {
  const host = createHost();
  const runtime = await withDeadline(extension.activate(host.msty), "activate for diagnose dispatch");
  assert.equal(typeof runtime.run, "function");

  const result = await withDeadline(runtime.run(DIAGNOSE_COMMAND, { probe: "payload-ignored" }), "diagnose dispatch");
  assert.ok(result && typeof result === "object", "diagnose must return a CommandResult-shaped value");
  assert.equal(result.message, "Host diagnostics opened.");
  assert.equal(result.metadata.readOnly, true);
  assert.equal(host.calls.capabilities, 1, "diagnose dispatch must render the probe exactly once");
  // Card D: the probe renders on the popup surface (drawer retired).
  assert.equal(host.calls.updateSurface[0].kind, "popup");

  // Unknown commands must still be classified, unchanged.
  await assert.rejects(
    withDeadline(runtime.run("hermes-review.unknown", undefined), "unknown command"),
    /Unknown command: hermes-review\.unknown/
  );

  // t_fa7ab623: a failing review now REPORTS WHY. The runtime keeps the reason
  // the diagnostic wrapper preserved and the probe renders it, so a failure
  // that only reproduces on the host becomes copyable evidence. The failure
  // toast itself keeps exactly the bare stage token — primary copy unchanged.
  const failing = createHost({ inferError: new Error("wo010 provider rejected the structured response") });
  const failingRuntime = await withDeadline(extension.activate(failing.msty), "activate for failure reporting");
  await withDeadline(failingRuntime.run(REVIEW_COMMAND, "wo010-failing-instruction"), "failing review dispatch");
  const failureToast = failing.calls.notifications.find((notification) => notification.tone === "error");
  assert.ok(failureToast, "a failing review must still raise the error toast");
  assert.equal(failureToast.body, "diagnostic-stage=inference-request", "failure toast body stays exactly the bare stage token");
  assert.equal(failing.calls.messages.length, 1, "the failing run must reach the transcript read");
  assert.equal(failing.calls.infer.length, 1, "the failing run must reach the isolated inference request");

  await withDeadline(failingRuntime.run(DIAGNOSE_COMMAND, undefined), "diagnose after failure");
  const report = failing.calls.updateSurface.at(-1);
  const reportSections = assertDiagnoseContent(report.content, "post-failure render");
  const failureRows = kvItems(section(reportSections, "Last failure"));
  assert.equal(failureRows.stage, "inference-request", "the report must name the failed stage");
  assert.equal(failureRows.reason, "Error: wo010 provider rejected the structured response", "the report must carry the preserved reason");
  assert.match(failureRows.at, /^\d{4}-\d{2}-\d{2}T/, "the report must timestamp the recorded failure");
}

const gates = [
  { id: "PT1", title: "Capability snapshot to rendered output mapping", run: runHealthy },
  { id: "PT2", title: "Permission-degraded and throwing hosts", run: runDegraded },
  { id: "PT3", title: "Seam request shape and read-only boundary", run: runSeamRequestShape },
  { id: "PT4", title: "Command dispatch through run(command, payload)", run: runCommandDispatch },
  { id: "PT5", title: "Surface open choreography (open when nothing is open, patch when open)", run: runSurfaceOpenChoreography }
];

const results = [];
for (const gate of gates) {
  try {
    await gate.run();
    results.push({ gate: gate.id, status: "PASS" });
    console.log(`[PASS][${gate.id}] ${gate.title}`);
  } catch (error) {
    results.push({ gate: gate.id, status: "UNEXPECTED_FAILURE", error: error?.message ?? String(error) });
    console.error(`[UNEXPECTED_FAILURE][${gate.id}] ${gate.title}: ${error?.message ?? String(error)}`);
  }
}

console.log(`WO010_RESULT_MATRIX=${JSON.stringify(results)}`);
const failures = results.filter((result) => result.status !== "PASS");
console.log(`Diagnose contract: ${results.length - failures.length} passed, ${failures.length} failing.`);
if (failures.length) process.exitCode = 1;
