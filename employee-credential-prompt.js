// employee-credential-prompt.js — reusable masked temporary-password dialog
// Explicitly invoked only by Employees & Accounts actions.

import { validateTemporaryPassword } from "./employee-credential-crypto.js";

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  }[char]));
}

function language() {
  return (document.body?.dataset?.language || document.documentElement.lang || "en") === "ar" ? "ar" : "en";
}

function t(ar, en) { return language() === "ar" ? ar : en; }

function ensureDialog() {
  let modal = document.getElementById("employee-credential-prompt");
  if (modal) return modal;

  const style = document.createElement("style");
  style.id = "employee-credential-prompt-style";
  style.textContent = `
    .employee-credential-prompt{position:fixed;inset:0;z-index:100100;background:rgba(15,23,42,.58);display:flex;align-items:center;justify-content:center;padding:18px}
    .employee-credential-prompt.hidden{display:none}.employee-credential-card{width:min(480px,100%);background:var(--card,#fff);color:inherit;border-radius:18px;padding:20px;box-shadow:0 28px 90px rgba(15,23,42,.34)}
    .employee-credential-card h3{margin:0 0 8px}.employee-credential-card p{margin:0 0 14px;opacity:.76;line-height:1.5}.employee-credential-card label{display:grid;gap:6px;font-weight:700;font-size:13px}.employee-credential-card input{width:100%;box-sizing:border-box}.employee-credential-error{margin-top:8px;font-size:12px;color:#b91c1c}.employee-credential-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
  `;
  document.head.appendChild(style);

  modal = document.createElement("div");
  modal.id = "employee-credential-prompt";
  modal.className = "employee-credential-prompt hidden";
  modal.innerHTML = `
    <div class="employee-credential-card" role="dialog" aria-modal="true">
      <h3 id="employee-credential-title"></h3>
      <p id="employee-credential-message"></p>
      <label>${t("كلمة المرور المؤقتة الجديدة", "New temporary password")}<input id="employee-credential-password" type="password" autocomplete="new-password" minlength="8" /></label>
      <div id="employee-credential-error" class="employee-credential-error"></div>
      <div class="employee-credential-actions"><button id="employee-credential-cancel" type="button" class="btn-secondary">${t("إلغاء", "Cancel")}</button><button id="employee-credential-confirm" type="button" class="btn-primary">${t("متابعة", "Continue")}</button></div>
    </div>`;
  document.body.appendChild(modal);
  return modal;
}

export function requestTemporaryPassword({ title = "", message = "" } = {}) {
  const modal = ensureDialog();
  const titleEl = document.getElementById("employee-credential-title");
  const messageEl = document.getElementById("employee-credential-message");
  const input = document.getElementById("employee-credential-password");
  const errorEl = document.getElementById("employee-credential-error");
  const confirm = document.getElementById("employee-credential-confirm");
  const cancel = document.getElementById("employee-credential-cancel");

  if (titleEl) titleEl.textContent = title || t("إعداد كلمة مرور مؤقتة", "Set temporary password");
  if (messageEl) messageEl.textContent = message || t("يجب أن تتكون كلمة المرور من 8 أحرف على الأقل.", "The temporary password must contain at least 8 characters.");
  if (input) input.value = "";
  if (errorEl) errorEl.textContent = "";
  modal.classList.remove("hidden");
  setTimeout(() => input?.focus(), 0);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      modal.classList.add("hidden");
      confirm?.removeEventListener("click", onConfirm);
      cancel?.removeEventListener("click", onCancel);
      modal.removeEventListener("click", onBackdrop);
      input?.removeEventListener("keydown", onKeyDown);
      resolve(value);
    };
    const onConfirm = () => {
      try {
        const password = validateTemporaryPassword(input?.value || "");
        finish(password);
      } catch (error) {
        if (errorEl) errorEl.textContent = String(error?.message || error);
      }
    };
    const onCancel = () => finish(null);
    const onBackdrop = (event) => { if (event.target === modal) finish(null); };
    const onKeyDown = (event) => {
      if (event.key === "Enter") { event.preventDefault(); onConfirm(); }
      if (event.key === "Escape") finish(null);
    };
    confirm?.addEventListener("click", onConfirm);
    cancel?.addEventListener("click", onCancel);
    modal.addEventListener("click", onBackdrop);
    input?.addEventListener("keydown", onKeyDown);
  });
}

export function credentialPromptText(name, action) {
  const safeName = esc(name);
  return action === "promotion"
    ? t(`سيتم تغيير CCMS لـ ${safeName}. أنشئ كلمة مرور مؤقتة جديدة للحساب.`, `${safeName}'s CCMS will change. Set a new temporary password for the account.`)
    : action === "demotion"
      ? t(`سيتم تغيير CCMS لـ ${safeName}. أنشئ كلمة مرور مؤقتة جديدة للحساب.`, `${safeName}'s CCMS will change. Set a new temporary password for the account.`)
      : t(`إعداد كلمة مرور مؤقتة جديدة لـ ${safeName}.`, `Set a new temporary password for ${safeName}.`);
}
