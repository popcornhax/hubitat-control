// src/actions/hubitat-control.ts

import streamDeck, {
  action,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  SendToPluginEvent,
  SingletonAction,
  WillAppearEvent,
} from "@elgato/streamdeck";

import { HubitatClient, HubitatConfig } from "../hubitat-client";


type HubitatGlobalSettings = {
  hubIp: string | null;
  appId: string | null;
  accessToken: string | null;
};

export type HubitatControlSettings = {
  // Hubitat Maker API connection
  hubIp?: string;
  appId?: string;
  accessToken?: string;

  // Device binding
  deviceId?: string;
  deviceLabel?: string;

  // Selected command to invoke on key press (e.g. "toggle", "on", "off", "refresh")
  command?: string;

  // Optional single argument for commands that need a value (setLevel, setColorTemperature, etc.)
  commandArg?: string;

  // Last known state of the switch ("on" | "off")
  lastKnownState?: string;

  // Status Matching
  statusAttribute?: string;       // default "switch"
  statusMatchValue?: string;      // default "on"
  statusMatchedImage?: string;    // base64 or resource path
  statusUnmatchedImage?: string;  // base64 or resource path
};

@action({ UUID: "com.popcornhax.hubitat-control.control" })
export class HubitatControl extends SingletonAction<HubitatControlSettings> {
  constructor() {
    super();


    const intervalMs = 5000; // poll every 5s for now
    setInterval(() => {
      void this.refreshAllVisibleActions();
    }, intervalMs);
  }

  // Tracks last connection/device key per context to avoid re-syncing on every keystroke.
  private lastConnectionKeyByContext = new Map<string, string>();


  /**
   * When the key appears on the canvas, hydrate connection from global settings
   * if needed, then refresh the title/state.
   */
  override async onWillAppear(
    ev: WillAppearEvent<HubitatControlSettings>,
  ): Promise<void> {
    const settings = ev.payload.settings ?? {};

    // Load any previously-saved global Hubitat connection settings.
    const global = await streamDeck.settings.getGlobalSettings<HubitatGlobalSettings>();

    const merged: HubitatControlSettings = {
      ...settings,
      hubIp: settings.hubIp ?? (global?.hubIp ?? undefined),
      appId: settings.appId ?? (global?.appId ?? undefined),
      accessToken: settings.accessToken ?? (global?.accessToken ?? undefined),
    };

    const connectionChanged =
      merged.hubIp !== settings.hubIp ||
      merged.appId !== settings.appId ||
      merged.accessToken !== settings.accessToken;

    // If we filled in any missing connection values from global settings,
    // persist the merged settings. onDidReceiveSettings will then call
    // updateFromDevice for us.
    if (connectionChanged) {
      await ev.action.setSettings(merged);
      return;
    }

    // Otherwise, nothing to hydrate -> just behave as before.
    await this.updateFromDevice(ev);
  }

  /**
   * When settings change (e.g. from the property inspector),
   * update global connection settings (if provided) and re-sync from Hubitat.
   */
  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<HubitatControlSettings>,
  ): Promise<void> {
    const settings = ev.payload.settings ?? {};

    // If the user has provided any connection fields on this key,
    // push them into global settings so future keys can reuse them.
    if (settings.hubIp || settings.appId || settings.accessToken) {
      const global: HubitatGlobalSettings = {
        hubIp: settings.hubIp ?? null,
        appId: settings.appId ?? null,
        accessToken: settings.accessToken ?? null,
      };

      await streamDeck.settings.setGlobalSettings(global);
    }

    // Build a "connection key" that represents the Hubitat endpoint + device.
    const connectionKey = [
      settings.hubIp ?? "",
      settings.appId ?? "",
      settings.accessToken ?? "",
      settings.deviceId ?? "",
    ].join("|");

    // `context` exists at runtime but isn't declared on the TS type for this event.
    const context = (ev as any).context as string | undefined;

    // If for some reason we can't get a context, fall back to the old behavior.
    if (!context) {
      await this.updateFromDevice(ev);
      return;
    }

    const previousKey = this.lastConnectionKeyByContext.get(context);

    // Update cache for this context.
    this.lastConnectionKeyByContext.set(context, connectionKey);

    // Only re-sync from Hubitat when the connection/device actually changes.
    const connectionChanged =
      connectionKey.length > 0 && connectionKey !== previousKey;

    if (connectionChanged) {
      await this.updateFromDevice(ev);
    }
    // If only things like commandArg, statusMatchValue, etc. changed,
    // we skip updateFromDevice to avoid PI re-renders while typing.
  }

  /**
   * Handle key press: send the selected command to the configured device,
   * then refresh state/title/icon.
   */
  override async onKeyDown(
    ev: KeyDownEvent<HubitatControlSettings>,
  ): Promise<void> {
    const settings = ev.payload.settings ?? {};
    const client = this.createClient(settings);

    if (!client || !settings.deviceId) {
      console.warn("[HubitatControl] onKeyDown: missing client or deviceId");
      await ev.action.setTitle("No device");
      return;
    }

    const deviceId = settings.deviceId;
    const command = (settings.command || "toggle").trim();

    // Parse optional command args (comma-separated in the PI).
    let args: (string | number)[] = [];
    if (settings.commandArg && settings.commandArg.trim().length > 0) {
      args = settings.commandArg
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }

    try {
      // Fire the command
      await client.sendCommand(deviceId, command, args);

      // After sending, refresh the switch state (if available)
      const state = await client.getSwitchState(deviceId);

      const effectiveSettings: HubitatControlSettings = {
        ...settings,
        lastKnownState: state,
      };

      // Update status icon (if configured) and title
      await this.updateKeyImage(ev.action, effectiveSettings, state);
      await ev.action.setTitle(this.buildTitle(effectiveSettings));
    } catch (err) {
      console.error("[HubitatControl] onKeyDown error", err);
      await ev.action.setTitle("Err");
    }
  }

  /** 
   * Handle data source requests from the property inspector (sdpi-components).
   */
  override async onSendToPlugin(
    ev: SendToPluginEvent<{ event?: string; isRefresh?: boolean; settings?: HubitatControlSettings }, HubitatControlSettings>,
  ): Promise<void> {
    const { event: eventName, settings: piSettings } = ev.payload;

    if (!eventName) {
      return;
    }

    // Helper to respond to the PI.
    const reply = async (items: Array<{ label?: string; value: string }>): Promise<void> => {
      await streamDeck.ui.current?.sendToPropertyInspector({
        event: eventName!,
        items,
      });
    };

    try {
      // Helper that will attempt to obtain settings that include a
      // `deviceId`. The property inspector may send a data-source request
      // before the new setting has been persisted to the action instance,
      // so retry briefly (up to 1s) to reduce the race.
      const getSettingsWithDeviceId = async (): Promise<HubitatControlSettings> => {
        let settings = piSettings ?? (await ev.action.getSettings<HubitatControlSettings>()) ?? {};
        const start = Date.now();
        while (!settings.deviceId && Date.now() - start < 1000) {
          // small delay and re-read persisted settings
          await new Promise((r) => setTimeout(r, 50));
          settings = piSettings ?? (await ev.action.getSettings<HubitatControlSettings>()) ?? {};
        }
        return settings;
      };
      // Data source for the device dropdown
      if (eventName === "hubitatDevices") {
        const settings = piSettings ?? (await ev.action.getSettings<HubitatControlSettings>()) ?? {};
        const client = this.createClient(settings);
        if (!client) {
          await reply([]);
          return;
        }

        const devices = await client.listDevices();

        const items = devices.map((d) => ({
          label: d.label || d.name || d.id,
          value: d.id,
        }));

        await reply(items);
        return;
      }

      // Data source for the command dropdown
      if (eventName === "hubitatCommands") {
        const settings = await getSettingsWithDeviceId();
        const client = this.createClient(settings);
        if (!client || !settings.deviceId) {
          await reply([]);
          return;
        }

        // Advanced mode: expose all commands the device reports (plus synthetic ones from the client).
        const commands = await client.getSimpleCommands(settings.deviceId);

        const items = commands.map((c) => ({
          label: c,
          value: c,
        }));

        await reply(items);
        return;
      }

      // Data source for the status attribute dropdown
      if (eventName === "hubitatStatusAttributes") {
        const settings = await getSettingsWithDeviceId();
        const client = this.createClient(settings);

        if (!client || !settings.deviceId) {
          await reply([]);
          return;
        }

        try {
          const device = await client.getDevice(settings.deviceId);
          const attrs = (device.attributes ?? []) as any[];

          const names = new Set<string>();

          for (const attr of attrs) {
            if (!attr) continue;
            const name = (attr.name ?? "").toString().trim();
            if (!name) continue;

            // If you only want attributes with a currentValue, you could uncomment this:
            // if (!("currentValue" in attr)) continue;

            names.add(name);
          }

          const items = Array.from(names)
            .sort((a, b) => a.localeCompare(b))
            .map((n) => ({ label: n, value: n }));

          await reply(items);
        } catch (err) {
          console.error("[HubitatControl] hubitatStatusAttributes error", err);
          await reply([]);
        }

        return;
      }
    } catch (err) {
      console.error("[HubitatControl] onSendToPlugin error", err);
    }
  }

  /**
   * Periodically refresh all visible HubitatControl actions.
   */
  private async refreshAllVisibleActions(): Promise<void> {
    // this.actions is provided by SingletonAction and contains all visible
    // instances of this action UUID.
    this.actions.forEach((instance) => {
      void this.refreshSingleInstance(instance as any);
    });
  }

  private async refreshSingleInstance(instance: any): Promise<void> {
    try {
      const settings =
        ((await instance.getSettings()) as HubitatControlSettings | undefined) ?? {};

      const client = this.createClient(settings);
      if (!client || !settings.deviceId) {
        return;
      }

      const state = await client.getSwitchState(settings.deviceId);
      const effectiveSettings: HubitatControlSettings = {
        ...settings,
        lastKnownState: state,
      };

      await this.updateKeyImage(instance, effectiveSettings, state);
      await instance.setTitle(this.buildTitle(effectiveSettings));
    } catch (err) {
      console.error("[HubitatControl] refreshSingleInstance error", err);
    }
  }

  private async updateKeyImage(
    actionInstance: { setImage(image: string): Promise<void> } | any,
    settings: HubitatControlSettings,
    attributeValueRaw: string | undefined,
  ): Promise<void> {
    const { statusMatchedImage, statusUnmatchedImage, statusMatchValue } = settings;

    // If no images are configured, do nothing.
    if (!statusMatchedImage && !statusUnmatchedImage) {
      return;
    }

    const attributeValue = (attributeValueRaw ?? "").toLowerCase();
    const expected = (statusMatchValue ?? "on").toLowerCase();

    const img =
      attributeValue && attributeValue === expected
        ? statusMatchedImage
        : statusUnmatchedImage;

    if (!img) {
      return;
    }

    try {
      await actionInstance.setImage(img);
    } catch (err) {
      console.error("[HubitatControl] updateKeyImage error", err);
    }
  }

  // --- helpers ------------------------------------------------------------

  private createClient(
    settings: HubitatControlSettings,
  ): HubitatClient | undefined {
    const { hubIp, appId, accessToken } = settings;

    if (!hubIp || !appId || !accessToken) {
      return undefined;
    }

    const cfg: HubitatConfig = { hubIp, appId, accessToken };
    return new HubitatClient(cfg);
  }

  /**
   * Refresh title and lastKnownState from Hubitat if we have enough config.
   */
  private async updateFromDevice(
    ev:
      | WillAppearEvent<HubitatControlSettings>
      | DidReceiveSettingsEvent<HubitatControlSettings>,
  ): Promise<void> {
    const settings = ev.payload.settings ?? {};
    console.log("[HubitatControl] updateFromDevice settings", settings);
    const client = this.createClient(settings);

    if (!client || !settings.deviceId) {
      await ev.action.setTitle("Hubitat");
      return;
    }

    try {
      const state = await client.getSwitchState(settings.deviceId);

      const effectiveSettings: HubitatControlSettings = {
        ...settings,
        lastKnownState: state,
      };

      await this.updateKeyImage(ev.action, effectiveSettings, state);

      await ev.action.setTitle(this.buildTitle(effectiveSettings));
    } catch (err) {
      console.error("Error refreshing Hubitat device:", err);
      await ev.action.setTitle("Err");
    }
  }

  private buildTitle(settings: HubitatControlSettings): string {
    const label = settings.deviceLabel || "Hubitat";
    //    const stateRaw = settings.lastKnownState;
    //    const state = stateRaw ? stateRaw.toUpperCase() : "";

    //    if (!state) {
    return label;
    //    }

    //    return `${label}\n${state}`;
  }
}