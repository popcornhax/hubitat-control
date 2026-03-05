// src/actions/hubitat-control.ts

import streamDeck, {
  action,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  SendToPluginEvent,
  SingletonAction,
  WillAppearEvent,
  WillDisappearEvent,
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
  private readonly pollIntervalMs = 5000;
  private isRefreshAllInFlight = false;
  private clientCache = new Map<string, HubitatClient>();
  private clientRefCountByKey = new Map<string, number>();
  private clientKeyByContext = new Map<string, string>();
  private visibleActionContexts = new Set<string>();
  private pollTimer: NodeJS.Timeout | undefined;

  // Tracks the last state and title sent to the Stream Deck app per context.
  // Used to suppress redundant setImage/setTitle calls in the polling loop
  private lastSentStateByContext = new Map<string, string | undefined>();
  private lastSentTitleByContext = new Map<string, string>();

  // Caches the most recent settings per context so the polling loop can use
  // them without calling instance.getSettings() on every cycle. Each
  // getSettings() call is a WebSocket round-trip whose response includes full
  // base64 image data; at polling frequency this generates significant traffic
  // to the host application.
  private settingsByContext = new Map<string, HubitatControlSettings>();

  constructor() {
    super();
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
    this.markActionVisible(ev.action.id);

    const settings = ev.payload.settings ?? {};

    // Load any previously-saved global Hubitat connection settings.
    const global = await streamDeck.settings.getGlobalSettings<HubitatGlobalSettings>();

    const merged: HubitatControlSettings = {
      ...settings,
      hubIp: settings.hubIp ?? (global?.hubIp ?? undefined),
      appId: settings.appId ?? (global?.appId ?? undefined),
      accessToken: settings.accessToken ?? (global?.accessToken ?? undefined),
    };
    this.updateContextClientTracking(ev.action.id, merged);
    this.settingsByContext.set(ev.action.id, merged);

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

    const context = ev.action.id;
    this.updateContextClientTracking(context, settings);
    this.settingsByContext.set(context, settings);

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

  override onWillDisappear(ev: WillDisappearEvent<HubitatControlSettings>): void {
    this.markActionHidden(ev.action.id);
    this.releaseContextClientTracking(ev.action.id);
    this.lastConnectionKeyByContext.delete(ev.action.id);
    this.lastSentStateByContext.delete(ev.action.id);
    this.lastSentTitleByContext.delete(ev.action.id);
    this.settingsByContext.delete(ev.action.id);
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
    if (this.isRefreshAllInFlight) {
      return;
    }

    this.isRefreshAllInFlight = true;

    // this.actions is provided by SingletonAction and contains all visible
    // instances of this action UUID.
    try {
      const refreshes: Array<Promise<void>> = [];
      this.actions.forEach((instance) => {
        refreshes.push(this.refreshSingleInstance(instance as any));
      });
      await Promise.allSettled(refreshes);
    } finally {
      this.isRefreshAllInFlight = false;
    }
  }

  private async refreshSingleInstance(instance: any): Promise<void> {
    try {
      const context: string = instance.id;
      let settings = this.settingsByContext.get(context);

      if (!settings) {
        // Cache miss: instance.id didn't match the key stored in onWillAppear/
        // onDidReceiveSettings. Call getSettings() exactly once to recover, then
        // store in the cache so all future polls use the cached copy and don't
        // hit the host again.
        settings = ((await instance.getSettings()) as HubitatControlSettings | undefined) ?? {};
        if (settings.deviceId) {
          this.settingsByContext.set(context, settings);
        }
      }

      const client = this.createClient(settings);
      if (!client || !settings.deviceId) {
        return;
      }

      const state = await client.getSwitchState(settings.deviceId);
      const effectiveSettings: HubitatControlSettings = {
        ...settings,
        lastKnownState: state,
      };

      const title = this.buildTitle(effectiveSettings);
      const willUpdate = !this.lastSentStateByContext.has(context) || state !== this.lastSentStateByContext.get(context);

      // Only send setImage when the device state has changed since the last poll,
      // or on the first poll for this context (has() distinguishes "never sent"
      // from "sent undefined", avoiding a false equality on first run).
      if (willUpdate) {
        await this.updateKeyImage(instance, effectiveSettings, state);
        this.lastSentStateByContext.set(context, state);
      }

      // Similarly, only send setTitle when the title has actually changed.
      if (title !== this.lastSentTitleByContext.get(context)) {
        await instance.setTitle(title);
        this.lastSentTitleByContext.set(context, title);
      }
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
    const cacheKey = this.getClientCacheKey(settings);
    if (!cacheKey) {
      return undefined;
    }

    const cachedClient = this.clientCache.get(cacheKey);
    if (cachedClient) {
      return cachedClient;
    }

    if (!hubIp || !appId || !accessToken) {
      return undefined;
    }
    const cfg: HubitatConfig = { hubIp, appId, accessToken };
    const client = new HubitatClient(cfg);
    this.clientCache.set(cacheKey, client);
    return client;
  }

  private getClientCacheKey(settings: HubitatControlSettings): string | undefined {
    const { hubIp, appId, accessToken } = settings;
    if (!hubIp || !appId || !accessToken) {
      return undefined;
    }
    return `${hubIp}|${appId}|${accessToken}`;
  }

  private markActionVisible(context: string | undefined): void {
    if (!context) {
      return;
    }

    this.visibleActionContexts.add(context);
    this.ensurePolling();
  }

  private markActionHidden(context: string | undefined): void {
    if (!context) {
      return;
    }

    this.visibleActionContexts.delete(context);
    if (this.visibleActionContexts.size === 0) {
      this.stopPolling();
    }
  }

  private ensurePolling(): void {
    if (this.pollTimer) {
      return;
    }

    this.pollTimer = setInterval(() => {
      void this.refreshAllVisibleActions();
    }, this.pollIntervalMs);
  }

  private stopPolling(): void {
    if (!this.pollTimer) {
      return;
    }

    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  private updateContextClientTracking(
    context: string | undefined,
    settings: HubitatControlSettings,
  ): void {
    if (!context) {
      return;
    }

    const nextKey = this.getClientCacheKey(settings);
    const prevKey = this.clientKeyByContext.get(context);

    if (prevKey === nextKey) {
      return;
    }

    if (prevKey) {
      this.decrementClientRef(prevKey);
      this.clientKeyByContext.delete(context);
    }

    if (nextKey) {
      this.clientKeyByContext.set(context, nextKey);
      this.incrementClientRef(nextKey);
    }
  }

  private releaseContextClientTracking(context: string | undefined): void {
    if (!context) {
      return;
    }

    const cacheKey = this.clientKeyByContext.get(context);
    if (!cacheKey) {
      return;
    }

    this.clientKeyByContext.delete(context);
    this.decrementClientRef(cacheKey);
  }

  private incrementClientRef(cacheKey: string): void {
    const count = this.clientRefCountByKey.get(cacheKey) ?? 0;
    this.clientRefCountByKey.set(cacheKey, count + 1);
  }

  private decrementClientRef(cacheKey: string): void {
    const count = this.clientRefCountByKey.get(cacheKey);
    if (count === undefined) {
      return;
    }

    if (count <= 1) {
      this.clientRefCountByKey.delete(cacheKey);
      this.clientCache.delete(cacheKey);
      return;
    }

    this.clientRefCountByKey.set(cacheKey, count - 1);
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
    return label;
  }
}
