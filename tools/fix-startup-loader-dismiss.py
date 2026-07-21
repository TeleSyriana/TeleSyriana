from pathlib import Path

path = Path('app-core.js')
source = path.read_text(encoding='utf-8')

old = '''  startPresence();
  subscribeIssueCalendar();
}
'''
new = '''  startPresence();
  subscribeIssueCalendar();

  // Home is the initial ready state. Tickets load lazily when opened,
  // so startup must not wait for a tickets-ready event.
  setAppLoading(
    100,
    loadingText("جاهز", "Ready"),
    loadingText("تم فتح لوحة التحكم.", "Dashboard ready."),
    { noWatchdog: true }
  );
  hideAppLoading(200);
}
'''

count = source.count(old)
if count != 1:
    raise SystemExit(f'Expected exactly one showDashboard tail marker, found {count}')

path.write_text(source.replace(old, new, 1), encoding='utf-8')
print('Startup loader dismissal patch applied.')
