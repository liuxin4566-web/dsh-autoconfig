/**
 * dsh-autoconfig browser plugin entry.
 *
 * Registers one tab type in the official right sidebar, beside the built-in
 * Files tab. The Sidebar owns width/split/fullscreen/collapse; this plugin only
 * fills its pane. Connections live host-side, so switching tabs or closing the
 * panel never disconnects a device.
 */
import * as React from "react";
import { createAutoconfigApi } from "./api.js";
import { AutoconfigPanel } from "./Panel.jsx";
import { IconTerminal16 } from "./IconTerminal16.jsx";
import { activateSidebarWhenAvailable } from "./sidebar-lifecycle.js";
import { announceAgentConnections, clearAnnouncements, setSurfaceOpener } from "./store.js";
import TYPERT_REMOTE from "../remote.js";

const NS = "autoconfig";
export const TAB_KIND = "autoconfig";
export const TAB_ID = "dsh-autoconfig";

export const inject = ["remote", "slots", "locale"];

export async function apply(ctx) {
  const disposers = [];
  const own = (dispose) => {
    if (typeof dispose === "function") disposers.push(dispose);
    return dispose;
  };
  const unwind = async () => {
    let failure = null;
    for (const dispose of disposers.reverse()) {
      try {
        await dispose();
      } catch (error) {
        failure ??= error;
      }
    }
    disposers.length = 0;
    if (failure) throw failure;
  };

  try {
    own(await ctx.remote.$mount(TYPERT_REMOTE));
    const api = createAutoconfigApi(ctx);

    own(ctx.locale.register(NS, {
      zh: {
        tabTitle: "自动配置终端",
        guideTitle: "设备终端",
        guideDescription: "SSH / Telnet / 串口 Console / SFTP 连接路由器、交换机、防火墙"
      },
      en: {
        tabTitle: "Auto-Config Terminal",
        guideTitle: "Device Terminal",
        guideDescription: "Connect routers, switches and firewalls over SSH, Telnet, serial console or SFTP"
      }
    }));
    const hostT = ctx.locale.bind(NS);

    own(activateSidebarWhenAvailable(ctx, {
      registerSidebar: (sidebarCtx) => applySidebarRegistrations(sidebarCtx, { api, hostT }),
      onSidebarError: (error) => {
        console.error("[dsh-autoconfig] right-sidebar registration failed; no terminal surface available:", error);
      }
    }));

    // Reveal the tab when an agent connects a device. The panel itself polls
    // faster while mounted; this root-level poll is what makes a connection
    // requested from the conversation visible even when the pane was closed.
    let stopped = false;
    let polling = false;
    const timer = setInterval(async () => {
      if (stopped || polling) return;
      polling = true;
      try {
        const listed = await api.list();
        if (!stopped) announceAgentConnections(listed.connections);
      } catch {
        // The host may still be loading; the next poll retries.
      } finally {
        polling = false;
      }
    }, 2500);
    timer.unref?.();
    own(() => {
      stopped = true;
      clearInterval(timer);
      clearAnnouncements();
    });

    return async () => {
      await unwind();
      clearAnnouncements();
      setSurfaceOpener(null);
    };
  } catch (error) {
    try {
      await unwind();
    } catch (cleanupError) {
      console.error("[dsh-autoconfig] apply failed and cleanup failed too:", cleanupError);
    }
    throw error;
  }
}

function applySidebarRegistrations(ctx, { api, hostT }) {
  const disposers = [];
  const own = (dispose) => {
    if (typeof dispose === "function") disposers.push(dispose);
    return dispose;
  };
  try {
    setSurfaceOpener(() => {
      try {
        ctx.sidebarRight.openTab(TAB_KIND);
      } catch (error) {
        console.warn("[dsh-autoconfig] openTab failed:", error?.message ?? error);
      }
    });
    own(() => setSurfaceOpener(null));

    own(ctx.sidebarRightTabs.register({
      id: TAB_ID,
      kind: TAB_KIND,
      priority: "extension",
      title: () => hostT("tabTitle"),
      guide: [{
        order: 30,
        title: () => hostT("guideTitle"),
        description: () => hostT("guideDescription"),
        icon: IconTerminal16
      }]
    }));

    own(ctx.slots.inject("sidebar.right.pane.tab", () =>
      ctx.slots.register(
        {
          name: "sidebar.right.pane.tab",
          key: TAB_ID,
          locale: NS,
          inject: () => ({ api })
        },
        AutoconfigPanel
      )
    ));

    return () => {
      for (const dispose of disposers.reverse()) dispose();
    };
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose();
    throw error;
  }
}
