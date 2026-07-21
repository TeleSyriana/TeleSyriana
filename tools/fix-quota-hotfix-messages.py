from pathlib import Path


def replace_required(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly 1 match, found {count}")
    return text.replace(old, new, 1)


p = Path("messages-core.js")
s = p.read_text()

# The first quota patch accidentally replaced the helper's own groups/recents
# subscriptions with a recursive call. Restore the intended subscriptions.
s = replace_required(
    s,
    '''  subscribePresenceSidebar();
  subscribeProfilesSidebar();
  syncMessagesPageRealtime();
  subscribeالحالةDots();''',
    '''  subscribePresenceSidebar();
  subscribeProfilesSidebar();
  subscribeGroupsCloud();
  subscribeRecentsCloud();
  subscribeالحالةDots();''',
    "restore Messages helper subscriptions",
)

# The original startup subscriptions must be replaced by the page-aware helper.
s = replace_required(
    s,
    '''  hookSearch();

  subscribeGroupsCloud();
  subscribeRecentsCloud();

  document.querySelectorAll(".nav-link[data-page]").forEach((btn) => {''',
    '''  hookSearch();

  syncMessagesPageRealtime();

  document.querySelectorAll(".nav-link[data-page]").forEach((btn) => {''',
    "replace hidden Messages startup groups/recents",
)

# Guard against recursive helper regression.
helper_start = s.index("function syncMessagesPageRealtime()")
helper_end = s.index("// ---------------- init ----------------", helper_start)
helper = s[helper_start:helper_end]
if "syncMessagesPageRealtime();" in helper:
    raise SystemExit("Messages helper still contains a recursive self-call")

p.write_text(s)
print("Messages quota lifecycle ordering fixed.")
