/**
 * Agent tools for dsh-autoconfig.
 *
 * Every tool drives the same host session the right-side terminal displays:
 * `device_send` echoes a dim `[agent ...]` marker into the terminal, `device_read`
 * harvests output from the same journal, and SFTP operations append transcript
 * lines. A tool can therefore never silently act on a device the operator
 * cannot see.
 */
import { defineTool } from "@deepseek-ai/dsh-tools";

function unwrap(result, tool) {
  if (!result || result.ok !== true) {
    throw new Error(`${tool} failed: ${result?.error?.message ?? "unknown error"}`);
  }
  return result.value;
}

function connectionSummary(info) {
  return {
    connectionId: info.connectionId,
    protocol: info.protocol,
    host: info.host,
    port: info.port,
    username: info.username,
    name: info.name,
    hostname: info.hostname,
    ip: info.ip,
    status: info.status,
    logFile: info.logFile
  };
}

const PROTOCOL_ENUM = ["ssh", "telnet", "console", "sftp"];
const nullableString = { oneOf: [{ type: "string" }, { type: "null" }] };
const nullableInteger = { oneOf: [{ type: "integer" }, { type: "null" }] };

export function registerDeviceTools(ctx, service) {
  ctx.tools.register(defineTool({
    name: "device_connect",
    description:
      "Connect to a router, switch, firewall or server and open its terminal in the right-side panel. " +
      "Supports protocol 'ssh' (interactive shell), 'sftp' (file transfer session), 'telnet' and 'console' (serial COM port). " +
      "After connecting, use device_send to type commands and device_read to read output. " +
      "For Telnet/console, when username and password are supplied, login prompts are answered automatically and the credentials are not written to the log. " +
      "The session is recorded automatically to a log named <hostname>_<ip>_<timestamp>.log.",
    parameters: {
      protocol: { type: "string", enum: PROTOCOL_ENUM, required: true, description: "Transport: ssh, sftp, telnet, or console (serial)." },
      host: { type: "string", description: "Device hostname or IP. Required for ssh/sftp/telnet; omit for console." },
      port: { type: "integer", description: "TCP port. Defaults: ssh/sftp 22, telnet 23." },
      username: { type: "string", description: "Login username. For SSH it is the SSH user; for telnet/console it is used for auto-login." },
      password: { type: "string", description: "Login password (never returned or logged)." },
      private_key: { type: "string", description: "PEM private key for SSH key authentication." },
      passphrase: { type: "string", description: "Private-key passphrase, if any." },
      name: { type: "string", description: "Operator-facing device name (e.g. 'core-sw-1'). Used in the log name until the real prompt hostname is discovered." },
      serial_path: { type: "string", description: "Serial port path for console, e.g. 'COM3' or '/dev/ttyUSB0'." },
      baud_rate: { type: "integer", description: "Console baud rate; default 9600." },
      data_bits: { type: "integer", enum: [5, 6, 7, 8], description: "Console data bits; default 8." },
      stop_bits: { type: "number", enum: [1, 1.5, 2], description: "Console stop bits; default 1." },
      parity: { type: "string", enum: ["none", "even", "odd", "mark", "space"], description: "Console parity; default none." },
      legacy: { type: "boolean", description: "SSH: use legacy SHA-1 KEX immediately (old Huawei VRP / IOS / Comware). Default: retry automatically only if the handshake fails on KEX." },
      auto_login: { type: "boolean", description: "Telnet/console: answer login/password prompts automatically. Default true when credentials are supplied." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          connectionId: { type: "string", required: true },
          protocol: { type: "string", required: true },
          host: nullableString,
          port: nullableInteger,
          username: nullableString,
          name: { type: "string", required: true },
          hostname: nullableString,
          ip: nullableString,
          status: { type: "string", required: true },
          logFile: nullableString
        }
      },
      render(_args, value) {
        return [{
          type: "text",
          text: `已连接 ${value.name}（${value.protocol}${value.host ? ` ${value.host}:${value.port ?? ""}` : ""}，id: ${value.connectionId}）。右侧终端已打开；日志：${value.logFile ?? "未记录"}。`
        }];
      }
    },
    async execute(args) {
      const result = await service.connect({
        protocol: args.protocol,
        host: args.host,
        port: args.port,
        username: args.username,
        password: args.password,
        privateKey: args.private_key,
        passphrase: args.passphrase,
        name: args.name,
        legacy: args.legacy,
        autoLogin: args.auto_login,
        agent: true,
        ...(args.protocol === "console"
          ? {
              serial: {
                path: args.serial_path,
                baudRate: args.baud_rate,
                dataBits: args.data_bits,
                stopBits: args.stop_bits,
                parity: args.parity
              }
            }
          : {})
      });
      const value = unwrap(result, "device_connect");
      return connectionSummary(value);
    }
  }));

  ctx.tools.register(defineTool({
    name: "device_list",
    description: "List device connections currently known to dsh-autoconfig, with protocol, host, status, active session and log file. Credentials are never returned.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          activeConnectionId: { ...nullableString, required: true },
          connections: {
            type: "array",
            required: true,
            items: { type: "object", additionalProperties: true }
          }
        }
      },
      render(_args, value) {
        if (value.connections.length === 0) return [{ type: "text", text: "当前没有设备连接。先用 device_connect 连接设备。" }];
        const lines = value.connections.map((conn) =>
          `${conn.connectionId === value.activeConnectionId ? "* " : "- "}${conn.name} (${conn.protocol}${conn.host ? ` ${conn.host}:${conn.port ?? ""}` : ""}) [${conn.status}]${conn.logFile ? ` log=${conn.logFile}` : ""}`
        );
        return [{ type: "text", text: lines.join("\n") }];
      }
    },
    async execute() {
      const listed = unwrap(await service.list(), "device_list");
      return { activeConnectionId: listed.activeConnectionId, connections: listed.connections };
    }
  }));

  ctx.tools.register(defineTool({
    name: "device_send",
    description:
      "Send input to a device terminal (the same terminal shown in the right-side panel). " +
      "By default a carriage return is appended so the command/prompt answer is submitted, exactly like a human pressing Enter. " +
      "Use press_enter=false for raw input (function keys, Ctrl-C, interactive menus). " +
      "The operation is echoed into the visible terminal as a dim [agent] marker and recorded in the session log. " +
      "Set sensitive=true when sending a password or secret so the value is redacted in the terminal marker and log.",
    parameters: {
      connection_id: { type: "string", description: "Target connection. Omit to use the current/active device." },
      input: { type: "string", required: true, description: "Text/bytes to send, e.g. 'display version'." },
      press_enter: { type: "boolean", description: "Append carriage return (Enter) unless input already ends with a newline. Default true." },
      sensitive: { type: "boolean", description: "Redact the input in the terminal marker and session log (use for passwords)." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          connectionId: { type: "string", required: true },
          written: { type: "integer", required: true }
        }
      },
      render(_args, value) {
        return [{ type: "text", text: `已向 ${value.connectionId} 发送 ${value.written} 字节；操作已显示在右侧终端。` }];
      }
    },
    async execute(args) {
      return service.writeAgentInput(args.connection_id, args.input, {
        pressEnter: args.press_enter !== false,
        sensitive: args.sensitive === true
      });
    }
  }));

  ctx.tools.register(defineTool({
    name: "device_read",
    description:
      "Read output from a device terminal. mode='new' (default) returns only output that arrived since the previous device_read on this connection; " +
      "mode='tail' returns the recent terminal buffer (up to 64 KB) and is the right choice for output that predates your first read. " +
      "The same text is visible in the right-side terminal, so the operator can audit every command you send.",
    parameters: {
      connection_id: { type: "string", description: "Target connection. Omit to use the current/active device." },
      mode: { type: "string", enum: ["new", "tail"], description: "'new' (default) or 'tail'." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          connectionId: { type: "string", required: true },
          data: { type: "string", required: true },
          truncated: { type: "boolean", required: true },
          closed: { type: "boolean", required: true }
        }
      },
      render(_args, value) {
        const body = value.data || "(no new output)";
        return [{ type: "text", text: `${body}${value.truncated ? "\n[output truncated to 64 KB]" : ""}${value.closed ? "\n[session closed]" : ""}` }];
      }
    },
    async execute(args) {
      return service.readAgentOutput(args.connection_id, args.mode ?? "new");
    }
  }));

  ctx.tools.register(defineTool({
    name: "device_close",
    description: "Close a device connection and its terminal session. The session log is finalized on disk.",
    parameters: {
      connection_id: { type: "string", description: "Target connection. Omit to close the current/active device." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          connectionId: { type: "string", required: true },
          closed: { type: "boolean", required: true }
        }
      },
      render(_args, value) { return [{ type: "text", text: `已关闭连接 ${value.connectionId}。` }]; }
    },
    async execute(args) {
      return service.closeConnection(args.connection_id);
    }
  }));

  ctx.tools.register(defineTool({
    name: "device_sftp",
    description:
      "Operate on files over SFTP on an SSH/SFTP connection: list, stat, read, write, mkdir, remove, rename. " +
      "Read returns text by default; set encoding='base64' for binary files. Write accepts text (data) or base64 (data_base64). " +
      "Every operation is appended to the right-side terminal transcript and to the session log.",
    parameters: {
      action: { type: "string", enum: ["list", "stat", "read", "write", "mkdir", "remove", "rename"], required: true },
      connection_id: { type: "string", description: "Target SSH/SFTP connection. Omit to use the current/active device." },
      path: { type: "string", description: "Remote POSIX path. Required for all actions except list (defaults to '.')." },
      to: { type: "string", description: "Rename target file name (same directory)." },
      data: { type: "string", description: "Text content for write." },
      data_base64: { type: "string", description: "Binary content for write, base64 encoded." },
      encoding: { type: "string", enum: ["text", "base64"], description: "Read output encoding; default text." },
      max_bytes: { type: "integer", description: "Read byte limit, at most 4194304." }
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render(args, value) {
        if (args.action === "list") {
          const entries = value.entries ?? [];
          const lines = entries.slice(0, 200).map((entry) =>
            `${entry.isDirectory ? "d" : "-"} ${String(entry.size).padStart(10)}  ${entry.name}`
          );
          return [{ type: "text", text: `${value.path}:\n${lines.join("\n")}${entries.length > 200 ? `\n... (${entries.length - 200} more)` : ""}` }];
        }
        if (args.action === "read" && typeof value.text === "string") {
          return [{ type: "text", text: value.text || "(empty file)" }];
        }
        return [{ type: "text", text: JSON.stringify(value, null, 2) }];
      }
    },
    async execute(args) {
      const action = args.action;
      const input = {
        path: args.path,
        to: args.to,
        maxBytes: args.max_bytes
      };
      if (action === "write") {
        if (typeof args.data_base64 === "string" && args.data_base64 !== "") {
          input.data = args.data_base64;
        } else {
          input.data = Buffer.from(args.data ?? "", "utf8").toString("base64");
        }
      }
      const result = await service.sftpTool(args.connection_id, action, input);
      const value = unwrap(result, "device_sftp");
      if (action === "read") {
        const bytes = Buffer.from(value.data, "base64");
        const text = args.encoding === "base64" ? null : bytes.toString("utf8");
        const textual = text !== null && !text.includes("\u0000");
        if (textual) return { path: value.path, bytes: value.bytes, truncated: value.truncated, text, encoding: "text" };
        return { path: value.path, bytes: value.bytes, truncated: value.truncated, base64: value.data, encoding: "base64" };
      }
      return value;
    }
  }));

  ctx.tools.register(defineTool({
    name: "device_logs",
    description:
      "List, read or delete the automatically recorded device session logs. " +
      "Log files are named <hostname>_<ip>_<YYYYMMDD-HHMMSS>.log. Use action='list' first, then action='read' with a file name; " +
      "reads are paged with offset/next_offset and capped at 64 KB per call.",
    parameters: {
      action: { type: "string", enum: ["list", "read", "delete"], required: true },
      file: { type: "string", description: "Log file name from action='list'." },
      offset: { type: "integer", description: "Byte offset for read; default 0." },
      max_bytes: { type: "integer", description: "Read limit, at most 65536." }
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render(args, value) {
        if (args.action === "list") {
          const logs = value.logs ?? [];
          if (logs.length === 0) return [{ type: "text", text: `日志目录为空：${value.dir}` }];
          const lines = logs.slice(0, 100).map((log) =>
            `${log.file}  ${log.bytes} bytes  ${log.startedAt ?? ""}  ${log.hostname ?? ""}${log.ip ? ` (${log.ip})` : ""}`
          );
          return [{ type: "text", text: `${value.dir}\n${lines.join("\n")}` }];
        }
        if (args.action === "read") return [{ type: "text", text: value.data || "(end of log)" }];
        return [{ type: "text", text: `已删除 ${value.deleted ? args.file : "(not found)"}` }];
      }
    },
    async execute(args) {
      if (args.action === "list") {
        return unwrap(await service.logList(), "device_logs");
      }
      if (args.action === "delete") {
        return unwrap(await service.logDelete({ file: args.file }), "device_logs");
      }
      const result = await service.logRead({
        file: args.file,
        offset: args.offset ?? 0,
        maxBytes: args.max_bytes ?? 64 * 1024
      });
      const value = unwrap(result, "device_logs");
      return { ...value, data: Buffer.from(value.data, "base64").toString("utf8") };
    }
  }));
}
