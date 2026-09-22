"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { EnabledModelsView } from "@/lib/enabled-models";
import {
  enabledModelsBulkActions,
  enabledModelsProviderToggle,
  filterEnabledModels,
  findProviderView,
  isLastEnabledModel,
} from "./enabled-models-helpers";
import { ConfigButton, ConfigSectionTitle, ConfigSwitch } from "./SettingsUi";

/**
 * Model switches backed by pi's `enabledModels` setting.
 *
 * Every switch writes through `/api/models/enabled` right away, like the login
 * controls in the same panel and unlike the models.json editor around them,
 * which buffers until Save. Requests are serialized: each one is a
 * read-modify-write of one settings key, so overlapping edits from the same
 * panel could otherwise lose one of them.
 */

interface Failure {
  /** Translation key for a known refusal. */
  messageKey?: string;
  /** Raw server text for everything else. */
  message?: string;
}

export interface EnabledModelsController {
  view: EnabledModelsView | null;
  loading: boolean;
  /** Control currently waiting on the server, or null when idle. */
  pending: string | null;
  failure: Failure | null;
  setModels: (key: string, refs: string[], enabled: boolean) => void;
  setProvider: (providerId: string, enabled: boolean) => void;
  clearScope: () => void;
  pruneStale: () => void;
  /** Re-read after models.json changed under the panel. */
  refresh: () => void;
  /** Re-verify the stored patterns after models.json was saved. */
  resync: (
    renames: { from: string; to: string }[],
    modelRenames: { from: string; to: string }[],
  ) => void;
}

type MutationBody =
  | { op: "models"; refs: string[]; enabled: boolean }
  | { op: "provider"; provider: string; enabled: boolean }
  | { op: "clear" }
  | { op: "prune" }
  | {
      op: "resync";
      renames: { from: string; to: string }[];
      modelRenames: { from: string; to: string }[];
      fullyEnabled: string[];
    };

const FAILURE_KEYS: Record<string, string> = {
  "last-model": "models.enabledLastModel",
  "project-scope": "models.enabledProjectScope",
};

export function useEnabledModels(cwd?: string | null): EnabledModelsController {
  const [view, setView] = useState<EnabledModelsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const pendingRef = useRef<string | null>(null);
  const queuedRef = useRef<{ key: string; body: MutationBody } | null>(null);
  const mutateRef = useRef<((key: string, body: MutationBody) => void) | null>(null);

  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    fetch(`/api/models/enabled${query}`, { signal: controller.signal })
      .then(async (res) => {
        const data = await res.json() as EnabledModelsView & { error?: string };
        if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
        setView(data);
        setFailure(null);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setFailure({ message: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [cwd, reloadKey]);

  const mutate = useCallback((key: string, body: MutationBody) => {
    // A save can land while a switch is still in flight; queue it rather than
    // dropping it, or the panel keeps describing the previous models.json.
    if (pendingRef.current) {
      queuedRef.current = { key, body };
      return;
    }
    pendingRef.current = key;
    setPending(key);
    setFailure(null);
    void (async () => {
      try {
        const res = await fetch("/api/models/enabled", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, ...(cwd ? { cwd } : {}) }),
        });
        const data = await res.json() as EnabledModelsView & { error?: string; reason?: string };
        if (!res.ok || data.error) {
          const messageKey = data.reason ? FAILURE_KEYS[data.reason] : undefined;
          setFailure(messageKey ? { messageKey } : { message: data.error ?? `HTTP ${res.status}` });
          return;
        }
        setView(data);
      } catch (error) {
        setFailure({ message: error instanceof Error ? error.message : String(error) });
      } finally {
        pendingRef.current = null;
        setPending(null);
        const queued = queuedRef.current;
        queuedRef.current = null;
        if (queued) mutateRef.current?.(queued.key, queued.body);
      }
    })();
  }, [cwd]);

  mutateRef.current = mutate;

  const setModels = useCallback((key: string, refs: string[], enabled: boolean) => {
    mutate(key, { op: "models", refs, enabled });
  }, [mutate]);

  const setProvider = useCallback((providerId: string, enabled: boolean) => {
    mutate(`provider:${providerId}`, { op: "provider", provider: providerId, enabled });
  }, [mutate]);

  const clearScope = useCallback(() => mutate("clear", { op: "clear" }), [mutate]);
  const pruneStale = useCallback(() => mutate("prune", { op: "prune" }), [mutate]);
  const refresh = useCallback(() => setReloadKey((key) => key + 1), []);
  // Resync writes and returns the fresh view, so it doubles as the reload
  // models.json needs after a save. The providers that are fully enabled right
  // now are the intent to preserve across whatever the save changed.
  const resync = useCallback((
    renames: { from: string; to: string }[],
    modelRenames: { from: string; to: string }[],
  ) => {
    const fullyEnabled = (view?.providers ?? [])
      .filter((provider) => provider.models.length > 0 && provider.enabledCount === provider.models.length)
      .map((provider) => provider.id);
    mutate("resync", { op: "resync", renames, modelRenames, fullyEnabled });
  }, [mutate, view]);

  return {
    view,
    loading,
    pending,
    failure,
    setModels,
    setProvider,
    clearScope,
    pruneStale,
    refresh,
    resync,
  };
}

/** Panel-wide note shown while `enabledModels` narrows the selector. */
export function EnabledModelsBanner({ controller }: { controller: EnabledModelsController }) {
  const { t } = useI18n();
  const { view, pending } = controller;
  if (!view) return null;
  const scoped = !view.allEnabled;
  const stale = view.stalePatterns.length;
  if (!scoped && stale === 0) return null;

  return (
    <div className="enabled-models-banner">
      <span
        className="enabled-models-banner-text"
        {...(stale > 0 ? { title: t("models.enabledStaleHint") } : {})}
      >
        {scoped
          ? t("models.enabledBanner", { enabled: view.enabledTotal, total: view.availableTotal })
          : t("models.enabledStale", { count: stale })}
        {scoped && stale > 0 && ` · ${t("models.enabledStale", { count: stale })}`}
      </span>
      {view.editable && stale > 0 && (
        <ConfigButton
          size="small"
          onClick={controller.pruneStale}
          disabled={pending !== null}
          title={t("models.enabledPruneHint")}
        >
          {t("models.enabledPrune")}
        </ConfigButton>
      )}
      {view.editable && scoped && (
        <ConfigButton
          size="small"
          onClick={controller.clearScope}
          disabled={pending !== null}
          title={t("models.enabledClearHint")}
        >
          {t("models.enabledClear")}
        </ConfigButton>
      )}
    </div>
  );
}

export function EnabledModelsSection({
  providerId,
  controller,
  custom = false,
}: {
  providerId: string;
  controller: EnabledModelsController;
  /** True for a models.json provider, whose models the panel itself edits. */
  custom?: boolean;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const { view, loading, pending, failure } = controller;
  const provider = findProviderView(view, providerId);

  useEffect(() => setQuery(""), [providerId]);

  if (loading && !view) {
    return <div className="enabled-models-empty">{t("agents.modelsLoading")}</div>;
  }
  if (!provider) {
    // A models.json provider is missing from the runtime when its edits are not
    // saved yet, when it has no models, or when its key does not work — never
    // because of a sign-in, so do not send the user looking for one.
    return failure?.message
      ? <div className="enabled-models-error">{failure.message}</div>
      : (
        <div className="enabled-models-empty">
          {t(custom ? "models.enabledCustomEmpty" : "models.enabledUnavailable")}
        </div>
      );
  }

  // A models.json provider has no rows of its own — the panel edits its models
  // directly — so it is switched as a whole and one switch says everything the
  // two bulk buttons said: they only ever sent the same provider-wide write.
  const isCustom = provider.kind === "custom";
  const shown = isCustom ? provider.models : filterEnabledModels(provider.models, query);
  const bulk = enabledModelsBulkActions(view, shown);
  const toggle = enabledModelsProviderToggle(view, provider);
  const filtered = shown.length !== provider.models.length;
  const busy = pending !== null;
  const bulkKey = `provider:${provider.id}`;
  // A provider-wide action is resolved server-side so models the browser has
  // not seen yet follow it too; a filtered action names its rows explicitly.
  const runBulk = (enabled: boolean, refs: string[]) => {
    if (filtered) controller.setModels(bulkKey, refs, enabled);
    else controller.setProvider(provider.id, enabled);
  };

  return (
    <div className="enabled-models-section">
      <div className="enabled-models-header">
        <ConfigSectionTitle>{t("models.enabledSection")}</ConfigSectionTitle>
        <span className="enabled-models-count">
          {t("models.enabledCount", { enabled: provider.enabledCount, total: provider.models.length })}
        </span>
        {isCustom ? (
          <ConfigSwitch
            checked={toggle.checked}
            loading={pending === bulkKey}
            disabled={busy || toggle.blocked}
            label={toggle.checked && !bulk.canDisable
              ? t("models.enabledLastModel")
              : t("models.enabledProviderToggle", { provider: provider.name })}
            onChange={(checked) => controller.setProvider(provider.id, checked)}
          />
        ) : (
          <>
            <ConfigButton
              size="small"
              disabled={busy || !bulk.canEnable}
              onClick={() => runBulk(true, bulk.enableRefs)}
            >
              {filtered ? t("models.enableShown") : t("models.enableAll")}
            </ConfigButton>
            <ConfigButton
              size="small"
              disabled={busy || !bulk.canDisable}
              title={!bulk.canDisable && bulk.disableRefs.length > 0 ? t("models.enabledLastModel") : undefined}
              onClick={() => runBulk(false, bulk.disableRefs)}
            >
              {filtered ? t("models.disableShown") : t("models.disableAll")}
            </ConfigButton>
          </>
        )}
      </div>

      {!view?.editable && <div className="enabled-models-note">{t("models.enabledProjectScope")}</div>}
      {failure && (
        <div className="enabled-models-error">
          {failure.messageKey ? t(failure.messageKey) : failure.message}
        </div>
      )}

      {isCustom ? (
        <div className="enabled-models-note">{t("models.enabledCustomHint")}</div>
      ) : (
        <>
          {provider.models.length > 8 && (
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("models.enabledFilterPlaceholder", { count: provider.models.length })}
              aria-label={t("models.enabledFilter")}
              className="enabled-models-filter"
            />
          )}
          <div className="enabled-models-list">
            {shown.length === 0 ? (
              <div className="enabled-models-empty">{t("models.enabledNoMatches")}</div>
            ) : shown.map((model) => {
              const lastOne = isLastEnabledModel(view, model);
              return (
                <div key={model.ref} className="enabled-models-row">
                  <span className="enabled-models-row-text">
                    <span className="enabled-models-row-name">{model.name}</span>
                    <code className="enabled-models-row-id">{model.id}</code>
                  </span>
                  {model.thinkingPin && (
                    <span className="enabled-models-pin" title={t("models.enabledPinHint")}>
                      {model.thinkingPin}
                    </span>
                  )}
                  <ConfigSwitch
                    checked={model.enabled}
                    loading={pending === model.ref}
                    disabled={busy || !view?.editable || lastOne}
                    label={lastOne
                      ? t("models.enabledLastModel")
                      : t("models.enabledToggle", { model: model.name })}
                    onChange={(checked) => controller.setModels(model.ref, [model.ref], checked)}
                  />
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
