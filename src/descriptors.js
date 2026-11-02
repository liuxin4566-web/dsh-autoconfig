/**
 * Invocation descriptors for the `autoconfig` Remote. One source of truth
 * consumed by both the host TYPERT manifest (typert.js) and the browser
 * contribution (remote.js).
 */
import * as S from "./schemas.js";

const PACKAGE = "dsh-autoconfig";
const NS = "autoconfig";

function def(method, requestSchema, requestType, resultSchema, resultType, options = {}) {
  return {
    id: `${PACKAGE}#${NS}/${method}`,
    service: NS,
    namespace: NS,
    method,
    ...(options.stream ? { mode: "stream", cancellation: { parameter: "signal" } } : {}),
    invocation: { kind: "direct" },
    parameters: [
      {
        name: "request",
        wire: "request",
        source: "json",
        codec: {
          mode: "strict",
          typeSymbol: `${PACKAGE}/types#${requestType}`,
          schema: requestSchema,
          create: () => requestSchema
        }
      }
    ],
    result: {
      mode: "strict",
      typeSymbol: `${PACKAGE}/types#${resultType}`,
      schema: resultSchema,
      create: () => resultSchema
    },
    sourceLocation: { file: "src/index.js", line: 1, column: 1 }
  };
}

export const DESCRIPTORS = [
  def("connect", S.connectRequestSchema, "AcConnectRequest", S.connectResultSchema, "AcConnectResult"),
  def("list", S.listRequestSchema, "AcListRequest", S.listResultSchema, "AcListResult"),
  def("profileSave", S.profileSaveRequestSchema, "AcProfileSaveRequest", S.profileSaveResultSchema, "AcProfileSaveResult"),
  def("profileList", S.profileListRequestSchema, "AcProfileListRequest", S.profileListResultSchema, "AcProfileListResult"),
  def("profileDelete", S.profileDeleteRequestSchema, "AcProfileDeleteRequest", S.profileDeleteResultSchema, "AcProfileDeleteResult"),
  def("profileConnect", S.profileConnectRequestSchema, "AcProfileConnectRequest", S.profileConnectResultSchema, "AcProfileConnectResult"),
  def("select", S.selectRequestSchema, "AcSelectRequest", S.selectResultSchema, "AcSelectResult"),
  def("write", S.writeRequestSchema, "AcWriteRequest", S.writeResultSchema, "AcWriteResult"),
  def("read", S.readRequestSchema, "AcReadRequest", S.readResultSchema, "AcReadResult"),
  def("terminalStream", S.terminalStreamRequestSchema, "AcTerminalStreamRequest", S.readResultSchema, "AcReadResult", { stream: true }),
  def("resize", S.resizeRequestSchema, "AcResizeRequest", S.resizeResultSchema, "AcResizeResult"),
  def("close", S.closeRequestSchema, "AcCloseRequest", S.closeResultSchema, "AcCloseResult"),
  def("serialPorts", S.serialPortsRequestSchema, "AcSerialPortsRequest", S.serialPortsResultSchema, "AcSerialPortsResult"),
  def("sftpList", S.sftpListRequestSchema, "AcSftpListRequest", S.sftpListResultSchema, "AcSftpListResult"),
  def("sftpReadFile", S.sftpReadFileRequestSchema, "AcSftpReadFileRequest", S.sftpReadFileResultSchema, "AcSftpReadFileResult"),
  def("sftpWriteFile", S.sftpWriteFileRequestSchema, "AcSftpWriteFileRequest", S.sftpWriteFileResultSchema, "AcSftpWriteFileResult"),
  def("sftpMkdir", S.sftpMkdirRequestSchema, "AcSftpMkdirRequest", S.sftpMkdirResultSchema, "AcSftpMkdirResult"),
  def("sftpDelete", S.sftpDeleteRequestSchema, "AcSftpDeleteRequest", S.sftpDeleteResultSchema, "AcSftpDeleteResult"),
  def("sftpRename", S.sftpRenameRequestSchema, "AcSftpRenameRequest", S.sftpRenameResultSchema, "AcSftpRenameResult"),
  def("logList", S.logListRequestSchema, "AcLogListRequest", S.logListResultSchema, "AcLogListResult"),
  def("logRead", S.logReadRequestSchema, "AcLogReadRequest", S.logReadResultSchema, "AcLogReadResult"),
  def("logDelete", S.logDeleteRequestSchema, "AcLogDeleteRequest", S.logDeleteResultSchema, "AcLogDeleteResult")
];
