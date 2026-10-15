/** Startup-only, bounded loopback listener check; never touches an existing process. */
import { createConnection } from "node:net";

export interface LocalApplicationEndpoint {
  readonly host: "localhost" | "127.0.0.1" | "::1";
  readonly port: number;
}
type ProbeState = "free" | "occupied" | "unavailable" | "unsupported";
export type ApplicationPortProbe = (
  host: "127.0.0.1" | "::1",
  port: number,
) => Promise<ProbeState>;

export const parseLocalApplicationEndpoint = (
  value: unknown,
): LocalApplicationEndpoint => {
  let parsed: URL;
  try {
    if (typeof value !== "string") throw new Error();
    parsed = new URL(value);
  } catch {
    throw new Error(
      "Application readiness requires a valid local HTTP or HTTPS endpoint.",
    );
  }
  const host = parsed.hostname === "[::1]" ? "::1" : parsed.hostname;
  const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    !["localhost", "127.0.0.1", "::1"].includes(host) ||
    parsed.username ||
    parsed.password ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error(
      "Application readiness requires a credential-free loopback HTTP or HTTPS endpoint.",
    );
  return Object.freeze({
    host: host as LocalApplicationEndpoint["host"],
    port,
  });
};

const probeLoopbackPort: ApplicationPortProbe = (host, port) =>
  new Promise<ProbeState>((resolve) => {
    const socket = createConnection({
      host,
      port,
      family: host === "::1" ? 6 : 4,
    });
    let settled = false;
    const finish = (state: ProbeState): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(state);
    };
    const timer = setTimeout(() => finish("unavailable"), 750);
    socket.once("connect", () => finish("occupied"));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      finish(
        error.code === "ECONNREFUSED"
          ? "free"
          : [
                "EAFNOSUPPORT",
                "EPROTONOSUPPORT",
                "ENETUNREACH",
                "EHOSTUNREACH",
              ].includes(error.code ?? "") && host === "::1"
            ? "unsupported"
            : "unavailable",
      ),
    );
  });

export const assertApplicationPortAvailable = async ({
  url,
  probe = probeLoopbackPort,
}: {
  readonly url: unknown;
  readonly probe?: ApplicationPortProbe;
}): Promise<void> => {
  const endpoint = parseLocalApplicationEndpoint(url);
  const hosts: readonly ("127.0.0.1" | "::1")[] =
    endpoint.host === "localhost" ? ["127.0.0.1", "::1"] : [endpoint.host];
  let results: readonly ProbeState[];
  try {
    results = await Promise.all(
      hosts.map((host) => probe(host, endpoint.port)),
    );
  } catch {
    throw new Error(
      "Application port availability could not be proved. No application was started; diagnose the local endpoint before retrying.",
    );
  }
  if (results.includes("occupied"))
    throw new Error(
      `Application port ${endpoint.port} is already in use. No application was started or stopped. Stop the existing application yourself, or choose a different reviewed local port and update its start command.`,
    );
  if (
    results.some((state) => !["free", "unsupported"].includes(state)) ||
    !results.includes("free")
  )
    throw new Error(
      "Application port availability could not be proved. No application was started; diagnose the local endpoint before retrying.",
    );
};
