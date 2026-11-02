/**
 * Zod schemas for the dsh-autoconfig wire contract. The host typert manifest
 * validates incoming arguments and outgoing results; the browser contribution
 * validates the same envelope before the panel consumes it.
 */
import { z } from "zod";

export const PROTOCOLS = ["ssh", "telnet", "console", "sftp"];

export const autoconfigErrorSchema = z.object({
  code: z.string(),
  message: z.string()
});

export function resultSchema(value) {
  return z.union([
    z.object({ ok: z.literal(true), value }),
    z.object({ ok: z.literal(false), error: autoconfigErrorSchema })
  ]);
}

const nullableString = z.string().nullable();
const nullableInt = z.number().int().nullable();

// ── connect ─────────────────────────────────────────────────────────────────

export const serialOptionsSchema = z.object({
  path: z.string().min(1).max(260),
  baudRate: z.number().int().min(50).max(4000000).optional(),
  dataBits: z.union([z.literal(5), z.literal(6), z.literal(7), z.literal(8)]).optional(),
  stopBits: z.union([z.literal(1), z.literal(1.5), z.literal(2)]).optional(),
  parity: z.enum(["none", "even", "odd", "mark", "space"]).optional()
});

export const connectRequestSchema = z.object({
  protocol: z.enum(PROTOCOLS),
  // Network transports. Serial uses `serial` instead.
  host: z.string().max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().max(128).optional(),
  password: z.string().max(8192).optional(),
  privateKey: z.string().max(131072).optional(),
  passphrase: z.string().max(8192).optional(),
  // Operator-facing device name. When the real prompt hostname is discovered,
  // the log file is renamed to that value.
  name: z.string().max(128).optional(),
  cols: z.number().int().min(1).max(2000).optional(),
  rows: z.number().int().min(1).max(2000).optional(),
  legacy: z.boolean().optional(),
  // Telnet/console: answer login/password prompts automatically.
  autoLogin: z.boolean().optional(),
  serial: serialOptionsSchema.optional(),
  // The connection was requested by an agent tool; the browser reveals it.
  agent: z.boolean().optional(),
  // UI opt-in: record this device in the left session bar; savePassword also
  // stores the password in DSH's credential store for double-click reconnect.
  saveProfile: z.boolean().optional(),
  savePassword: z.boolean().optional()
});

export const connectionInfoSchema = z.object({
  connectionId: z.string(),
  protocol: z.enum(PROTOCOLS),
  host: nullableString,
  port: nullableInt,
  username: nullableString,
  name: z.string(),
  hostname: nullableString,
  ip: nullableString,
  connected: z.boolean(),
  status: z.enum(["connecting", "open", "closed", "error"]),
  openedAt: z.string(),
  closedAt: nullableString,
  logFile: nullableString,
  agent: z.boolean(),
  exitCode: nullableInt
});

export const connectResultSchema = resultSchema(connectionInfoSchema);

export const listRequestSchema = z.object({});
export const listResultSchema = resultSchema(z.object({
  connections: z.array(connectionInfoSchema),
  activeConnectionId: nullableString,
  logDir: z.string(),
  protocols: z.array(z.enum(PROTOCOLS))
}));

// ── saved sessions (left connection bar) ────────────────────────────────────

export const profileInfoSchema = z.object({
  profileId: z.string(),
  protocol: z.enum(PROTOCOLS),
  host: nullableString,
  port: nullableInt,
  username: nullableString,
  name: z.string(),
  serial: serialOptionsSchema.nullable(),
  legacy: z.boolean(),
  autoLogin: z.boolean(),
  hasPassword: z.boolean(),
  createdAt: z.string(),
  lastUsedAt: nullableString
});

export const profileSaveRequestSchema = z.object({
  protocol: z.enum(PROTOCOLS),
  host: z.string().max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().max(128).optional(),
  password: z.string().max(8192).optional(),
  name: z.string().max(128).optional(),
  serial: serialOptionsSchema.optional(),
  legacy: z.boolean().optional(),
  autoLogin: z.boolean().optional(),
  savePassword: z.boolean().optional()
});
export const profileSaveResultSchema = resultSchema(profileInfoSchema);

export const profileListRequestSchema = z.object({});
export const profileListResultSchema = resultSchema(z.object({
  profiles: z.array(profileInfoSchema)
}));

export const profileDeleteRequestSchema = z.object({ profileId: z.string() });
export const profileDeleteResultSchema = resultSchema(z.object({ deleted: z.boolean() }));

export const profileConnectRequestSchema = z.object({ profileId: z.string() });
export const profileConnectResultSchema = resultSchema(connectionInfoSchema);

// ── terminal ────────────────────────────────────────────────────────────────

export const writeRequestSchema = z.object({
  connectionId: z.string(),
  // Base64 of the exact bytes to send (terminal input is not necessarily UTF-8).
  data: z.string(),
  source: z.enum(["panel", "agent"]).optional(),
  sensitive: z.boolean().optional()
});
export const writeResultSchema = resultSchema(z.object({ written: z.number().int() }));

export const readRequestSchema = z.object({
  connectionId: z.string(),
  timeoutMs: z.number().int().min(0).max(30000).optional(),
  after: z.number().int().min(0).optional()
});

export const exitSchema = z.object({
  code: nullableInt,
  signal: nullableString
}).nullable();

export const readValueSchema = z.object({
  data: z.string(),
  startOffset: z.number().int(),
  offset: z.number().int(),
  exit: exitSchema
});
export const readResultSchema = resultSchema(readValueSchema);
export const terminalStreamRequestSchema = z.object({
  connectionId: z.string(),
  after: z.number().int().min(0).optional()
});

export const resizeRequestSchema = z.object({
  connectionId: z.string(),
  cols: z.number().int().min(1).max(2000),
  rows: z.number().int().min(1).max(2000)
});
export const resizeResultSchema = resultSchema(z.object({ cols: z.number().int(), rows: z.number().int() }));

export const closeRequestSchema = z.object({ connectionId: z.string() });
export const closeResultSchema = resultSchema(z.object({ closed: z.boolean() }));

export const selectRequestSchema = z.object({ connectionId: z.string() });
export const selectResultSchema = resultSchema(z.object({ activeConnectionId: nullableString }));

// ── serial ──────────────────────────────────────────────────────────────────

export const serialPortsRequestSchema = z.object({});
export const serialPortsResultSchema = resultSchema(z.object({
  ports: z.array(z.object({
    path: z.string(),
    manufacturer: nullableString,
    serialNumber: nullableString,
    vendorId: nullableString,
    productId: nullableString
  }))
}));

// ── sftp ────────────────────────────────────────────────────────────────────

export const sftpListRequestSchema = z.object({
  connectionId: z.string(),
  path: z.string().max(4096).optional(),
  // The file browser polls; quiet listings must not flood the terminal/log
  // transcript that is supposed to show agent operations.
  quiet: z.boolean().optional()
});
export const sftpEntrySchema = z.object({
  name: z.string(),
  isDirectory: z.boolean(),
  size: z.number().int(),
  mtime: z.number().int(),
  mode: z.number().int()
});
export const sftpListResultSchema = resultSchema(z.object({
  path: z.string(),
  entries: z.array(sftpEntrySchema)
}));

export const sftpReadFileRequestSchema = z.object({
  connectionId: z.string(),
  path: z.string().max(4096),
  maxBytes: z.number().int().min(1).max(8 * 1024 * 1024).optional()
});
export const sftpReadFileResultSchema = resultSchema(z.object({
  path: z.string(),
  data: z.string(),
  bytes: z.number().int(),
  truncated: z.boolean()
}));

export const sftpWriteFileRequestSchema = z.object({
  connectionId: z.string(),
  path: z.string().max(4096),
  data: z.string()
});
export const sftpWriteFileResultSchema = resultSchema(z.object({
  path: z.string(),
  bytes: z.number().int()
}));

export const sftpMkdirRequestSchema = z.object({
  connectionId: z.string(),
  path: z.string().max(4096)
});
export const sftpMkdirResultSchema = resultSchema(z.object({ path: z.string() }));

export const sftpDeleteRequestSchema = z.object({
  connectionId: z.string(),
  path: z.string().max(4096)
});
export const sftpDeleteResultSchema = resultSchema(z.object({ path: z.string(), isDirectory: z.boolean() }));

export const sftpRenameRequestSchema = z.object({
  connectionId: z.string(),
  from: z.string().max(4096),
  to: z.string().max(4096)
});
export const sftpRenameResultSchema = resultSchema(z.object({ from: z.string(), to: z.string() }));

// ── logs ────────────────────────────────────────────────────────────────────

export const logListRequestSchema = z.object({});
export const logInfoSchema = z.object({
  file: z.string(),
  connectionId: nullableString,
  protocol: nullableString,
  host: nullableString,
  port: nullableInt,
  username: nullableString,
  hostname: nullableString,
  ip: nullableString,
  name: nullableString,
  startedAt: nullableString,
  endedAt: nullableString,
  bytes: z.number().int(),
  exitCode: nullableInt,
  truncated: z.boolean(),
  agent: z.boolean()
});
export const logListResultSchema = resultSchema(z.object({
  dir: z.string(),
  logs: z.array(logInfoSchema)
}));

export const logReadRequestSchema = z.object({
  file: z.string().max(260),
  offset: z.number().int().min(0).optional(),
  maxBytes: z.number().int().min(1).max(4 * 1024 * 1024).optional()
});
export const logReadResultSchema = resultSchema(z.object({
  file: z.string(),
  data: z.string(),
  startOffset: z.number().int(),
  nextOffset: z.number().int(),
  eof: z.boolean(),
  size: z.number().int()
}));

export const logDeleteRequestSchema = z.object({ file: z.string().max(260) });
export const logDeleteResultSchema = resultSchema(z.object({ deleted: z.boolean() }));
