import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const require = createRequire(import.meta.url);

test("client bundle registers a right-sidebar tab and cleans up", async () => {
  globalThis.self = globalThis;
  let exported;
  globalThis.window = {
    __ModuleLoader__: {
      load({ id, factory }) {
        assert.equal(id, "dsh-autoconfig");
        const module = { exports: {} };
        exported = factory((name) => {
          if (name === "react") return require("react");
          throw new Error(`unexpected require ${name}`);
        });
      }
    }
  };
  require(join(root, "lib", "client.js"));
  assert.equal(typeof exported.apply, "function");
  assert.deepEqual(exported.inject, ["remote", "slots", "locale"]);

  const registered = { tabs: [], slots: [], mounts: 0 };
  const sidebarCtx = {
    sidebarRightTabs: {
      register(config) {
        registered.tabs.push(config);
        return () => {};
      }
    },
    sidebarRight: { openTab() {} },
    slots: {
      inject(_name, register) {
        const dispose = register();
        return typeof dispose === "function" ? dispose : () => {};
      },
      register(config) {
        registered.slots.push(config);
        return () => {};
      }
    }
  };
  const ctx = {
    remote: {
      async $mount(contribution) {
        registered.mounts += 1;
        assert.equal(contribution.package, "dsh-autoconfig");
        assert.ok(Array.isArray(contribution.descriptors));
        return () => {};
      }
    },
    locale: {
      register() {
        return () => {};
      },
      bind() {
        return (key) => key;
      }
    },
    inject(_deps, callback) {
      callback(sidebarCtx);
      return () => {};
    }
  };

  const dispose = await exported.apply(ctx);
  assert.equal(registered.mounts, 1);
  assert.equal(registered.tabs.length, 1);
  assert.equal(registered.tabs[0].kind, "autoconfig");
  assert.equal(registered.tabs[0].priority, "extension");
  assert.equal(registered.slots.length, 1);
  assert.equal(registered.slots[0].key, "dsh-autoconfig");
  assert.equal(typeof dispose, "function");
  await dispose();
});
