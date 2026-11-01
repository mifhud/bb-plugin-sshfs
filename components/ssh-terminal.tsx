// Remote SSH terminal tab: opens a PTY shell on a mount, renders it in an
// xterm.js terminal, streams output via BB realtime, and sends input/resize
// through RPC. The server side performs `cd <path>` immediately after opening
// the shell, so the terminal starts in the directory the user right-clicked.
import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../server";
import { SSHF_TERMINAL_DATA } from "../contract";
import { errorMessage, parseMountPath } from "./utils";
import "@xterm/xterm/css/xterm.css";

/**
 * xterm.js terminal wrapper. The `params` prop carries `{ mount, path }`
 * (JSON from the host); `parseMountPath` validates it at runtime. The
 * server-side handler resolves `root + path` to an absolute path and `cd`s the
 * new PTY to it. All output streams back via the `sshfs-terminal` realtime
 * channel.
 */
export function SshTerminal({ params }: { params: unknown }) {
  const target = parseMountPath(params);
  const mount = target?.mount ?? "";
  const path = target?.path ?? "";

  const rpc = useRpc<typeof rpcContract>();
  const [openError, setOpenError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const fitScheduledRef = useRef(false);
  const cleanupRef = useRef<(() => void) | null>(null);
  const disposedRef = useRef(false);

  // Receive terminal output from the server. Narrowed field-by-field instead
  // of casting the whole payload to avoid trusting an unchecked shape.
  useRealtime(SSHF_TERMINAL_DATA, (payload: unknown) => {
    const term = termRef.current;
    if (term === null) return;
    if (typeof payload !== "object" || payload === null) return;
    if (!("sessionId" in payload)) return;
    if (payload.sessionId !== sessionIdRef.current) return;
    if ("closed" in payload && payload.closed === true) {
      term.writeln("\r\n\x1b[31m[Connection closed]\x1b[0m\r\n");
      sessionIdRef.current = null;
    } else if ("data" in payload && typeof payload.data === "string" && payload.data !== "") {
      term.write(payload.data);
    }
  });

  // Schedule a xterm.js `fit()` on the next frame (avoids layout thrash when
  // the terminal container is still measuring).
  const scheduleFit = useCallback(() => {
    if (fitScheduledRef.current) return;
    fitScheduledRef.current = true;
    requestAnimationFrame(() => {
      fitScheduledRef.current = false;
      const fitAddon = fitAddonRef.current;
      const term = termRef.current;
      if (fitAddon !== null && term !== null) {
        fitAddon.fit();
        if (sessionIdRef.current !== null) {
          void rpc
            .call("terminal_resize", {
              sessionId: sessionIdRef.current,
              cols: term.cols,
              rows: term.rows,
            })
            .catch(() => undefined);
        }
      }
    });
  }, [rpc]);

  useEffect(() => {
    if (target === null) {
      setOpenError("Invalid terminal parameters");
      return;
    }

    const container = containerRef.current;
    if (container === null) return;
    if (typeof window === "undefined") return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily:
        "ui-monospace, 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace",
      theme: {
        background: "#000000",
        foreground: "#e5e5e5",
        cursor: "#888888",
        black: "#000000",
        red: "#d73631",
        green: "#2eff84",
        yellow: "#febd44",
        blue: "#2472cc",
        magenta: "#d670d1",
        cyan: "#29b8db",
        white: "#e5e5e5",
        brightBlack: "#666666",
        brightRed: "#ff6b68",
        brightGreen: "#40ff80",
        brightYellow: "#ffc755",
        brightBlue: "#4a9eff",
        brightMagenta: "#ff86e6",
        brightCyan: "#4dd0e1",
        brightWhite: "#ffffff",
      },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    term.writeln("Connecting…\r\n");
    termRef.current = term;
    fitAddonRef.current = fitAddon;

    let disposed = false;

    const init = async () => {
      if (disposed) return;
      try {
        fitAddon.fit();
        const result = await rpc.call("terminal_open", {
          mount,
          path: path === "" ? "." : path,
          cols: term.cols,
          rows: term.rows,
        });
        sessionIdRef.current = result.sessionId;

        // xterm.js `onData` gives us every printable change (including pasted
        // text); forward it to the SSH channel.
        const dataDisposable = term.onData((data) => {
          if (sessionIdRef.current === null) return;
          void rpc.call("terminal_write", { sessionId: sessionIdRef.current, data });
        });

        // Initial fit after the shell handshake.
        scheduleFit();
        window.addEventListener("resize", scheduleFit);

        return () => {
          dataDisposable.dispose();
          window.removeEventListener("resize", scheduleFit);
          if (sessionIdRef.current !== null) {
            void rpc.call("terminal_close", { sessionId: sessionIdRef.current });
          }
          term.dispose();
          sessionIdRef.current = null;
        };
      } catch (cause) {
        const msg = errorMessage(cause);
        term.writeln(`\r\n\x1b[31m[${msg}]\x1b[0m\r\n`);
        toast.error(msg);
        return () => {
          term.dispose();
        };
      }
    };

    void init().then((cleanup) => {
      if (typeof cleanup === "function") {
        cleanupRef.current = cleanup;
      }
    });

    return () => {
      disposed = true;
      // Give `init()` a chance to finish if it hasn't yet, then run cleanup.
      new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => {
        const cleanup = cleanupRef.current;
        if (typeof cleanup === "function") cleanup();
        else {
          if (sessionIdRef.current !== null) {
            void rpc.call("terminal_close", { sessionId: sessionIdRef.current });
          }
          term.dispose();
        }
      });
    };
  }, [target, mount, path, rpc, scheduleFit]);

  if (openError !== null) {
    return (
      <div className="flex h-full w-full items-center justify-center text-sm text-destructive">
        {openError}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="h-full w-full" data-sshfs-terminal="container" />
  );
}
