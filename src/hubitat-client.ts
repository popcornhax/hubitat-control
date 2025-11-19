export type HubitatConfig = {
  /** Hubitat hub IP or hostname, e.g. 192.168.1.64 */
  hubIp: string;
  /** Maker API app ID, e.g. 110 */
  appId: string;
  /** Maker API access token */
  accessToken: string;
};

export type HubitatDeviceAttribute = {
  name: string;
  value: unknown;
};

export type HubitatDeviceCommand = {
  command: string;
};

export type HubitatDevice = {
  id: string;
  label: string;
  name: string;
  attributes?: HubitatDeviceAttribute[];
  capabilities?: string[];
  commands?: HubitatDeviceCommand[] | string[];
};

/**
 * Lightweight client for Hubitat Maker API, used by the Stream Deck plugin.
 */
export class HubitatClient {
  private readonly baseUrl: string;
  private readonly accessToken: string;

  constructor(config: HubitatConfig) {
    this.baseUrl = this.buildBaseUrl(config.hubIp, config.appId);
    this.accessToken = config.accessToken;
  }

  private buildBaseUrl(hubIp: string, appId: string): string {
    // Allow the user to enter either "192.168.1.64" or "http://192.168.1.64".
    const hasProtocol = /^https?:\/\//i.test(hubIp);
    const withProtocol = hasProtocol ? hubIp : `http://${hubIp}`;
    const trimmedIp = withProtocol.replace(/\/$/, "");
    return `${trimmedIp}/apps/api/${appId}`;
  }

  private buildUrl(path: string): string {
    const sep = path.startsWith("/") ? "" : "/";
    return `${this.baseUrl}${sep}${path}?access_token=${this.accessToken}`;
  }

  /**
   * List all devices exposed via Maker API.
   */
  async listDevices(): Promise<HubitatDevice[]> {
    const url = this.buildUrl("devices");
    const res = await fetch(url);

    if (!res.ok) {
      throw new Error(`Hubitat listDevices failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as HubitatDevice[];

    // Sort devices by label, then name, then id
    data.sort((a, b) => {
      const aKey = (a.label || a.name || a.id).toString();
      const bKey = (b.label || b.name || b.id).toString();
      return aKey.localeCompare(bKey);
    });

    return data;
  }

  /**
   * Get a single device with attributes, capabilities, and commands.
   */
  async getDevice(deviceId: string): Promise<HubitatDevice> {
    const url = this.buildUrl(`devices/${encodeURIComponent(deviceId)}`);
    const res = await fetch(url);

    if (!res.ok) {
      throw new Error(`Hubitat getDevice failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as HubitatDevice;
    return data;
  }

  /**
   * Send a command to a device.
   * Example: sendCommand("123", "on") or sendCommand("123", "setLevel", [50])
   */
  async sendCommand(
    deviceId: string,
    command: string,
    args: (string | number)[] = [],
  ): Promise<void> {
    // Maker API format: /devices/{id}/{command}/{arg1}/{arg2}
    const encodedArgs = args.map((a) => encodeURIComponent(String(a))).join("/");
    const commandPath = encodedArgs
      ? `devices/${encodeURIComponent(deviceId)}/${encodeURIComponent(command)}/${encodedArgs}`
      : `devices/${encodeURIComponent(deviceId)}/${encodeURIComponent(command)}`;

    const url = this.buildUrl(commandPath);
    const res = await fetch(url, { method: "GET" });

    if (!res.ok) {
      throw new Error(
        `Hubitat sendCommand failed (${deviceId} ${command}): ${res.status} ${res.statusText}`,
      );
    }
  }

  /**
   * Get a list of commands for a device to expose in the Stream Deck UI.
   *
   * We:
   * - Start with every command the device reports via Maker API.
   *   Maker API can represent commands either as strings ("on") or as
   *   objects ({ command: "on" }), so we handle both.
   */
  async getSimpleCommands(deviceId: string): Promise<string[]> {
    const device = await this.getDevice(deviceId);
    const caps = new Set(device.capabilities ?? []);

    const names = new Set<string>();

    for (const cmd of device.commands ?? []) {
      let name = "";

      if (typeof cmd === "string") {
        name = cmd.trim();
      } else if (cmd && typeof (cmd as any).command === "string") {
        name = (cmd as any).command.trim();
      }

      if (!name) continue;
      names.add(name);
    }

    // For switch-like devices, make sure a synthetic "toggle" exists even if the
    // driver doesn't explicitly list it.
    if (
      caps.has("Switch") ||
      caps.has("Outlet") ||
      caps.has("Light") ||
      caps.has("Bulb")
    ) {
      names.add("toggle");
    }

    // Fallback: if the driver reports no commands at all, offer a synthetic toggle
    // so the UI has at least one option.
    if (names.size === 0) {
      names.add("toggle");
    }

    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }

  /**
   * Get the value of a specific attribute (via /devices/{id}/attribute/{name}).
   */
  private async getAttributeValue(
    deviceId: string,
    attributeName: string,
  ): Promise<string | undefined> {
    const url = this.buildUrl(
      `devices/${encodeURIComponent(deviceId)}/attribute/${encodeURIComponent(attributeName)}`,
    );
    const res = await fetch(url);

    if (!res.ok) {
      throw new Error(
        `Hubitat getAttributeValue failed (${deviceId} ${attributeName}): ${res.status} ${res.statusText}`,
      );
    }

    const data = (await res.json()) as
      | { id: string; attribute: string; value?: string; currentValue?: string }
      | undefined;

    if (!data) return undefined;

    // Maker API sometimes uses value, sometimes currentValue.
    const v = (data.value ?? data.currentValue ?? "").toString();
    return v || undefined;
  }

  /**
   * Convenience helper to get the switch state for a device.
   * Returns "on", "off", or undefined if the state can't be determined.
   */
  async getSwitchState(deviceId: string): Promise<string | undefined> {
    try {
      const value = await this.getAttributeValue(deviceId, "switch");
      if (!value) return undefined;

      const lowered = value.toLowerCase();
      if (lowered === "on" || lowered === "off") {
        return lowered;
      }

      return undefined;
    } catch (err) {
      // Log upstream; callers can decide how to handle a missing/failed state.
      console.error("Hubitat getSwitchState error", err);
      return undefined;
    }
  }
}