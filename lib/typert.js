import { createRequire as __dshCreateRequire } from 'node:module'; import { fileURLToPath as __dshFileURLToPath } from 'node:url'; import { dirname as __dshDirname } from 'node:path'; const require = __dshCreateRequire(import.meta.url); const __filename = __dshFileURLToPath(import.meta.url); const __dirname = __dshDirname(__filename);
import {
  DESCRIPTORS,
  autoconfigErrorSchema
} from "./chunks/chunk-JD2643UU.js";
import "./chunks/chunk-36LNBFKI.js";

// src/typert.js
var TYPERT = {
  package: "dsh-autoconfig",
  face: "host",
  schemas: [
    { name: "autoconfigError", schema: autoconfigErrorSchema, create: () => autoconfigErrorSchema }
  ],
  invocations: DESCRIPTORS,
  model: {
    events: [],
    objects: [],
    services: [
      {
        description: "Network-device auto-configuration sessions for the DSH Web UI: connect over SSH, Telnet, serial console or SFTP, stream terminal input/output, and list recorded session logs.",
        summary: "SSH/Telnet/console/SFTP device sessions with automatic logging.",
        tags: [],
        jsDoc: "/**\n * Network-device sessions for the Web UI.\n */",
        key: "autoconfig",
        exportName: "AutoConfigService",
        members: [
          { kind: "method", name: "connect", signature: "async connect(request: AcConnectRequest): Promise<AcConnectResult>" },
          { kind: "method", name: "list", signature: "async list(request: AcListRequest): Promise<AcListResult>" },
          { kind: "method", name: "profileSave", signature: "async profileSave(request: AcProfileSaveRequest): Promise<AcProfileSaveResult>" },
          { kind: "method", name: "profileList", signature: "async profileList(request: AcProfileListRequest): Promise<AcProfileListResult>" },
          { kind: "method", name: "profileDelete", signature: "async profileDelete(request: AcProfileDeleteRequest): Promise<AcProfileDeleteResult>" },
          { kind: "method", name: "profileConnect", signature: "async profileConnect(request: AcProfileConnectRequest): Promise<AcProfileConnectResult>" },
          { kind: "method", name: "select", signature: "async select(request: AcSelectRequest): Promise<AcSelectResult>" },
          { kind: "method", name: "write", signature: "async write(request: AcWriteRequest): Promise<AcWriteResult>" },
          { kind: "method", name: "read", signature: "async read(request: AcReadRequest): Promise<AcReadResult>" },
          { kind: "method", name: "terminalStream", signature: "async *terminalStream(request: AcTerminalStreamRequest, signal?: AbortSignal): AsyncGenerator<AcReadResult>" },
          { kind: "method", name: "resize", signature: "async resize(request: AcResizeRequest): Promise<AcResizeResult>" },
          { kind: "method", name: "close", signature: "async close(request: AcCloseRequest): Promise<AcCloseResult>" },
          { kind: "method", name: "serialPorts", signature: "async serialPorts(request: AcSerialPortsRequest): Promise<AcSerialPortsResult>" },
          { kind: "method", name: "sftpList", signature: "async sftpList(request: AcSftpListRequest): Promise<AcSftpListResult>" },
          { kind: "method", name: "sftpReadFile", signature: "async sftpReadFile(request: AcSftpReadFileRequest): Promise<AcSftpReadFileResult>" },
          { kind: "method", name: "sftpWriteFile", signature: "async sftpWriteFile(request: AcSftpWriteFileRequest): Promise<AcSftpWriteFileResult>" },
          { kind: "method", name: "sftpMkdir", signature: "async sftpMkdir(request: AcSftpMkdirRequest): Promise<AcSftpMkdirResult>" },
          { kind: "method", name: "sftpDelete", signature: "async sftpDelete(request: AcSftpDeleteRequest): Promise<AcSftpDeleteResult>" },
          { kind: "method", name: "sftpRename", signature: "async sftpRename(request: AcSftpRenameRequest): Promise<AcSftpRenameResult>" },
          { kind: "method", name: "logList", signature: "async logList(request: AcLogListRequest): Promise<AcLogListResult>" },
          { kind: "method", name: "logRead", signature: "async logRead(request: AcLogReadRequest): Promise<AcLogReadResult>" },
          { kind: "method", name: "logDelete", signature: "async logDelete(request: AcLogDeleteRequest): Promise<AcLogDeleteResult>" }
        ],
        types: [
          { name: "AcProtocol", declaration: "export type AcProtocol = 'ssh' | 'telnet' | 'console' | 'sftp';" },
          { name: "AcSerialOptions", declaration: "export interface AcSerialOptions { readonly path: string; readonly baudRate?: number; readonly dataBits?: 5|6|7|8; readonly stopBits?: 1|1.5|2; readonly parity?: 'none'|'even'|'odd'|'mark'|'space'; }" },
          { name: "AcConnectRequest", declaration: "export interface AcConnectRequest { readonly protocol: AcProtocol; readonly host?: string; readonly port?: number; readonly username?: string; readonly password?: string; readonly privateKey?: string; readonly passphrase?: string; readonly name?: string; readonly cols?: number; readonly rows?: number; readonly legacy?: boolean; readonly autoLogin?: boolean; readonly serial?: AcSerialOptions; readonly agent?: boolean; readonly saveProfile?: boolean; readonly savePassword?: boolean; }" },
          { name: "AcConnectionInfo", declaration: "export interface AcConnectionInfo { readonly connectionId: string; readonly protocol: AcProtocol; readonly host: string | null; readonly port: number | null; readonly username: string | null; readonly name: string; readonly hostname: string | null; readonly ip: string | null; readonly connected: boolean; readonly status: 'connecting'|'open'|'closed'|'error'; readonly openedAt: string; readonly closedAt: string | null; readonly logFile: string | null; readonly agent: boolean; readonly exitCode: number | null; }" },
          { name: "AcConnectResult", declaration: "export type AcConnectResult = AcResult<AcConnectionInfo>;" },
          { name: "AcListRequest", declaration: "export interface AcListRequest {}" },
          { name: "AcListResult", declaration: "export type AcListResult = AcResult<{ connections: AcConnectionInfo[]; activeConnectionId: string | null; logDir: string; protocols: AcProtocol[] }>;" },
          { name: "AcProfileInfo", declaration: "export interface AcProfileInfo { readonly profileId: string; readonly protocol: AcProtocol; readonly host: string | null; readonly port: number | null; readonly username: string | null; readonly name: string; readonly serial: AcSerialOptions | null; readonly legacy: boolean; readonly autoLogin: boolean; readonly hasPassword: boolean; readonly createdAt: string; readonly lastUsedAt: string | null; }" },
          { name: "AcProfileSaveRequest", declaration: "export interface AcProfileSaveRequest { readonly protocol: AcProtocol; readonly host?: string; readonly port?: number; readonly username?: string; readonly password?: string; readonly name?: string; readonly serial?: AcSerialOptions; readonly legacy?: boolean; readonly autoLogin?: boolean; readonly savePassword?: boolean; }" },
          { name: "AcProfileSaveResult", declaration: "export type AcProfileSaveResult = AcResult<AcProfileInfo>;" },
          { name: "AcProfileListRequest", declaration: "export interface AcProfileListRequest {}" },
          { name: "AcProfileListResult", declaration: "export type AcProfileListResult = AcResult<{ profiles: AcProfileInfo[] }>;" },
          { name: "AcProfileDeleteRequest", declaration: "export interface AcProfileDeleteRequest { readonly profileId: string; }" },
          { name: "AcProfileDeleteResult", declaration: "export type AcProfileDeleteResult = AcResult<{ deleted: boolean }>;" },
          { name: "AcProfileConnectRequest", declaration: "export interface AcProfileConnectRequest { readonly profileId: string; }" },
          { name: "AcProfileConnectResult", declaration: "export type AcProfileConnectResult = AcResult<AcConnectionInfo>;" },
          { name: "AcResult", declaration: "export type AcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };" },
          { name: "AcSelectRequest", declaration: "export interface AcSelectRequest { readonly connectionId: string; }" },
          { name: "AcSelectResult", declaration: "export type AcSelectResult = AcResult<{ activeConnectionId: string | null }>;" },
          { name: "AcWriteRequest", declaration: "export interface AcWriteRequest { readonly connectionId: string; readonly data: string; readonly source?: 'panel'|'agent'; readonly sensitive?: boolean; }" },
          { name: "AcWriteResult", declaration: "export type AcWriteResult = AcResult<{ written: number }>;" },
          { name: "AcReadRequest", declaration: "export interface AcReadRequest { readonly connectionId: string; readonly timeoutMs?: number; readonly after?: number; }" },
          { name: "AcReadResult", declaration: "export type AcReadResult = AcResult<{ data: string; startOffset: number; offset: number; exit: AcExit | null }>;" },
          { name: "AcExit", declaration: "export interface AcExit { readonly code: number | null; readonly signal: string | null; }" },
          { name: "AcTerminalStreamRequest", declaration: "export interface AcTerminalStreamRequest { readonly connectionId: string; readonly after?: number; }" },
          { name: "AcResizeRequest", declaration: "export interface AcResizeRequest { readonly connectionId: string; readonly cols: number; readonly rows: number; }" },
          { name: "AcResizeResult", declaration: "export type AcResizeResult = AcResult<{ cols: number; rows: number }>;" },
          { name: "AcCloseRequest", declaration: "export interface AcCloseRequest { readonly connectionId: string; }" },
          { name: "AcCloseResult", declaration: "export type AcCloseResult = AcResult<{ closed: boolean }>;" },
          { name: "AcSerialPortsRequest", declaration: "export interface AcSerialPortsRequest {}" },
          { name: "AcSerialPortInfo", declaration: "export interface AcSerialPortInfo { readonly path: string; readonly manufacturer: string | null; readonly serialNumber: string | null; readonly vendorId: string | null; readonly productId: string | null; }" },
          { name: "AcSerialPortsResult", declaration: "export type AcSerialPortsResult = AcResult<{ ports: AcSerialPortInfo[] }>;" },
          { name: "AcSftpEntry", declaration: "export interface AcSftpEntry { readonly name: string; readonly isDirectory: boolean; readonly size: number; readonly mtime: number; readonly mode: number; }" },
          { name: "AcSftpListRequest", declaration: "export interface AcSftpListRequest { readonly connectionId: string; readonly path?: string; }" },
          { name: "AcSftpListResult", declaration: "export type AcSftpListResult = AcResult<{ path: string; entries: AcSftpEntry[] }>;" },
          { name: "AcSftpReadFileRequest", declaration: "export interface AcSftpReadFileRequest { readonly connectionId: string; readonly path: string; readonly maxBytes?: number; }" },
          { name: "AcSftpReadFileResult", declaration: "export type AcSftpReadFileResult = AcResult<{ path: string; data: string; bytes: number; truncated: boolean }>;" },
          { name: "AcSftpWriteFileRequest", declaration: "export interface AcSftpWriteFileRequest { readonly connectionId: string; readonly path: string; readonly data: string; }" },
          { name: "AcSftpWriteFileResult", declaration: "export type AcSftpWriteFileResult = AcResult<{ path: string; bytes: number }>;" },
          { name: "AcSftpMkdirRequest", declaration: "export interface AcSftpMkdirRequest { readonly connectionId: string; readonly path: string; }" },
          { name: "AcSftpMkdirResult", declaration: "export type AcSftpMkdirResult = AcResult<{ path: string }>;" },
          { name: "AcSftpDeleteRequest", declaration: "export interface AcSftpDeleteRequest { readonly connectionId: string; readonly path: string; }" },
          { name: "AcSftpDeleteResult", declaration: "export type AcSftpDeleteResult = AcResult<{ path: string; isDirectory: boolean }>;" },
          { name: "AcSftpRenameRequest", declaration: "export interface AcSftpRenameRequest { readonly connectionId: string; readonly from: string; readonly to: string; }" },
          { name: "AcSftpRenameResult", declaration: "export type AcSftpRenameResult = AcResult<{ from: string; to: string }>;" },
          { name: "AcLogInfo", declaration: "export interface AcLogInfo { readonly file: string; readonly connectionId: string | null; readonly protocol: string | null; readonly host: string | null; readonly port: number | null; readonly username: string | null; readonly hostname: string | null; readonly ip: string | null; readonly name: string | null; readonly startedAt: string | null; readonly endedAt: string | null; readonly bytes: number; readonly exitCode: number | null; readonly truncated: boolean; readonly agent: boolean; }" },
          { name: "AcLogListRequest", declaration: "export interface AcLogListRequest {}" },
          { name: "AcLogListResult", declaration: "export type AcLogListResult = AcResult<{ dir: string; logs: AcLogInfo[] }>;" },
          { name: "AcLogReadRequest", declaration: "export interface AcLogReadRequest { readonly file: string; readonly offset?: number; readonly maxBytes?: number; }" },
          { name: "AcLogReadResult", declaration: "export type AcLogReadResult = AcResult<{ file: string; data: string; startOffset: number; nextOffset: number; eof: boolean; size: number }>;" },
          { name: "AcLogDeleteRequest", declaration: "export interface AcLogDeleteRequest { readonly file: string; }" },
          { name: "AcLogDeleteResult", declaration: "export type AcLogDeleteResult = AcResult<{ deleted: boolean }>;" }
        ]
      }
    ]
  }
};
var typert_default = TYPERT;
export {
  TYPERT,
  typert_default as default
};
