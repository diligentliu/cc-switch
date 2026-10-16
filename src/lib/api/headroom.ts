import { invoke } from "@tauri-apps/api/core";

export interface HeadroomStatus {
  running: boolean;
  port: number;
  version: string | null;
  pid: number | null;
}

export interface HeadroomField {
  key: string;
  env: string;
  label: string;
  group: string;
  type:
    | "bool"
    | "int"
    | "float"
    | "str"
    | "enum"
    | "optional-bool"
    | "csv-list"
    | "header-map";
  choices: string[];
  default: unknown;
  help: string;
  secret: boolean;
  manifest_managed: boolean;
  minimum: number | null;
  maximum: number | null;
  value: unknown;
  stored: unknown;
}

export interface HeadroomSchema {
  fields: HeadroomField[];
  groups: string[];
  values: Record<string, unknown>;
  needs_restart_keys: string[];
  supervised: boolean;
}

export const headroomApi = {
  async status(): Promise<HeadroomStatus> {
    return invoke("headroom_status");
  },

  async isInstalled(): Promise<boolean> {
    return invoke("headroom_is_installed");
  },

  async install(): Promise<string> {
    return invoke("headroom_install");
  },

  async update(): Promise<string> {
    return invoke("headroom_update");
  },

  async uninstall(port: number): Promise<string> {
    return invoke("headroom_uninstall", { port });
  },

  async start(port: number): Promise<number> {
    return invoke("headroom_start", { port });
  },

  async stop(port: number): Promise<void> {
    return invoke("headroom_stop", { port });
  },

  async restart(port: number): Promise<number> {
    return invoke("headroom_restart", { port });
  },

  async schema(port: number): Promise<HeadroomSchema> {
    return invoke("headroom_settings_schema", { port });
  },

  async saveSettings(
    port: number,
    values: Record<string, unknown>,
  ): Promise<{ needsRestart: boolean; changedKeys: string[] }> {
    return invoke("headroom_save_settings", { port, values });
  },
};
