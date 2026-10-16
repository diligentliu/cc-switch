import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "@/lib/toast";
import { headroomApi } from "@/lib/api/headroom";
import { proxyApi } from "@/lib/api/proxy";
import { useProxyFrontPort, useSetProxyFrontPort } from "@/lib/query/proxy";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  SettingsBlock,
  SettingsCard,
  SettingsRow,
} from "@/components/settings/SettingsLayout";
import { HeadroomSettingsForm } from "@/components/settings/HeadroomSettingsForm";
import { cn } from "@/lib/utils";

const DEFAULT_PORT = 8787;
/// Headroom sits in front of CC Switch, so clients must already be routed
/// through CC Switch for the extra hop to exist at all.
const ROUTE_MODE_APPS = ["claude", "codex"] as const;

export function HeadroomSection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const { data: savedFrontPort } = useProxyFrontPort();
  const saveFrontPortMutation = useSetProxyFrontPort();

  const [port, setPort] = useState(String(DEFAULT_PORT));
  const [portError, setPortError] = useState<string | null>(null);

  const status = useQuery({
    queryKey: ["headroom", "status"],
    queryFn: () => headroomApi.status(),
    refetchInterval: 5_000,
  });

  const modeQueries = useQueries({
    queries: ROUTE_MODE_APPS.map((app) => ({
      queryKey: ["providers", app, "mode"],
      queryFn: () => proxyApi.getAppMode(app),
      refetchInterval: 5_000,
    })),
  });

  const unrouted = ROUTE_MODE_APPS.filter(
    (_, index) => modeQueries[index]?.data?.mode === "direct",
  );

  const installed = useQuery({
    queryKey: ["headroom", "installed"],
    queryFn: () => headroomApi.isInstalled(),
  });

  useEffect(() => {
    if (savedFrontPort !== undefined) {
      setPort(savedFrontPort === null ? "" : String(savedFrontPort));
    }
  }, [savedFrontPort]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["headroom"] });
  };

  const installMutation = useMutation({
    mutationFn: () => headroomApi.install(),
    onSuccess: () => {
      toast.success(t("headroom.toast.installed"));
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const updateMutation = useMutation({
    mutationFn: () => headroomApi.update(),
    onSuccess: () => {
      toast.success(t("headroom.toast.updated"));
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const uninstallMutation = useMutation({
    mutationFn: (targetPort: number) => headroomApi.uninstall(targetPort),
    onSuccess: () => {
      toast.success(t("headroom.toast.uninstalled"));
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const running = status.data?.running ?? false;
  const portNumber = Number(port.trim());

  const enableMutation = useMutation({
    mutationFn: async (nextPort: number) => {
      if (!installed.data) {
        await headroomApi.install();
      }
      // Start first: clients may only be pointed at a port that is answering.
      await headroomApi.start(nextPort);
      try {
        await saveFrontPortMutation.mutateAsync(nextPort);
      } catch (error) {
        await headroomApi.stop(nextPort);
        throw error;
      }
    },
    onSuccess: () => {
      toast.success(t("headroom.toast.started"));
      refresh();
    },
    onError: (error: Error) => {
      toast.error(error.message);
      refresh();
    },
  });

  const disableMutation = useMutation({
    mutationFn: async (targetPort: number) => {
      // Point clients back at CC Switch first, so nothing is left aimed at a port
      // that is about to stop answering.
      await saveFrontPortMutation.mutateAsync(null);
      await headroomApi.stop(targetPort);
    },
    onSuccess: () => {
      toast.success(t("headroom.toast.stopped"));
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const toggle = (enabled: boolean) => {
    if (enabled) {
      if (unrouted.length > 0) {
        toast.error(t("headroom.routeModeRequired"));
        return;
      }
      const parsed = Number(port.trim());
      const ok = Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535;
      setPortError(ok ? null : t("headroom.portInvalid"));
      if (!ok) return;
      enableMutation.mutate(parsed);
    } else {
      disableMutation.mutate(portNumber);
    }
  };

  const busy =
    enableMutation.isPending ||
    disableMutation.isPending ||
    installMutation.isPending ||
    updateMutation.isPending;

  return (
    <SettingsBlock
      title={t("headroom.title")}
      help={{ title: t("headroom.title"), body: t("headroom.help") }}
    >
      {unrouted.length > 0 && (
        <div className="mb-3 rounded-md border border-border bg-muted/40 px-4 py-3 text-caption text-fg-2">
          {t("headroom.routeModeNotice", {
            apps: unrouted
              .map((app) => t(`headroom.app.${app}`))
              .join(t("headroom.appSeparator")),
          })}
        </div>
      )}
      <SettingsCard>
        <SettingsRow
          label={t("headroom.enable")}
          description={
            enableMutation.isPending
              ? t("headroom.enabling")
              : disableMutation.isPending
                ? t("headroom.disabling")
                : t("headroom.enableHint")
          }
          control={
            <div className="flex items-center gap-2">
              {(enableMutation.isPending || disableMutation.isPending) && (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-fg-3" />
              )}
              <Switch
                checked={running}
                disabled={busy || installed.isLoading || unrouted.length > 0}
                onCheckedChange={toggle}
                aria-label={t("headroom.enable")}
              />
            </div>
          }
        />

        <SettingsRow
          label={t("headroom.port")}
          help={{ title: t("headroom.port"), body: t("headroom.portHelp") }}
          control={
            <label className="space-y-1">
              <Input
                value={port}
                placeholder={String(DEFAULT_PORT)}
                onChange={(event) => setPort(event.target.value)}
                aria-label={t("headroom.port")}
                aria-invalid={portError ? true : undefined}
                disabled={running}
                className="w-[262px]"
              />
              <span
                className={cn(
                  "block text-caption",
                  portError ? "text-danger-text" : "text-fg-3",
                )}
              >
                {portError ?? t("headroom.portHint")}
              </span>
            </label>
          }
        />

        <SettingsRow
          label={t("headroom.component")}
          help={{
            title: t("headroom.component"),
            body: t("headroom.componentHelp"),
          }}
          description={
            installed.data
              ? t("headroom.version", { version: status.data?.version ?? "?" })
              : t("headroom.notInstalled")
          }
          control={
            <div className="flex items-center gap-2">
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {installed.data ? (
                <>
                  <Button
                    variant="neutral"
                    size="regular"
                    disabled={busy}
                    onClick={() => updateMutation.mutate()}
                  >
                    {t("headroom.update")}
                  </Button>
                  <Button
                    variant="neutral"
                    size="regular"
                    disabled={busy || running}
                    onClick={() => uninstallMutation.mutate(portNumber)}
                  >
                    {t("headroom.uninstall")}
                  </Button>
                </>
              ) : (
                <Button
                  variant="neutral"
                  size="regular"
                  disabled={busy}
                  onClick={() => installMutation.mutate()}
                >
                  {t("headroom.install")}
                </Button>
              )}
            </div>
          }
        />
      </SettingsCard>

      {running && <HeadroomSettingsForm port={portNumber} />}
    </SettingsBlock>
  );
}
