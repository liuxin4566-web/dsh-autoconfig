import * as React from "react";

const { useEffect, useRef, useState } = React;

const PROTOCOLS = [
  { id: "ssh", label: "SSH", port: 22, hint: "交互式 shell，最常用" },
  { id: "telnet", label: "Telnet", port: 23, hint: "老设备/带外管理" },
  { id: "console", label: "串口 Console", port: null, hint: "USB/COM 口直连" },
  { id: "sftp", label: "SFTP", port: 22, hint: "文件传输（SSH 子系统）" }
];

function defaultPort(protocol) {
  return PROTOCOLS.find((entry) => entry.id === protocol)?.port ?? null;
}

export function ConnectDialog({ api, initialProtocol = "ssh", initial = null, onClose, onConnected }) {
  const base = initial ?? {};
  const startProtocol = base.protocol ?? initialProtocol;
  const [protocol, setProtocol] = useState(startProtocol);
  const [host, setHost] = useState(base.host ?? "");
  const [port, setPort] = useState(String(base.port ?? defaultPort(startProtocol) ?? ""));
  const [username, setUsername] = useState(base.username ?? "");
  const [password, setPassword] = useState("");
  const [authMode, setAuthMode] = useState("password");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [name, setName] = useState(base.name ?? "");
  const [legacy, setLegacy] = useState(base.legacy === true);
  const [autoLogin, setAutoLogin] = useState(base.autoLogin !== false);
  const [remember, setRemember] = useState(true);
  const [serialPath, setSerialPath] = useState(base.serial?.path ?? "COM1");
  const [baudRate, setBaudRate] = useState(String(base.serial?.baudRate ?? 9600));
  const [dataBits, setDataBits] = useState(String(base.serial?.dataBits ?? 8));
  const [stopBits, setStopBits] = useState(String(base.serial?.stopBits ?? 1));
  const [parity, setParity] = useState(base.serial?.parity ?? "none");
  const [ports, setPorts] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const lastDefaultPort = useRef(String(base.port ?? defaultPort(startProtocol) ?? ""));

  useEffect(() => {
    const next = defaultPort(protocol);
    if (next !== null && (port === "" || port === lastDefaultPort.current)) {
      setPort(String(next));
    }
    lastDefaultPort.current = next === null ? "" : String(next);
  }, [protocol]);

  const loadPorts = async () => {
    try {
      const listed = await api.serialPorts();
      setPorts(listed.ports ?? []);
      if (listed.ports?.length > 0 && !listed.ports.some((entry) => entry.path === serialPath)) {
        setSerialPath(listed.ports[0].path);
      }
    } catch (loadError) {
      setError(loadError.message);
    }
  };

  useEffect(() => {
    if (protocol === "console") void loadPorts();
  }, [protocol]);

  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const request = {
        protocol,
        name: name.trim() || undefined,
        username: username.trim() || undefined,
        password: password || undefined,
        legacy: protocol === "ssh" || protocol === "sftp" ? legacy : undefined,
        autoLogin: protocol === "telnet" || protocol === "console" ? autoLogin : undefined,
        saveProfile: false
      };
      if (protocol === "console") {
        if (!serialPath.trim()) throw new Error("请选择或填写串口，例如 COM3 或 /dev/ttyUSB0");
        request.serial = {
          path: serialPath.trim(),
          baudRate: Number(baudRate) || 9600,
          dataBits: Number(dataBits) || 8,
          stopBits: Number(stopBits) || 1,
          parity
        };
      } else {
        if (!host.trim()) throw new Error("请填写设备 IP 或主机名");
        request.host = host.trim();
        request.port = Number(port) || defaultPort(protocol) || 22;
        if (authMode === "key") {
          if (!privateKey.trim()) throw new Error("请粘贴 SSH 私钥，或切换为密码认证");
          request.privateKey = privateKey;
          request.passphrase = passphrase || undefined;
        }
      }
      const info = await api.connect(request);
      if (remember) {
        try {
          await api.profileSave({
            protocol,
            host: request.host,
            port: request.port,
            username: request.username,
            // A blank field means "keep the saved password" rather than
            // "delete it"; only an explicit untick would remove it.
            password: password || undefined,
            savePassword: password !== "" ? true : undefined,
            name: info.name || name.trim() || undefined,
            serial: request.serial,
            legacy: request.legacy,
            autoLogin: request.autoLogin
          });
        } catch {
          // The connection is already live; failing to remember it is cosmetic.
        }
      }
      onConnected(info);
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setBusy(false);
    }
  };

  const isSerial = protocol === "console";
  const isSsh = protocol === "ssh" || protocol === "sftp";

  return (
    <div className="ac-modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <form className="ac-modal" onSubmit={submit} role="dialog" aria-modal="true" aria-label="连接设备">
        <div className="ac-modal-head">
          <h3>连接设备</h3>
          <button type="button" className="ac-tab-close" onClick={onClose} disabled={busy} aria-label="关闭">×</button>
        </div>
        <div className="ac-modal-body">
          <div className="ac-proto-tabs">
            {PROTOCOLS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className="ac-btn"
                data-active={protocol === entry.id}
                onClick={() => setProtocol(entry.id)}
                disabled={busy}
                title={entry.hint}
              >
                {entry.label}
              </button>
            ))}
          </div>
          <div className="ac-field">
            <span className="ac-hint">
              {protocol === "ssh" && "通过 SSH 打开交互式 shell；设备需已开启 SSH 并配置本地用户。"}
              {protocol === "telnet" && "通过 Telnet 连接；可自动回答 login/password 提示。"}
              {protocol === "console" && "通过串口直连设备 Console 口；默认 9600 8N1。"}
              {protocol === "sftp" && "通过 SSH 认证后只打开 SFTP 子系统，适合上传/下载配置与镜像。"}
            </span>
          </div>

          <div className="ac-form-grid">
            <div className="ac-field" data-span="2">
              <label htmlFor="ac-name">设备名称（hostname，可选）</label>
              <input id="ac-name" className="ac-input" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如 core-sw-1；连接后会尝试用设备提示符中的主机名自动重命名日志" disabled={busy} />
            </div>

            {!isSerial && (
              <>
                <div className="ac-field">
                  <label htmlFor="ac-host">IP / 主机名</label>
                  <input id="ac-host" className="ac-input" value={host} onChange={(event) => setHost(event.target.value)} placeholder="10.1.1.1 或 fw.example.com" autoFocus disabled={busy} />
                </div>
                <div className="ac-field">
                  <label htmlFor="ac-port">端口</label>
                  <input id="ac-port" className="ac-input" type="number" min="1" max="65535" value={port} onChange={(event) => setPort(event.target.value)} disabled={busy} />
                </div>
              </>
            )}

            <div className="ac-field">
              <label htmlFor="ac-user">用户名</label>
              <input id="ac-user" className="ac-input" value={username} onChange={(event) => setUsername(event.target.value)} placeholder={isSerial ? "用于自动登录，可留空" : "admin"} autoComplete="off" disabled={busy} />
            </div>

            {isSsh ? (
              <div className="ac-field">
                <label htmlFor="ac-auth">认证方式</label>
                <select id="ac-auth" className="ac-select" value={authMode} onChange={(event) => setAuthMode(event.target.value)} disabled={busy}>
                  <option value="password">密码</option>
                  <option value="key">私钥</option>
                </select>
              </div>
            ) : (
              <div className="ac-field">
                <label htmlFor="ac-pass">密码</label>
                <input id="ac-pass" className="ac-input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" disabled={busy} />
              </div>
            )}

            {isSsh && authMode === "password" && (
              <div className="ac-field" data-span="2">
                <label htmlFor="ac-pass2">密码</label>
                <input id="ac-pass2" className="ac-input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" disabled={busy} />
              </div>
            )}

            {isSsh && authMode === "key" && (
              <>
                <div className="ac-field" data-span="2">
                  <label htmlFor="ac-key">私钥（PEM / OpenSSH）</label>
                  <textarea id="ac-key" className="ac-textarea" value={privateKey} onChange={(event) => setPrivateKey(event.target.value)} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" disabled={busy} />
                </div>
                <div className="ac-field" data-span="2">
                  <label htmlFor="ac-phrase">私钥口令（可选）</label>
                  <input id="ac-phrase" className="ac-input" type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} disabled={busy} />
                </div>
              </>
            )}

            {isSerial && (
              <>
                <div className="ac-field">
                  <label htmlFor="ac-com">串口</label>
                  <div style={{ display: "flex", gap: 6 }}>
                    <select id="ac-com" className="ac-select" value={serialPath} onChange={(event) => setSerialPath(event.target.value)} disabled={busy}>
                      {ports.length === 0 && <option value={serialPath}>{serialPath}</option>}
                      {ports.map((entry) => (
                        <option key={entry.path} value={entry.path}>{entry.path}{entry.manufacturer ? ` — ${entry.manufacturer}` : ""}</option>
                      ))}
                    </select>
                    <button type="button" className="ac-btn" onClick={() => void loadPorts()} disabled={busy} title="刷新串口列表">刷新</button>
                  </div>
                </div>
                <div className="ac-field">
                  <label htmlFor="ac-baud">波特率</label>
                  <select id="ac-baud" className="ac-select" value={baudRate} onChange={(event) => setBaudRate(event.target.value)} disabled={busy}>
                    {["9600", "19200", "38400", "57600", "115200"].map((rate) => <option key={rate} value={rate}>{rate}</option>)}
                  </select>
                </div>
                <div className="ac-field">
                  <label htmlFor="ac-bits">数据位 / 停止位 / 校验</label>
                  <div style={{ display: "flex", gap: 6 }}>
                    <select id="ac-bits" className="ac-select" value={dataBits} onChange={(event) => setDataBits(event.target.value)} disabled={busy}>
                      {["5", "6", "7", "8"].map((value) => <option key={value} value={value}>{value}</option>)}
                    </select>
                    <select className="ac-select" value={stopBits} onChange={(event) => setStopBits(event.target.value)} disabled={busy}>
                      {["1", "1.5", "2"].map((value) => <option key={value} value={value}>{value}</option>)}
                    </select>
                    <select className="ac-select" value={parity} onChange={(event) => setParity(event.target.value)} disabled={busy}>
                      {["none", "even", "odd", "mark", "space"].map((value) => <option key={value} value={value}>{value}</option>)}
                    </select>
                  </div>
                </div>
              </>
            )}

            {(protocol === "telnet" || protocol === "console") && (
              <div className="ac-field" data-span="2">
                <label className="ac-check">
                  <input type="checkbox" checked={autoLogin} onChange={(event) => setAutoLogin(event.target.checked)} disabled={busy} />
                  自动回答 login / password 提示（凭据不会写入日志）
                </label>
              </div>
            )}

            {isSsh && (
              <div className="ac-field" data-span="2">
                <label className="ac-check">
                  <input type="checkbox" checked={legacy} onChange={(event) => setLegacy(event.target.checked)} disabled={busy} />
                  兼容旧设备（使用 SHA-1 group14 KEX；老款华为 VRP / IOS / Comware 常用）
                </label>
              </div>
            )}

            <div className="ac-field" data-span="2">
              <label className="ac-check">
                <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} disabled={busy} />
                保存到左侧会话栏
                {isSsh && authMode === "key"
                  ? "（私钥不保存）"
                  : password !== ""
                    ? "，并记住密码（双击直连）"
                    : "；填写密码后会记住，下次双击直连"}
              </label>
            </div>
          </div>

          {error && <div className="ac-form-error">{error}</div>}
        </div>
        <div className="ac-modal-foot">
          <button type="button" className="ac-btn" onClick={onClose} disabled={busy}>取消</button>
          <button type="submit" className="ac-btn" data-variant="primary" disabled={busy}>
            {busy ? "连接中…" : "连接"}
          </button>
        </div>
      </form>
    </div>
  );
}
