import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Loader2 } from "lucide-react";
import { toast } from "@/lib/toast";
import { headroomApi, type HeadroomField } from "@/lib/api/headroom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  SettingsCard,
  SettingsRow,
} from "@/components/settings/SettingsLayout";
import { cn } from "@/lib/utils";

const UNSET = "__unset__";

export function HeadroomSettingsForm({ port }: { port: number }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [openGroups, setOpenGroups] = useState<string[] | null>(null);

  const schema = useQuery({
    queryKey: ["headroom", "schema", port],
    queryFn: () => headroomApi.schema(port),
    enabled: port > 0,
  });

  const fields = schema.data?.fields ?? [];
  const groups = schema.data?.groups ?? [];

  const values = useMemo(() => {
    const base: Record<string, unknown> = { ...(schema.data?.values ?? {}) };
    return { ...base, ...draft };
  }, [schema.data, draft]);

  const changedKeys = useMemo(
    () =>
      Object.keys(draft).filter(
        (key) => draft[key] !== schema.data?.values?.[key],
      ),
    [draft, schema.data],
  );

  const needsRestart = useMemo(() => {
    const restartKeys = schema.data?.needs_restart_keys ?? [];
    return changedKeys.some((key) => restartKeys.includes(key));
  }, [changedKeys, schema.data]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      await headroomApi.saveSettings(port, draft);
      await headroomApi.restart(port);
    },
    onSuccess: () => {
      setDraft({});
      toast.success(t("headroom.toast.saved"));
      void queryClient.invalidateQueries({ queryKey: ["headroom"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const setValue = (key: string, value: unknown) => {
    setDraft((prev) => {
      const next = { ...prev };
      if (schema.data?.values?.[key] === value) {
        delete next[key];
      } else {
        next[key] = value;
      }
      return next;
    });
  };

  if (schema.isLoading) {
    return (
      <SettingsCard>
        <div className="flex items-center gap-2 px-4 py-6 text-fg-3">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("headroom.loadingSettings")}
        </div>
      </SettingsCard>
    );
  }

  if (schema.isError) {
    return (
      <SettingsCard>
        <div className="px-4 py-6 text-caption text-danger-text">
          {t("headroom.settingsUnavailable")}
          <span className="mt-1 block text-fg-3">
            {schema.error instanceof Error
              ? schema.error.message
              : String(schema.error)}
          </span>
        </div>
      </SettingsCard>
    );
  }

  return (
    <SettingsCard>
      {groups.map((group) => {
        const groupFields = fields.filter((field) => field.group === group);
        if (groupFields.length === 0) return null;
        const open = (openGroups ?? groups.slice(0, 1)).includes(group);
        const dirty = groupFields.filter((field) =>
          changedKeys.includes(field.key),
        ).length;

        return (
          <div key={group} className="border-b border-border last:border-b-0">
            <button
              type="button"
              onClick={() =>
                setOpenGroups((prev) => {
                  const current = prev ?? groups.slice(0, 1);
                  return current.includes(group)
                    ? current.filter((item) => item !== group)
                    : [...current, group];
                })
              }
              className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-muted/40"
              aria-expanded={open}
            >
              <ChevronRight
                className={cn(
                  "h-4 w-4 shrink-0 text-fg-3 transition-transform",
                  open && "rotate-90",
                )}
              />
              <span className="text-body font-medium">{group}</span>
              <span className="text-caption text-fg-3">
                {t("headroom.fieldCount", { count: groupFields.length })}
              </span>
              {dirty > 0 && (
                <span className="ml-auto text-caption text-accent-text">
                  {t("headroom.changedCount", { count: dirty })}
                </span>
              )}
            </button>

            {open && (
              <div className="px-4 pb-3">
                {groupFields.map((field) => (
                  <FieldRow
                    key={field.key}
                    field={field}
                    value={values[field.key]}
                    onChange={(value) => setValue(field.key, value)}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}

      <div className="flex items-center gap-3 px-4 py-3">
        <Button
          variant="neutral"
          size="regular"
          disabled={changedKeys.length === 0 || saveMutation.isPending}
          onClick={() => saveMutation.mutate()}
        >
          {saveMutation.isPending && (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          )}
          {needsRestart ? t("headroom.applyAndRestart") : t("headroom.apply")}
        </Button>
        {changedKeys.length > 0 && (
          <span className="text-caption text-fg-3">
            {t("headroom.changedCount", { count: changedKeys.length })}
          </span>
        )}
      </div>
    </SettingsCard>
  );
}

function FieldRow({
  field,
  value,
  onChange,
}: {
  field: HeadroomField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const help = field.help
    ? { title: field.label, body: field.help }
    : undefined;

  return (
    <SettingsRow
      label={field.label}
      help={help}
      control={controlFor(field, value, onChange)}
    />
  );
}

function controlFor(
  field: HeadroomField,
  value: unknown,
  onChange: (value: unknown) => void,
) {
  const width = "w-[240px]";

  switch (field.type) {
    case "bool":
      return (
        <Switch
          checked={value === true}
          onCheckedChange={onChange}
          aria-label={field.label}
        />
      );

    case "optional-bool":
      return (
        <Select
          value={value === null || value === undefined ? UNSET : String(value)}
          onValueChange={(next) =>
            onChange(next === UNSET ? null : next === "true")
          }
        >
          <SelectTrigger className={width} aria-label={field.label}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={UNSET}>—</SelectItem>
            <SelectItem value="true">true</SelectItem>
            <SelectItem value="false">false</SelectItem>
          </SelectContent>
        </Select>
      );

    case "enum":
      return (
        <Select
          value={value === null || value === undefined ? UNSET : String(value)}
          onValueChange={(next) => onChange(next === UNSET ? null : next)}
        >
          <SelectTrigger className={width} aria-label={field.label}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={UNSET}>—</SelectItem>
            {field.choices.map((choice) => (
              <SelectItem key={choice} value={choice}>
                {choice}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );

    case "int":
    case "float":
      return (
        <Input
          type="number"
          value={value === null || value === undefined ? "" : String(value)}
          min={field.minimum ?? undefined}
          max={field.maximum ?? undefined}
          step={field.type === "float" ? "any" : undefined}
          placeholder={String(field.default ?? "")}
          onChange={(event) => {
            const raw = event.target.value;
            if (raw === "") {
              onChange(null);
              return;
            }
            const parsed =
              field.type === "int" ? Number.parseInt(raw, 10) : Number(raw);
            onChange(Number.isNaN(parsed) ? null : parsed);
          }}
          aria-label={field.label}
          className={width}
        />
      );

    default:
      return (
        <Input
          value={value === null || value === undefined ? "" : String(value)}
          placeholder={String(field.default ?? "")}
          onChange={(event) => {
            const raw = event.target.value;
            onChange(raw === "" ? null : raw);
          }}
          aria-label={field.label}
          className={width}
        />
      );
  }
}
