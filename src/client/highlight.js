/**
 * Terminal keyword highlighting.
 *
 * Rules are transcribed from `colorful-network.ini` (Notepad++-style keyword
 * list): regex, COLORREF (0x00BBGGRR) and a flag column. The file has case
 * matching off, so every rule is case-insensitive.
 *
 * Only complete, plain-text lines are decorated. A line that already carries
 * ANSI escapes (device-colored output) is passed through untouched, and an
 * incomplete tail is written immediately so interactive prompts never wait for
 * a newline. That trades prompt coloring for correct terminal timing.
 */

/** COLORREF is 0x00BBGGRR, not RGB. */
function colorRefToRgb(value) {
  const b = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const r = value & 0xff;
  return { r, g, b };
}

function parseHexColor(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? "").trim());
  if (!match) return { r: 0, g: 0, b: 0 };
  const value = Number.parseInt(match[1], 16);
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

function toHex({ r, g, b }) {
  return `#${[r, g, b].map((part) => Math.round(Math.max(0, Math.min(255, part))).toString(16).padStart(2, "0")).join("")}`;
}

function luminance({ r, g, b }) {
  const channel = (value) => {
    const normalized = Math.max(0, Math.min(255, value)) / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function mix(color, target, ratio) {
  return {
    r: color.r + (target.r - color.r) * ratio,
    g: color.g + (target.g - color.g) * ratio,
    b: color.b + (target.b - color.b) * ratio
  };
}

export function isLightBackground(background) {
  return luminance(parseHexColor(background)) > 0.5;
}

/** Rule table in file order. Later groups do not override earlier matches. */
export const HIGHLIGHT_RULES = [
  { pattern: String.raw`(no(t)?(connect)?)|((shut)?(down)?)`, colorRef: 0x000000ff },
  { pattern: String.raw`(dis((able(d)?)|(connect(ed)?)|(allow(ed)?)|(card(ed)?))|(error(s)?))|(fail((ure)|(ed))?)|((city)?[w]{2}m)|(den((y)|(ied)){1})`, colorRef: 0x000000ff },
  { pattern: String.raw`red|administratively|undo|unknown|fault|block|refused|problem|warnings|alerts|critical|delete|inactive|unassigned`, colorRef: 0x000000ff },
  { pattern: String.raw`(([7-9]\d)|(100))(\.\d{0,2})?\%`, colorRef: 0x000000ff },

  { pattern: String.raw`green|up|forward|full|active`, colorRef: 0x0000ff00 },
  { pattern: String.raw`(connect(ed)?)|(permit(ed)?)|(estab(lish)?(ed)?)|(enable(d)?|(allow(ed)?))`, colorRef: 0x0000ff00 },
  { pattern: String.raw`(([0-3](\d)?)|\d{1})(\.\d{0,2})?\%`, colorRef: 0x0000ff00 },

  { pattern: String.raw`(bgp|(ospf(v3)?)|(rip(ng)?)|eigrp|static|odr|unr|(is(\-)?is)|pim|direct)(\-\d*)?`, colorRef: 0x00ff8000 },
  { pattern: String.raw`cyan|ipv6|tcp|udp|(i(c|g)mp)|gre|esp|ah|isakmp|(arp(a)?)|dhcp|(http(s)?)|dns|((t)?ftp)|telnet|ssh|www|ntp|radius|tacacs|pop\d|smtp|ppp|fr(ame(\-)?relay)?|hdlc`, colorRef: 0x00ff8000 },
  { pattern: String.raw`standby|vrrp|glbp|(mst(p)?)|((r)?stp)|spanning\-tree|dot1q|802\.1q`, colorRef: 0x00ff8000 },
  { pattern: String.raw`ldp|tdp|mpls|aaa|(account(ing)?)|(auth((entication)|(orization)))|nat|bfd|nqa|sla|rtr|vrf|vpn(\-instance)?`, colorRef: 0x00ff8000 },

  { pattern: String.raw`(((passive\-)|(silent\-))?interface)|(in|out)((bound)|(put))?`, colorRef: 0x00ff00ff },
  { pattern: String.raw`magenta|router|redistribute|(import(\-route)?)|export|network|neighbor|peer|area|acl|(class((ifier)|(\-map)))|behavior|policy(\-map)?`, colorRef: 0x00ff00ff },
  { pattern: String.raw`access\-((list)|(class)|(group))|ip\-prefix|prefix\-list|(route(\-.*)?)|(traffic.*)`, colorRef: 0x00ff00ff },
  { pattern: String.raw`[4-6]\d((\.\d{0,2})?)\%`, colorRef: 0x00ff00ff },

  { pattern: String.raw`((fast)?|(gigabit)?)ethernet((\d)?\d\/)*(\d)+(\.\d{1,4})?`, colorRef: 0x000080ff },
  { pattern: String.raw`\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(\/(\d){0,2})?`, colorRef: 0x000080ff },
  { pattern: String.raw`([A-Fa-f0-9]{1,4}::?){1,7}[A-Fa-f0-9]{1,4}(\/(\d){0,3})?`, colorRef: 0x000080ff },
  { pattern: String.raw`([0-9a-fA-f]{4}[.|-][0-9a-fA-f]{4}[.|-][0-9a-fA-f]{4})|([0-9a-fa-f]{2}[.|-]){5}[0-9a-fa-f]{2}`, colorRef: 0x000080ff },
  { pattern: String.raw`\d{1,2}\.([0-9a-fA-F]{2,4}.){1,11}\d{1,2}`, colorRef: 0x000080ff },
  { pattern: String.raw`(orange|ge|fa|fe|(eth((\-)?(trunk)?))|null|loopback|tunnel|dialer|bri|serial|atm|pos|(vlan(if)?))(((\d)?\d\/)*(\d)+)?`, colorRef: 0x000080ff },
  { pattern: String.raw`((virtual\-(template|ppp|access))|(channel\-group)|(port\-channel)|(ether(\-)?channel))(((\d)?\d\/)*(\d)+)?`, colorRef: 0x000080ff }
].map((rule, index) => {
  let regex = null;
  try {
    regex = new RegExp(rule.pattern, "gi");
  } catch {
    regex = null;
  }
  return { ...rule, index, regex };
}).filter((rule) => rule.regex !== null);

const colorCache = new Map();

function ansiFor(rule, background) {
  const key = `${rule.index}:${background}`;
  const cached = colorCache.get(key);
  if (cached !== undefined) return cached;
  let rgb = colorRefToRgb(rule.colorRef);
  if (isLightBackground(background)) {
    // Keep semantic colors readable on a user-selected white/light terminal.
    rgb = mix(rgb, { r: 0, g: 0, b: 0 }, 0.5);
  } else if (luminance(rgb) < 0.08) {
    rgb = mix(rgb, { r: 255, g: 255, b: 255 }, 0.25);
  }
  const code = `\x1b[38;2;${Math.round(rgb.r)};${Math.round(rgb.g)};${Math.round(rgb.b)}m`;
  colorCache.set(key, code);
  return code;
}

const RESET = "\x1b[0m";
const MAX_LINE = 12_000;
const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

/**
 * A keyword alternative only matches when it is not embedded in a larger word.
 * Without this, `ge` lights up inside "Usage" and `no` inside "Canonical" —
 * both are substrings, not device keywords.
 */
function hasWordBoundaries(text, start, end) {
  const before = start > 0 ? text[start - 1] : "";
  const after = end < text.length ? text[end] : "";
  if (before !== "" && WORD_CHARACTER.test(before)) return false;
  if (after !== "" && WORD_CHARACTER.test(after)) return false;
  return true;
}

/** Decorate one complete line (without altering newlines). */
export function highlightLine(line, background = "#000000") {
  if (typeof line !== "string" || line === "") return line;
  if (line.includes("\x1b")) return line;
  let suffix = "";
  let body = line;
  // H3C/Huawei devices often terminate lines with "\r\r\n". Strip the whole
  // ending (and any stray trailing CR) before checking for embedded CRs;
  // otherwise every device line looks like a carriage-return progress line
  // and is passed through unhighlighted.
  const ending = /\r*\n$/.exec(body);
  if (ending !== null) {
    suffix = ending[0];
    body = body.slice(0, -suffix.length);
  }
  while (body.endsWith("\r")) body = body.slice(0, -1);
  // Carriage-return progress lines overwrite themselves; decorating them would
  // leave partial escape sequences in the overwritten cells.
  if (body.includes("\r") || body.length > MAX_LINE) return line;

  const matches = [];
  for (const rule of HIGHLIGHT_RULES) {
    rule.regex.lastIndex = 0;
    let match;
    while ((match = rule.regex.exec(body)) !== null) {
      if (match[0].length === 0) {
        rule.regex.lastIndex += 1;
        continue;
      }
      const end = match.index + match[0].length;
      if (!hasWordBoundaries(body, match.index, end)) continue;
      matches.push({ start: match.index, end, rule });
    }
  }
  if (matches.length === 0) return line;

  // Earliest start wins; among the same start, the longest match wins; ties go
  // to the rule that appears first in the file.
  matches.sort((left, right) =>
    left.start - right.start
    || (right.end - right.start) - (left.end - left.start)
    || left.rule.index - right.rule.index
  );
  let output = "";
  let cursor = 0;
  for (const match of matches) {
    if (match.start < cursor) continue;
    output += body.slice(cursor, match.start);
    output += ansiFor(match.rule, background);
    output += body.slice(match.start, match.end);
    output += RESET;
    cursor = match.end;
  }
  output += body.slice(cursor);
  return output + suffix;
}

/**
 * Transform a terminal chunk: complete lines are highlighted, an incomplete
 * tail is returned as-is so prompts and progress output appear immediately.
 */
export function createTerminalHighlighter(getOptions) {
  // SSH chunks split lines arbitrarily. Highlighting only lines wholly inside
  // one chunk misses almost everything, so keep the incomplete tail here and
  // let the caller flush it after a short delay (prompts stay responsive).
  let carry = "";
  const optionsOf = () => (typeof getOptions === "function" ? getOptions() : undefined);
  const decorate = (text, background) => {
    let output = "";
    let start = 0;
    for (let index = 0; index < text.length; index += 1) {
      if (text.charCodeAt(index) !== 10) continue;
      output += highlightLine(text.slice(start, index + 1), background);
      start = index + 1;
    }
    return output;
  };
  return {
    transform(chunk) {
      if (typeof chunk !== "string" || chunk === "") return chunk;
      const options = optionsOf();
      if (options?.enabled === false) {
        const pending = carry;
        carry = "";
        return pending + chunk;
      }
      if (chunk.length > 512 * 1024) {
        const pending = carry;
        carry = "";
        return pending + chunk;
      }
      const text = carry + chunk;
      const lastNewline = text.lastIndexOf("\n");
      if (lastNewline < 0) {
        // Keep only a bounded tail; pathological output must not grow memory.
        if (text.length > 64 * 1024) {
          carry = "";
          return text;
        }
        carry = text;
        return "";
      }
      carry = text.slice(lastNewline + 1);
      return decorate(text.slice(0, lastNewline + 1), options?.background ?? "#000000");
    },
    /** Emit the incomplete tail (called by a short timer or on teardown). */
    flush() {
      const pending = carry;
      carry = "";
      if (pending === "") return "";
      return pending;
    }
  };
}

/** Exposed for tests and for a future "custom rules" UI. */
export function colorForRule(rule, background) {
  return ansiFor(rule, background);
}

export function highlightColorHex(rule, background) {
  let rgb = colorRefToRgb(rule.colorRef);
  if (isLightBackground(background)) rgb = mix(rgb, { r: 0, g: 0, b: 0 }, 0.5);
  return toHex(rgb);
}
