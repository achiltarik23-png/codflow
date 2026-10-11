import { useState } from "react";
import { Check, Copy, Key, KeyRound, Loader2, Trash2 } from "lucide-react";
import { Button, Dialog } from "@/components/ui";
import { useT } from "@/i18n/react";
import { notify } from "@/lib/notify";
import { rotateStoreApiKey } from "@/features/settings/api";
import type { StoreConfig } from "@/features/settings/types";

export function ApiSettings({ storeConfig }: { storeConfig: StoreConfig }) {
  const t = useT("settings");
  const common = useT("common");
  const [rotatedKey, setRotatedKey] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);
  const [copied, setCopied] = useState(false);

  async function handleRotate() {
    setRotating(true);
    try {
      const result = await rotateStoreApiKey();
      setRotatedKey(result.apiKey);
      setCopied(false);
      notify.success(t("store.api_key_rotated"));
    } catch {
      notify.error(t("store.api_key_rotate_failed"));
    } finally {
      setRotating(false);
    }
  }

  async function handleCopy() {
    if (!rotatedKey) return;
    try {
      await navigator.clipboard.writeText(rotatedKey);
      setCopied(true);
      notify.success(t("store.api_key_copied"));
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
      notify.error(common("feedback.copy_failed"));
    }
  }

  function closeResult() {
    setRotatedKey(null);
    setCopied(false);
  }

  return (
    <>
      <section className="rounded-xl border border-border bg-card">
        <div className="flex items-start gap-3 border-b border-border px-5 py-4">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
            <Key size={18} aria-hidden="true" />
          </span>
          <div>
            <h2 className="text-sm font-bold text-foreground">{t("store.api_key_title")}</h2>
            <p className="text-xs text-muted-foreground">{t("store.api_key_subtitle")}</p>
          </div>
        </div>
        <div className="space-y-4 px-5 py-5">
          <p className="text-sm text-muted-foreground">
            {storeConfig.storeApiKeyConfigured
              ? t("store.api_key_configured")
              : t("store.api_key_missing")}
          </p>
          <Button
            type="button"
            variant="secondary"
            onClick={() => void handleRotate()}
            disabled={rotating}
          >
            {rotating ? <Loader2 size={15} className="animate-spin" /> : <KeyRound size={15} />}
            {storeConfig.storeApiKeyConfigured
              ? t("store.api_key_rotate")
              : t("store.api_key_generate")}
          </Button>
        </div>
      </section>

      <Dialog
        open={rotatedKey !== null}
        onClose={closeResult}
        title={
          <span className="inline-flex items-center gap-2.5">
            <span className="grid size-8 place-items-center rounded-lg bg-amber-500/10 text-amber-600">
              <KeyRound size={16} aria-hidden="true" />
            </span>
            {t("store.api_key_result_title")}
          </span>
        }
        description={t("store.api_key_result_description")}
        className="max-w-sm"
        showClose={false}
      >
        {rotatedKey && (
          <>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 select-all truncate rounded-lg border border-border bg-muted/60 px-3 py-2.5 font-mono text-xs text-foreground">
                {rotatedKey}
              </code>
              <Button
                type="button"
                variant="secondary"
                size="icon"
                onClick={() => void handleCopy()}
                aria-label={t("store.api_key_copy")}
              >
                {copied ? <Check size={15} className="text-violet-500" /> : <Copy size={15} />}
              </Button>
            </div>
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2.5">
              <Trash2 size={14} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
              <p className="text-xs font-semibold leading-relaxed text-destructive">
                {t("store.api_key_warning")}
              </p>
            </div>
            <div className="mt-6">
              <Button type="button" className="w-full" onClick={closeResult}>
                {t("store.api_key_done")}
              </Button>
            </div>
          </>
        )}
      </Dialog>
    </>
  );
}
