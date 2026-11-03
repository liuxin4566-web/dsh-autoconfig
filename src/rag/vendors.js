/**
 * Vendor command tables and error patterns.
 *
 * Everything here is data: adding a vendor must not require touching the plan
 * engine. `prompt` patterns are used to detect the CLI prompt, `read` commands
 * collect a device profile, and `errors` classify failed commands (the caret
 * marker is reconstructed from the `^` line by errors.js).
 */
export const VENDORS = Object.freeze({
  h3c: {
    id: "h3c",
    label: "H3C / Comware",
    platform: "comware",
    prompt: [/(?:^|[\r\n])(?:<[^>\r\n]{1,64}>|\[~?[^\]\r\n]{1,64}\])\s*$/],
    more: [/----\s*More\s*----/i, /--More--/i],
    version: ["display version"],
    serial: ["display device manuinfo"],
    config: ["display current-configuration"],
    pagingOff: "screen-length disable",
    enterConfig: "system-view",
    exitConfig: "return",
    save: "save force",
    quit: "quit",
    savePrompt: /(?:Are you sure|Please input|\[Y\/N\])/i,
    errorPatterns: [
      /%\s*(Unrecognized|Incomplete|Too many parameters|Wrong parameter|Ambiguous) command found at '\^' position\.?/i,
      /%\s*Unrecognized command/i,
      /Error:\s*(Unrecognized|Incomplete|Wrong parameter|Too many parameters) command found at '\^' position\.?/i,
      /%\s*(Permission denied|Authorization failed)/i
    ],
    versionPatterns: [
      /Comware Software,? Version\s+([0-9A-Za-z.\-]+(?:,\s*Alpha\s+\d+)?)/i,
      /Version\s+([0-9]+\.[0-9]+\.[0-9]+[A-Za-z0-9.\-]*)/i
    ],
    modelPatterns: [
      /H3C\s+([A-Za-z0-9][A-Za-z0-9\-/]{2,32})\s+uptime/i,
      /BOARD TYPE:\s*([A-Za-z0-9\-/]+)/i
    ],
    serialPatterns: [/DEVICE_SERIAL_NUMBER:\s*([A-Za-z0-9\-]+)/i]
  },
  huawei: {
    id: "huawei",
    label: "Huawei / VRP",
    platform: "vrp",
    prompt: [/(?:^|[\r\n])(?:<[^>\r\n]{1,64}>|\[~?[^\]\r\n]{1,64}\])\s*$/],
    more: [/----\s*More\s*----/i, /--More--/i],
    version: ["display version"],
    serial: ["display device manuinfo", "display elabel"],
    config: ["display current-configuration"],
    pagingOff: "screen-length 0 temporary",
    enterConfig: "system-view",
    exitConfig: "return",
    save: "save",
    quit: "quit",
    savePrompt: /(?:Are you sure|\[Y\/N\])/i,
    errorPatterns: [
      /Error:\s*(Unrecognized|Incomplete|Wrong parameter|Too many parameters) command found at '\^' position\.?/i,
      /%\s*(Unrecognized|Incomplete|Wrong parameter) command/i
    ],
    versionPatterns: [/Version\s+([0-9]+\.[0-9]+\.[0-9]+[A-Za-z0-9.\-]*)/i],
    modelPatterns: [/([A-Za-z0-9\-]{3,32})\s+uptime is/i],
    serialPatterns: [/DEVICE_SERIAL_NUMBER:\s*([A-Za-z0-9\-]+)/i, /SN:\s*([A-Za-z0-9\-]+)/i]
  },
  maipu: {
    id: "maipu",
    label: "Maipu",
    platform: "maipu",
    prompt: [/(?:^|[\r\n])[A-Za-z0-9._-]{1,64}(?:\([^)\r\n]{1,40}\))?[>#]\s*$/],
    more: [/----\s*More\s*----/i, /--More--/i],
    version: ["show version"],
    serial: ["show device", "show version"],
    config: ["show running-config"],
    pagingOff: "terminal length 0",
    enterConfig: "configure terminal",
    exitConfig: "end",
    save: "write",
    quit: "exit",
    savePrompt: /(?:Are you sure|\[Y\/N\])/i,
    errorPatterns: [
      /%\s*(Invalid input|Incomplete command|Ambiguous command|Unrecognized command)/i,
      /Error:\s*(Invalid input|Unrecognized command)/i
    ],
    versionPatterns: [/(?:Version|version)\s+([0-9]+\.[0-9]+\.[0-9]+[A-Za-z0-9.\-]*)/],
    modelPatterns: [/([A-Za-z0-9\-]{3,32})\s+uptime/i],
    serialPatterns: [/(?:Serial|SN)[^\n:]*:\s*([A-Za-z0-9\-]+)/i]
  },
  ruijie: {
    id: "ruijie",
    label: "Ruijie",
    platform: "ios",
    prompt: [/(?:^|[\r\n])[A-Za-z0-9._-]{1,64}(?:\([^)\r\n]{1,40}\))?[>#]\s*$/],
    more: [/--More--/i, /----\s*More\s*----/i],
    version: ["show version"],
    serial: ["show version", "show device"],
    config: ["show running-config"],
    pagingOff: "terminal length 0",
    enterConfig: "configure terminal",
    exitConfig: "end",
    save: "write",
    quit: "exit",
    savePrompt: /(?:Are you sure|\[Y\/N\])/i,
    errorPatterns: [
      /%\s*Invalid input detected at '\^' marker\.?/i,
      /%\s*Incomplete command\.?/i,
      /%\s*Ambiguous command:/i
    ],
    versionPatterns: [/(?:Version|version)\s+([0-9]+\.[0-9]+\.[0-9]+[A-Za-z0-9.\-]*)/],
    modelPatterns: [/([A-Za-z0-9\-]{3,32})\s+uptime/i],
    serialPatterns: [/(?:Serial|SN)[^\n:]*:\s*([A-Za-z0-9\-]+)/i]
  },
  cisco: {
    id: "cisco",
    label: "Cisco / IOS",
    platform: "ios",
    prompt: [/(?:^|[\r\n])[A-Za-z0-9._-]{1,64}(?:\([^)\r\n]{1,40}\))?[>#]\s*$/],
    more: [/--More--/i],
    version: ["show version"],
    serial: ["show inventory"],
    config: ["show running-config"],
    pagingOff: "terminal length 0",
    enterConfig: "configure terminal",
    exitConfig: "end",
    save: "write memory",
    quit: "exit",
    savePrompt: /(?:Are you sure|\[confirm\])/i,
    errorPatterns: [
      /%\s*Invalid input detected at '\^' marker\.?/i,
      /%\s*Incomplete command\.?/i,
      /%\s*Ambiguous command:/i
    ],
    versionPatterns: [/Version\s+([0-9]+\.[0-9]+\.[0-9]+[A-Za-z0-9.\-()]*)/],
    modelPatterns: [/^[Cc]isco\s+([A-Za-z0-9\-]+)/m, /[Mm]odel [Nn]umber\s*:\s*([A-Za-z0-9\-]+)/],
    serialPatterns: [/[Ss]erial [Nn]umber\s*:\s*([A-Za-z0-9\-]+)/]
  }
});

export const VENDOR_LIST = Object.values(VENDORS);

export function getVendor(id) {
  return VENDORS[String(id ?? "").toLowerCase()] ?? null;
}

export function detectVendorFromText(text) {
  const sample = String(text ?? "");
  if (/Comware|H3C/i.test(sample)) return "h3c";
  if (/Huawei|VRP|HUAWEI/i.test(sample)) return "huawei";
  if (/Maipu|迈普/i.test(sample)) return "maipu";
  if (/Ruijie|锐捷/i.test(sample)) return "ruijie";
  if (/Cisco|IOS/i.test(sample)) return "cisco";
  return null;
}