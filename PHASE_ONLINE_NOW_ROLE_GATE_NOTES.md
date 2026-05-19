# Online Now Role Gate

- The Home page “Online now / المتواجدون الآن” widget is now visible only for admin/owner, manager, HR, and supervisor roles.
- Agents still update presence so management can see them, but agents do not see the team online list.
- Implemented in `app.js` with `canViewOnlineNow()` and hidden widget behaviour.
