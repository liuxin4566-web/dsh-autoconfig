/** Module-level UI state shared by the plugin root and the panel. */

let surfaceOpener = null;

export function setSurfaceOpener(opener) {
  surfaceOpener = typeof opener === "function" ? opener : null;
}

export function requestSurface() {
  try {
    surfaceOpener?.();
  } catch {}
}

export function hasSurfaceOpener() {
  return surfaceOpener !== null;
}

/** Agent-opened sessions are revealed exactly once per page lifetime. */
const announced = new Set();

export function announceAgentConnections(connections) {
  // Before the sidebar is ready there is nowhere to reveal; leave the
  // connection unannounced so the next poll (after registration) opens it.
  if (!hasSurfaceOpener()) return false;
  let appeared = false;
  for (const connection of connections ?? []) {
    if (connection?.agent !== true) continue;
    if (announced.has(connection.connectionId)) continue;
    announced.add(connection.connectionId);
    appeared = true;
  }
  if (appeared) requestSurface();
  return appeared;
}

export function clearAnnouncements() {
  announced.clear();
}
