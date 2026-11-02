/**
 * Minimal Telnet (RFC 854/855) stream demultiplexer.
 *
 * Telnet reserves 0xFF (IAC) for in-band commands. A raw socket therefore
 * cannot be handed to xterm: option negotiation and subnegotiation must be
 * consumed here, and unsupported options must be refused instead of displayed.
 * The parser is transport-free so it can be unit-tested without a socket.
 */

export const IAC = 255;
export const DONT = 254;
export const DO = 253;
export const WONT = 252;
export const WILL = 251;
export const SB = 250;
export const GA = 249;
export const SE = 240;

export const OPT_BINARY = 0;
export const OPT_ECHO = 1;
export const OPT_SGA = 3;
export const OPT_TTYPE = 24;
export const OPT_NAWS = 31;

/** Options this client is willing to enable on its own side. */
const LOCAL_SUPPORTED = new Set([OPT_BINARY, OPT_SGA, OPT_TTYPE, OPT_NAWS]);
/** Options this client accepts the peer enabling. */
const REMOTE_SUPPORTED = new Set([OPT_BINARY, OPT_ECHO, OPT_SGA]);

function iac(...bytes) {
  return Buffer.from([IAC, ...bytes]);
}

/**
 * @param {object} handlers
 * @param {(bytes: Uint8Array) => void} [handlers.onData] application bytes
 * @param {(bytes: Buffer) => void} [handlers.onReply] bytes to write back
 */
export function createTelnetParser({ onData, onReply } = {}) {
  let state = 0; // 0=data 1=after IAC 2=option command 3=subneg 4=subneg IAC
  let command = 0;
  let subneg = [];
  let localEnabled = new Set();
  let remoteEnabled = new Set();

  const reply = (bytes) => {
    try {
      onReply?.(bytes);
    } catch {
      /* a dead socket must not break parsing */
    }
  };

  const handleOption = (verb, option) => {
    if (verb === DO) {
      if (LOCAL_SUPPORTED.has(option)) {
        localEnabled.add(option);
        reply(iac(WILL, option));
        if (option === OPT_NAWS) sendNaws();
      } else {
        reply(iac(WONT, option));
      }
      return;
    }
    if (verb === WILL) {
      if (REMOTE_SUPPORTED.has(option)) {
        remoteEnabled.add(option);
        reply(iac(DO, option));
      } else {
        reply(iac(DONT, option));
      }
    }
    // WONT / DONT: the peer is refusing; no reply is required by RFC 854.
  };

  const handleSubneg = (bytes) => {
    // TTYPE SEND (24, 1) -> IS "xterm-256color"
    if (bytes[0] === OPT_TTYPE && bytes[1] === 1) {
      const name = Buffer.from("xterm-256color", "ascii");
      reply(Buffer.concat([Buffer.from([IAC, SB, OPT_TTYPE, 0]), name, Buffer.from([IAC, SE])]));
    }
    // NAWS from peer is a client-side option; ignored.
    // Terminal speed / window size / environment: ignored.
  };

  function sendNaws() {
    if (!localEnabled.has(OPT_NAWS)) return;
    const cols = Math.max(1, Math.min(0xffff, parser.cols | 0));
    const rows = Math.max(1, Math.min(0xffff, parser.rows | 0));
    reply(Buffer.from([
      IAC, SB, OPT_NAWS,
      (cols >> 8) & 0xff, cols & 0xff,
      (rows >> 8) & 0xff, rows & 0xff,
      IAC, SE
    ]));
  }

  const parser = {
    cols: 80,
    rows: 24,
    /** Feed one socket chunk. Returns nothing; application bytes go to onData. */
    feed(chunk) {
      const input = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      const output = [];
      for (let i = 0; i < input.length; i += 1) {
        const byte = input[i];
        if (state === 0) {
          if (byte === IAC) state = 1;
          else output.push(byte);
        } else if (state === 1) {
          if (byte === IAC) {
            output.push(IAC);
            state = 0;
          } else if (byte === SB) {
            state = 3;
            subneg = [];
          } else if (byte >= WILL && byte <= DONT) {
            command = byte;
            state = 2;
          } else {
            // NOP, DM, BRK, IP, AO, AYT, EC, EL, GA: no payload / handled by peer.
            state = 0;
          }
        } else if (state === 2) {
          handleOption(command, byte);
          state = 0;
        } else if (state === 3) {
          if (byte === IAC) state = 4;
          else subneg.push(byte);
        } else if (state === 4) {
          if (byte === SE) {
            handleSubneg(subneg);
            subneg = [];
            state = 0;
          } else {
            // Escaped IAC inside subnegotiation.
            subneg.push(IAC, byte);
            state = 3;
          }
        }
      }
      if (output.length > 0) onData?.(Uint8Array.from(output));
    },
    /** Announce the local window size (after the peer has enabled NAWS). */
    resize(cols, rows) {
      parser.cols = cols;
      parser.rows = rows;
      sendNaws();
    },
    /** Negotiate the options every interactive client offers first. */
    negotiate() {
      reply(iac(WILL, OPT_TTYPE));
      reply(iac(WILL, OPT_NAWS));
      reply(iac(WILL, OPT_SGA));
      reply(iac(DO, OPT_SGA));
    }
  };

  return parser;
}
