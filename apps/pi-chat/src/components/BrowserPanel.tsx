import { Button } from "@components/ui/button";
import type { BrowserHandoffRequest, BrowserState, RuntimeStatus } from "@shared/types";
import { X } from "lucide-react";
import { useEffect, useRef } from "react";

export function BrowserPanel({
  error,
  browserHandoff,
  actionPending,
  onResolveBrowserHandoff,
  onSave,
  onLoad,
  onClose,
  browser,
  status,
}: {
  browser?: BrowserState;
  status: RuntimeStatus;
  error?: string;
  browserHandoff?: BrowserHandoffRequest;
  actionPending: boolean;
  onResolveBrowserHandoff: (action: "resume" | "cancel") => void;
  onSave: () => void;
  onLoad: () => void;
  onClose: () => void;
}) {
  const vncUrl = browser?.vncUrl;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const mixedContent = Boolean(
    vncUrl && location.protocol === "https:" && new URL(vncUrl).protocol === "http:",
  );
  const manualControl =
    status === "ready" || (status === "waiting_for_human" && Boolean(browserHandoff));
  const inputBlocked =
    !manualControl || actionPending || Boolean(error) || browser?.phase !== "ready";
  const phaseText =
    browser?.error ??
    {
      starting: "正在创建沙箱并准备浏览器…",
      loading: "正在装载已保存的登录态…",
      saving: "正在加密保存登录态…",
      releasing: "正在关闭浏览器…",
      stopped: "浏览器已关闭。",
      error: "浏览器暂不可用。",
      ready: "",
    }[browser?.phase ?? "starting"];

  useEffect(() => {
    const dialog = dialogRef.current!;
    const previousFocus = document.activeElement;
    const media = window.matchMedia("(max-width: 1023px)");
    const show = () => {
      if (dialog.open) dialog.close();
      if (media.matches) dialog.showModal();
      else dialog.show();
      closeRef.current?.focus();
    };
    show();
    media.addEventListener("change", show);
    return () => {
      media.removeEventListener("change", show);
      dialog.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    // Cross-origin iframe input must be blocked for keyboard as well as pointer users.
    if (inputBlocked && document.activeElement === iframeRef.current) closeRef.current?.focus();
  }, [inputBlocked]);

  return (
    <dialog
      ref={dialogRef}
      id="browser-panel"
      className="browser-panel"
      aria-label="浏览器"
      tabIndex={-1}
      onKeyDown={(event) => {
        // Desktop uses show(), whose non-modal dialog does not emit cancel on Escape.
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="browser-panel-toolbar">
        {phaseText && (
          <p role="status" className="browser-panel-status">
            {phaseText}
          </p>
        )}
        <Button size="sm" variant="outline" disabled={inputBlocked} onClick={onLoad}>
          Load 登录态
        </Button>
        <Button size="sm" variant="outline" disabled={inputBlocked} onClick={onSave}>
          Save 登录态
        </Button>
        <Button
          ref={closeRef}
          variant="ghost"
          size="icon"
          aria-label="关闭浏览器面板"
          onClick={onClose}
        >
          <X size={18} />
        </Button>
      </header>
      {browserHandoff && (
        <section className="browser-handoff-bar" aria-label="浏览器人工接管">
          <span>完成操作后</span>
          <div className="browser-handoff-actions">
            <Button
              size="sm"
              disabled={inputBlocked || mixedContent}
              onClick={() => onResolveBrowserHandoff("resume")}
            >
              {actionPending ? "正在处理…" : "已完成，继续"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={actionPending || Boolean(error)}
              onClick={() => onResolveBrowserHandoff("cancel")}
            >
              取消任务
            </Button>
          </div>
        </section>
      )}
      {mixedContent ? (
        <p className="browser-panel-error" role="alert">
          HTTPS 页面无法嵌入 HTTP AIO。请为 AIO 配置 HTTPS，或在可信内网使用 HTTP 打开 pi-chat。
        </p>
      ) : vncUrl ? (
        <div className="browser-viewport">
          <iframe
            ref={iframeRef}
            src={vncUrl}
            title="AIO 远程桌面"
            inert={inputBlocked}
            tabIndex={inputBlocked ? -1 : 0}
            referrerPolicy="no-referrer"
          />
          {inputBlocked && (
            <div className="browser-input-shield">
              <div className="browser-status-notice" role="status">
                <p>
                  {error ||
                    phaseText ||
                    (!manualControl ? "Agent 正在控制浏览器，当前仅可查看。" : "正在处理…")}
                </p>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </dialog>
  );
}
