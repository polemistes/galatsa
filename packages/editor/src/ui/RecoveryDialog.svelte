<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!--
  Work a program left when it stopped, offered at start with the choices of
  docs/adr/0006, section 7.1.
-->
<script lang="ts">
  import type { I18n } from "@galatsa/i18n";
  import { noticeText, type Notice, type RecoveryOffer } from "@galatsa/storage";
  import type { EditorApp } from "../app.ts";
  import Dialog from "./Dialog.svelte";
  import { translator } from "./reactive.ts";

  let {
    i18n,
    app,
    offer,
    problem,
  }: { i18n: I18n; app: EditorApp; offer: RecoveryOffer; problem: Notice | null } =
    $props();

  const t = $derived(translator(i18n));
  let confirm = $state<"discard" | "delete" | null>(null);
  let message = $state<string | null>(null);
  const title = $derived(
    offer.title.trim() !== "" ? offer.title : t("storage:recovery.untitled"),
  );
  const savedToFile = $derived(offer.savedToFileAt !== null && offer.fileName !== null);

  function discard(): void {
    void app.discard(offer.slot).then((result) => {
      if (result === null) message = t("editor:recovery.discardNoFile");
      else if (!result.ok && result.reason === "other-document")
        message = t("editor:recovery.otherDocument", { name: result.name });
      else if (!result.ok && result.reason === "file-failed")
        message = noticeText(i18n, result.problem);
    });
  }
</script>

<Dialog heading={t("storage:recovery.heading")}>
  <p>{t("storage:recovery.offer", { title, when: offer.changedAt })}</p>
  {#if problem !== null}
    <p role="alert">{noticeText(i18n, problem)}</p>
  {/if}
  {#if message !== null}
    <p role="alert">{message}</p>
  {/if}
  {#if confirm === "discard"}
    <p>
      {t("storage:recovery.discardChanges.detail", {
        name: offer.fileName ?? "",
        when: offer.savedToFileAt ?? 0,
      })}
    </p>
  {:else if confirm === "delete"}
    <p>{t("storage:recovery.delete.detail", { title })}</p>
  {/if}
  <div class="buttons">
    <button type="button" onclick={() => void app.restore(offer.slot)}>
      {t("storage:recovery.restore")}
    </button>
    <button type="button" onclick={() => void app.later(offer.slot)}>
      {t("storage:recovery.later")}
    </button>
    <button
      type="button"
      title={t("storage:recovery.dismiss.detail", { title })}
      onclick={() => void app.dismiss(offer.slot)}
    >
      {t("storage:recovery.dismiss")}
    </button>
    {#if savedToFile}
      {#if confirm === "discard"}
        <button type="button" onclick={discard}>
          {t("editor:recovery.discardConfirm")}
        </button>
      {:else}
        <button type="button" onclick={() => (confirm = "discard")}>
          {t("storage:recovery.discardChanges")}
        </button>
      {/if}
    {:else if confirm === "delete"}
      <button type="button" onclick={() => void app.deleteOffer(offer.slot)}>
        {t("editor:recovery.deleteConfirm")}
      </button>
    {:else}
      <button type="button" onclick={() => (confirm = "delete")}>
        {t("storage:recovery.delete")}
      </button>
    {/if}
  </div>
</Dialog>
