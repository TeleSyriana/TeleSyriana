from pathlib import Path


def replace_required(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly 1 match, found {count}")
    return text.replace(old, new, 1)


# ---------------- tasks.js / Notes ----------------
p = Path("tasks.js")
s = p.read_text()

old_notes_tail = '''function initNotes() {
  currentUser = getUser();
  hookNotes();
  translateNotesStatic();
  if (!currentUser) {
    notes = [];
    blankEditor(true);
    if (unsubNotes) unsubNotes();
    unsubNotes = null;
    setStatus(nt("يلزم تسجيل الدخول", "Login required"), "error");
    return;
  }
  subscribeNotes();
}

document.addEventListener("DOMContentLoaded", initNotes);
window.addEventListener("telesyriana:user-changed", initNotes);'''

new_notes_tail = '''let notesPageLifecycleBound = false;

function notesPageIsActive() {
  const page = el("page-tasks");
  return Boolean(page && !page.classList.contains("hidden"));
}

function stopNotesSubscription() {
  if (unsubNotes) {
    try { unsubNotes(); } catch {}
  }
  unsubNotes = null;
}

function bindNotesPageLifecycle() {
  if (notesPageLifecycleBound) return;
  notesPageLifecycleBound = true;
  document.addEventListener("click", (event) => {
    const nav = event.target?.closest?.(".nav-link[data-page]");
    if (!nav) return;
    if (nav.dataset.page === "tasks") setTimeout(initNotes, 0);
    else stopNotesSubscription();
  });
}

function initNotes() {
  currentUser = getUser();
  hookNotes();
  translateNotesStatic();
  bindNotesPageLifecycle();

  if (!currentUser) {
    notes = [];
    blankEditor(true);
    stopNotesSubscription();
    setStatus(nt("يلزم تسجيل الدخول", "Login required"), "error");
    return;
  }

  if (!notesPageIsActive()) {
    stopNotesSubscription();
    return;
  }

  subscribeNotes();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initNotes);
else initNotes();
window.addEventListener("telesyriana:user-changed", initNotes);'''

s = replace_required(s, old_notes_tail, new_notes_tail, "Notes page-scoped Firestore listener")
p.write_text(s)


# ---------------- meetings.js ----------------
p = Path("meetings.js")
s = p.read_text()

init_marker = "  // -------------------- init --------------------\n"
meeting_helpers = '''  function meetingsPageIsActive() {
    const page = document.getElementById("page-meetings");
    return Boolean(page && !page.classList.contains("hidden"));
  }

  function stopUpcomingSubscription() {
    if (unsubUpcoming) {
      try { unsubUpcoming(); } catch {}
    }
    unsubUpcoming = null;
  }

  function syncMeetingsPageRealtime() {
    const user = getCurrentUser();
    const active = meetingsPageIsActive();

    if (elCreateBox) {
      const show = active && !!user && canManageاجتماعs(user);
      elCreateBox.classList.toggle("hidden", !show);
      if (show) {
        injectShareButtons();
        prepareCreateDefaults(false).catch(console.error);
      }
    }

    if (!user || !active) {
      stopUpcomingSubscription();
      return;
    }

    subscribeUpcoming();
  }

  // -------------------- init --------------------
'''
s = replace_required(s, init_marker, meeting_helpers, "Meetings page lifecycle helpers")

old_init_start = '''  function initاجتماعs() {
    const user = getCurrentUser();

    // supervisor create UI
    if (elCreateBox) {
      const show = !!user && canManageاجتماعs(user);
      elCreateBox.classList.toggle("hidden", !show);
      if (show) {
        injectShareButtons();
        prepareCreateDefaults(false).catch(console.error);
      }
    }

    subscribeUpcoming();
'''
new_init_start = '''  function initاجتماعs() {
    syncMeetingsPageRealtime();

    document.querySelectorAll(".nav-link[data-page]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.page === "meetings") setTimeout(syncMeetingsPageRealtime, 0);
        else stopUpcomingSubscription();
      });
    });
'''
s = replace_required(s, old_init_start, new_init_start, "Meetings hidden-page startup reads")

old_user_change = '''    window.addEventListener("telesyriana:user-changed", () => {
      const u = getCurrentUser();
      const show = !!u && canManageاجتماعs(u);
      elCreateBox?.classList.toggle("hidden", !show);
      if (show) {
        injectShareButtons();
        prepareCreateDefaults(false).catch(console.error);
      }
    });'''
new_user_change = '''    window.addEventListener("telesyriana:user-changed", () => {
      syncMeetingsPageRealtime();
    });'''
s = replace_required(s, old_user_change, new_user_change, "Meetings user-change hidden reads")

p.write_text(s)

print("Notes and Meetings quota lifecycle patches applied successfully.")
