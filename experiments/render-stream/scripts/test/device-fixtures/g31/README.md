# g31 recorded adb/CDP fixture

Excerpts of read-only adb queries on the attached moto g31 (serial ZY22FD8XP3) on 2026-10-15, trimmed
to the lines the device harness parses (no account, app or personal data; the one non-Chrome DevTools
socket name is replaced by a generic one). `page-facts.json` is what `DEVICE_PAGE_FACTS_EXPRESSION`
returned on the phone in G7d's smoke run (2026-10-15, Chrome 154.0.8037.127, landscape lock on):
Chrome reaches the Mali-G52 through ANGLE, the landscape viewport is 828x330 CSS px, and the page's
user agent is Chrome's reduced one (`Android 10; K`, `Chrome/154.0.0.0`), so the model and the
version come from getprop and `/json/version`, never from the page.
`settings.txt` is the fake's INITIAL session state for the restore test, not the phone's (the phone
had stay_on_while_plugged_in 2, accelerometer_rotation 0, user_rotation 0).
