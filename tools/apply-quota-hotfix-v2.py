from pathlib import Path


def replace_required(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly 1 match, found {count}")
    return text.replace(old, new, 1)


def replace_first_required(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count < 1:
        raise SystemExit(f"{label}: expected at least 1 match, found 0")
    return text.replace(old, new, 1)


# ---------- app-core.js ----------
p = Path("app-core.js")
s = p.read_text()
s = replace_required(s, '''function startPresence() {
  if (!currentUser) return;
  subscribePresence();
  updatePresence(true);
  if (presenceTimerId) clearInterval(presenceTimerId);
  presenceTimerId = setInterval(() => updatePresence(false), 30_000);
}''', '''function stopPresenceListener() {
  if (!presenceUnsub) return;
  try { presenceUnsub(); } catch {}
  presenceUnsub = null;
}

function syncHomeRealtimeListeners(pageId = pageVisibleName()) {
  const homeActive = pageId === "home";
  if (homeActive && canViewOnlineNow(currentUser)) subscribePresence();
  else stopPresenceListener();

  if (homeActive && canViewTeamDashboard(currentUser)) subscribeSupervisorDashboard();
  else if (supUnsub) {
    try { supUnsub(); } catch {}
    supUnsub = null;
  }

  if (homeActive) subscribeIssueCalendar();
  else if (issueCalendarUnsub) {
    try { issueCalendarUnsub(); } catch {}
    issueCalendarUnsub = null;
  }
}

function startPresence() {
  if (!currentUser) return;
  syncHomeRealtimeListeners();
  updatePresence(true);
  if (presenceTimerId) clearInterval(presenceTimerId);
  presenceTimerId = setInterval(() => updatePresence(false), 60_000);
}''', "app presence lifecycle")
s = replace_required(s,
    'if (role !== "agent") return [{ key: "team", source: base }];',
    'if (role !== "agent") return [{ key: "team", source: query(base, where("status", "in", ["open", "waiting_customer", "waiting_courier", "waiting_supplier", "escalated", "urgent"])) }];',
    "active-only management issue calendar")
s = replace_required(s,
    '  updatePresence(false).catch(() => {});\n  try { translateFeaturePages(getLanguage()); applyPhase21LanguagePolish(getLanguage()); setTimeout(() => applyPhase21LanguagePolish(getLanguage()), 80); } catch {}',
    '  updatePresence(false).catch(() => {});\n  syncHomeRealtimeListeners(pageId);\n  try { translateFeaturePages(getLanguage()); applyPhase21LanguagePolish(getLanguage()); setTimeout(() => applyPhase21LanguagePolish(getLanguage()), 80); } catch {}',
    "page-scoped home realtime listeners")
p.write_text(s)


# ---------- messages-core.js ----------
p = Path("messages-core.js")
s = p.read_text()
s = replace_required(s,
    '  updateBadgesForRoom(key);\n  ensureUnreadWatcher(key);',
    '  updateBadgesForRoom(key);\n  if (currentUser?.id) ensureUnreadWatcher(key);',
    "no unread watchers before login")
s = replace_required(s, "// ---------------- init ----------------\n", '''function messagesPageIsActive() {
  const page = document.getElementById("page-messages");
  return Boolean(page && !page.classList.contains("hidden"));
}

function stopMessagesPageRealtime() {
  try { unsubPresence?.(); } catch {}
  unsubPresence = null;
  try { unsubscribeProfiles?.(); } catch {}
  unsubscribeProfiles = null;
  try { unsubscribeالحالة?.(); } catch {}
  unsubscribeالحالة = null;
  unsubscribeGroupsCloud();
  unsubscribeRecentsCloud();
  presenceCache.clear();
}

function syncMessagesPageRealtime() {
  setCurrentUser();
  if (!currentUser?.id || !messagesPageIsActive()) {
    stopMessagesPageRealtime();
    return;
  }
  subscribePresenceSidebar();
  subscribeProfilesSidebar();
  subscribeGroupsCloud();
  subscribeRecentsCloud();
  subscribeالحالةDots();
  applyProfileAvatars();
  applyBirthdayBadges();
}

// ---------------- init ----------------
''', "messages page helpers")
s = replace_required(s,
    '  setCurrentUser();\n  subscribePresenceSidebar();\n  subscribeProfilesSidebar();\n  applyProfileAvatars();',
    '  setCurrentUser();\n  syncMessagesPageRealtime();',
    "hidden initial message presence/profile")
s = replace_first_required(s,
    '  subscribeGroupsCloud();\n  subscribeRecentsCloud();',
    '  syncMessagesPageRealtime();',
    "hidden initial messages groups/recents")
s = replace_required(s, '''  document.querySelectorAll(".nav-link[data-page]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.page !== "messages") document.body.classList.remove("chat-open");
    });
  });''', '''  document.querySelectorAll(".nav-link[data-page]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.page !== "messages") {
        document.body.classList.remove("chat-open");
        stopMessagesPageRealtime();
      } else {
        setTimeout(syncMessagesPageRealtime, 0);
      }
    });
  });''', "messages navigation lifecycle")
s = replace_required(s,
    '  subscribeالحالةDots();\n});',
    '  syncMessagesPageRealtime();\n});',
    "hidden initial messages status listener")
s = replace_required(s, '''  subscribeGroupsCloud();
  subscribeRecentsCloud();
  subscribeالحالةDots();
  subscribeProfilesSidebar();
  applyProfileAvatars();
  applyBirthdayBadges();
  applyProfileAvatars();''', '''  syncMessagesPageRealtime();
  if (messagesPageIsActive()) {
    applyProfileAvatars();
    applyBirthdayBadges();
  }''', "messages user-change lifecycle")
p.write_text(s)


# ---------- groups-core.js ----------
p = Path("groups-core.js")
s = p.read_text()
s = replace_required(s, '''document.addEventListener("DOMContentLoaded", () => {
  hookMemberSearch();
  hookUI();
  subscribeGroupsList();
});

window.addEventListener("telesyriana:user-changed", () => {
  applySupervisorVisibility();
  subscribeGroupsList();
});''', '''function groupsMessagesPageIsActive() {
  const page = document.getElementById("page-messages");
  return Boolean(page && !page.classList.contains("hidden"));
}

function stopGroupsList() {
  try { unsubGroups?.(); } catch {}
  unsubGroups = null;
}

function syncGroupsListLifecycle() {
  if (getCurrentUser()?.id && groupsMessagesPageIsActive()) subscribeGroupsList();
  else stopGroupsList();
}

document.addEventListener("DOMContentLoaded", () => {
  hookMemberSearch();
  hookUI();
  syncGroupsListLifecycle();
  document.querySelectorAll(".nav-link[data-page]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.page === "messages") setTimeout(syncGroupsListLifecycle, 0);
      else stopGroupsList();
    });
  });
});

window.addEventListener("telesyriana:user-changed", () => {
  applySupervisorVisibility();
  syncGroupsListLifecycle();
});''', "groups hidden-page listener lifecycle")
p.write_text(s)

print("Quota hotfix v2 source patches applied successfully.")
